/**
 * Updater manifest + binary downloads + download logging.
 *
 * 单一下载地址(无 free / pro 分版本):
 *   GET /api/v1/updates/:platform/:current_version  → Tauri-format manifest
 *   GET /api/v1/releases/public                     → public changelog JSON
 *   GET /releases/:platform/:file                   → binary
 *
 * The `releases` and `downloads` tables still keep an `edition` column for
 * backwards compatibility with old data; new uploads default it to "all"
 * and the public download path doesn't expose it.
 */

import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

export const apiReleasesRouter = new Hono<AppEnv>();

apiReleasesRouter.get("/updates/:platform/:current_version", (c) => {
  const { db, config } = c.var.app;
  const platform = c.req.param("platform");
  const current = c.req.param("current_version");

  const row = db
    .prepare(
      `SELECT version, signature, file_path, notes, published_at
         FROM releases
        WHERE platform = ?
        ORDER BY published_at DESC LIMIT 1`,
    )
    .get(platform) as
    | { version: string; signature: string; file_path: string; notes: string | null; published_at: string }
    | undefined;

  if (!row) return c.body(null, 204);
  if (!versionGt(row.version, current)) return c.body(null, 204);

  return c.json({
    version: row.version,
    notes: row.notes ?? "",
    pub_date: row.published_at,
    platforms: {
      [platform]: {
        signature: row.signature,
        url: `https://${config.domain}/releases/${platform}/${row.file_path}`,
      },
    },
  });
});

apiReleasesRouter.get("/releases/public", (c) => {
  const { db } = c.var.app;
  const rows = db
    .prepare(
      `SELECT version, MAX(published_at) AS published_at,
              MIN(COALESCE(notes, '')) AS notes
         FROM releases
        GROUP BY version
        ORDER BY published_at DESC LIMIT 50`,
    )
    .all() as { version: string; published_at: string; notes: string }[];
  return c.json(rows);
});

// ── Public download router (mounted at /releases/*) ───────────────────────
export const releasesRouter = new Hono<AppEnv>();

releasesRouter.get("/:platform/:file", (c) => serveFile(c));

async function serveFile(c: any) {
  const { db, config } = c.var.app;
  const platform = c.req.param("platform") as string;
  const file = c.req.param("file") as string;
  if (file.includes("..") || file.includes("/") || file.includes("\\")) {
    return c.text("bad filename", 400);
  }

  // 选最新一条记录(无视 edition 列,因为 UI 不再区分),用于查文件路径。
  const row = db
    .prepare(
      `SELECT edition, file_path FROM releases
        WHERE platform = ? AND file_path = ?
        ORDER BY published_at DESC LIMIT 1`,
    )
    .get(platform, file) as { edition: string; file_path: string } | undefined;
  // Even if not found in DB, still attempt to serve from disk by directory
  // — supports the case where edition was 'free' or 'pro' historically.
  const candidates: string[] = [];
  if (row) candidates.push(join(config.releasesDir, row.edition, platform, file));
  candidates.push(
    join(config.releasesDir, "all", platform, file),
    join(config.releasesDir, "free", platform, file),
    join(config.releasesDir, "pro", platform, file),
    join(config.releasesDir, platform, file),
  );

  const path = candidates.find((p) => existsSync(p));
  if (!path) return c.text("release not found", 404);

  const stat = statSync(path);
  const buf = readFileSync(path);

  // Log
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "?";
  const ua = c.req.header("user-agent") ?? null;
  const version = fileVersion(file) ?? "unknown";
  db.prepare(
    `INSERT INTO downloads (version, platform, edition, license_key, ip, user_agent, bytes_served)
     VALUES (?, ?, 'all', NULL, ?, ?, ?)`,
  ).run(version, platform, ip, ua, stat.size);

  c.header("content-type", "application/octet-stream");
  c.header("content-disposition", `attachment; filename="${basename(file)}"`);
  c.header("content-length", String(stat.size));
  return c.body(buf);
}

function fileVersion(file: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:[.-][\w]+)?)/.exec(file);
  return m ? m[1]! : null;
}

function versionGt(a: string, b: string): boolean {
  const parse = (s: string) =>
    s.split(".").map((p) => parseInt(p, 10) || 0);
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
