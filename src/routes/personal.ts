import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { keyMintRateLimit, perKeyRateLimit } from "../middleware/rateLimit";
import {
  createPersonalKey,
  deletePersonalKey,
  getPersonalConfig,
  rotatePersonalKey,
} from "../services/personalService";
import type { AppEnv } from "../types";

export const personal = new Hono<AppEnv>();

/**
 * Mints a new personal key. Unauthenticated, but guarded by a strict
 * key-mint rate limit. The key is returned exactly once; only its hash
 * is stored server-side.
 *
 * @route POST /personal
 * @returns {201} The freshly minted personal key.
 */
personal.post("/", keyMintRateLimit, (c) => {
  const { personalKey } = createPersonalKey();
  return c.json({ personalKey }, 201);
});

/**
 * Returns the full account configuration (addresses, channels, push tokens)
 * for the restore/sync flow. Never includes the key itself. Requires
 * authentication.
 *
 * @route GET /personal
 * @returns {200} The account configuration.
 */
personal.get("/", requireAuth, perKeyRateLimit, (c) => {
  return c.json(getPersonalConfig(c.get("personalKeyId")));
});

/**
 * Issues a fresh personal key for the same account; the old key stops
 * working immediately. Requires authentication.
 *
 * @route POST /personal/rotate
 * @returns {200} The replacement personal key.
 */
personal.post("/rotate", requireAuth, perKeyRateLimit, (c) => {
  const personalKey = rotatePersonalKey(c.get("personalKeyId"));
  return c.json({ personalKey });
});

/**
 * Deletes the personal key and everything under it (addresses, channels,
 * push tokens, activity). Requires authentication.
 *
 * @route DELETE /personal
 * @returns {200} Deletion confirmation.
 */
personal.delete("/", requireAuth, perKeyRateLimit, (c) => {
  deletePersonalKey(c.get("personalKeyId"));
  return c.json({ deleted: true });
});
