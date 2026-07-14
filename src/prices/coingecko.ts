import { env } from "../config/env";

const FETCH_TIMEOUT_MS = 10_000;

function headers(): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  if (env.prices.apiKey) h["x-cg-demo-api-key"] = env.prices.apiKey;
  return h;
}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const res = await fetch(`${env.prices.baseUrl}${path}?${qs}`, {
    headers: headers(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`coingecko returned ${res.status}`);
  return (await res.json()) as T;
}

type PriceResponse = Record<string, Record<string, number>>;

export async function fetchNativePrices(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const data = await get<PriceResponse>("/simple/price", {
    ids: ids.join(","),
    vs_currencies: env.prices.currency,
  });
  return flatten(data);
}

export async function fetchTokenPrices(addresses: string[]): Promise<Record<string, number>> {
  if (addresses.length === 0) return {};
  const data = await get<PriceResponse>("/simple/token_price/ethereum", {
    contract_addresses: addresses.join(","),
    vs_currencies: env.prices.currency,
  });
  return flatten(data);
}

function flatten(data: PriceResponse): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, quotes] of Object.entries(data)) {
    const value = quotes?.[env.prices.currency];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}
