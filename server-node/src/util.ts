import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function randomTicket(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}
