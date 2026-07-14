import { afterAll, describe, expect, test } from "bun:test";

process.env.DATABASE_PATH = ":memory:";
process.env.WATCHERS_ENABLED = "false";

const { connectDb, getDb } = await import("../db/client");
const { buildApp } = await import("../server");
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

describe("PATCH /addresses/:addressId", () => {
  test("renames an address by replacing its label", async () => {
    const { auth } = mintKey();
    const createRes = await app.fetch(
      req("/addresses", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          chain: "bitcoin",
          address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
          label: "before",
        }),
      }),
    );
    const { id } = (await createRes.json()) as { id: string };

    const patchRes = await app.fetch(
      req(`/addresses/${id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ label: "after" }),
      }),
    );
    expect(patchRes.status).toBe(200);
    const updated = (await patchRes.json()) as { label: string | null };
    expect(updated.label).toBe("after");

    const list = (await (await app.fetch(req("/addresses", { headers: auth }))).json()) as {
      addresses: { id: string; label: string | null }[];
    };
    expect(list.addresses.find((a) => a.id === id)!.label).toBe("after");
  });

  test("omitting label clears it", async () => {
    const { auth } = mintKey();
    const createRes = await app.fetch(
      req("/addresses", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          chain: "bitcoin",
          address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
          label: "cold wallet",
        }),
      }),
    );
    const { id } = (await createRes.json()) as { id: string };

    const patchRes = await app.fetch(
      req(`/addresses/${id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({}),
      }),
    );
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { label: string | null }).label).toBeNull();
  });

  test("a label over 100 chars is rejected", async () => {
    const { auth } = mintKey();
    const createRes = await app.fetch(
      req("/addresses", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          chain: "bitcoin",
          address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        }),
      }),
    );
    const { id } = (await createRes.json()) as { id: string };

    const patchRes = await app.fetch(
      req(`/addresses/${id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ label: "x".repeat(101) }),
      }),
    );
    expect(patchRes.status).toBe(400);
  });

  test("unknown address id returns 404", async () => {
    const { auth } = mintKey();
    const patchRes = await app.fetch(
      req("/addresses/does-not-exist", {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ label: "x" }),
      }),
    );
    expect(patchRes.status).toBe(404);
  });

  test("an address owned by another key returns 404", async () => {
    const owner = mintKey();
    const other = mintKey();
    const createRes = await app.fetch(
      req("/addresses", {
        method: "POST",
        headers: owner.auth,
        body: JSON.stringify({
          chain: "bitcoin",
          address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        }),
      }),
    );
    const { id } = (await createRes.json()) as { id: string };

    const patchRes = await app.fetch(
      req(`/addresses/${id}`, {
        method: "PATCH",
        headers: other.auth,
        body: JSON.stringify({ label: "hijacked" }),
      }),
    );
    expect(patchRes.status).toBe(404);
  });
});
