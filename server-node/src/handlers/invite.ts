/**
 * /api/v1/invite/* — 推广大使邀请码归因系统(v0.3.0)
 *
 * 唯一公开端点是 `validate` —— 客户端升级对话框输入码后调一次,确认有效
 * 性 + 拿到大使昵称做安抚展示。无折扣、无奖励叙事都在客户端外做。
 *
 * 归因写入 `invite_redemptions` 表的逻辑挂在 wechat webhook 里完成,
 * 见 handlers/payment.ts:202+。
 */

import { Hono } from "hono";
import type { AppEnv } from "../app.js";

export const inviteRouter = new Hono<AppEnv>();

/**
 * POST /api/v1/invite/validate
 *
 * Body: { code: "DOCMIND-AB12" }
 * Response (200):
 *   { ok: true,  code: "DOCMIND-AB12", ambassador: "B 站 UP @某某" }
 *   { ok: false, reason: "not_found" | "disabled" | "expired" }
 *
 * 客户端在用户输入推广码、点"校验"按钮时调用。返回成功表示码可用,
 * 客户端在请求 /payment/prepare 时把同一个 code 透传到 body.invite_code。
 * 后端 webhook 标记订单付款成功后,自动写入 invite_redemptions。
 */
inviteRouter.post("/validate", async (c) => {
  const { db } = c.var.app;
  const body = (await c.req.json().catch(() => ({}))) as { code?: string };
  const raw = String(body?.code ?? "").trim().toUpperCase();
  if (!raw) return c.json({ ok: false, reason: "missing_code" }, 400);

  // 限定格式,防止注入和奇怪输入。允许字母数字 + 短横线,长度 4-32。
  if (!/^[A-Z0-9-]{4,32}$/.test(raw)) {
    return c.json({ ok: false, reason: "not_found" });
  }

  const row = db
    .prepare(
      `SELECT code, ambassador, status, expires_at
         FROM invite_codes
        WHERE code = ?`,
    )
    .get(raw) as
    | { code: string; ambassador: string; status: string; expires_at: string | null }
    | undefined;

  if (!row) return c.json({ ok: false, reason: "not_found" });
  if (row.status !== "active") return c.json({ ok: false, reason: "disabled" });
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return c.json({ ok: false, reason: "expired" });
  }

  return c.json({
    ok: true,
    code: row.code,
    ambassador: row.ambassador,
  });
});
