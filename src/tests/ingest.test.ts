import { afterAll, describe, expect, test } from "bun:test";

process.env.DATABASE_PATH = ":memory:";
process.env.WATCHERS_ENABLED = "false";

const { connectDb, getDb, now } = await import("../db/client");
const { bitcoin } = await import("../chains/bitcoin");
const { processIncomingTxs } = await import("../services/ingestService");
const { parseEsploraTxs } = await import("../ingest/bitcoinWatcher");
const { parseEthBlock, parseErc20Logs } = await import("../ingest/ethereumWatcher");
const { getCursor, setCursor } = await import("../ingest/state");

connectDb(":memory:");

const ADDR = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

describe("parseEsploraTxs", () => {
  test("sums multiple vouts paying the watched address", () => {
    const txs = parseEsploraTxs(ADDR, [
      {
        txid: "aa11",
        vout: [
          { scriptpubkey_address: ADDR, value: 300_000 },
          { scriptpubkey_address: "bc1qother", value: 999 },
          { scriptpubkey_address: ADDR, value: 200_000 },
        ],
        status: { confirmed: true, block_time: 1_700_000_000 },
      },
    ]);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.amount).toBe("0.005");
    expect(txs[0]!.asset).toBe("BTC");
    expect(txs[0]!.timestamp).toBe(1_700_000_000);
  });

  test("excludes txs that pay the address nothing", () => {
    const txs = parseEsploraTxs(ADDR, [
      {
        txid: "bb22",
        vout: [{ scriptpubkey_address: "bc1qother", value: 5000 }],
        status: { confirmed: true },
      },
    ]);
    expect(txs).toHaveLength(0);
  });

  test("unconfirmed txs carry no timestamp", () => {
    const txs = parseEsploraTxs(ADDR, [
      {
        txid: "cc33",
        vout: [{ scriptpubkey_address: ADDR, value: 1000 }],
        status: { confirmed: false },
      },
    ]);
    expect(txs[0]!.timestamp).toBeUndefined();
  });

  test("tolerates OP_RETURN vouts without an address", () => {
    const txs = parseEsploraTxs(ADDR, [
      {
        txid: "dd44",
        vout: [{ value: 0 }, { scriptpubkey_address: ADDR, value: 2500 }],
        status: { confirmed: true, block_time: 1_700_000_001 },
      },
    ]);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.amount).toBe("0.000025");
  });

  test("excludes self-spends, change back to the watched address is not a donation", () => {
    const txs = parseEsploraTxs(ADDR, [
      {
        txid: "ee55",
        vin: [{ prevout: { scriptpubkey_address: ADDR } }],
        vout: [
          { scriptpubkey_address: "bc1qpayee", value: 50_000 },
          { scriptpubkey_address: ADDR, value: 40_000 },
        ],
        status: { confirmed: true, block_time: 1_700_000_002 },
      },
      {
        txid: "ff66",
        vin: [{ prevout: { scriptpubkey_address: "bc1qdonor" } }, { prevout: null }],
        vout: [{ scriptpubkey_address: ADDR, value: 10_000 }],
        status: { confirmed: true, block_time: 1_700_000_003 },
      },
    ]);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.txHash).toBe("ff66");
  });
});

