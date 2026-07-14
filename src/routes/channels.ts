import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { channelTestRateLimit, perKeyRateLimit } from "../middleware/rateLimit";
import {
  addChannel,
  getChannel,
  listChannels,
  removeChannel,
  updateChannel,
} from "../services/channelService";
import { sendToChannel } from "../services/notificationService";
import { ValidationError } from "../services/pushTokenService";
import type { AppEnv } from "../types";

export const channels = new Hono<AppEnv>();

channels.use("*", requireAuth, perKeyRateLimit);

/**
 * Lists every notification channel of the authenticated key. Secret config
 * values (e.g. webhook URLs) are returned as previews only.
 *
 * @route GET /channels
 * @returns {200} The configured channels.
 */
channels.get("/", (c) => {
  return c.json({ channels: listChannels(c.get("personalKeyId")) });
});

/**
 * Creates a notification channel for the authenticated key.
 *
 * @route POST /channels
 * @param {string} body.type - Channel type: "ntfy", "discord", "slack", or "email".
 * @param {object} body.config - Type-specific configuration (validated per type).
 * @returns {201} The created channel.
 * @returns {400} Invalid JSON body, type, config, or channel limit reached.
 */
channels.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    return c.json(addChannel(c.get("personalKeyId"), body.type, body.config), 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/**
 * Updates a channel's enabled flag and/or configuration.
 *
 * @route PATCH /channels/:channelId
 * @param {string} param.channelId - Id of a channel owned by the key.
 * @param {boolean} [body.enabled] - Whether the channel receives notifications.
 * @param {object} [body.config] - Replacement type-specific configuration.
 * @returns {200} The updated channel.
 * @returns {400} Invalid JSON body or patch values.
 * @returns {404} Channel not found or owned by another key.
 */
channels.patch("/:channelId", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const updated = updateChannel(c.get("personalKeyId"), c.req.param("channelId"), body);
    if (!updated) return c.json({ error: "Channel not found" }, 404);
    return c.json(updated);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/**
 * Deletes a notification channel.
 *
 * @route DELETE /channels/:channelId
 * @param {string} param.channelId - Id of a channel owned by the key.
 * @returns {200} Deletion confirmation.
 * @returns {404} Channel not found or owned by another key.
 */
channels.delete("/:channelId", (c) => {
  const removed = removeChannel(c.get("personalKeyId"), c.req.param("channelId"));
  if (!removed) return c.json({ error: "Channel not found" }, 404);
  return c.json({ deleted: true });
});

/**
 * Sends a test notification through a channel. Send failures return 200 with
 * `sent: false` rather than a 5xx, because Cloudflare replaces 502 bodies
 * with its own error page, which would hide the diagnostic from the client.
 * Limited to 10 test sends per key per hour on top of the per-key rate limit.
 *
 * @route POST /channels/:channelId/test
 * @param {string} param.channelId - Id of a channel owned by the key.
 * @returns {200} `{ sent: true }` on success, `{ sent: false, error }` on send failure.
 * @returns {404} Channel not found or owned by another key.
 * @returns {429} Test-send rate limit exceeded (10/hour per key).
 */
channels.post("/:channelId/test", channelTestRateLimit, async (c) => {
  const channel = getChannel(c.get("personalKeyId"), c.req.param("channelId"));
  if (!channel) return c.json({ error: "Channel not found" }, 404);
  try {
    await sendToChannel(channel, {
      chain: "bitcoin",
      chainName: "Bitcoin",
      address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      txHash: "0000000000000000000000000000000000000000000000000000000000000000",
      amount: "0.00123456",
      asset: "BTC",
      isTest: true,
    });
    return c.json({ sent: true });
  } catch (err) {
    console.error(
      `[channels] test send failed for ${channel.type} ${channel.id}: ${(err as Error).message}`,
    );
    return c.json({ sent: false, error: (err as Error).message });
  }
});
