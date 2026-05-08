/**
 * Updater manifest + binary downloads + download logging.
 *
 * Routes:
 *   GET /api/v1/updates/:platform/:current_version  → Tauri-format manifest
 *   GET /api/v1/releases/public                     → public changelog JSON
 *   GET /releases/free/:platform/:file              → public binary
 *   GET /releases/pro/:platform/:file               → token-gated binary
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
        WHERE platform = ? AND edition = 'free'
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
        url: `https://${config.domain}/releases/free/${platform}/${row.file_path}`,
      },
    },
  });
});

apiReleasesRouter.get("/releases/public", (c) => {
  const { db } = c.var.app;
  const rows = db
    .prepare(
      `SELECT version, published_at, COALESCE(notes, '') AS notes
         FROM releases
        GROUP BY version
        ORDER BY published_at DESC LIMIT 50`,
    )
    .all() as { version: string; published_at: string; notes: string }[];
  return c.json(rows);
});

// ── Static file router (mounted at /releases/*) ────────────────────────────
export const releasesRouter = new Hono<AppEnv>();

releasesRouter.get("/free/:platform/:file", (c) => serveFile(c, "free"));
releasesRouter.get("/pro/:platform/:file", (c) => {
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const licenseKey = extractKey(bearer);
  if (!licenseKey) return c.text("missing or invalid license token", 401);
  return serveFile(c, "pro", licenseKey);
});

function extractKey(tokenJson: string): string | null {
  try {
    const v = JSON.parse(tokenJson);
    if (typeof v?.key === "string") return v.key;
    return null;
  } catch {
    return null;
  }
}

async function serveFile(c: any, edition: "free" | "pro", licenseKey?: string) {
  const { db, config } = c.var.app;
  const platform = c.req.param("platform");
  const file = c.req.param("file");
  if (file.includes("..") || file.includes("/") || file.includes("\\")) {
    return c.text("bad filename", 400);
  }
  const path = join(config.releasesDir, edition, platform, file);
  if (!existsSync(path)) return c.text("release not found", 404);

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
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(version, platform, edition, licenseKey ?? null, ip, ua, stat.size);

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
