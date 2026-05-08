/**
 * License activation endpoint.
 *
 *   POST /api/v1/license/activate
 *     { key, fingerprint, machine_label? }
 *   →
 *     200 { token_json: "<JSON-encoded LicenseToken>" }
 *     404 LICENSE_NOT_FOUND
 *     409 DEVICE_BOUND
 *     410 LICENSE_REVOKED
 *
 * No unbind path exists — licenses are bound to a single device for life.
 * The only re-bind allowed is when the same fingerprint comes back (e.g.
 * reinstall) — that path returns a freshly signed token.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { signToken } from "../license/sign.js";

const ActivateSchema = z.object({
  key: z.string().min(1),
  fingerprint: z.string().min(16),
  machine_label: z.string().optional().nullable(),
});

export const licenseRouter = new Hono<AppEnv>();

licenseRouter.post("/license/activate", async (c) => {
  const parsed = ActivateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.text("INVALID_REQUEST", 400);
  }

  const key = parsed.data.key.trim().toUpperCase();
  const fingerprint = parsed.data.fingerprint.toLowerCase();
  const label = parsed.data.machine_label ?? "";

  const { db, signingKey } = c.var.app;

  type Row = {
    plan: string;
    bound_fingerprint: string | null;
    revoked: number;
  };
  const row = db
    .prepare(
      `SELECT plan, bound_fingerprint,
              CASE WHEN COALESCE(note, '') LIKE 'REVOKED%' THEN 1 ELSE 0 END AS revoked
         FROM licenses WHERE key = ?`,
    )
    .get(key) as Row | undefined;

  if (!row) return c.text("LICENSE_NOT_FOUND", 404);
  if (row.revoked) return c.text("LICENSE_REVOKED", 410);

  // Binding check
  if (row.bound_fingerprint && row.bound_fingerprint.toLowerCase() !== fingerprint) {
    return c.text("DEVICE_BOUND", 409);
  }

  if (!row.bound_fingerprint) {
    db.prepare(
      `UPDATE licenses
          SET bound_fingerprint = ?, bound_at = datetime('now'), machine_label = ?
        WHERE key = ?`,
    ).run(fingerprint, label, key);
  }

  const issuedAt = new Date();
  const plan = row.plan === "trial" ? "trial" : "lifetime";
  const expiresAt =
    plan === "trial" ? new Date(issuedAt.getTime() + 5 * 86400 * 1000) : null;

  const tokenJson = await signToken(signingKey.privateKey, {
    key,
    plan,
    fingerprint,
    issuedAt,
    expiresAt,
  });

  return c.json({ token_json: tokenJson });
});
