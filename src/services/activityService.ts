import { env } from "../config/env";
import { getDb, now } from "../db/client";
import { getPrice } from "../prices";
import type { ActivityRow } from "../types";
import { ValidationError } from "./pushTokenService";

const MAX_PAGE_SIZE = 100;

export function listActivity(personalKeyId: string, limitRaw?: string, cursorRaw?: string) {
  let limit = Number(limitRaw ?? 25);
  if (!Number.isInteger(limit) || limit < 1) limit = 25;
  if (limit > MAX_PAGE_SIZE) limit = MAX_PAGE_SIZE;

  const cursor = cursorRaw !== undefined ? Number(cursorRaw) : null;
  const db = getDb();

  const rows =
    cursor !== null && Number.isInteger(cursor)
      ? db
          .query<ActivityRow, [string, number, number]>(
            "SELECT * FROM activity WHERE personal_key_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
          )
          .all(personalKeyId, cursor, limit)
      : db
          .query<ActivityRow, [string, number]>(
            "SELECT * FROM activity WHERE personal_key_id = ? ORDER BY id DESC LIMIT ?",
          )
          .all(personalKeyId, limit);

  const last = rows[rows.length - 1];
  return {
    items: rows.map((r) => ({
      id: r.id,
      chain: r.chain,
      address: r.address,
      txHash: r.tx_hash,
      amount: r.amount,
      asset: r.asset,
      createdAt: r.created_at,
    })),
    nextCursor: rows.length === limit && last ? last.id : null,
  };
}

function fiatValueOf(amount: string, asset: string): { value: number; fetchedAt: number } | null {
  const quote = getPrice(asset);
  if (!quote) return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return null;
  const value = n * quote.value;
  return Number.isFinite(value) ? { value, fetchedAt: quote.fetchedAt } : null;
}

export function getWalletValue(personalKeyId: string, limitRaw?: string, cursorRaw?: string) {
  const page = listActivity(personalKeyId, limitRaw, cursorRaw);

  const allRows = getDb()
    .query<{ amount: string; asset: string }, [string]>(
      "SELECT amount, asset FROM activity WHERE personal_key_id = ?",
    )
    .all(personalKeyId);

  let total = 0;
  let unpricedCount = 0;
  let priceAsOf: number | null = null;
  for (const row of allRows) {
    const fiat = fiatValueOf(row.amount, row.asset);
    if (fiat === null) {
      unpricedCount++;
      continue;
    }
    total += fiat.value;
    priceAsOf = priceAsOf === null ? fiat.fetchedAt : Math.min(priceAsOf, fiat.fetchedAt);
  }

  return {
    currency: env.prices.currency,
    priceAsOf: priceAsOf === null ? null : Math.floor(priceAsOf / 1000),
    total: Math.round(total * 100) / 100,
    unpricedCount,
    items: page.items.map((item) => {
      const fiat = fiatValueOf(item.amount, item.asset);
      return { ...item, fiatValue: fiat === null ? null : Math.round(fiat.value * 100) / 100 };
    }),
    nextCursor: page.nextCursor,
  };
}

const SUMMARY_WINDOWS = { "24h": 86_400, "7d": 604_800, "30d": 2_592_000 } as const;

