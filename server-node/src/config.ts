/**
 * Runtime configuration loaded from environment variables.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./payjs.js";

const env = (key: string, fallback = ""): string =>
  process.env[key] ?? fallback;

export const config = (() => {
  const dataDir = env("DATA_DIR", "/data");
  const dbPath = join(dataDir, "db", "docmind.sqlite");
  const keysDir = join(dataDir, "keys");
  const releasesDir = join(dataDir, "releases");
  for (const d of [dataDir, join(dataDir, "db"), keysDir, releasesDir]) {
    mkdirSync(d, { recursive: true });
  }

  const adminPassword = env("ADMIN_PASSWORD", "change-me");

  return {
    domain: env("DOMAIN", "doc-api.boyobang.com"),
    portalDomain: env("PORTAL_DOMAIN", "doc-web.boyobang.com"),
    listenPort: parseInt(env("PORT", "8081"), 10),
    listenHost: env("HOST", "0.0.0.0"),
    dataDir,
    dbPath,
    keysDir,
    releasesDir,
    adminUsername: env("ADMIN_USERNAME", "admin"),
    adminPassword,
    adminPasswordHash: sha256Hex(Buffer.from(adminPassword)),
    payjsMerchantId: env("PAYJS_MERCHANT_ID"),
    payjsKey: env("PAYJS_KEY"),
    payjsNotifyUrl: env(
      "PAYJS_NOTIFY_URL",
      `https://${env("DOMAIN", "doc-api.boyobang.com")}/api/v1/payment/payjs/webhook`
    ),
    priceLifetimeFen: parseInt(env("PRICE_LIFETIME_FEN", "2000"), 10),
  };
})();

export type Config = typeof config;
