import { env } from "../config/env";
import { listAllWatchedAddresses, listMoneroWatchTargets } from "../services/addressService";
import { setCachedBalance } from "../services/balanceService";
import { fetchBitcoinCashBalance } from "./bitcoinCashWatcher";
import { fetchAddressBalance } from "./esploraCommon";
import { fetchEvmBalances } from "./evmWatcher";
import { formatUnits } from "./format";
import { ensureWalletRpcRunning, fetchViewOnlyReceived } from "./moneroWalletRpc";
import { fetchSolanaBalances } from "./solanaWatcher";

const MONERO_DECIMALS = 12;

async function refreshBitcoinLike(chain: "bitcoin" | "litecoin"): Promise<void> {
  const baseUrl =
    chain === "bitcoin" ? env.ingest.bitcoinEsploraUrl : env.ingest.litecoinEsploraUrl;
  const asset = chain === "bitcoin" ? "BTC" : "LTC";
  for (const address of listAllWatchedAddresses(chain)) {
    try {
      const raw = await fetchAddressBalance(baseUrl, address, chain);
      if (raw !== null) setCachedBalance(chain, address, [{ asset, amount: formatUnits(raw, 8) }]);
    } catch (err) {
      console.error(
        `[balances:${chain}] failed for ${address}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

async function refreshBitcoinCash(): Promise<void> {
  for (const address of listAllWatchedAddresses("bitcoin-cash")) {
    try {
      const raw = await fetchBitcoinCashBalance(address);
      if (raw !== null) {
        setCachedBalance("bitcoin-cash", address, [{ asset: "BCH", amount: formatUnits(raw, 8) }]);
      }
    } catch (err) {
      console.error(
        `[balances:bitcoin-cash] failed for ${address}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

async function refreshEvm(chain: "ethereum" | "base"): Promise<void> {
  const rpcUrl = chain === "ethereum" ? env.ingest.ethereumRpcUrl : env.ingest.baseRpcUrl;
  const tokens = chain === "ethereum" ? env.ingest.ethereumErc20Tokens : env.ingest.baseErc20Tokens;
  for (const address of listAllWatchedAddresses(chain)) {
    try {
      const balances = await fetchEvmBalances(rpcUrl, "ETH", address, tokens);
      setCachedBalance(
        chain,
        address,
        balances.map((b) => ({ asset: b.asset, amount: formatUnits(b.raw, b.decimals) })),
      );
    } catch (err) {
      console.error(
        `[balances:${chain}] failed for ${address}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

async function refreshSolana(): Promise<void> {
  for (const address of listAllWatchedAddresses("solana")) {
    try {
      const balances = await fetchSolanaBalances(
        env.ingest.solanaRpcUrl,
        address,
        env.ingest.solanaSplTokens,
      );
      setCachedBalance(
        "solana",
        address,
        balances.map((b) => ({ asset: b.asset, amount: formatUnits(b.raw, b.decimals) })),
      );
    } catch (err) {
      console.error(
        `[balances:solana] failed for ${address}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

async function refreshMonero(): Promise<void> {
  const targets = listMoneroWatchTargets();
  if (targets.length === 0) return;
  await ensureWalletRpcRunning();
  for (const { address, viewKey } of targets) {
    try {
      const raw = await fetchViewOnlyReceived(address, viewKey);
      setCachedBalance("monero", address, [
        { asset: "XMR", amount: formatUnits(raw, MONERO_DECIMALS) },
      ]);
    } catch (err) {
      console.error(
        `[balances:monero] failed for ${address}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

interface BalanceRefresher {
  chainId: string;
  intervalMs: number;
  refresh(): Promise<void>;
}

const refreshers: BalanceRefresher[] = [
  {
    chainId: "bitcoin",
    intervalMs: env.ingest.bitcoinPollIntervalMs,
    refresh: () => refreshBitcoinLike("bitcoin"),
  },
  {
    chainId: "litecoin",
    intervalMs: env.ingest.litecoinPollIntervalMs,
    refresh: () => refreshBitcoinLike("litecoin"),
  },
  {
    chainId: "bitcoin-cash",
    intervalMs: env.ingest.bitcoinCashPollIntervalMs,
    refresh: refreshBitcoinCash,
  },
  {
    chainId: "ethereum",
    intervalMs: env.ingest.ethereumPollIntervalMs,
    refresh: () => refreshEvm("ethereum"),
  },
  { chainId: "base", intervalMs: env.ingest.basePollIntervalMs, refresh: () => refreshEvm("base") },
  { chainId: "solana", intervalMs: env.ingest.solanaPollIntervalMs, refresh: refreshSolana },
  { chainId: "monero", intervalMs: env.ingest.moneroPollIntervalMs, refresh: refreshMonero },
];

const MAX_BACKOFF_MS = 5 * 60_000;

let stops: (() => void)[] = [];

function runLoop(refresher: BalanceRefresher): void {
  let failures = 0;
  let timer: Timer | undefined;

  const schedule = (delayMs: number) => {
    timer = setTimeout(async () => {
      try {
        await refresher.refresh();
        failures = 0;
        schedule(refresher.intervalMs);
      } catch (err) {
        failures++;
        const delay = Math.min(refresher.intervalMs * 2 ** failures, MAX_BACKOFF_MS);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[balances:${refresher.chainId}] refresh failed (attempt ${failures}, retry in ${Math.round(delay / 1000)}s): ${msg}`,
        );
        schedule(delay);
      }
    }, delayMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  };

  stops.push(() => clearTimeout(timer));
  schedule(1000);
}

export function startBalancePoller(): void {
  if (!env.ingest.watchersEnabled) {
    console.log("[balances] poller disabled via WATCHERS_ENABLED=false");
    return;
  }
  for (const refresher of refreshers) {
    if (!env.enabledChains.includes(refresher.chainId)) continue;
    console.log(`[balances:${refresher.chainId}] poller started (every ${refresher.intervalMs}ms)`);
    runLoop(refresher);
  }
}

export function stopBalancePoller(): void {
  for (const stop of stops) stop();
  stops = [];
}
