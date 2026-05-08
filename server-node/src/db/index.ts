/**
 * SQLite access via node-sqlite3-wasm with a thin better-sqlite3-style
 * adapter so handler code can use the familiar `.get(a, b)` / `.run(a, b)`
 * variadic-positional syntax instead of the underlying single-bindings form.
 */

// node-sqlite3-wasm is CommonJS; use default import + destructure.
import sqlitePkg from "node-sqlite3-wasm";
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

export function openDb(path: string): Database {
  if (_db) return _db;
  const raw = new WasmDatabase(path);
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA foreign_keys = ON;");
  const adapted = adapt(raw);
  applyMigrations(adapted);
  _db = adapted;
  return adapted;
}

export function db(): Database {
  if (!_db) throw new Error("db not opened");
  return _db;
}
