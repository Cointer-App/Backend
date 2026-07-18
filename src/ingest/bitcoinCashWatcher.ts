import { getChain } from "../chains";
import { env } from "../config/env";
import { recordActivity } from "../services/activityService";
import { listAllWatchedAddresses } from "../services/addressService";
import { processIncomingTxs } from "../services/ingestService";
import type { NormalizedTx } from "../types";
import { sleep } from "./esploraCommon";
import { formatUnits } from "./format";

interface BlockchairAddressData {
  address?: { balance?: number };
  transactions?: {
    block_id: number;
    transaction_hash?: string;
    hash?: string;
    time: string;
    balance_change: number;
  }[];
}

interface BlockchairAddressResponse {
  data?: Record<string, BlockchairAddressData>;
  context?: { code?: number; error?: string };
}

export function parseBlockchairTxs(
  address: string,
  entries: NonNullable<BlockchairAddressData["transactions"]>,
): NormalizedTx[] {
  const out: NormalizedTx[] = [];
  for (const entry of entries) {
    const txHash = entry.transaction_hash ?? entry.hash;
    if (!txHash || entry.balance_change <= 0) continue;
    out.push({
      txHash,
      address,
      amount: formatUnits(BigInt(entry.balance_change), 8),
      asset: "BCH",
      timestamp:
        entry.block_id > 0 ? Math.floor(new Date(`${entry.time}Z`).getTime() / 1000) : undefined,
    });
  }
  return out;
}

class BlockchairHttpError extends Error {
  constructor(
    readonly status: number,
    address: string,
  ) {
    super(`Blockchair responded ${status} for address ${address}`);
  }
}

async function fetchBlockchairAddress(address: string): Promise<BlockchairAddressData | null> {
  const apiKeyParam = env.ingest.bitcoinCashExplorerApiKey
    ? `&key=${env.ingest.bitcoinCashExplorerApiKey}`
    : "";
  const res = await fetch(
    `${env.ingest.bitcoinCashExplorerUrl}/dashboards/address/${address}?transaction_details=true&limit=50${apiKeyParam}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (res.status === 429 || res.status >= 500) throw new BlockchairHttpError(res.status, address);
  if (!res.ok) {
    console.error(`[ingest:bitcoin-cash] HTTP ${res.status} for ${address}, skipping`);
    return null;
  }
  let payload: BlockchairAddressResponse;
  try {
    payload = (await res.json()) as BlockchairAddressResponse;
  } catch {
    console.error(`[ingest:bitcoin-cash] non-JSON response for ${address}, skipping`);
    return null;
  }
  if (payload.context?.code && payload.context.code !== 200) {
    console.error(
      `[ingest:bitcoin-cash] API error for ${address}: ${payload.context.error ?? payload.context.code}`,
    );
    return null;
  }
  return payload.data?.[address] ?? null;
}

async function fetchAddressTxs(address: string): Promise<NormalizedTx[] | null> {
  const data = await fetchBlockchairAddress(address);
  const entries = data?.transactions;
  if (!entries) return null;
  return parseBlockchairTxs(address, entries);
}

/** Current confirmed balance in satoshis, from Blockchair's per-address summary. */
export async function fetchBitcoinCashBalance(address: string): Promise<bigint | null> {
  const data = await fetchBlockchairAddress(address);
  const balance = data?.address?.balance;
  return typeof balance === "number" ? BigInt(balance) : null;
}

export async function seedBitcoinCashAddress(
  personalKeyId: string,
  address: string,
): Promise<void> {
  const txs = await fetchAddressTxs(address);
  if (!txs) return;
  for (const tx of txs) {
    recordActivity(personalKeyId, "bitcoin-cash", tx.address, tx.txHash, tx.amount, tx.asset);
  }
}

export async function pollBitcoinCash(): Promise<void> {
  const chain = getChain("bitcoin-cash");
  if (!chain) return;

  const addresses = listAllWatchedAddresses(chain.id);
  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i]!;
    if (i > 0) await sleep(env.ingest.bitcoinCashAddressGapMs);

    const txs = await fetchAddressTxs(address);
    if (!txs) continue;
    await processIncomingTxs(chain, txs);
  }
}
