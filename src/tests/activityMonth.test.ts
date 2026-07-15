import { afterAll, describe, expect, test } from "bun:test";

process.env.DATABASE_PATH = ":memory:";
process.env.WATCHERS_ENABLED = "false";

const { connectDb, getDb } = await import("../db/client");
const { buildApp } = await import("../server");
const { recordActivity } = await import("../services/activityService");
const { createPersonalKey } = await import("../services/personalService");
const { __setPriceForTest } = await import("../prices");

connectDb(":memory:");
const app = buildApp();

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

interface MonthTotals {
  month: string;
  currency: string;
  priceAsOf: number | null;
  count: number;
  fiatTotal: number;
  unpricedCount: number;
  assets: {
    chain: string;
    asset: string;
    count: number;
    amount: string;
    fiatValue: number | null;
  }[];
}

const mintedKeyIds: string[] = [];
function mintKey(): { keyId: string; auth: Record<string, string> } {
  const { id, personalKey } = createPersonalKey();
  mintedKeyIds.push(id);
  return { keyId: id, auth: { Authorization: `Bearer ${personalKey}` } };
}

afterAll(() => {
  for (const id of mintedKeyIds) {
    getDb().run("DELETE FROM personal_keys WHERE id = ?", [id]);
  }
});

function setCreatedAt(txHash: string, timestamp: number): void {
  getDb().run("UPDATE activity SET created_at = ? WHERE tx_hash = ?", [timestamp, txHash]);
}

function monthString(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

describe("GET /activity/month", () => {
  test("requires auth", async () => {
    const res = await app.fetch(req("/activity/month"));
    expect(res.status).toBe(401);
  });

  test("rejects a bad month format", async () => {
    const { auth } = mintKey();
    for (const bad of ["2026", "2026-7", "2026-13", "07-2026", "garbage"]) {
      const res = await app.fetch(req(`/activity/month?month=${bad}`, { headers: auth }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "month must be in YYYY-MM format" });
    }
  });

  test("totals only the requested month and defaults to the current month", async () => {
    const { keyId, auth } = mintKey();
    const addr = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

    const nowDate = new Date();
    const thisMonth = monthString(nowDate);
    const prevDate = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - 1, 15));
    const prevMonth = monthString(prevDate);

    recordActivity(keyId, "bitcoin", addr, "tx-this-month", "0.5", "BTC");
    recordActivity(keyId, "ethereum", "0xabc", "tx-this-month-eth", "100", "USDC");
    recordActivity(keyId, "bitcoin", addr, "tx-prev-month", "1", "BTC");
    setCreatedAt("tx-prev-month", Math.floor(prevDate.getTime() / 1000));

    __setPriceForTest("BTC", 100_000);
    __setPriceForTest("USDC", null);
    try {
      const current = await app.fetch(req("/activity/month", { headers: auth }));
      expect(current.status).toBe(200);
      const totals = (await current.json()) as MonthTotals;

      expect(totals.month).toBe(thisMonth);
      expect(totals.currency).toBe("usd");
      expect(totals.count).toBe(2);
      expect(totals.fiatTotal).toBe(50_000);
      expect(totals.unpricedCount).toBe(1);
      expect(totals.assets).toEqual([
        { chain: "bitcoin", asset: "BTC", count: 1, amount: "0.5", fiatValue: 50_000 },
        { chain: "ethereum", asset: "USDC", count: 1, amount: "100", fiatValue: null },
      ]);

      const previous = await app.fetch(
        req(`/activity/month?month=${prevMonth}`, { headers: auth }),
      );
      expect(previous.status).toBe(200);
      const prevTotals = (await previous.json()) as MonthTotals;

      expect(prevTotals.month).toBe(prevMonth);
      expect(prevTotals.count).toBe(1);
      expect(prevTotals.fiatTotal).toBe(100_000);
      expect(prevTotals.unpricedCount).toBe(0);
    } finally {
      __setPriceForTest("BTC", null);
    }
  });

  test("returns zeros for a month with no activity", async () => {
    const { auth } = mintKey();
    const res = await app.fetch(req("/activity/month?month=2020-01", { headers: auth }));
    expect(res.status).toBe(200);
    const totals = (await res.json()) as MonthTotals;
    expect(totals.month).toBe("2020-01");
    expect(totals.count).toBe(0);
    expect(totals.fiatTotal).toBe(0);
    expect(totals.unpricedCount).toBe(0);
    expect(totals.priceAsOf).toBeNull();
    expect(totals.assets).toHaveLength(0);
  });
});
