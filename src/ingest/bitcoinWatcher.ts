import { getChain } from "../chains";
import { env } from "../config/env";
import { recordActivity } from "../services/activityService";
import { listAllWatchedAddresses } from "../services/addressService";
import { processIncomingTxs } from "../services/ingestService";
import type { NormalizedTx } from "../types";
import { formatUnits } from "./format";

export interface EsploraTx {
  txid: string;
  vin?: { prevout?: { scriptpubkey_address?: string } | null }[];
  vout: { scriptpubkey_address?: string; value: number }[];
  status: { confirmed: boolean; block_time?: number };
}

export function parseEsploraTxs(address: string, txs: EsploraTx[]): NormalizedTx[] {
  const out: NormalizedTx[] = [];
  for (const tx of txs) {
    if (typeof tx?.txid !== "string" || !Array.isArray(tx.vout)) continue;
    if (tx.vin?.some((vin) => vin?.prevout?.scriptpubkey_address === address)) continue;
    let sats = 0n;
    for (const vout of tx.vout) {
      if (vout?.scriptpubkey_address === address && Number.isSafeInteger(vout.value)) {
        sats += BigInt(vout.value);
      }
    }
    if (sats === 0n) continue;
    out.push({
      txHash: tx.txid,
      address,
      amount: formatUnits(sats, 8),
      asset: "BTC",
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchAddressTxs(address: string): Promise<EsploraTx[] | null> {
  const res = await fetch(`${env.ingest.bitcoinEsploraUrl}/address/${address}/txs`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429 || res.status >= 500) throw new EsploraHttpError(res.status, address);
  if (!res.ok) {
    console.error(`[ingest:bitcoin] HTTP ${res.status} for ${address}, skipping`);
    return null;
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    console.error(`[ingest:bitcoin] non-JSON response for ${address}, skipping`);
    return null;
  }
  return Array.isArray(payload) ? (payload as EsploraTx[]) : null;
}

export async function seedBitcoinAddress(personalKeyId: string, address: string): Promise<void> {
  const txs = await fetchAddressTxs(address);
  if (!txs) return;
  for (const tx of parseEsploraTxs(address, txs)) {
    recordActivity(personalKeyId, "bitcoin", tx.address, tx.txHash, tx.amount, tx.asset);
  }
}

export async function pollBitcoin(): Promise<void> {
  const chain = getChain("bitcoin");
  if (!chain) return;

  const addresses = listAllWatchedAddresses(chain.id);
  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i]!;
    if (i > 0) await sleep(env.ingest.bitcoinAddressGapMs);

    const txs = await fetchAddressTxs(address);
    if (!txs) continue;
    await processIncomingTxs(chain, parseEsploraTxs(address, txs));
  }
}
