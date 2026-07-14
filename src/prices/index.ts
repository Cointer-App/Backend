import { getEnabledChains } from "../chains";
import { env } from "../config/env";
import { fetchNativePrices, fetchTokenPrices } from "./coingecko";

export interface PriceQuote {
  value: number;
  currency: string;
  fetchedAt: number;
}

const cache = new Map<string, { value: number; fetchedAt: number }>();

const MAX_BACKOFF_MS = 5 * 60_000;

let stop: (() => void) | null = null;

export function getPrice(asset: string): PriceQuote | null {
  const entry = cache.get(asset.toUpperCase());
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > env.prices.stalenessMs) return null;
  return { value: entry.value, currency: env.prices.currency, fetchedAt: entry.fetchedAt };
}

export function formatFiat(value: number): string {
  const currency = env.prices.currency;
  const symbol = currency === "usd" ? "$" : "";
  const suffix = currency === "usd" ? "" : ` ${currency.toUpperCase()}`;
  if (value > 0 && value < 0.01) return `<${symbol}0.01${suffix}`;
  const formatted = value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${symbol}${formatted}${suffix}`;
}

function targets(): {
  byId: { ticker: string; id: string }[];
  byAddress: { ticker: string; address: string }[];
} {
  const byId = new Map<string, string>();
  const byAddress: { ticker: string; address: string }[] = [];

  for (const chain of getEnabledChains()) {
    const ticker = chain.asset.toUpperCase();
    const id = env.prices.coinIds[ticker];
    if (id) byId.set(ticker, id);
  }
  if (env.enabledChains.includes("ethereum")) {
    for (const token of env.ingest.ethereumErc20Tokens) {
      const ticker = token.ticker.toUpperCase();
      const id = env.prices.coinIds[ticker];
      if (id) byId.set(ticker, id);
      else byAddress.push({ ticker, address: token.address });
    }
  }
  return { byId: [...byId].map(([ticker, id]) => ({ ticker, id })), byAddress };
}

async function refreshPrices(): Promise<void> {
  const { byId, byAddress } = targets();

  const [idRes, addressRes] = await Promise.allSettled([
    fetchNativePrices(byId.map((t) => t.id)),
    fetchTokenPrices(byAddress.map((t) => t.address)),
  ]);

  const fetchedAt = Date.now();

  if (idRes.status === "fulfilled") {
    for (const { ticker, id } of byId) {
      const value = idRes.value[id];
      if (value !== undefined) cache.set(ticker, { value, fetchedAt });
    }
  }
  if (addressRes.status === "fulfilled") {
    for (const { ticker, address } of byAddress) {
      const value = addressRes.value[address];
      if (value !== undefined) cache.set(ticker, { value, fetchedAt });
    }
  }

  const failed = [idRes, addressRes].find(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (failed) throw failed.reason;
}

export function startPriceFeed(): void {
  if (!env.prices.enabled) {
    console.log("[prices] feed disabled via PRICES_ENABLED=false");
    return;
  }
  const unmapped = getEnabledChains().filter((c) => !env.prices.coinIds[c.asset.toUpperCase()]);
  for (const chain of unmapped) {
    console.warn(
      `[prices] no CoinGecko id for ${chain.asset} — set PRICE_COINGECKO_IDS to price it`,
    );
  }

  let failures = 0;
  let timer: Timer | undefined;

  const schedule = (delayMs: number) => {
    timer = setTimeout(async () => {
      try {
        await refreshPrices();
        failures = 0;
        schedule(env.prices.refreshIntervalMs);
      } catch (err) {
        failures++;
        const delay = Math.min(env.prices.refreshIntervalMs * 2 ** failures, MAX_BACKOFF_MS);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[prices] refresh failed (attempt ${failures}, retry in ${Math.round(delay / 1000)}s): ${msg}`,
        );
        schedule(delay);
      }
    }, delayMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  };

  stop = () => clearTimeout(timer);
  console.log(`[prices] feed started (every ${env.prices.refreshIntervalMs}ms)`);
  schedule(1000);
}

export function stopPriceFeed(): void {
  stop?.();
  stop = null;
}

export function __setPriceForTest(asset: string, value: number | null): void {
  if (value === null) cache.delete(asset.toUpperCase());
  else cache.set(asset.toUpperCase(), { value, fetchedAt: Date.now() });
}
