import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "../config/env";
import { applySchema } from "./schema";

let db: Database | null = null;

export function connectDb(path: string = env.databasePath): Database {
  if (db) return db;
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  applySchema(db);
  return db;
}

export function getDb(): Database {
  if (!db) throw new Error("Database not connected, call connectDb() first");
  return db;
}

export function resetDb(): void {
  db?.close();
  db = null;
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
