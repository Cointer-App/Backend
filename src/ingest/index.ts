import { env } from "../config/env";
import { pollBitcoin, seedBitcoinAddress } from "./bitcoinWatcher";
import { pollEthereum } from "./ethereumWatcher";

interface Watcher {
  chainId: string;
  intervalMs: number;
  poll(): Promise<void>;
}

const watchers: Record<string, Omit<Watcher, "chainId">> = {
  bitcoin: { intervalMs: env.ingest.bitcoinPollIntervalMs, poll: pollBitcoin },
  ethereum: { intervalMs: env.ingest.ethereumPollIntervalMs, poll: pollEthereum },
};

const MAX_BACKOFF_MS = 5 * 60_000;

let stops: (() => void)[] = [];

function runLoop(watcher: Watcher): void {
  let failures = 0;
  let timer: Timer | undefined;

  const schedule = (delayMs: number) => {
    timer = setTimeout(async () => {
      try {
        await watcher.poll();
        failures = 0;
        schedule(watcher.intervalMs);
      } catch (err) {
        failures++;
        const delay = Math.min(watcher.intervalMs * 2 ** failures, MAX_BACKOFF_MS);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[ingest:${watcher.chainId}] poll failed (attempt ${failures}, retry in ${Math.round(delay / 1000)}s): ${msg}`,
        );
        schedule(delay);
      }
    }, delayMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  };

  stops.push(() => clearTimeout(timer));
  schedule(1000);
}

export function startWatchers(): void {
  if (!env.ingest.watchersEnabled) {
    console.log("[ingest] watchers disabled via WATCHERS_ENABLED=false");
    return;
  }
  for (const chainId of env.enabledChains) {
    const watcher = watchers[chainId];
    if (!watcher) {
      console.warn(
        `[ingest] chain "${chainId}" is enabled but has no watcher — addresses on it will never notify`,
      );
      continue;
    }
    console.log(`[ingest:${chainId}] watcher started (every ${watcher.intervalMs}ms)`);
    runLoop({ chainId, ...watcher });
  }
}

export function stopWatchers(): void {
  for (const stop of stops) stop();
  stops = [];
}

export async function seedAddressHistory(
  chainId: string,
  personalKeyId: string,
  address: string,
): Promise<void> {
  if (!env.ingest.watchersEnabled) return;
  try {
    if (chainId === "bitcoin") await seedBitcoinAddress(personalKeyId, address);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ingest:${chainId}] history seed failed for ${address}: ${msg}`);
  }
}