describe("parseEthBlock", () => {
  const RECIPIENT = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
  const watched = new Set([RECIPIENT]);

  test("matches to-address case-insensitively and converts wei", () => {
    const txs = parseEthBlock(
      {
        timestamp: "0x65a0f000",
        transactions: [
          {
            hash: "0xabc",
            from: "0x00000000000000000000000000000000000000ff",
            to: "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
            value: "0x11c37937e08000",
          },
        ],
      },
      watched,
    );
    expect(txs).toHaveLength(1);
    expect(txs[0]!.address).toBe(RECIPIENT);
    expect(txs[0]!.amount).toBe("0.005");
    expect(txs[0]!.asset).toBe("ETH");
    expect(txs[0]!.timestamp).toBe(0x65a0f000);
  });

  test("skips contract creations, zero values and unwatched recipients", () => {
    const sender = "0x00000000000000000000000000000000000000ff";
    const txs = parseEthBlock(
      {
        timestamp: "0x1",
        transactions: [
          { hash: "0x1", from: sender, to: null, value: "0x1" },
          { hash: "0x2", from: sender, to: RECIPIENT, value: "0x0" },
          {
            hash: "0x3",
            from: sender,
            to: "0x0000000000000000000000000000000000000001",
            value: "0x1",
          },
        ],
      },
      watched,
    );
    expect(txs).toHaveLength(0);
  });

  test("skips self-transfers, a watched address sending to itself is not incoming", () => {
    const txs = parseEthBlock(
      {
        timestamp: "0x1",
        transactions: [
          {
            hash: "0x1",
            from: "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
            to: RECIPIENT,
            value: "0x1",
          },
        ],
      },
      watched,
    );
    expect(txs).toHaveLength(0);
  });
});

describe("parseErc20Logs", () => {
  const RECIPIENT = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
  const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const watched = new Set([RECIPIENT]);
  const tokens = new Map([[USDC, { ticker: "USDC", address: USDC, decimals: 6 }]]);
  const paddedRecipient = `0x000000000000000000000000${RECIPIENT.slice(2)}`;

  test("decodes recipient topic and applies token decimals", () => {
    const txs = parseErc20Logs(
      [
        {
          address: USDC,
          topics: [TRANSFER_TOPIC, "0x0", paddedRecipient],
          data: "0x4c4b40",
          transactionHash: "0xfeed",
        },
      ],
      watched,
      tokens,
      1_700_000_002,
    );
    expect(txs).toHaveLength(1);
    expect(txs[0]!.address).toBe(RECIPIENT);
    expect(txs[0]!.amount).toBe("5");
    expect(txs[0]!.asset).toBe("USDC");
    expect(txs[0]!.timestamp).toBe(1_700_000_002);
  });

  test("sums multiple transfers of the same token in one tx", () => {
    const log = {
      address: USDC,
      topics: [TRANSFER_TOPIC, "0x0", paddedRecipient],
      data: "0x0f4240",
      transactionHash: "0xfeed2",
    };
    const txs = parseErc20Logs([log, { ...log }], watched, tokens, 0);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.amount).toBe("2");
  });

  test("skips self-transfers, sender topic equals recipient topic", () => {
    const txs = parseErc20Logs(
      [
        {
          address: USDC,
          topics: [TRANSFER_TOPIC, paddedRecipient, paddedRecipient],
          data: "0x4c4b40",
          transactionHash: "0xself",
        },
      ],
      watched,
      tokens,
      0,
    );
    expect(txs).toHaveLength(0);
  });

  test("ignores unknown tokens, unwatched recipients and non-Transfer topics", () => {
    const txs = parseErc20Logs(
      [
        {
          address: "0x00000000000000000000000000000000000000aa",
          topics: [TRANSFER_TOPIC, "0x0", paddedRecipient],
          data: "0x1",
          transactionHash: "0x1",
        },
        {
          address: USDC,
          topics: [TRANSFER_TOPIC, "0x0", `0x${"0".repeat(64)}`],
          data: "0x1",
          transactionHash: "0x2",
        },
        {
          address: USDC,
          topics: ["0xdeadbeef", "0x0", paddedRecipient],
          data: "0x1",
          transactionHash: "0x3",
        },
      ],
      watched,
      tokens,
      0,
    );
    expect(txs).toHaveLength(0);
  });
});

