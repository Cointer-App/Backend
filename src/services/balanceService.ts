import { env } from "../config/env";
import { getDb } from "../db/client";
import { getPrice } from "../prices";
import type { AddressRow } from "../types";

interface AssetBalance {
  asset: string;
  amount: string;
  fiatValue: number | null;
}

export interface WalletBalance {
  id: string;
  chain: string;
  address: string;
  label: string | null;
  /** True for chains where this reflects lifetime received, not a live spendable balance (Monero). */
  approximate: boolean;
  assets: AssetBalance[];
  fiatValue: number | null;
}

interface CacheEntry {
  assets: { asset: string; amount: string }[];
  fetchedAt: number;
}

/**
 * Populated by the background balance poller (see ingest/balancePoller.ts),
 * keyed by "chain:address". Requests never fetch live — they only read this
 * cache, so GET /wallets/value stays as fast as any other DB-backed route
 * instead of paying the cost of a live RPC/explorer call per chain per
 * request.
 */
const balanceCache = new Map<string, CacheEntry>();

export function cacheKeyFor(chain: string, address: string): string {
  return `${chain}:${address}`;
}

export function setCachedBalance(
  chain: string,
  address: string,
  assets: { asset: string; amount: string }[],
): void {
  balanceCache.set(cacheKeyFor(chain, address), { assets, fetchedAt: Date.now() });
}

export function getCachedBalance(chain: string, address: string): CacheEntry | null {
  return balanceCache.get(cacheKeyFor(chain, address)) ?? null;
}

function priceAsset(
  asset: string,
  amount: string,
): { value: number | null; fetchedAt: number | null } {
  const quote = getPrice(asset);
  if (!quote) return { value: null, fetchedAt: null };
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return { value: null, fetchedAt: null };
  const value = n * quote.value;
  return Number.isFinite(value)
    ? { value: Math.round(value * 100) / 100, fetchedAt: quote.fetchedAt }
    : { value: null, fetchedAt: null };
}

export function getWalletBalances(personalKeyId: string): {
  currency: string;
  priceAsOf: number | null;
  total: number;
  wallets: WalletBalance[];
} {
  const addresses = getDb()
    .query<AddressRow, [string]>(
      "SELECT * FROM addresses WHERE personal_key_id = ? ORDER BY created_at",
    )
    .all(personalKeyId);

  let total = 0;
  let priceAsOf: number | null = null;

  const wallets = addresses.map((row): WalletBalance => {
    const cached = getCachedBalance(row.chain, row.address);
    const approximate = row.chain === "monero";

    let walletFiat: number | null = 0;
    const assets: AssetBalance[] = (cached?.assets ?? [])
      .filter((a) => Number(a.amount) > 0)
      .map((a) => {
        const priced = priceAsset(a.asset, a.amount);
        if (priced.value === null) walletFiat = null;
        else if (walletFiat !== null) walletFiat += priced.value;
        if (priced.fetchedAt !== null) {
          priceAsOf = priceAsOf === null ? priced.fetchedAt : Math.min(priceAsOf, priced.fetchedAt);
        }
        return { asset: a.asset, amount: a.amount, fiatValue: priced.value };
      });

    if (walletFiat !== null) total += walletFiat;

    return {
      id: row.id,
      chain: row.chain,
      address: row.address,
      label: row.label,
      approximate,
      assets,
      fiatValue: walletFiat === null ? null : Math.round(walletFiat * 100) / 100,
    };
  });

  return {
    currency: env.prices.currency,
    priceAsOf: priceAsOf === null ? null : Math.floor(priceAsOf / 1000),
    total: Math.round(total * 100) / 100,
    wallets,
  };
}
