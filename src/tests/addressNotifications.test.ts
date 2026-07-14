import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_PATH = ":memory:";
process.env.WATCHERS_ENABLED = "false";

const { connectDb, getDb } = await import("../db/client");
const { buildApp } = await import("../server");
const { resolveRecipients } = await import("../services/notificationService");
const { createPersonalKey } = await import("../services/personalService");

connectDb(":memory:");
const app = buildApp();

const WATCHED = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

const mintedKeyIds: string[] = [];
function mintKey(): { keyId: string; auth: Record<string, string> } {
  const { id, personalKey } = createPersonalKey();
  mintedKeyIds.push(id);
  return {
    keyId: id,
    auth: { Authorization: `Bearer ${personalKey}`, "content-type": "application/json" },
  };
}

afterAll(() => {
  for (const id of mintedKeyIds) {
    getDb().run("DELETE FROM personal_keys WHERE id = ?", [id]);
  }
});

async function post(path: string, auth: Record<string, string>, body: unknown): Promise<Response> {
  return app.fetch(req(path, { method: "POST", headers: auth, body: JSON.stringify(body) }));
}

async function patchNotifications(
  auth: Record<string, string>,
  addressId: string,
  body: unknown,
): Promise<Response> {
  return app.fetch(
    req(`/addresses/${addressId}/notifications`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify(body),
    }),
  );
}

interface Settings {
  push: { enabled: boolean };
  channels: { id: string; type: string; enabled: boolean; enabledForWallet: boolean }[];
}

async function getSettings(auth: Record<string, string>, addressId: string): Promise<Settings> {
  const res = await app.fetch(req(`/addresses/${addressId}/notifications`, { headers: auth }));
  expect(res.status).toBe(200);
  return (await res.json()) as Settings;
}

let keyId: string;
let auth: Record<string, string>;
let addressId: string;
let ntfyId: string;
let discordId: string;

beforeAll(async () => {
  ({ keyId, auth } = mintKey());

  const addrRes = await post("/addresses", auth, { chain: "bitcoin", address: WATCHED });
  expect(addrRes.status).toBe(201);
  addressId = ((await addrRes.json()) as { id: string }).id;

  const ntfyRes = await post("/channels", auth, { type: "ntfy", config: { topic: "tips" } });
  expect(ntfyRes.status).toBe(201);
  ntfyId = ((await ntfyRes.json()) as { id: string }).id;

  const discordRes = await post("/channels", auth, {
    type: "discord",
    config: { url: "https://discord.com/api/webhooks/123456/token-abc" },
  });
  expect(discordRes.status).toBe(201);
  discordId = ((await discordRes.json()) as { id: string }).id;

  const pushRes = await post("/push-token", auth, {
    token: "ExponentPushToken[abcdefghij1234]",
    platform: "ios",
  });
  expect(pushRes.status).toBe(201);
});

