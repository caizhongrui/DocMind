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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";

const SUPPORTED_PLATFORMS = new Set([
  "darwin-aarch64",
  "darwin-x86_64",
  "windows-x86_64",
]);

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

  // SQLite `datetime('now')` returns "YYYY-MM-DD HH:MM:SS" (UTC, space
  // separator). Tauri's updater parses pub_date as RFC3339 via the `time`
  // crate — it needs "T" between date+time and a "Z" timezone suffix.
  // Without this fix the whole manifest fails to parse and the client
  // silently sees no update.
  const pubDate = row.published_at.includes("T")
    ? row.published_at
    : row.published_at.replace(" ", "T") + "Z";

  return c.json({
    version: row.version,
    notes: row.notes ?? "",
    pub_date: pubDate,
    platforms: {
      [platform]: {
        signature: row.signature,
        url: `https://${config.domain}/releases/${platform}/${row.file_path}`,
      },
    },
  });
});

/**
 * Token-authed release publish — used by GitHub Actions to sync the
 * .app.tar.gz / .nsis.zip / .msi.zip updater bundles to this server
 * after a tagged build finishes.
 *
 * Auth: `Authorization: Bearer <RELEASES_PUBLISH_TOKEN>` (env var on
 * the server, secret in GitHub).
 *
 * Body: multipart/form-data with the same fields as the admin form:
 *   version    string  e.g. "0.1.3"
 *   platform   string  one of darwin-aarch64 / darwin-x86_64 / windows-x86_64
 *   notes      string  optional release notes
 *   signature  string  contents of the .sig file (minisign)
 *   binary     File    the updater bundle itself
 */
apiReleasesRouter.post("/releases/publish", async (c) => {
  const expected = process.env.RELEASES_PUBLISH_TOKEN;
  if (!expected) {
    return c.json({ error: "RELEASES_PUBLISH_TOKEN not set on server" }, 503);
  }
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || token !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const { db, config } = c.var.app;
  const form = await c.req.formData();
  const version = String(form.get("version") ?? "").trim();
  const platform = String(form.get("platform") ?? "").trim();
  const notes = String(form.get("notes") ?? "");
  const signature = String(form.get("signature") ?? "");
  const binary = form.get("binary");

  if (!version || !platform) return c.json({ error: "version + platform required" }, 400);
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return c.json({ error: `unsupported platform: ${platform}` }, 400);
  }
  if (!(binary instanceof File) || binary.size === 0) {
    return c.json({ error: "missing binary" }, 400);
  }

  const edition = "all";
  const dir = join(config.releasesDir, edition, platform);
  mkdirSync(dir, { recursive: true });
  const filename = binary.name;
  const dest = join(dir, filename);
  const bytes = Buffer.from(await binary.arrayBuffer());
  writeFileSync(dest, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");

  db.prepare(
    `INSERT INTO releases (version, platform, edition, file_path, sha256, size, signature, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(version, platform, edition) DO UPDATE SET
       file_path = excluded.file_path,
       sha256 = excluded.sha256,
       size = excluded.size,
       signature = excluded.signature,
       notes = excluded.notes`,
  ).run(version, platform, edition, filename, sha, bytes.length, signature, notes);

  console.log(`[releases] published ${platform} ${version} (${filename}, ${bytes.length} bytes)`);
  return c.json({
    ok: true,
    version,
    platform,
    file: filename,
    sha256: sha,
    size: bytes.length,
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
  c.header("access-control-allow-origin", "*");
  c.header("cache-control", "public, max-age=60");
  return c.json(rows);
});

/**
 * Latest release per platform — used by the portal's `/download` page to
 * show version numbers + active download links (or a "待上传" placeholder
 * when nothing has been published yet for a given platform).
 */
apiReleasesRouter.get("/releases/latest", (c) => {
  const { db, config } = c.var.app;
  const rows = db
    .prepare(
      `SELECT platform, version, file_path, size, published_at
         FROM releases r
        WHERE published_at = (
          SELECT MAX(published_at) FROM releases r2 WHERE r2.platform = r.platform
        )`,
    )
    .all() as Array<{
    platform: string;
    version: string;
    file_path: string;
    size: number;
    published_at: string;
  }>;

  const byPlatform: Record<
    string,
    {
      version: string;
      file: string;
      size: number;
      published_at: string;
      url: string;
    }
  > = {};
  for (const r of rows) {
    byPlatform[r.platform] = {
      version: r.version,
      file: r.file_path,
      size: r.size,
      published_at: r.published_at,
      url: `https://${config.domain}/releases/${encodeURIComponent(r.platform)}/${encodeURIComponent(r.file_path)}`,
    };
  }

  c.header("access-control-allow-origin", "*");
  c.header("cache-control", "public, max-age=60");
  return c.json(byPlatform);
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
