import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { perKeyRateLimit } from "../middleware/rateLimit";
import { getWalletBalances } from "../services/balanceService";
import type { AppEnv } from "../types";

export const wallets = new Hono<AppEnv>();

/**
 * Live balance for every watched address on the authenticated key: current
 * on-chain amount per asset (native coin plus configured tokens), priced at
 * the latest cached rate, with a grand total. Balances come from a
 * background poller (same pattern as prices), so this reads a cache and
 * never blocks on a live chain call. Monero wallets are view-only and
 * cannot detect spends, so their value reflects lifetime received, not a
 * live spendable balance (`approximate: true`). Requires authentication.
 *
 * @route GET /wallets/value
 * @returns {200} Per-wallet balances with fiat values, currency, and priceAsOf.
 */
wallets.get("/value", requireAuth, perKeyRateLimit, (c) => {
  return c.json(getWalletBalances(c.get("personalKeyId")));
});
