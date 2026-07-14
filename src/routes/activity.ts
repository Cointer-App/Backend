import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { perKeyRateLimit } from "../middleware/rateLimit";
import { getActivitySummary, getWalletValue, listActivity } from "../services/activityService";
import type { AppEnv } from "../types";

export const activity = new Hono<AppEnv>();

/**
 * Lists recent incoming transfers for the authenticated key, newest first,
 * as a cursor-paged result. Requires authentication.
 *
 * @route GET /activity
 * @param {string} [query.limit] - Page size (default 25, capped).
 * @param {string} [query.cursor] - Cursor from a previous page's response.
 * @returns {200} A page of activity items with the next cursor.
 */
activity.get("/", requireAuth, perKeyRateLimit, (c) => {
  return c.json(listActivity(c.get("personalKeyId"), c.req.query("limit"), c.req.query("cursor")));
});

/**
 * Returns the same activity page as GET /activity with a fiat value per item,
 * plus a total and unpriced count covering every retained row for the key
 * (stable across pages). Assets without a fresh cached price get a null
 * fiatValue and are excluded from the total. Requires authentication.
 *
 * @route GET /activity/value
 * @param {string} [query.limit] - Page size (default 25, capped).
 * @param {string} [query.cursor] - Cursor from a previous page's response.
 * @returns {200} A page of priced activity items with total and unpricedCount.
 */
activity.get("/value", requireAuth, perKeyRateLimit, (c) => {
  return c.json(
    getWalletValue(c.get("personalKeyId"), c.req.query("limit"), c.req.query("cursor")),
  );
});

/**
 * Aggregates the key's retained activity into fixed time windows (24h, 7d,
 * 30d) with deposit counts and fiat totals, plus per-asset totals over all
 * retained rows. Assets without a fresh cached price get a null fiatValue and
 * are excluded from window totals (counted in unpricedCount instead).
 * Requires authentication.
 *
 * @route GET /activity/summary
 * @returns {200} Window and per-asset aggregates with currency and priceAsOf.
 */
activity.get("/summary", requireAuth, perKeyRateLimit, (c) => {
  return c.json(getActivitySummary(c.get("personalKeyId")));
});
