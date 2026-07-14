import { getDb, now } from "../db/client";

export function getCursor(chain: string): number | null {
  const row = getDb()
    .query<{ cursor: string }, [string]>("SELECT cursor FROM ingest_state WHERE chain = ?")
    .get(chain);
  return row ? Number(row.cursor) : null;
}

export function setCursor(chain: string, position: number): void {
  getDb().run(
    `INSERT INTO ingest_state (chain, cursor, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (chain) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    [chain, String(position), now()],
  );
}
