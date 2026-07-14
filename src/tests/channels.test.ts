import { afterAll, describe, expect, test } from "bun:test";

process.env.DATABASE_PATH = ":memory:";
process.env.WATCHERS_ENABLED = "false";

const { connectDb, getDb } = await import("../db/client");
const { buildApp } = await import("../server");
const { createLimiter } = await import("../middleware/rateLimit");
const { createPersonalKey } = await import("../services/personalService");

connectDb(":memory:");
const app = buildApp();

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

describe("PATCH /channels/:channelId", () => {
  test("an invalid config rejects the whole patch, enabled is not left changed", async () => {
    const { auth } = mintKey();
    const createRes = await app.fetch(
      req("/channels", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ type: "ntfy", config: { topic: "tips" } }),
      }),
    );
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };

    const patchRes = await app.fetch(
      req(`/channels/${id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ enabled: false, config: { topic: "bad topic!" } }),
      }),
    );
    expect(patchRes.status).toBe(400);

    const list = (await (await app.fetch(req("/channels", { headers: auth }))).json()) as {
      channels: { id: string; enabled: boolean; config: { topic: string } }[];
    };
    const channel = list.channels.find((c) => c.id === id)!;
    expect(channel.enabled).toBe(true);
    expect(channel.config.topic).toBe("tips");
  });

  test("a valid combined patch applies both fields", async () => {
    const { auth } = mintKey();
    const createRes = await app.fetch(
      req("/channels", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ type: "ntfy", config: { topic: "before" } }),
      }),
    );
    const { id } = (await createRes.json()) as { id: string };

    const patchRes = await app.fetch(
      req(`/channels/${id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ enabled: false, config: { topic: "after" } }),
      }),
    );
    expect(patchRes.status).toBe(200);
    const updated = (await patchRes.json()) as { enabled: boolean; config: { topic: string } };
    expect(updated.enabled).toBe(false);
    expect(updated.config.topic).toBe("after");
  });
});

describe("createLimiter", () => {
  test("allows up to the limit, then rejects with a retry hint until the window resets", () => {
    const limiter = createLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) {
      expect(limiter.check("key").allowed).toBe(true);
    }
    const rejected = limiter.check("key");
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSec).toBeGreaterThan(0);
    expect(limiter.check("other-key").allowed).toBe(true);
  });
});