describe("per-wallet notification settings", () => {
  test("defaults: every method enabled for a fresh wallet", async () => {
    const settings = await getSettings(auth, addressId);
    expect(settings.push.enabled).toBe(true);
    expect(settings.channels).toHaveLength(2);
    for (const ch of settings.channels) {
      expect(ch.enabled).toBe(true);
      expect(ch.enabledForWallet).toBe(true);
    }
  });

  test("muting one channel leaves the others and push untouched, and is reversible", async () => {
    const res = await patchNotifications(auth, addressId, { channels: { [discordId]: false } });
    expect(res.status).toBe(200);
    const settings = (await res.json()) as Settings;
    expect(settings.channels.find((c) => c.id === discordId)!.enabledForWallet).toBe(false);
    expect(settings.channels.find((c) => c.id === ntfyId)!.enabledForWallet).toBe(true);
    expect(settings.push.enabled).toBe(true);
    expect(settings.channels.find((c) => c.id === discordId)!.enabled).toBe(true);

    const restore = await patchNotifications(auth, addressId, { channels: { [discordId]: true } });
    expect(restore.status).toBe(200);
    expect(((await restore.json()) as Settings).channels.every((c) => c.enabledForWallet)).toBe(
      true,
    );
    const rows = getDb()
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM address_channel_mutes WHERE address_id = ?",
      )
      .get(addressId)!.n;
    expect(rows).toBe(0);
  });

  test("resolveRecipients honors mutes; no addressId means no filtering", async () => {
    await patchNotifications(auth, addressId, { channels: { [discordId]: false }, push: false });

    const filtered = resolveRecipients(keyId, addressId);
    expect(filtered.channels.map((c) => c.id)).toEqual([ntfyId]);
    expect(filtered.tokens).toHaveLength(0);

    const unfiltered = resolveRecipients(keyId);
    expect(unfiltered.channels).toHaveLength(2);
    expect(unfiltered.tokens).toHaveLength(1);

    const disable = await app.fetch(
      req(`/channels/${ntfyId}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(disable.status).toBe(200);
    expect(resolveRecipients(keyId, addressId).channels).toHaveLength(0);
    await app.fetch(
      req(`/channels/${ntfyId}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ enabled: true }),
      }),
    );

    await patchNotifications(auth, addressId, { channels: { [discordId]: true }, push: true });
  });

  test("a channel added later is enabled by default, even on a wallet with mutes", async () => {
    await patchNotifications(auth, addressId, { channels: { [discordId]: false } });
    const slackRes = await post("/channels", auth, {
      type: "slack",
      config: { url: "https://hooks.slack.com/services/T000/B000/XXXX" },
    });
    expect(slackRes.status).toBe(201);
    const slackId = ((await slackRes.json()) as { id: string }).id;

    const settings = await getSettings(auth, addressId);
    expect(settings.channels.find((c) => c.id === slackId)!.enabledForWallet).toBe(true);
    expect(resolveRecipients(keyId, addressId).channels.map((c) => c.id)).toContain(slackId);

    await app.fetch(req(`/channels/${slackId}`, { method: "DELETE", headers: auth }));
    await patchNotifications(auth, addressId, { channels: { [discordId]: true } });
  });

  test("GET /personal exposes per-wallet mutes", async () => {
    await patchNotifications(auth, addressId, { channels: { [discordId]: false }, push: false });
    const res = await app.fetch(req("/personal", { headers: auth }));
    const config = (await res.json()) as {
      addresses: { id: string; notifications: { pushMuted: boolean; mutedChannelIds: string[] } }[];
    };
    const addr = config.addresses.find((a) => a.id === addressId)!;
    expect(addr.notifications.pushMuted).toBe(true);
    expect(addr.notifications.mutedChannelIds).toEqual([discordId]);
    await patchNotifications(auth, addressId, { channels: { [discordId]: true }, push: true });
  });

  test("deleting a channel or address cascades its mute rows away", async () => {
    const { auth: auth2 } = mintKey();
    const addr2 = (
      (await (await post("/addresses", auth2, { chain: "bitcoin", address: WATCHED })).json()) as {
        id: string;
      }
    ).id;
    const ch2 = (
      (await (
        await post("/channels", auth2, { type: "ntfy", config: { topic: "other" } })
      ).json()) as { id: string }
    ).id;
    await patchNotifications(auth2, addr2, { channels: { [ch2]: false }, push: false });

    const db = getDb();
    const muteCount = (table: string) =>
      db
        .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE address_id = ?`)
        .get(addr2)!.n;
    expect(muteCount("address_channel_mutes")).toBe(1);
    expect(muteCount("address_push_mutes")).toBe(1);

    await app.fetch(req(`/channels/${ch2}`, { method: "DELETE", headers: auth2 }));
    expect(muteCount("address_channel_mutes")).toBe(0);

    await app.fetch(req(`/addresses/${addr2}`, { method: "DELETE", headers: auth2 }));
    expect(muteCount("address_push_mutes")).toBe(0);
  });

  test("validation and ownership failures", async () => {
    const mixed = await patchNotifications(auth, addressId, {
      channels: { [discordId]: false, "00000000-0000-0000-0000-000000000000": false },
    });
    expect(mixed.status).toBe(400);
    const after = await getSettings(auth, addressId);
    expect(after.channels.find((c) => c.id === discordId)!.enabledForWallet).toBe(true);

    expect((await patchNotifications(auth, addressId, { push: "no" })).status).toBe(400);
    expect(
      (await patchNotifications(auth, addressId, { channels: { [discordId]: 0 } })).status,
    ).toBe(400);
    expect((await patchNotifications(auth, addressId, { channels: [discordId] })).status).toBe(400);

    expect((await patchNotifications(auth, addressId, {})).status).toBe(200);

    const { auth: strangerAuth } = mintKey();
    const peek = await app.fetch(
      req(`/addresses/${addressId}/notifications`, { headers: strangerAuth }),
    );
    expect(peek.status).toBe(404);
    const strangerChannel = (
      (await (
        await post("/channels", strangerAuth, { type: "ntfy", config: { topic: "stranger" } })
      ).json()) as { id: string }
    ).id;
    const crossPatch = await patchNotifications(auth, addressId, {
      channels: { [strangerChannel]: false },
    });
    expect(crossPatch.status).toBe(400);

    const anon = await app.fetch(req(`/addresses/${addressId}/notifications`));
    expect(anon.status).toBe(401);
  });
});
