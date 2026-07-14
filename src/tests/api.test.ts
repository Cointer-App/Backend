import { describe, expect, test } from "bun:test";

process.env.DATABASE_PATH = ":memory:";
process.env.WATCHERS_ENABLED = "false";

const { connectDb } = await import("../db/client");
const { buildApp } = await import("../server");
const { bitcoin } = await import("../chains/bitcoin");
const { processIncomingTxs } = await import("../services/ingestService");

connectDb(":memory:");
const app = buildApp();

const WATCHED = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

describe("GET /capabilities", () => {
  test("exposes server config without auth", async () => {
    const res = await app.fetch(req("/capabilities"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: false,
      currency: "usd",
      limits: {
        maxAddressesPerKey: 10,
        maxChannelsPerKey: 10,
        maxPushTokensPerKey: 10,
        activityRetentionDays: 90,
      },
    });
  });
});

describe("end-to-end ingestion flow", () => {
  test("mint key → watch address → ingest tx → activity, deduped on redelivery", async () => {
    const mintRes = await app.fetch(req("/personal", { method: "POST" }));
    expect(mintRes.status).toBe(201);
    const { personalKey } = (await mintRes.json()) as { personalKey: string };
    const auth = { Authorization: `Bearer ${personalKey}` };

    const addRes = await app.fetch(
      req("/addresses", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ chain: "bitcoin", address: WATCHED.toUpperCase(), label: "tips" }),
      }),
    );
    expect(addRes.status).toBe(201);
    const created = (await addRes.json()) as { address: string };
    expect(created.address).toBe(WATCHED);

    const tx = { txHash: "deadbeef01", address: WATCHED, amount: "0.005", asset: "BTC" };
    await processIncomingTxs(bitcoin, [tx]);

    const actRes = await app.fetch(req("/activity", { headers: auth }));
    const activity = (await actRes.json()) as { items: { txHash: string; amount: string }[] };
    expect(activity.items).toHaveLength(1);
    expect(activity.items[0]!.txHash).toBe("deadbeef01");
    expect(activity.items[0]!.amount).toBe("0.005");

    await processIncomingTxs(bitcoin, [tx]);
    const actRes2 = await app.fetch(req("/activity", { headers: auth }));
    expect(((await actRes2.json()) as { items: unknown[] }).items).toHaveLength(1);

    await processIncomingTxs(bitcoin, [
      {
        txHash: "cafe02",
        address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        amount: "1",
        asset: "BTC",
      },
    ]);
    const actRes3 = await app.fetch(req("/activity", { headers: auth }));
    expect(((await actRes3.json()) as { items: unknown[] }).items).toHaveLength(1);

    const list = (await (await app.fetch(req("/addresses", { headers: auth }))).json()) as {
      addresses: { id: string }[];
    };
    const delRes = await app.fetch(
      req(`/addresses/${list.addresses[0]!.id}`, { method: "DELETE", headers: auth }),
    );
    expect(delRes.status).toBe(200);
    const stats = (await (await app.fetch(req("/stats/wallets"))).json()) as {
      watchedWallets: number;
    };
    expect(stats.watchedWallets).toBe(0);
  });
});
