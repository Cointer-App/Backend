import { env } from "../config/env";

/**
 * Manages one long-lived `monero-wallet-rpc` subprocess that services all
 * watched Monero addresses sequentially, one view-only wallet file at a
 * time (open_wallet / generate_from_keys / close_wallet). A single shared
 * process is used instead of one-per-address to keep resource usage and
 * process-management complexity bounded — this is the one chain in the
 * codebase that requires a managed subprocess rather than plain HTTP polling.
 */

const WALLET_DIR = "./data/monero-wallets";
const RPC_PORT = 18_083;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}/json_rpc`;

let proc: ReturnType<typeof Bun.spawn> | null = null;
let rpcId = 0;
// Index into env.ingest.moneroRemoteNodes of the daemon the running process
// was spawned against. Advances on the next (re)spawn after a failure, so a
// dead node doesn't wedge every future attempt on the same host.
let daemonIndex = 0;

async function waitForRpc(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "get_version" }),
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function spawnAgainstDaemon(daemon: string): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn(
    [
      env.ingest.moneroWalletRpcPath,
      "--wallet-dir",
      WALLET_DIR,
      "--rpc-bind-port",
      String(RPC_PORT),
      "--rpc-bind-ip",
      "127.0.0.1",
      "--disable-rpc-login",
      "--daemon-address",
      daemon,
      "--non-interactive",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  child.exited.then((code) => {
    console.error(`[ingest:monero] wallet-rpc process exited (code ${code}, daemon ${daemon})`);
    if (proc === child) proc = null;
  });
  return child;
}

export async function ensureWalletRpcRunning(): Promise<void> {
  if (proc && !proc.killed) return;

  const nodes = env.ingest.moneroRemoteNodes;
  if (nodes.length === 0) {
    throw new Error("MONERO_REMOTE_NODES is not set — no remote node to connect to");
  }
  await Bun.write(`${WALLET_DIR}/.keep`, "");

  // Try each configured node in turn, starting from the last-known-good
  // index, so a single dead node doesn't repeatedly stall every poll.
  for (let attempt = 0; attempt < nodes.length; attempt++) {
    const idx = (daemonIndex + attempt) % nodes.length;
    const daemon = nodes[idx]!;
    proc?.kill();
    proc = spawnAgainstDaemon(daemon);
    const ready = await waitForRpc(30_000);
    if (ready) {
      daemonIndex = idx;
      return;
    }
    console.warn(`[ingest:monero] daemon ${daemon} did not come up, trying next node`);
    proc?.kill();
    proc = null;
  }
  throw new Error(
    `monero-wallet-rpc failed to start against any of ${nodes.length} configured node(s)`,
  );
}

export function stopWalletRpc(): void {
  proc?.kill();
  proc = null;
}

interface RpcError {
  code: number;
  message: string;
}

async function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`monero-wallet-rpc ${method} responded HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: RpcError };
  if (body.error) throw new Error(`monero-wallet-rpc ${method} error: ${body.error.message}`);
  if (body.result === undefined) throw new Error(`monero-wallet-rpc ${method} returned no result`);
  return body.result;
}

const WALLET_PASSWORD = ""; // Local, loopback-only RPC; wallet files hold no spend key.

function walletFilename(address: string): string {
  return address.slice(0, 24);
}

async function openOrCreateWallet(address: string, viewKey: string): Promise<void> {
  const filename = walletFilename(address);
  try {
    await rpc("open_wallet", { filename, password: WALLET_PASSWORD });
  } catch {
    await rpc("generate_from_keys", {
      filename,
      address,
      viewkey: viewKey,
      password: WALLET_PASSWORD,
      autosave_current: false,
      restore_height: 0,
    });
  }
}

export interface MoneroTransfer {
  txid: string;
  amount: number;
  height: number;
  timestamp: number;
  type: string;
}

export async function fetchIncomingTransfers(
  address: string,
  viewKey: string,
): Promise<MoneroTransfer[]> {
  await openOrCreateWallet(address, viewKey);
  try {
    const result = await rpc<{ in?: MoneroTransfer[]; pool?: MoneroTransfer[] }>("get_transfers", {
      in: true,
      pool: true,
    });
    return [...(result.in ?? []), ...(result.pool ?? [])];
  } finally {
    await rpc("close_wallet").catch(() => {});
  }
}

/**
 * Total ever received on a view-only wallet, in atomic units. Not a true
 * spendable balance: without the spend key this RPC cannot detect outgoing
 * transfers, so it never decreases even after funds are spent elsewhere.
 * Callers must present this as "received", not "balance".
 */
export async function fetchViewOnlyReceived(address: string, viewKey: string): Promise<bigint> {
  await openOrCreateWallet(address, viewKey);
  try {
    const result = await rpc<{ balance: number }>("get_balance");
    return BigInt(result.balance);
  } finally {
    await rpc("close_wallet").catch(() => {});
  }
}
