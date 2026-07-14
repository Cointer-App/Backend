import { getChain } from "../chains";
import { env } from "../config/env";
import { getDb, now } from "../db/client";
import type { AddressRow } from "../types";
import { ValidationError } from "./pushTokenService";

export function listAddresses(personalKeyId: string) {
  const rows = getDb()
    .query<AddressRow, [string]>(
      "SELECT * FROM addresses WHERE personal_key_id = ? ORDER BY created_at",
    )
    .all(personalKeyId);
  return rows.map((r) => ({
    id: r.id,
    chain: r.chain,
    address: r.address,
    label: r.label,
    createdAt: r.created_at,
  }));
}

export function addAddress(
  personalKeyId: string,
  chainId: unknown,
  rawAddress: unknown,
  label: unknown,
) {
  if (typeof chainId !== "string") throw new ValidationError("chain is required");
  const chain = getChain(chainId);
  if (!chain) throw new ValidationError(`Unsupported chain "${chainId}", see GET /chains`);
  if (typeof rawAddress !== "string" || !chain.validate(rawAddress.trim())) {
    throw new ValidationError(`Not a valid ${chain.displayName} address`);
  }
  if (label !== undefined && label !== null && (typeof label !== "string" || label.length > 100)) {
    throw new ValidationError("label must be a string of at most 100 characters");
  }
  const address = chain.normalize(rawAddress.trim());

  const db = getDb();
  const dupe = db
    .query<{ id: string }, [string, string, string]>(
      "SELECT id FROM addresses WHERE personal_key_id = ? AND chain = ? AND address = ?",
    )
    .get(personalKeyId, chain.id, address);
  if (dupe) throw new ValidationError("You are already watching this address");

  const count = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM addresses WHERE personal_key_id = ?")
    .get(personalKeyId)!.n;
  if (count >= env.limits.maxAddressesPerKey) {
    throw new ValidationError(`Address limit reached (${env.limits.maxAddressesPerKey})`);
  }

  const id = crypto.randomUUID();
  const createdAt = now();
  db.run(
    "INSERT INTO addresses (id, personal_key_id, chain, address, label, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, personalKeyId, chain.id, address, (label as string | null) ?? null, createdAt],
  );
  return { id, chain: chain.id, address, label: (label as string | null) ?? null, createdAt };
}

export function updateAddress(personalKeyId: string, addressId: string, label: unknown) {
  const row = getDb()
    .query<AddressRow, [string, string]>(
      "SELECT * FROM addresses WHERE id = ? AND personal_key_id = ?",
    )
    .get(addressId, personalKeyId);
  if (!row) return null;

  if (label !== undefined && label !== null && (typeof label !== "string" || label.length > 100)) {
    throw new ValidationError("label must be a string of at most 100 characters");
  }

  getDb().run("UPDATE addresses SET label = ? WHERE id = ?", [
    (label as string | null) ?? null,
    row.id,
  ]);
  return {
    id: row.id,
    chain: row.chain,
    address: row.address,
    label: (label as string | null) ?? null,
    createdAt: row.created_at,
  };
}

export function removeAddress(personalKeyId: string, addressId: string): boolean {
  const res = getDb().run("DELETE FROM addresses WHERE id = ? AND personal_key_id = ?", [
    addressId,
    personalKeyId,
  ]);
  return res.changes > 0;
}

export function listAllWatchedAddresses(chainId: string): string[] {
  return getDb()
    .query<{ address: string }, [string]>("SELECT DISTINCT address FROM addresses WHERE chain = ?")
    .all(chainId)
    .map((r) => r.address);
}
