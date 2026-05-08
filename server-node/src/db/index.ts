/**
 * SQLite access via better-sqlite3.
 *
 * Native SQLite. Handles WAL, file locking, and recovery exactly as the
 * SQLite C library does — no special handling needed across container
 * restarts. Data is preserved verbatim.
 *
 * Alpine x64 + arm64 prebuilds are downloaded by `prebuild-install` at
 * `npm ci` time. The Dockerfile keeps python3/make/g++ around as a
 * fallback in case the download is unavailable.
 */

import BetterSqlite3 from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { applyMigrations } from "./migrations.js";

export type Database = DatabaseType;

let _db: DatabaseType | null = null;

export function openDb(path: string): DatabaseType {
  if (_db) return _db;
  const db = new BetterSqlite3(path);
  // WAL is fine here — better-sqlite3 implements it natively against the
  // host filesystem and handles SQLITE_BUSY automatically.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  applyMigrations(db);
  _db = db;
  return db;
}

export function db(): DatabaseType {
  if (!_db) throw new Error("db not opened");
  return _db;
}
