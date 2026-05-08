/**
 * Ed25519 keypair management.
 *
 * On first start the server generates a fresh keypair under `keys/` and
 * prints the public key — the operator copies it into the desktop client's
 * `SERVER_PUBLIC_KEY_HEX` constant before shipping.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";

const PRIV_FILE = "ed25519.priv";
const PUB_FILE = "ed25519.pub";

export interface SigningKey {
  privateKey: Uint8Array; // 32 bytes
  publicKey: Uint8Array;  // 32 bytes
  publicKeyHex: string;
}

export async function loadOrGenerate(dir: string): Promise<SigningKey> {
  mkdirSync(dir, { recursive: true });
  const privPath = join(dir, PRIV_FILE);
  const pubPath = join(dir, PUB_FILE);

  if (existsSync(privPath)) {
    const priv = readFileSync(privPath);
    if (priv.length !== 32) {
      throw new Error(
        `${privPath} is not a 32-byte Ed25519 secret key (got ${priv.length} bytes)`
      );
    }
    const pub = await ed.getPublicKeyAsync(priv);
    return {
      privateKey: priv,
      publicKey: pub,
      publicKeyHex: Buffer.from(pub).toString("hex"),
    };
  }

  console.warn(
    `[keys] no signing key at ${privPath}; generating a new keypair. ` +
      `REMEMBER to bake the printed public key into the desktop client ` +
      `(src-tauri/src/license/token.rs SERVER_PUBLIC_KEY_HEX) before shipping.`
  );

  const priv = randomBytes(32);
  const pub = await ed.getPublicKeyAsync(priv);
  writeFileSync(privPath, priv);
  writeFileSync(pubPath, Buffer.from(pub).toString("hex") + "\n");
  try {
    chmodSync(privPath, 0o600);
  } catch {
    // best-effort on Windows / non-POSIX
  }

  console.log("=================================================================");
  console.log("  DocMind license server — new Ed25519 keypair generated");
  console.log("  Public key (hex):");
  console.log(`  ${Buffer.from(pub).toString("hex")}`);
  console.log("  Bake this into the desktop client before publishing the next");
  console.log("  release.");
  console.log("=================================================================");

  return {
    privateKey: priv,
    publicKey: pub,
    publicKeyHex: Buffer.from(pub).toString("hex"),
  };
}
