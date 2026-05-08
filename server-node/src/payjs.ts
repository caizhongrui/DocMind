/**
 * PayJS sign / verify + a few hash helpers.
 *
 * PayJS uses MD5 over a sorted key=value query plus the merchant key.
 * Reference: https://payjs.cn/api
 */

import { createHash } from "node:crypto";

export function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function md5UpperHex(input: string): string {
  return createHash("md5").update(input).digest("hex").toUpperCase();
}

export function payjsSign(
  params: Record<string, string>,
  merchantKey: string,
): string {
  const sorted = Object.keys(params)
    .filter((k) => k !== "sign" && params[k] !== "" && params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return md5UpperHex(`${sorted}&key=${merchantKey}`);
}

export function payjsVerify(
  params: Record<string, string>,
  merchantKey: string,
): boolean {
  const provided = params.sign;
  if (!provided) return false;
  const expected = payjsSign(params, merchantKey);
  return provided.toUpperCase() === expected;
}
