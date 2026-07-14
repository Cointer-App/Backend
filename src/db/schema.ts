import type { Database } from "bun:sqlite";

export function applySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS personal_keys (
      id            TEXT PRIMARY KEY,
      key_hash      TEXT NOT NULL UNIQUE,
      created_at    INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS addresses (
      id               TEXT PRIMARY KEY,
      personal_key_id  TEXT NOT NULL REFERENCES personal_keys(id) ON DELETE CASCADE,
      chain            TEXT NOT NULL,
      address          TEXT NOT NULL,
      label            TEXT,
      created_at       INTEGER NOT NULL,
      UNIQUE (personal_key_id, chain, address)
    );
    CREATE INDEX IF NOT EXISTS idx_addresses_chain_address ON addresses (chain, address);

    CREATE TABLE IF NOT EXISTS channels (
      id               TEXT PRIMARY KEY,
      personal_key_id  TEXT NOT NULL REFERENCES personal_keys(id) ON DELETE CASCADE,
      type             TEXT NOT NULL,
      config           TEXT NOT NULL,
      enabled          INTEGER NOT NULL DEFAULT 1,
      created_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channels_personal_key ON channels (personal_key_id);

    CREATE TABLE IF NOT EXISTS push_tokens (
      id               TEXT PRIMARY KEY,
      personal_key_id  TEXT NOT NULL REFERENCES personal_keys(id) ON DELETE CASCADE,
      token            TEXT NOT NULL,
      platform         TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      UNIQUE (personal_key_id, token)
    );

    CREATE TABLE IF NOT EXISTS activity (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      personal_key_id  TEXT NOT NULL REFERENCES personal_keys(id) ON DELETE CASCADE,
      chain            TEXT NOT NULL,
      address          TEXT NOT NULL,
      tx_hash          TEXT NOT NULL,
      amount           TEXT NOT NULL,
      asset            TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      UNIQUE (personal_key_id, chain, tx_hash, address)
    );
    CREATE INDEX IF NOT EXISTS idx_activity_personal_key ON activity (personal_key_id, id DESC);

    CREATE TABLE IF NOT EXISTS ingest_state (
      chain       TEXT PRIMARY KEY,
      cursor      TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- Per-wallet notification opt-outs: a row means "this address does NOT
    -- notify via this channel". Absence of a row = enabled, so new channels
    -- and new addresses default to all notifications on.
    CREATE TABLE IF NOT EXISTS address_channel_mutes (
      address_id  TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
      channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (address_id, channel_id)
    );

    -- Same opt-out semantics for Expo push, muted per address across all devices.
    CREATE TABLE IF NOT EXISTS address_push_mutes (
      address_id  TEXT PRIMARY KEY REFERENCES addresses(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL
    );
  `);
}
