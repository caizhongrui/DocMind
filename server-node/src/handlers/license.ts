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

const TRIAL_DAYS = 5;

const ActivateSchema = z.object({
  key: z.string().min(1),
  fingerprint: z.string().min(16),
  machine_label: z.string().optional().nullable(),
});

const StartTrialSchema = z.object({
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

/**
 * Start (or re-issue) a 5-day Pro trial for the given hardware fingerprint.
 *
 * The server is the **only** place trial eligibility is tracked. Each
 * fingerprint can start exactly one trial; deleting local files on the
 * client does not reset it. If a trial is already on file:
 *   - still inside its 5-day window → re-sign a token with the SAME
 *     expires_at (idempotent for re-installs)
 *   - already expired → 409 TRIAL_ALREADY_USED
 */
licenseRouter.post("/license/start_trial", async (c) => {
  const parsed = StartTrialSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.text("INVALID_REQUEST", 400);

  const fingerprint = parsed.data.fingerprint.toLowerCase().trim();
  const machineLabel = parsed.data.machine_label ?? "";
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "?";
  const ua = c.req.header("user-agent") ?? "";

  const { db, signingKey } = c.var.app;

  type Row = { started_at: string; expires_at: string };
  const existing = db
    .prepare(`SELECT started_at, expires_at FROM trials WHERE fingerprint = ?`)
    .get(fingerprint) as Row | undefined;

  let issuedAt: Date;
  let expiresAt: Date;

  if (existing) {
    const exp = new Date(existing.expires_at);
    if (Number.isNaN(exp.getTime()) || exp < new Date()) {
      return c.text("TRIAL_ALREADY_USED", 409);
    }
    // Same fingerprint, trial still active — re-issue token with the same
    // expires_at so reinstalls don't get "free" extra days.
    issuedAt = new Date();
    expiresAt = exp;
  } else {
    issuedAt = new Date();
    expiresAt = new Date(issuedAt.getTime() + TRIAL_DAYS * 86400 * 1000);
    db.prepare(
      `INSERT INTO trials (fingerprint, started_at, expires_at, machine_label, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      fingerprint,
      issuedAt.toISOString(),
      expiresAt.toISOString(),
      machineLabel,
      ip,
      ua,
    );
  }

  // The token's `key` field is required by the schema; for trials we use a
  // synthetic prefix so admin UIs can tell them apart from purchased keys.
  const tokenJson = await signToken(signingKey.privateKey, {
    key: `TRIAL-${fingerprint.slice(0, 16).toUpperCase()}`,
    plan: "trial",
    fingerprint,
    issuedAt,
    expiresAt,
  });
  return c.json({ token_json: tokenJson });
});
