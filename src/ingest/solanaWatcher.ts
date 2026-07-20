import { getChain } from "../chains";
import { env, type Erc20Token } from "../config/env";
import { recordActivity } from "../services/activityService";
import { listAllWatchedAddresses } from "../services/addressService";
import { processIncomingTxs } from "../services/ingestService";
import type { NormalizedTx } from "../types";
import { getAddressCursor, setAddressCursor } from "./addressState";
import { sleep } from "./esploraCommon";
import { formatUnits } from "./format";

const LAMPORTS_PER_SOL_DECIMALS = 9;

interface SignatureInfo {
  signature: string;
  err: unknown;
  blockTime?: number | null;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

interface SolanaTransaction {
  transaction: { message: { accountKeys: (string | { pubkey: string })[] } };
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  blockTime?: number | null;
}

let rpcId = 0;

async function rpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RPC ${method} responded HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`RPC ${method} error ${body.error.code}: ${body.error.message}`);
  if (body.result === undefined) throw new Error(`RPC ${method} returned no result`);
  return body.result;
}

function accountKey(key: string | { pubkey: string }): string {
  return typeof key === "string" ? key : key.pubkey;
}

export function parseSolanaTransaction(
  signature: string,
  tx: SolanaTransaction,
  address: string,
  tokens: Map<string, Erc20Token>,
): NormalizedTx[] {
  if (!tx.meta || tx.meta.err) return [];
  const out: NormalizedTx[] = [];
  const timestamp = tx.blockTime ?? undefined;

  const accountKeys = tx.transaction.message.accountKeys.map(accountKey);
  const idx = accountKeys.indexOf(address);
  if (idx !== -1) {
    const pre = tx.meta.preBalances[idx];
    const post = tx.meta.postBalances[idx];
    if (typeof pre === "number" && typeof post === "number" && post > pre) {
      out.push({
        txHash: signature,
        address,
        amount: formatUnits(BigInt(post - pre), LAMPORTS_PER_SOL_DECIMALS),
        asset: "SOL",
        timestamp,
      });
    }
  }

  const pre = new Map(
    (tx.meta.preTokenBalances ?? [])
      .filter((b) => b.owner === address)
      .map((b) => [`${b.accountIndex}|${b.mint}`, BigInt(b.uiTokenAmount.amount)]),
  );
  for (const post of tx.meta.postTokenBalances ?? []) {
    if (post.owner !== address) continue;
    const token = tokens.get(post.mint);
    if (!token) continue;
    const key = `${post.accountIndex}|${post.mint}`;
    const before = pre.get(key) ?? 0n;
    const after = BigInt(post.uiTokenAmount.amount);
    if (after > before) {
      out.push({
        txHash: signature,
        address,
        amount: formatUnits(after - before, token.decimals),
        asset: token.ticker,
        timestamp,
      });
    }
  }

  return out;
}

async function fetchNewSignatures(rpcUrl: string, address: string): Promise<SignatureInfo[]> {
  const until = getAddressCursor("solana", address) ?? undefined;
  const sigs = await rpc<SignatureInfo[]>(rpcUrl, "getSignaturesForAddress", [
    address,
    { limit: env.ingest.solanaSignaturesPerPoll, until },
  ]);
  return sigs.filter((s) => !s.err);
}

async function processAddress(
  chainId: string,
  address: string,
  tokens: Map<string, Erc20Token>,
  onTxs: (txs: NormalizedTx[]) => Promise<void>,
): Promise<void> {
  const signatures = await fetchNewSignatures(env.ingest.solanaRpcUrl, address);
  if (signatures.length === 0) return;

  // Newest-first from the RPC; process oldest-first so amounts land in order.
  const ordered = [...signatures].reverse();
  for (const { signature } of ordered) {
    const tx = await rpc<SolanaTransaction | null>(env.ingest.solanaRpcUrl, "getTransaction", [
      signature,
      { maxSupportedTransactionVersion: 0 },
    ]);
    if (!tx) continue;
    const txs = parseSolanaTransaction(signature, tx, address, tokens);
    if (txs.length > 0) await onTxs(txs);
  }

  setAddressCursor(chainId, address, signatures[0]!.signature);
}

export interface SolanaBalance {
  asset: string;
  raw: bigint;
  decimals: number;
}

interface TokenAccountsResponse {
  value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[];
}

/**
 * Native SOL balance plus every configured SPL token balance for one address.
 * Each asset is fetched independently so one failing token lookup (rate
 * limit, timeout) doesn't discard the balances that did succeed.
 */
export async function fetchSolanaBalances(
  rpcUrl: string,
  address: string,
  tokens: Erc20Token[],
): Promise<SolanaBalance[]> {
  const [lamportsResult, ...tokenResults] = await Promise.allSettled([
    rpc<number>(rpcUrl, "getBalance", [address]),
    ...tokens.map((token) =>
      rpc<TokenAccountsResponse>(rpcUrl, "getTokenAccountsByOwner", [
        address,
        { mint: token.address },
        { encoding: "jsonParsed" },
      ]),
    ),
  ]);

  const balances: SolanaBalance[] = [];
  if (lamportsResult.status === "fulfilled") {
    balances.push({
      asset: "SOL",
      raw: BigInt(lamportsResult.value),
      decimals: LAMPORTS_PER_SOL_DECIMALS,
    });
  } else {
    console.error(`[balances:solana] getBalance failed for ${address}: ${lamportsResult.reason}`);
  }

  tokens.forEach((token, i) => {
    const result = tokenResults[i]!;
    if (result.status === "fulfilled") {
      const raw = result.value.value.reduce(
        (sum, acc) => sum + BigInt(acc.account.data.parsed.info.tokenAmount.amount),
        0n,
      );
      balances.push({ asset: token.ticker, raw, decimals: token.decimals });
    } else {
      console.error(
        `[balances:solana] ${token.ticker} lookup failed for ${address}: ${result.reason}`,
      );
    }
  });

  return balances;
}

export async function seedSolanaAddress(personalKeyId: string, address: string): Promise<void> {
  const tokens = new Map(env.ingest.solanaSplTokens.map((t) => [t.address, t]));
  await processAddress("solana", address, tokens, async (txs) => {
    for (const tx of txs) {
      recordActivity(personalKeyId, "solana", tx.address, tx.txHash, tx.amount, tx.asset);
    }
  });
}

export async function pollSolana(): Promise<void> {
  const chain = getChain("solana");
  if (!chain) return;

  const tokens = new Map(env.ingest.solanaSplTokens.map((t) => [t.address, t]));
  const addresses = listAllWatchedAddresses(chain.id);
  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i]!;
    if (i > 0) await sleep(env.ingest.solanaAddressGapMs);
    await processAddress(chain.id, address, tokens, (txs) => processIncomingTxs(chain, txs));
  }
}
