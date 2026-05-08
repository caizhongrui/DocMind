/**
 * SQLite access via node-sqlite3-wasm with a thin better-sqlite3-style
 * adapter so handler code can use the familiar `.get(a, b)` / `.run(a, b)`
 * variadic-positional syntax instead of the underlying single-bindings form.
 */

// node-sqlite3-wasm is CommonJS; use default import + destructure.
import sqlitePkg from "node-sqlite3-wasm";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import { applyMigrations } from "./migrations.js";

interface WasmStatement {
  run(b?: unknown): { changes: number; lastInsertRowid: number | bigint };
  get(b?: unknown): Record<string, unknown> | null;
  all(b?: unknown): Record<string, unknown>[];
}
interface WasmDatabaseInstance {
  prepare(sql: string): WasmStatement;
  exec(sql: string): void;
  close(): void;
}
const WasmDatabase = (sqlitePkg as unknown as {
  Database: new (path: string) => WasmDatabaseInstance;
}).Database;

export interface Statement {
  run(...args: unknown[]): { changes: number; lastInsertRowid: number };
  get(...args: unknown[]): Record<string, unknown> | undefined;
  all(...args: unknown[]): Record<string, unknown>[];
}

export interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}

let _db: Database | null = null;

function flatten(args: unknown[]): unknown[] {
  if (args.length === 1 && Array.isArray(args[0])) return args[0] as unknown[];
  return args;
}

function adapt(raw: WasmDatabaseInstance): Database {
  return {
    prepare(sql: string): Statement {
      const stmt = raw.prepare(sql);
      return {
        run(...args) {
          const a = flatten(args) as any;
          const r = stmt.run(a);
          return {
            changes: r.changes,
            lastInsertRowid: Number(r.lastInsertRowid),
          };
        },
        get(...args) {
          const a = flatten(args) as any;
          return (stmt.get(a) ?? undefined) as Record<string, unknown> | undefined;
        },
        all(...args) {
          const a = flatten(args) as any;
          return stmt.all(a) as Record<string, unknown>[];
        },
      };
    },
    exec(sql: string) {
      raw.exec(sql);
    },
    close() {
      raw.close();
    },
  };
}

/**
 * Open the database, healing from any stale state left over by a previous
 * crashed/killed container.
 *
 * Failure modes we handle:
 *
 *   1. **Stale recovery files** (`.sqlite-journal`, `.sqlite-wal`, `.sqlite-shm`):
 *      a previous container died mid-transaction or the DB was previously in
 *      WAL mode. node-sqlite3-wasm cannot finish recovery because its WASM
 *      filesystem layer doesn't fully implement the shared-memory locking
 *      WAL needs. We always delete these on startup.
 *
 *   2. **DB file header still says WAL**: even after removing the side files,
 *      SQLite's header may say "I'm a WAL DB" and refuse normal access. We
 *      try `PRAGMA journal_mode = DELETE` as the very first op; if it fails,
 *      the file is unrecoverable in this runtime — we rename it aside and
 *      let migrations recreate from scratch.
 *
 * For DocMind's admin DB the recreate path is acceptable: real licenses
 * issued via PayJS webhook are append-only and will be re-issued by the
 * webhook itself if the DB is empty (PayJS retries are idempotent on the
 * order side).
 */
export function openDb(path: string): Database {
  if (_db) return _db;

  cleanStaleRecoveryFiles(path);

  let raw: WasmDatabaseInstance;
  try {
    raw = new WasmDatabase(path);
    applyOpenPragmas(raw);
  } catch (e) {
    console.error(
      `[db] failed to open ${path}: ${String(e)} — backing up and recreating`,
    );
    if (existsSync(path)) {
      const backup = `${path}.broken-${Date.now()}`;
      try {
        renameSync(path, backup);
        console.warn(`[db] moved broken database to ${backup}`);
      } catch (renameErr) {
        console.error(`[db] could not back up broken database: ${renameErr}`);
        throw e;
      }
    }
    cleanStaleRecoveryFiles(path);
    raw = new WasmDatabase(path);
    applyOpenPragmas(raw);
  }

  const adapted = adapt(raw);
  applyMigrations(adapted);
  _db = adapted;
  return adapted;
}

function cleanStaleRecoveryFiles(path: string): void {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const f = path + suffix;
    if (existsSync(f)) {
      try {
        unlinkSync(f);
        console.warn(`[db] removed stale ${f}`);
      } catch (e) {
        console.warn(`[db] could not remove ${f}: ${e}`);
      }
    }
  }
}

function applyOpenPragmas(raw: WasmDatabaseInstance): void {
  // First PRAGMA must be journal_mode = DELETE so any leftover WAL header
  // is rewritten before we touch anything else.
  raw.exec("PRAGMA journal_mode = DELETE;");
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec("PRAGMA synchronous = NORMAL;");
  raw.exec("PRAGMA busy_timeout = 5000;");
}

export function db(): Database {
  if (!_db) throw new Error("db not opened");
  return _db;
}