export function getActivitySummary(personalKeyId: string) {
  const rows = getDb()
    .query<{ chain: string; asset: string; amount: string; created_at: number }, [string]>(
      "SELECT chain, asset, amount, created_at FROM activity WHERE personal_key_id = ?",
    )
    .all(personalKeyId);

  const nowSec = now();
  const windows: Record<string, { count: number; fiatTotal: number; unpricedCount: number }> = {};
  for (const key of Object.keys(SUMMARY_WINDOWS)) {
    windows[key] = { count: 0, fiatTotal: 0, unpricedCount: 0 };
  }

  // Amounts are summed as Number, so totals are display precision only.
  const assets = new Map<
    string,
    { chain: string; asset: string; count: number; amount: number; fiatValue: number | null }
  >();
  let priceAsOf: number | null = null;

  for (const row of rows) {
    const fiat = fiatValueOf(row.amount, row.asset);
    if (fiat !== null) {
      priceAsOf = priceAsOf === null ? fiat.fetchedAt : Math.min(priceAsOf, fiat.fetchedAt);
    }

    for (const [key, seconds] of Object.entries(SUMMARY_WINDOWS)) {
      if (row.created_at < nowSec - seconds) continue;
      const window = windows[key]!;
      window.count++;
      if (fiat === null) window.unpricedCount++;
      else window.fiatTotal += fiat.value;
    }

    const assetKey = `${row.chain}:${row.asset}`;
    let entry = assets.get(assetKey);
    if (!entry) {
      entry = { chain: row.chain, asset: row.asset, count: 0, amount: 0, fiatValue: 0 };
      assets.set(assetKey, entry);
    }
    entry.count++;
    entry.amount += Number(row.amount);
    if (fiat === null) entry.fiatValue = null;
    else if (entry.fiatValue !== null) entry.fiatValue += fiat.value;
  }

  for (const window of Object.values(windows)) {
    window.fiatTotal = Math.round(window.fiatTotal * 100) / 100;
  }

  return {
    currency: env.prices.currency,
    priceAsOf: priceAsOf === null ? null : Math.floor(priceAsOf / 1000),
    windows,
    assets: [...assets.values()]
      .map((entry) => ({
        ...entry,
        amount: String(entry.amount),
        fiatValue: entry.fiatValue === null ? null : Math.round(entry.fiatValue * 100) / 100,
      }))
      .sort((a, b) => (b.fiatValue ?? -1) - (a.fiatValue ?? -1)),
  };
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function getMonthlyActivity(personalKeyId: string, monthRaw?: string) {
  let month: string;
  if (monthRaw === undefined) {
    const d = new Date(now() * 1000);
    month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  } else {
    if (!MONTH_PATTERN.test(monthRaw)) {
      throw new ValidationError("month must be in YYYY-MM format");
    }
    month = monthRaw;
  }

  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5)) - 1;
  const start = Date.UTC(year, monthIndex, 1) / 1000;
  const end = Date.UTC(year, monthIndex + 1, 1) / 1000;

  const rows = getDb()
    .query<{ chain: string; asset: string; amount: string }, [string, number, number]>(
      "SELECT chain, asset, amount FROM activity WHERE personal_key_id = ? AND created_at >= ? AND created_at < ?",
    )
    .all(personalKeyId, start, end);

  let fiatTotal = 0;
  let unpricedCount = 0;
  let priceAsOf: number | null = null;

  // Amounts are summed as Number, so totals are display precision only.
  const assets = new Map<
    string,
    { chain: string; asset: string; count: number; amount: number; fiatValue: number | null }
  >();

  for (const row of rows) {
    const fiat = fiatValueOf(row.amount, row.asset);
    if (fiat === null) {
      unpricedCount++;
    } else {
      fiatTotal += fiat.value;
      priceAsOf = priceAsOf === null ? fiat.fetchedAt : Math.min(priceAsOf, fiat.fetchedAt);
    }

    const assetKey = `${row.chain}:${row.asset}`;
    let entry = assets.get(assetKey);
    if (!entry) {
      entry = { chain: row.chain, asset: row.asset, count: 0, amount: 0, fiatValue: 0 };
      assets.set(assetKey, entry);
    }
    entry.count++;
    entry.amount += Number(row.amount);
    if (fiat === null) entry.fiatValue = null;
    else if (entry.fiatValue !== null) entry.fiatValue += fiat.value;
  }

  return {
    month,
    currency: env.prices.currency,
    priceAsOf: priceAsOf === null ? null : Math.floor(priceAsOf / 1000),
    count: rows.length,
    fiatTotal: Math.round(fiatTotal * 100) / 100,
    unpricedCount,
    assets: [...assets.values()]
      .map((entry) => ({
        ...entry,
        amount: String(entry.amount),
        fiatValue: entry.fiatValue === null ? null : Math.round(entry.fiatValue * 100) / 100,
      }))
      .sort((a, b) => (b.fiatValue ?? -1) - (a.fiatValue ?? -1)),
  };
}

export function recordActivity(
  personalKeyId: string,
  chain: string,
  address: string,
  txHash: string,
  amount: string,
  asset: string,
): boolean {
  const res = getDb().run(
    `INSERT OR IGNORE INTO activity (personal_key_id, chain, address, tx_hash, amount, asset, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [personalKeyId, chain, address, txHash, amount, asset, now()],
  );
  return res.changes > 0;
}

export function pruneOldActivity(): void {
  const cutoff = now() - env.limits.activityRetentionDays * 86_400;
  const res = getDb().run("DELETE FROM activity WHERE created_at < ?", [cutoff]);
  if (res.changes > 0) console.log(`[retention] pruned ${res.changes} activity rows`);
}

export function countWatchedWallets(): number {
  return getDb()
    .query<{ n: number }, []>("SELECT COUNT(DISTINCT chain || ':' || address) AS n FROM addresses")
    .get()!.n;
}
