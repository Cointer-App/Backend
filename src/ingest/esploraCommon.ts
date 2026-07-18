import type { NormalizedTx } from "../types";
import { formatUnits } from "./format";

export interface EsploraTx {
  txid: string;
  vin?: { prevout?: { scriptpubkey_address?: string } | null }[];
  vout: { scriptpubkey_address?: string; value: number }[];
  status: { confirmed: boolean; block_time?: number };
}

export function parseEsploraTxs(
  address: string,
  txs: EsploraTx[],
  asset: string,
  decimals: number,
): NormalizedTx[] {
  const out: NormalizedTx[] = [];
  for (const tx of txs) {
    if (typeof tx?.txid !== "string" || !Array.isArray(tx.vout)) continue;
    if (tx.vin?.some((vin) => vin?.prevout?.scriptpubkey_address === address)) continue;
    let units = 0n;
    for (const vout of tx.vout) {
      if (vout?.scriptpubkey_address === address && Number.isSafeInteger(vout.value)) {
        units += BigInt(vout.value);
      }
    }
    if (units === 0n) continue;
    out.push({
      txHash: tx.txid,
      address,
      amount: formatUnits(units, decimals),
      asset,
      timestamp: tx.status?.confirmed ? tx.status.block_time : undefined,
    });
  }
  return out;
}

export class EsploraHttpError extends Error {
  constructor(
    readonly status: number,
    address: string,
  ) {
    super(`Esplora responded ${status} for address ${address}`);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface EsploraAddressStats {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
}

/** Current balance (confirmed + unconfirmed) in base units, from Esplora's per-address summary. */
export async function fetchAddressBalance(
  baseUrl: string,
  address: string,
  logTag: string,
): Promise<bigint | null> {
  const res = await fetch(`${baseUrl}/address/${address}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429 || res.status >= 500) throw new EsploraHttpError(res.status, address);
  if (!res.ok) {
    console.error(`[balances:${logTag}] HTTP ${res.status} for ${address}, skipping`);
    return null;
  }
  let stats: EsploraAddressStats;
  try {
    stats = (await res.json()) as EsploraAddressStats;
  } catch {
    console.error(`[balances:${logTag}] non-JSON response for ${address}, skipping`);
    return null;
  }
  if (!stats.chain_stats || !stats.mempool_stats) return null;
  const funded =
    BigInt(stats.chain_stats.funded_txo_sum) + BigInt(stats.mempool_stats.funded_txo_sum);
  const spent = BigInt(stats.chain_stats.spent_txo_sum) + BigInt(stats.mempool_stats.spent_txo_sum);
  const balance = funded - spent;
  return balance < 0n ? 0n : balance;
}

export async function fetchAddressTxs(
  baseUrl: string,
  address: string,
  logTag: string,
): Promise<EsploraTx[] | null> {
  const res = await fetch(`${baseUrl}/address/${address}/txs`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429 || res.status >= 500) throw new EsploraHttpError(res.status, address);
  if (!res.ok) {
    console.error(`[ingest:${logTag}] HTTP ${res.status} for ${address}, skipping`);
    return null;
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    console.error(`[ingest:${logTag}] non-JSON response for ${address}, skipping`);
    return null;
  }
  return Array.isArray(payload) ? (payload as EsploraTx[]) : null;
}
