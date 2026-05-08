/**
 * License token format + Ed25519 signing.
 *
 * Wire format **must** match the Rust client's `LicenseToken` struct exactly,
 * including JSON field order — the canonical signing payload depends on it.
 *
 * Token JSON shape:
 *   {
 *     "v": 1,
 *     "key": "DM-XXXX-XXXX-XXXX-XXXX-XXXX",
 *     "plan": "lifetime" | "trial",
 *     "fingerprint": "<sha256_hex_32>",
 *     "issued_at": "<RFC3339>",
 *     "expires_at": "<RFC3339>" | null,
 *     "sig": "<base64_ed25519_signature>"
 *   }
 *
 * Signing process:
 *   1. Build token with `sig: ""`.
 *   2. JSON.stringify with the exact key order shown above.
 *   3. Ed25519-sign the UTF-8 bytes.
 *   4. base64-encode the signature and place it in `sig`.
 */

import * as ed from "@noble/ed25519";

export type TokenPlan = "lifetime" | "trial";

export interface LicenseToken {
  v: number;
  key: string;
  plan: TokenPlan;
  fingerprint: string;
  issued_at: string;
  expires_at: string | null;
  sig: string;
}

const KEY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // base32-ish, no I/O/0/1

/** Generate a fresh license key string (DM-XXXX-XXXX-XXXX-XXXX-XXXX). */
export function generateKey(): string {
  const chunks: string[] = [];
  for (let c = 0; c < 5; c++) {
    let chunk = "";
    for (let i = 0; i < 4; i++) {
      const idx = Math.floor(Math.random() * KEY_CHARS.length);
      chunk += KEY_CHARS[idx]!;
    }
    chunks.push(chunk);
  }
  return `DM-${chunks.join("-")}`;
}

/**
 * Sign a license token. Returns the fully-formed JSON string ready to be
 * stored or returned to the client.
 */
export async function signToken(
  privateKey: Uint8Array,
  args: {
    key: string;
    plan: TokenPlan;
    fingerprint: string;
    issuedAt: Date;
    expiresAt: Date | null;
  },
): Promise<string> {
  const token: LicenseToken = {
    v: 1,
    key: args.key,
    plan: args.plan,
    fingerprint: args.fingerprint,
    issued_at: args.issuedAt.toISOString(),
    expires_at: args.expiresAt ? args.expiresAt.toISOString() : null,
    sig: "",
  };
  // JSON.stringify preserves insertion order in modern V8/Node — and since
  // the struct above has the canonical order, this matches the Rust side.
  const payload = JSON.stringify(token);
  const sig = await ed.signAsync(new TextEncoder().encode(payload), privateKey);
  token.sig = Buffer.from(sig).toString("base64");
  return JSON.stringify(token);
}
