import { Hono } from "hono";
import { seedAddressHistory } from "../ingest";
import { requireAuth } from "../middleware/auth";
import { perKeyRateLimit } from "../middleware/rateLimit";
import {
  getAddressNotificationSettings,
  updateAddressNotificationSettings,
} from "../services/addressNotificationService";
import {
  addAddress,
  listAddresses,
  removeAddress,
  updateAddress,
} from "../services/addressService";
import { ValidationError } from "../services/pushTokenService";
import type { AppEnv } from "../types";

export const addresses = new Hono<AppEnv>();

addresses.use("*", requireAuth, perKeyRateLimit);

/**
 * Lists every address watched by the authenticated key.
 *
 * @route GET /addresses
 * @returns {200} The watched addresses.
 */
addresses.get("/", (c) => {
  return c.json({ addresses: listAddresses(c.get("personalKeyId")) });
});

/**
 * Adds an address to watch for the authenticated key. The address's existing
 * on-chain history is seeded off the request path so it never notifies.
 *
 * @route POST /addresses
 * @param {string} body.chain - Chain id (see GET /chains).
 * @param {string} body.address - Address to watch, normalized to the chain's canonical form.
 * @param {string} [body.label] - Optional display label.
 * @returns {201} The created address record.
 * @returns {400} Invalid JSON body, chain, address, or label.
 */
addresses.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const created = addAddress(c.get("personalKeyId"), body.chain, body.address, body.label);
    void seedAddressHistory(created.chain, c.get("personalKeyId"), created.address);
    return c.json(created, 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/**
 * Renames a watched address by replacing its label.
 *
 * @route PATCH /addresses/:addressId
 * @param {string} param.addressId - Id of a watched address owned by the key.
 * @param {string} [body.label] - New display label. Omit or set null to clear it.
 * @returns {200} The updated address record.
 * @returns {400} Invalid JSON body or bad label.
 * @returns {404} Address not found or owned by another key.
 */
addresses.patch("/:addressId", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const updated = updateAddress(c.get("personalKeyId"), c.req.param("addressId"), body.label);
    if (!updated) return c.json({ error: "Address not found" }, 404);
    return c.json(updated);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/**
 * Returns the per-address notification settings: every notification method
 * of the authenticated key (channels and push), each flagged with whether it
 * is muted for this address.
 *
 * @route GET /addresses/:addressId/notifications
 * @param {string} param.addressId - Id of a watched address owned by the key.
 * @returns {200} The notification settings for the address.
 * @returns {404} Address not found or owned by another key.
 */
addresses.get("/:addressId/notifications", (c) => {
  const settings = getAddressNotificationSettings(c.get("personalKeyId"), c.req.param("addressId"));
  if (!settings) return c.json({ error: "Address not found" }, 404);
  return c.json(settings);
});

/**
 * Applies a partial patch to the per-address notification settings. false
 * mutes a method for this address, true unmutes it. The whole patch is
 * validated before anything is written, so an invalid entry never leaves a
 * partial update behind.
 *
 * @route PATCH /addresses/:addressId/notifications
 * @param {string} param.addressId - Id of a watched address owned by the key.
 * @param {boolean} [body.push] - Mute state for push notifications.
 * @param {Object<string, boolean>} [body.channels] - Mute state per channel id.
 * @returns {200} The updated notification settings.
 * @returns {400} Invalid JSON body, non-boolean value, or unknown channel id.
 * @returns {404} Address not found or owned by another key.
 */
addresses.patch("/:addressId/notifications", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const settings = updateAddressNotificationSettings(
      c.get("personalKeyId"),
      c.req.param("addressId"),
      {
        push: body.push,
        channels: body.channels,
      },
    );
    if (!settings) return c.json({ error: "Address not found" }, 404);
    return c.json(settings);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/**
 * Stops watching an address and removes it from the authenticated key.
 *
 * @route DELETE /addresses/:addressId
 * @param {string} param.addressId - Id of a watched address owned by the key.
 * @returns {200} Deletion confirmation.
 * @returns {404} Address not found or owned by another key.
 */
addresses.delete("/:addressId", (c) => {
  const removed = removeAddress(c.get("personalKeyId"), c.req.param("addressId"));
  if (!removed) return c.json({ error: "Address not found" }, 404);
  return c.json({ deleted: true });
});
