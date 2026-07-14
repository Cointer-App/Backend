import { Hono } from "hono";
import { getEnabledChains } from "../chains";
import { env } from "../config/env";
import { countWatchedWallets } from "../services/activityService";
import type { AppEnv } from "../types";

export const meta = new Hono<AppEnv>();

/**
 * Returns current server configuration the frontend needs at runtime:
 * whether the email channel type is available, the fiat currency used for
 * values, and the per-key resource limits. Public, no authentication;
 * exposes only server configuration, never per-key data.
 *
 * @route GET /capabilities
 * @returns {200} Email availability, fiat currency, and per-key limits.
 */
meta.get("/capabilities", (c) => {
  return c.json({
    email: Boolean(env.smtp || env.cloudflareEmail),
    currency: env.prices.currency,
    limits: {
      maxAddressesPerKey: env.limits.maxAddressesPerKey,
      maxChannelsPerKey: env.limits.maxChannelsPerKey,
      maxPushTokensPerKey: env.limits.maxPushTokensPerKey,
      activityRetentionDays: env.limits.activityRetentionDays,
    },
  });
});

/**
 * Lists the chains currently supported by the server. Public, no
 * authentication.
 *
 * @route GET /chains
 * @returns {200} The enabled chains with id, name, and asset ticker.
 */
meta.get("/chains", (c) => {
  return c.json({
    chains: getEnabledChains().map((chain) => ({
      id: chain.id,
      name: chain.displayName,
      asset: chain.asset,
    })),
  });
});

/**
 * Returns the number of wallets currently watched across all keys. Public,
 * no authentication.
 *
 * @route GET /stats/wallets
 * @returns {200} The watched wallet count.
 */
meta.get("/stats/wallets", (c) => {
  return c.json({ watchedWallets: countWatchedWallets() });
});

/**
 * Health check. Public, no authentication.
 *
 * @route GET /health
 * @returns {200} `{ status: "ok" }`.
 */
meta.get("/health", (c) => {
  return c.json({ status: "ok" });
});
