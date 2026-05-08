/**
 * DocMind self-hosted backend (Node 20 + Hono + better-sqlite3).
 *
 * Single Node process serves three logical surfaces, distinguished by the
 * incoming `Host` header (set by the upstream BT Nginx reverse proxy):
 *
 *   - Host = doc-web.boyobang.com  → static Astro portal under /app/portal
 *   - Host = doc-api.boyobang.com  → JSON API + admin HTML + activate page
 *   - any other host (loopback)    → falls through to the API surface
 *
 * SSL is terminated upstream; this process only speaks plain HTTP.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { config } from "./config.js";
import { openDb } from "./db/index.js";
import { loadOrGenerate } from "./license/keys.js";
import type { AppEnv } from "./app.js";
import { licenseRouter } from "./handlers/license.js";
import { paymentRouter, paymentSuccessHandler } from "./handlers/payment.js";
import { apiReleasesRouter, releasesRouter } from "./handlers/releases.js";
import { adminRouter } from "./handlers/admin.js";
import { publicRouter } from "./handlers/public.js";
import { existsSync } from "node:fs";

const PORTAL_ROOT = process.env.PORTAL_ROOT ?? "/app/portal";

async function main() {
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === "change-me") {
    console.error(
      "[entrypoint] ERROR: ADMIN_PASSWORD must be set (and not 'change-me').",
    );
    process.exit(1);
  }

  const db = openDb(config.dbPath);
  const signingKey = await loadOrGenerate(config.keysDir);
  console.log(
    `[server] starting on ${config.listenHost}:${config.listenPort} ` +
      `(domain=${config.domain}, portal=${config.portalDomain})`,
  );
  console.log(`[server] ed25519 public key: ${signingKey.publicKeyHex}`);

  const app = new Hono<AppEnv>();

  // Inject app context into every request.
  app.use(async (c, next) => {
    c.set("app", { db, signingKey, config });
    await next();
  });

  // Portal static files (only when Host matches the portal domain).
  // Each request that hits the portal is logged into `portal_access`.
  const portalAvailable = existsSync(PORTAL_ROOT);
  if (!portalAvailable) {
    console.warn(
      `[server] PORTAL_ROOT ${PORTAL_ROOT} not found — portal will 404.`,
    );
  }

  app.use("*", async (c, next) => {
    const host = (c.req.header("host") ?? "").toLowerCase().split(":")[0];
    if (host !== config.portalDomain.toLowerCase()) return next();
    if (!portalAvailable) return next();

    // Skip serving / logging non-portal paths (caller is hitting the wrong
    // subdomain). Returning 404 is more honest than silently 200ing the SPA.
    const reqPath = new URL(c.req.url).pathname;
    const isApiOrAdmin =
      reqPath.startsWith("/api/") ||
      reqPath.startsWith("/admin") ||
      reqPath.startsWith("/payment/") ||
      reqPath.startsWith("/releases/") ||
      reqPath === "/activate";
    if (isApiOrAdmin) {
      return c.text("Not found on portal domain — try doc-api host", 404);
    }

    const ip = clientIp(c);
    const ua = c.req.header("user-agent") ?? null;
    const referer = c.req.header("referer") ?? null;

    // Try direct file → /index.html in directory → SPA fallback to /
    const handler = serveStatic({ root: PORTAL_ROOT });
    let res = await handler(c, async () => {});
    if (!res || (res as Response).status === 404) {
      if (!reqPath.endsWith("/")) {
        const idx = serveStatic({
          root: PORTAL_ROOT,
          rewriteRequestPath: () => `${reqPath}/index.html`,
        });
        const r2 = await idx(c, async () => {});
        if (r2 && (r2 as Response).status !== 404) res = r2;
      }
    }
    if (!res || (res as Response).status === 404) {
      const fallback = serveStatic({
        root: PORTAL_ROOT,
        rewriteRequestPath: () => "/index.html",
      });
      res = (await fallback(c, async () => {})) ?? res;
    }

    const status = res ? (res as Response).status : 404;
    const lenHeader = res ? (res as Response).headers.get("content-length") : null;
    const bytes = lenHeader ? parseInt(lenHeader, 10) : null;
    try {
      db.prepare(
        `INSERT INTO portal_access (method, path, status, ip, user_agent, referer, bytes_served)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(c.req.method, reqPath, status, ip, ua, referer, bytes);
    } catch (e) {
      console.warn("[portal_access] log failed:", e);
    }
    if (res) return res;
    return c.text("Not Found", 404);
  });

  // API surface (mounted unconditionally — the portal middleware above
  // short-circuits doc-web requests before they reach here).
  app.route("/api/v1", licenseRouter);
  app.route("/api/v1/payment", paymentRouter);
  app.route("/api/v1", apiReleasesRouter);
  app.route("/releases", releasesRouter);
  app.route("/admin", adminRouter);

  // Public-facing pages on doc-api.* host.
  app.get("/payment/success", paymentSuccessHandler() as any);
  app.route("/", publicRouter);

  serve(
    {
      fetch: app.fetch,
      hostname: config.listenHost,
      port: config.listenPort,
    },
    (info) => {
      console.log(`[server] listening on ${info.address}:${info.port}`);
    },
  );
}

main().catch((e) => {
  console.error("[server] fatal:", e);
  process.exit(1);
});

function clientIp(c: any): string {
  const xff = c.req.header("x-forwarded-for") as string | undefined;
  if (xff) return xff.split(",")[0]!.trim();
  const xri = c.req.header("x-real-ip") as string | undefined;
  if (xri) return xri.trim();
  return "?";
}

