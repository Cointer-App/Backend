import { env } from "../config/env";
import { getDb, now } from "../db/client";
import type { PushTokenRow } from "../types";

const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,64}\]$/;
const PLATFORMS = new Set(["ios", "android"]);

export class ValidationError extends Error {}

export function listPushTokens(personalKeyId: string) {
  const rows = getDb()
    .query<PushTokenRow, [string]>(
      "SELECT * FROM push_tokens WHERE personal_key_id = ? ORDER BY created_at",
    )
    .all(personalKeyId);
  return rows.map((r) => ({
    id: r.id,
    token: r.token,
    platform: r.platform,
    createdAt: r.created_at,
  }));
}

export function registerPushToken(personalKeyId: string, token: unknown, platform: unknown) {
  if (typeof token !== "string" || !EXPO_TOKEN_RE.test(token)) {
    throw new ValidationError("token must be an Expo push token (ExponentPushToken[...])");
  }
  if (typeof platform !== "string" || !PLATFORMS.has(platform)) {
    throw new ValidationError('platform must be "ios" or "android"');
  }

  const db = getDb();
  const existing = db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM push_tokens WHERE personal_key_id = ? AND token = ?",
    )
    .get(personalKeyId, token);
  if (existing) return { id: existing.id, token, platform };

  const count = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM push_tokens WHERE personal_key_id = ?",
    )
    .get(personalKeyId)!.n;
  if (count >= env.limits.maxPushTokensPerKey) {
    throw new ValidationError(`Push token limit reached (${env.limits.maxPushTokensPerKey})`);
  }

  const id = crypto.randomUUID();
  db.run(
    "INSERT INTO push_tokens (id, personal_key_id, token, platform, created_at) VALUES (?, ?, ?, ?, ?)",
    [id, personalKeyId, token, platform, now()],
  );
  return { id, token, platform };
}

export function removePushToken(personalKeyId: string, tokenId: string): boolean {
  const res = getDb().run("DELETE FROM push_tokens WHERE id = ? AND personal_key_id = ?", [
    tokenId,
    personalKeyId,
  ]);
  return res.changes > 0;
}

export function removeDeadToken(token: string): void {
  getDb().run("DELETE FROM push_tokens WHERE token = ?", [token]);
}
