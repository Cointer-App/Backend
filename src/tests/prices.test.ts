import { afterAll, describe, expect, test } from "bun:test";

process.env.DATABASE_PATH = ":memory:";
process.env.WATCHERS_ENABLED = "false";

const { connectDb } = await import("../db/client");
const { buildApp } = await import("../server");
const { bitcoin } = await import("../chains/bitcoin");
const { processIncomingTxs } = await import("../services/ingestService");
const { buildMessage } = await import("../services/notificationService");
const { formatFiat, getPrice, __setPriceForTest } = await import("../prices");

connectDb(":memory:");
const app = buildApp();

const WATCHED = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

afterAll(() => {
  __setPriceForTest("BTC", null);
  const { getDb } = require("../db/client") as typeof import("../db/client");
  getDb().run("DELETE FROM addresses WHERE address = ?", [WATCHED]);
});

describe("formatFiat", () => {
  test("two decimals with thousands separators", () => {
    expect(formatFiat(412.3)).toBe("$412.30");
    expect(formatFiat(1234.567)).toBe("$1,234.57");
  });

  test("zero", () => {
    expect(formatFiat(0)).toBe("$0.00");
  });

  test("dust renders as <$0.01", () => {
    expect(formatFiat(0.0042)).toBe("<$0.01");
  });
});

describe("getPrice", () => {
  test("unknown asset is null", () => {
    expect(getPrice("NOPE")).toBeNull();
  });

  test("seeded price is returned case-insensitively", () => {
    __setPriceForTest("BTC", 100_000);
    expect(getPrice("btc")?.value).toBe(100_000);
    __setPriceForTest("BTC", null);
    expect(getPrice("BTC")).toBeNull();
  });
});

describe("buildMessage fiat clause", () => {
  const event = {
    chain: "bitcoin",
    chainName: "Bitcoin",
    address: WATCHED,
    txHash: "00aa00aa00aa00aa",
    amount: "0.005",
    asset: "BTC",
  };

  test("without a cached price the body is the pre-fiat format", () => {
    __setPriceForTest("BTC", null);
    expect(buildMessage(event).body).toBe(
      "0.005 BTC received at bc1qw508…v8f3t4 (tx 00aa00aa00…) on Bitcoin",
    );
  });

  test("with a cached price the fiat value is appended", () => {
    __setPriceForTest("BTC", 100_000);
    expect(buildMessage(event).body).toBe(
      "0.005 BTC (≈ $500.00) received at bc1qw508…v8f3t4 (tx 00aa00aa00…) on Bitcoin",
    );
    __setPriceForTest("BTC", null);
  });

  test("unparseable amount falls back cleanly", () => {
    __setPriceForTest("BTC", 100_000);
    expect(buildMessage({ ...event, amount: "not-a-number" }).body).toContain(
      "not-a-number BTC received at",
    );
    __setPriceForTest("BTC", null);
  });
});

describe("GET /activity/value", () => {
  test("prices items, totals over all rows, nulls unpriced assets", async () => {
    const mintRes = await app.fetch(req("/personal", { method: "POST" }));
    const { personalKey } = (await mintRes.json()) as { personalKey: string };
    const auth = { Authorization: `Bearer ${personalKey}` };

    await app.fetch(
      req("/addresses", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ chain: "bitcoin", address: WATCHED }),
      }),
    );
    await processIncomingTxs(bitcoin, [
      { txHash: "feed01", address: WATCHED, amount: "0.005", asset: "BTC" },
      { txHash: "feed02", address: WATCHED, amount: "1", asset: "WEIRD" },
    ]);

    type ValueResponse = {
      currency: string;
      priceAsOf: number | null;
      total: number;
      unpricedCount: number;
      items: { asset: string; fiatValue: number | null }[];
      nextCursor: number | null;
    };

    __setPriceForTest("BTC", null);
    const bare = (await (
      await app.fetch(req("/activity/value", { headers: auth }))
    ).json()) as ValueResponse;
    expect(bare.total).toBe(0);
    expect(bare.priceAsOf).toBeNull();
    expect(bare.unpricedCount).toBe(2);
    expect(bare.items.every((i) => i.fiatValue === null)).toBe(true);

    __setPriceForTest("BTC", 100_000);
    const priced = (await (
      await app.fetch(req("/activity/value", { headers: auth }))
    ).json()) as ValueResponse;
    expect(priced.currency).toBe("usd");
    expect(priced.total).toBe(500);
    expect(priced.unpricedCount).toBe(1);
    expect(priced.priceAsOf).not.toBeNull();
    expect(priced.items.find((i) => i.asset === "BTC")?.fiatValue).toBe(500);
    expect(priced.items.find((i) => i.asset === "WEIRD")?.fiatValue).toBeNull();

    const paged = (await (
      await app.fetch(req("/activity/value?limit=1", { headers: auth }))
    ).json()) as ValueResponse;
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBe(500);
    expect(paged.nextCursor).not.toBeNull();

    __setPriceForTest("BTC", null);
  });
});
