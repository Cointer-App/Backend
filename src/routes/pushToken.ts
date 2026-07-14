import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { perKeyRateLimit } from "../middleware/rateLimit";
import { registerPushToken, removePushToken, ValidationError } from "../services/pushTokenService";
import type { AppEnv } from "../types";

export const pushToken = new Hono<AppEnv>();

pushToken.use("*", requireAuth, perKeyRateLimit);

/**
 * Registers an Expo push token for the authenticated key.
 *
 * @route POST /push-token
 * @param {string} body.token - Expo push token (ExponentPushToken[...]).
 * @param {string} body.platform - Device platform: "ios" or "android".
 * @returns {201} The registered push token record.
 * @returns {400} Invalid JSON body, token, or platform.
 */
pushToken.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    return c.json(registerPushToken(c.get("personalKeyId"), body.token, body.platform), 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/**
 * Removes a registered push token.
 *
 * @route DELETE /push-token/:tokenId
 * @param {string} param.tokenId - Id of a push token owned by the key.
 * @returns {200} Deletion confirmation.
 * @returns {404} Push token not found or owned by another key.
 */
pushToken.delete("/:tokenId", (c) => {
  const removed = removePushToken(c.get("personalKeyId"), c.req.param("tokenId"));
  if (!removed) return c.json({ error: "Push token not found" }, 404);
  return c.json({ deleted: true });
});
