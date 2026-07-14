import { describe, expect, test } from "bun:test";

process.env.DATABASE_PATH = ":memory:";
process.env.WATCHERS_ENABLED = "false";

const { connectDb, getDb, now } = await import("../db/client");
const { buildApp } = await import("../server");
const { recordActivity } = await import("../services/activityService");
const { __setPriceForTest } = await import("../prices");

connectDb(":memory:");
const app = buildApp();

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

interface Summary {
  currency: string;
  priceAsOf: number | null;
  windows: Record<string, { count: number; fiatTotal: number; unpricedCount: number }>;
  assets: {
    chain: string;
    asset: string;
    count: number;
    amount: string;
    fiatValue: number | null;
  }[];
}

async function mintKey(): Promise<{ keyId: string; auth: Record<string, string> }> {
  const res = await app.fetch(req("/personal", { method: "POST" }));
  expect(res.status).toBe(201);
  const { personalKey } = (await res.json()) as { personalKey: string };
  const keyId = getDb()
    .query<{ id: string }, []>("SELECT id FROM personal_keys ORDER BY rowid DESC LIMIT 1")
    .get()!.id;
  return { keyId, auth: { Authorization: `Bearer ${personalKey}` } };
}

function backdate(txHash: string, ageSeconds: number): void {
  getDb().run("UPDATE activity SET created_at = ? WHERE tx_hash = ?", [now() - ageSeconds, txHash]);
}

describe("GET /activity/summary", () => {
  test("requires auth", async () => {
    const res = await app.fetch(req("/activity/summary"));
    expect(res.status).toBe(401);
  });

  test("buckets activity into windows and aggregates per asset", async () => {
    const { keyId, auth } = await mintKey();
    const addr = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

    recordActivity(keyId, "bitcoin", addr, "tx-recent", "0.5", "BTC");
    recordActivity(keyId, "bitcoin", addr, "tx-week", "0.25", "BTC");
    backdate("tx-week", 3 * 86_400);
    recordActivity(keyId, "bitcoin", addr, "tx-month", "1", "BTC");
    backdate("tx-month", 20 * 86_400);
    recordActivity(keyId, "ethereum", "0xabc", "tx-eth", "100", "USDC");

    __setPriceForTest("BTC", 100_000);
    __setPriceForTest("USDC", null);
    try {
      const res = await app.fetch(req("/activity/summary", { headers: auth }));
      expect(res.status).toBe(200);
      const summary = (await res.json()) as Summary;

      expect(summary.currency).toBe("usd");
      expect(summary.priceAsOf).not.toBeNull();

      expect(summary.windows["24h"]).toEqual({ count: 2, fiatTotal: 50_000, unpricedCount: 1 });
      expect(summary.windows["7d"]).toEqual({ count: 3, fiatTotal: 75_000, unpricedCount: 1 });
      expect(summary.windows["30d"]).toEqual({ count: 4, fiatTotal: 175_000, unpricedCount: 1 });

      expect(summary.assets).toHaveLength(2);
      const [btc, usdc] = summary.assets;
      expect(btc).toEqual({
        chain: "bitcoin",
        asset: "BTC",
        count: 3,
        amount: "1.75",
        fiatValue: 175_000,
      });
      expect(usdc).toEqual({
        chain: "ethereum",
        asset: "USDC",
        count: 1,
        amount: "100",
        fiatValue: null,
      });
    } finally {
      __setPriceForTest("BTC", null);
    }
  });

  test("returns empty windows for a key with no activity", async () => {
    const { auth } = await mintKey();
    const res = await app.fetch(req("/activity/summary", { headers: auth }));
    const summary = (await res.json()) as Summary;
    expect(summary.priceAsOf).toBeNull();
    expect(summary.windows["30d"]).toEqual({ count: 0, fiatTotal: 0, unpricedCount: 0 });
    expect(summary.assets).toHaveLength(0);
  });
});
