import type { ChainAdapter } from "../chains";
import { env } from "../config/env";
import { getDb, now } from "../db/client";
import type { NormalizedTx } from "../types";
import { recordActivity } from "./activityService";
import { notifyPersonalKey } from "./notificationService";

const HISTORY_GRACE_SEC = 3600;

export async function processIncomingTxs(chain: ChainAdapter, txs: NormalizedTx[]): Promise<void> {
  const findOwners = getDb().query<
    { id: string; personal_key_id: string; created_at: number },
    [string, string]
  >("SELECT id, personal_key_id, created_at FROM addresses WHERE chain = ? AND address = ?");

  const minTimestamp = now() - env.ingest.maxAgeDays * 86_400;

  const jobs: Promise<void>[] = [];
  for (const tx of txs) {
    if (tx.timestamp !== undefined && tx.timestamp < minTimestamp) continue;
    const owners = findOwners.all(chain.id, tx.address);
    for (const { id, personal_key_id, created_at } of owners) {
      if (tx.timestamp !== undefined && tx.timestamp < created_at - HISTORY_GRACE_SEC) continue;
      const isNew = recordActivity(
        personal_key_id,
        chain.id,
        tx.address,
        tx.txHash,
        tx.amount,
        tx.asset,
      );
      if (!isNew) continue;
      jobs.push(
        notifyPersonalKey(
          personal_key_id,
          {
            chain: chain.id,
            chainName: chain.displayName,
            address: tx.address,
            txHash: tx.txHash,
            amount: tx.amount,
            asset: tx.asset,
          },
          id,
        ),
      );
    }
  }
  await Promise.all(jobs);
}
