import { createMiddleware } from "hono/factory";
import { getDb, now } from "../db/client";
import type { AppEnv } from "../types";

export const PERSONAL_KEY_RE = /^ck_[A-Za-z0-9_-]{43}$/;

export function hashPersonalKey(key: string): string {
  return new Bun.CryptoHasher("sha256").update(key).digest("hex");
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing bearer token" }, 401);
  }
  const key = header.slice("Bearer ".length).trim();
  if (!PERSONAL_KEY_RE.test(key)) {
    return c.json({ error: "Invalid personal key" }, 401);
  }

  const row = getDb()
    .query<{ id: string; last_seen_at: number }, [string]>(
      "SELECT id, last_seen_at FROM personal_keys WHERE key_hash = ?",
    )
    .get(hashPersonalKey(key));
  if (!row) {
    return c.json({ error: "Invalid personal key" }, 401);
  }

  const ts = now();
  if (ts - row.last_seen_at > 3600) {
    getDb().run("UPDATE personal_keys SET last_seen_at = ? WHERE id = ?", [ts, row.id]);
  }

  c.set("personalKeyId", row.id);
  await next();
});
