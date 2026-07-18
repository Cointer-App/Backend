import { getChain } from "../chains";
import type { Erc20Token } from "../config/env";
import { listAllWatchedAddresses } from "../services/addressService";
import { processIncomingTxs } from "../services/ingestService";
import type { NormalizedTx } from "../types";
import { formatUnits } from "./format";
import { getCursor, setCursor } from "./state";

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface EvmBlock {
  timestamp: string;
  transactions: { hash: string; from: string; to: string | null; value: string }[];
}

export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
}

export function parseEvmBlock(
  block: EvmBlock,
  watched: Set<string>,
  nativeAsset: string,
): NormalizedTx[] {
  const timestamp = parseInt(block.timestamp, 16);
  const out: NormalizedTx[] = [];
  for (const tx of block.transactions) {
    const to = tx?.to?.toLowerCase();
    if (!to || !watched.has(to) || typeof tx.hash !== "string") continue;
    if (tx.from?.toLowerCase() === to) continue;
    let wei: bigint;
    try {
      wei = BigInt(tx.value);
    } catch {
      continue;
    }
    if (wei === 0n) continue;
    out.push({
      txHash: tx.hash,
      address: to,
      amount: formatUnits(wei, 18),
      asset: nativeAsset,
      timestamp,
    });
  }
  return out;
}

export function parseEvmTokenLogs(
  logs: EvmLog[],
  watched: Set<string>,
  tokens: Map<string, Erc20Token>,
  blockTimestamp: number,
): NormalizedTx[] {
  const sums = new Map<string, { tx: NormalizedTx; raw: bigint; decimals: number }>();
  for (const log of logs) {
    const token = tokens.get(log?.address?.toLowerCase());
    if (!token || log.topics?.[0] !== TRANSFER_TOPIC || typeof log.topics[2] !== "string") continue;
    const to = `0x${log.topics[2].slice(-40)}`.toLowerCase();
    if (!watched.has(to) || typeof log.transactionHash !== "string") continue;
    if (typeof log.topics[1] === "string" && `0x${log.topics[1].slice(-40)}`.toLowerCase() === to)
      continue;
    let raw: bigint;
    try {
      raw = BigInt(log.data);
    } catch {
      continue;
    }
    if (raw === 0n) continue;
    const key = `${log.transactionHash}|${to}|${token.ticker}`;
    const entry = sums.get(key);
    if (entry) {
      entry.raw += raw;
    } else {
      sums.set(key, {
        tx: {
          txHash: log.transactionHash,
          address: to,
          amount: "",
          asset: token.ticker,
          timestamp: blockTimestamp,
        },
        raw,
        decimals: token.decimals,
      });
    }
  }
  return [...sums.values()].map(({ tx, raw, decimals }) => ({
    ...tx,
    amount: formatUnits(raw, decimals),
  }));
}

const toTopic = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;

const REORG_OVERLAP_BLOCKS = 2;

/** keccak256("balanceOf(address)")[0:4] */
const BALANCE_OF_SELECTOR = "0x70a08231";

async function evmRpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RPC ${method} responded HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`RPC ${method} error ${body.error.code}: ${body.error.message}`);
  if (body.result === undefined || body.result === null)
    throw new Error(`RPC ${method} returned no result`);
  return body.result;
}

export interface EvmBalance {
  asset: string;
  raw: bigint;
  decimals: number;
}

/** Native coin balance plus every configured ERC20 token balance for one address. */
export async function fetchEvmBalances(
  rpcUrl: string,
  nativeAsset: string,
  address: string,
  tokens: Erc20Token[],
): Promise<EvmBalance[]> {
  const paddedAddress = `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const [nativeHex, ...tokenResults] = await Promise.all([
    evmRpc<string>(rpcUrl, "eth_getBalance", [address, "latest"]),
    ...tokens.map((token) =>
      evmRpc<string>(rpcUrl, "eth_call", [
        { to: token.address, data: `${BALANCE_OF_SELECTOR}${paddedAddress.slice(2)}` },
        "latest",
      ]),
    ),
  ]);
  const balances: EvmBalance[] = [{ asset: nativeAsset, raw: BigInt(nativeHex), decimals: 18 }];
  tokens.forEach((token, i) => {
    balances.push({ asset: token.ticker, raw: BigInt(tokenResults[i]!), decimals: token.decimals });
  });
  return balances;
}

export interface EvmWatcherConfig {
  chainId: string;
  nativeAsset: string;
  rpcUrl: string;
  tokens: Erc20Token[];
  maxCatchupBlocks: number;
}

export function createEvmPoller(config: EvmWatcherConfig): () => Promise<void> {
  let rpcId = 0;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`RPC ${method} responded HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error)
      throw new Error(`RPC ${method} error ${body.error.code}: ${body.error.message}`);
    if (body.result === undefined || body.result === null)
      throw new Error(`RPC ${method} returned no result`);
    return body.result;
  }

  return async function poll(): Promise<void> {
    const chain = getChain(config.chainId);
    if (!chain) return;

    const head = parseInt(await rpc<string>("eth_blockNumber", []), 16);
    const cursor = getCursor(chain.id);
    if (cursor === null) {
      setCursor(chain.id, head);
      return;
    }
    if (head <= cursor) return;

    let from = Math.max(cursor + 1 - REORG_OVERLAP_BLOCKS, 1);
    const maxCatchup = config.maxCatchupBlocks;
    if (head - cursor > maxCatchup) {
      console.warn(
        `[ingest:${config.chainId}] ${head - cursor} blocks behind, skipping to the last ${maxCatchup}`,
      );
      from = head - maxCatchup + 1;
    }
    if (from > head) return;

    const watched = new Set(listAllWatchedAddresses(chain.id));
    if (watched.size === 0) {
      setCursor(chain.id, head);
      return;
    }

    const tokens = new Map(config.tokens.map((t) => [t.address, t]));
    const watchedTopics = [...watched].map(toTopic);

    for (let n = from; n <= head; n++) {
      const hex = `0x${n.toString(16)}`;
      const block = await rpc<EvmBlock>("eth_getBlockByNumber", [hex, true]);
      const txs = parseEvmBlock(block, watched, config.nativeAsset);

      if (tokens.size > 0) {
        const logs = await rpc<EvmLog[]>("eth_getLogs", [
          {
            fromBlock: hex,
            toBlock: hex,
            address: [...tokens.keys()],
            topics: [TRANSFER_TOPIC, null, watchedTopics],
          },
        ]);
        txs.push(...parseEvmTokenLogs(logs, watched, tokens, parseInt(block.timestamp, 16)));
      }

      await processIncomingTxs(chain, txs);
      setCursor(chain.id, n);
    }
  };
}