describe("per-key created_at history filter", () => {
  const FILTER_ADDR = "bc1qfiltertestaddressxxxxxxxxxxxxxxxxxxxx";
  const insertedKeyIds: string[] = [];

  afterAll(() => {
    for (const id of insertedKeyIds) {
      getDb().run("DELETE FROM personal_keys WHERE id = ?", [id]);
    }
  });

  function insertKeyWatching(createdAt: number): string {
    const keyId = crypto.randomUUID();
    insertedKeyIds.push(keyId);
    const db = getDb();
    db.run(
      "INSERT INTO personal_keys (id, key_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
      [keyId, `hash-${keyId}`, createdAt, createdAt],
    );
    db.run(
      "INSERT INTO addresses (id, personal_key_id, chain, address, label, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
      [crypto.randomUUID(), keyId, "bitcoin", FILTER_ADDR, createdAt],
    );
    return keyId;
  }

  function activityCount(keyId: string): number {
    return getDb()
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM activity WHERE personal_key_id = ?",
      )
      .get(keyId)!.n;
  }

  test("confirmed txs only notify keys that were already watching", async () => {
    const t = now();
    const earlyKey = insertKeyWatching(t - 10_000);
    const lateKey = insertKeyWatching(t - 1_000);

    await processIncomingTxs(bitcoin, [
      {
        txHash: "history01",
        address: FILTER_ADDR,
        amount: "0.1",
        asset: "BTC",
        timestamp: t - 6_000,
      },
    ]);
    expect(activityCount(earlyKey)).toBe(1);
    expect(activityCount(lateKey)).toBe(0);

    await processIncomingTxs(bitcoin, [
      { txHash: "mempool02", address: FILTER_ADDR, amount: "0.2", asset: "BTC" },
    ]);
    expect(activityCount(earlyKey)).toBe(2);
    expect(activityCount(lateKey)).toBe(1);

    await processIncomingTxs(bitcoin, [
      {
        txHash: "grace03",
        address: FILTER_ADDR,
        amount: "0.3",
        asset: "BTC",
        timestamp: t - 1_500,
      },
    ]);
    expect(activityCount(lateKey)).toBe(2);
  });

  test("a fully muted address still records activity, mutes affect delivery only", async () => {
    const t = now();
    const mutedKey = insertKeyWatching(t - 10_000);
    const db = getDb();
    const addressId = db
      .query<{ id: string }, [string]>("SELECT id FROM addresses WHERE personal_key_id = ?")
      .get(mutedKey)!.id;
    const channelId = crypto.randomUUID();
    db.run(
      "INSERT INTO channels (id, personal_key_id, type, config, enabled, created_at) VALUES (?, ?, 'ntfy', ?, 1, ?)",
      [channelId, mutedKey, JSON.stringify({ server: "https://ntfy.sh", topic: "muted" }), t],
    );
    db.run(
      "INSERT INTO address_channel_mutes (address_id, channel_id, created_at) VALUES (?, ?, ?)",
      [addressId, channelId, t],
    );
    db.run("INSERT INTO address_push_mutes (address_id, created_at) VALUES (?, ?)", [addressId, t]);

    await processIncomingTxs(bitcoin, [
      { txHash: "muted05", address: FILTER_ADDR, amount: "0.5", asset: "BTC", timestamp: t - 100 },
    ]);
    expect(activityCount(mutedKey)).toBe(1);
  });

  test("txs older than the ingest window never notify, even long-time watchers", async () => {
    const t = now();
    const ancientKey = insertKeyWatching(t - 9 * 86_400);

    await processIncomingTxs(bitcoin, [
      {
        txHash: "pruned04",
        address: FILTER_ADDR,
        amount: "0.4",
        asset: "BTC",
        timestamp: t - 8 * 86_400,
      },
    ]);
    expect(activityCount(ancientKey)).toBe(0);
  });
});

describe("ingest cursor state", () => {
  test("returns null for an unknown chain", () => {
    expect(getCursor("nope")).toBeNull();
  });

  test("upserts and reads back", () => {
    setCursor("testchain", 123);
    expect(getCursor("testchain")).toBe(123);
    setCursor("testchain", 456);
    expect(getCursor("testchain")).toBe(456);
  });
});
