/**
 * Runtime configuration loaded from environment variables.
 */

import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./util.js";

const env = (key: string, fallback = ""): string =>
  process.env[key] ?? fallback;

/**
 * Read a PEM file, falling back to an inline env var if the path doesn't
 * exist. This lets the operator either:
 *   1. Mount the PEM file into the container and set ..._PATH
 *   2. Or paste the PEM text directly into ..._PEM (one-line, with \n)
 */
function readPem(pathEnv: string, inlineEnv: string): string {
  const path = env(pathEnv);
  if (path && existsSync(path)) {
    return readFileSync(path, "utf8");
  }
  const inline = env(inlineEnv);
  if (inline) return inline.replace(/\\n/g, "\n");
  return "";
}

export const config = (() => {
  const dataDir = env("DATA_DIR", "/data");
  const dbPath = join(dataDir, "db", "docmind.sqlite");
  const keysDir = join(dataDir, "keys");
  const releasesDir = join(dataDir, "releases");
  for (const d of [dataDir, join(dataDir, "db"), keysDir, releasesDir]) {
    mkdirSync(d, { recursive: true });
  }

  const adminPassword = env("ADMIN_PASSWORD", "change-me");

  const wechatMchId = env("WECHAT_MCH_ID");
  const wechatAppId = env("WECHAT_APP_ID");
  const wechatApiV3Key = env("WECHAT_API_V3_KEY");
  const wechatCertSerialNo = env("WECHAT_MCH_CERT_SERIAL_NO");
  const wechatPrivateKey = readPem("WECHAT_MCH_PRIVATE_KEY_PATH", "WECHAT_MCH_PRIVATE_KEY");
  const wechatPlatformCert = readPem("WECHAT_PLATFORM_CERT_PATH", "WECHAT_PLATFORM_CERT");
  // ID for the new "微信支付公钥" scheme (PUB_KEY_ID_xxx). Optional —
  // if set, callback verification additionally checks the Wechatpay-Serial
  // header matches this ID, producing a clearer error than a raw signature
  // mismatch when the wrong PEM is uploaded.
  const wechatPlatformKeyId = env("WECHAT_PLATFORM_KEY_ID");
  const domain = env("DOMAIN", "doc-api.boyobang.com");
  const wechatNotifyUrl = env(
    "WECHAT_NOTIFY_URL",
    `https://${domain}/api/v1/payment/wechat/webhook`,
  );

  return {
    domain,
    portalDomain: env("PORTAL_DOMAIN", "doc-web.boyobang.com"),
    listenPort: parseInt(env("PORT", "8080"), 10),
    listenHost: env("HOST", "0.0.0.0"),
    dataDir,
    dbPath,
    keysDir,
    releasesDir,
    adminUsername: env("ADMIN_USERNAME", "admin"),
    adminPassword,
    adminPasswordHash: sha256Hex(Buffer.from(adminPassword)),
    wechat: {
      mchId: wechatMchId,
      appId: wechatAppId,
      apiV3Key: wechatApiV3Key,
      certSerialNo: wechatCertSerialNo,
      privateKey: wechatPrivateKey,
      platformCert: wechatPlatformCert,
      platformKeyId: wechatPlatformKeyId,
      notifyUrl: wechatNotifyUrl,
    },
    priceLifetimeFen: parseInt(env("PRICE_LIFETIME_FEN", "2000"), 10),
  };
})();

export type Config = typeof config;
