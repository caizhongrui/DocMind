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
  if (existsSync(PORTAL_ROOT)) {
    app.use("*", async (c, next) => {
      const host = (c.req.header("host") ?? "").toLowerCase().split(":")[0];
      if (host === config.portalDomain.toLowerCase()) {
        // Try the file first; if it doesn't exist, fall back to /index.html
        // so direct navigation to /pricing etc still works.
        const handler = serveStatic({ root: PORTAL_ROOT });
        const res = await handler(c, async () => {});
        if (res && (res as Response).status !== 404) return res;
        // Astro produces directory-style routes — try {path}/index.html
        const path = new URL(c.req.url).pathname;
        if (!path.endsWith("/")) {
          const idx = serveStatic({
            root: PORTAL_ROOT,
            rewriteRequestPath: () => `${path}/index.html`,
          });
          const res2 = await idx(c, async () => {});
          if (res2 && (res2 as Response).status !== 404) return res2;
        }
        // Final fallback to the SPA root.
        const fallback = serveStatic({
          root: PORTAL_ROOT,
          rewriteRequestPath: () => "/index.html",
        });
        const res3 = await fallback(c, async () => {});
        if (res3) return res3;
      }
      return next();
    });
  } else {
    console.warn(
      `[server] PORTAL_ROOT ${PORTAL_ROOT} not found — portal will 404.`,
    );
  }

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

