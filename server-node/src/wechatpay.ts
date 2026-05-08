/**
 * 微信支付 API v3 集成。
 *
 * 用 Native(扫码)支付 + 退款。流程:
 *
 *   下单:
 *     1. 调 POST /v3/pay/transactions/native 拿 code_url
 *     2. 渲染二维码,用户用微信扫码完成支付
 *     3. 微信回调 notify_url(AES-256-GCM 加密 + RSA 签名)
 *     4. 验签 → 解密 → 拿到 trade_state 与 out_trade_no
 *
 *   退款:
 *     1. 调 POST /v3/refund/domestic/refunds(签名同上)
 *     2. 同步响应给出初始 status (SUCCESS / PROCESSING)
 *     3. 异步结果通过单独的 refund notify_url 回调
 *
 * 凭据来自商户后台:
 *   - 商户号 mchid
 *   - 应用 AppID
 *   - API v3 密钥(32 字符,AES key)
 *   - 商户 API 私钥 PEM(签名用)
 *   - 商户证书序列号(40 字符 hex)
 *   - 微信支付平台公钥 PEM 或证书 PEM(验证回调用)
 *   - (可选)平台公钥 ID(Wechatpay-Serial 头校验)
 */

import { createSign, createVerify, createDecipheriv, randomBytes } from "node:crypto";

export interface WechatPayCreds {
  mchId: string;
  appId: string;
  apiV3Key: string;       // 32 chars (used as AES-256-GCM key)
  privateKey: string;      // PEM
  certSerialNo: string;    // 40-char hex
  platformCert: string;    // PEM (public cert OR public key)
  platformKeyId?: string;  // Optional: PUB_KEY_ID_xxx for new public-key scheme
  notifyUrl: string;
}

export class WechatPay {
  constructor(private cfg: WechatPayCreds) {}

  /**
   * Build the Authorization header for an outbound API v3 request.
   * Spec: WECHATPAY2-SHA256-RSA2048 mchid="...",nonce_str="...",timestamp="...",serial_no="...",signature="..."
   */
  private signRequest(method: string, urlPath: string, body: string): string {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(16).toString("hex");
    const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`;
    const signature = createSign("RSA-SHA256")
      .update(message)
      .sign(this.cfg.privateKey, "base64");
    return (
      `WECHATPAY2-SHA256-RSA2048 ` +
      `mchid="${this.cfg.mchId}",` +
      `nonce_str="${nonce}",` +
      `timestamp="${ts}",` +
      `serial_no="${this.cfg.certSerialNo}",` +
      `signature="${signature}"`
    );
  }

  /**
   * Create a Native (扫码) prepay order. Returns the `code_url` that the
   * client renders as a QR code.
   */
  async createNativePrepay(args: {
    outTradeNo: string;
    description: string;
    amountFen: number;
    attach?: string;
  }): Promise<string> {
    const path = "/v3/pay/transactions/native";
    const body = JSON.stringify({
      appid: this.cfg.appId,
      mchid: this.cfg.mchId,
      description: args.description,
      out_trade_no: args.outTradeNo,
      notify_url: this.cfg.notifyUrl,
      amount: { total: args.amountFen, currency: "CNY" },
      ...(args.attach ? { attach: args.attach } : {}),
    });
    const auth = this.signRequest("POST", path, body);
    const resp = await fetch(`https://api.mch.weixin.qq.com${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: auth,
        "User-Agent": "DocMind-Server/1.0",
      },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`wechat prepay failed: ${resp.status} ${text}`);
    }
    const j = (await resp.json()) as { code_url?: string };
    if (!j.code_url) throw new Error(`wechat prepay returned no code_url`);
    return j.code_url;
  }

  /**
   * Apply for a refund against an existing transaction.
   *
   * POST /v3/refund/domestic/refunds
   *
   * Returns the parsed response. status is normally PROCESSING for
   * non-instant cases — final state arrives via the refund notify_url
   * callback. For some payment methods (small amounts to balance) it's
   * SUCCESS immediately.
   */
  async createRefund(args: {
    outTradeNo: string;
    outRefundNo: string;
    refundFen: number;
    totalFen: number;
    reason?: string;
    notifyUrl?: string;
  }): Promise<RefundResponse> {
    const path = "/v3/refund/domestic/refunds";
    const payload: Record<string, unknown> = {
      out_trade_no: args.outTradeNo,
      out_refund_no: args.outRefundNo,
      amount: {
        refund: args.refundFen,
        total: args.totalFen,
        currency: "CNY",
      },
    };
    if (args.reason) payload.reason = args.reason;
    if (args.notifyUrl) payload.notify_url = args.notifyUrl;
    const body = JSON.stringify(payload);
    const auth = this.signRequest("POST", path, body);
    const resp = await fetch(`https://api.mch.weixin.qq.com${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: auth,
        "User-Agent": "DocMind-Server/1.0",
      },
      body,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`wechat refund failed: ${resp.status} ${text}`);
    }
    return JSON.parse(text) as RefundResponse;
  }

  /**
   * Verify a callback's RSA-SHA256 signature against the platform's
   * public cert (or public key PEM, both are accepted by Node's
   * createVerify).
   *
   * Signing string: {timestamp}\n{nonce}\n{body}\n
   */
  verifyCallback(args: {
    timestamp: string;
    nonce: string;
    body: string;
    signature: string;
  }): boolean {
    const message = `${args.timestamp}\n${args.nonce}\n${args.body}\n`;
    try {
      return createVerify("RSA-SHA256")
        .update(message)
        .verify(this.cfg.platformCert, args.signature, "base64");
    } catch {
      return false;
    }
  }

  /**
   * Decrypt a callback's `resource` block using AES-256-GCM with the
   * APIv3 key. Returns the plaintext JSON.
   */
  decryptResource(args: {
    ciphertext: string;
    associatedData: string;
    nonce: string;
  }): string {
    const key = Buffer.from(this.cfg.apiV3Key, "utf8");
    if (key.length !== 32) {
      throw new Error("apiV3Key must be exactly 32 bytes");
    }
    const ciphertextBuf = Buffer.from(args.ciphertext, "base64");
    if (ciphertextBuf.length < 16) {
      throw new Error("ciphertext too short");
    }
    const tag = ciphertextBuf.subarray(ciphertextBuf.length - 16);
    const data = ciphertextBuf.subarray(0, ciphertextBuf.length - 16);

    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(args.nonce, "utf8"));
    decipher.setAAD(Buffer.from(args.associatedData, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    return plaintext.toString("utf8");
  }
}

/** Subset of fields returned by /v3/refund/domestic/refunds. */
export interface RefundResponse {
  refund_id: string;
  out_refund_no: string;
  transaction_id: string;
  out_trade_no: string;
  channel: string;
  user_received_account?: string;
  success_time?: string;
  create_time: string;
  status: "SUCCESS" | "CLOSED" | "PROCESSING" | "ABNORMAL";
  funds_account?: string;
  amount: {
    total: number;
    refund: number;
    payer_total: number;
    payer_refund: number;
    settlement_refund: number;
    settlement_total: number;
    discount_refund: number;
    currency: string;
  };
}

/** WeChat callback envelope (the JSON body POSTed to our notify_url). */
export interface WechatCallbackEnvelope {
  id: string;
  create_time: string;
  resource_type: string;
  event_type: string;
  summary: string;
  resource: {
    algorithm: "AEAD_AES_256_GCM";
    ciphertext: string;
    associated_data: string;
    nonce: string;
    original_type: string;
  };
}

/** Decrypted resource for transaction.success events. */
export interface WechatTransactionEvent {
  appid: string;
  mchid: string;
  out_trade_no: string;
  transaction_id: string;
  trade_type: string;
  trade_state: "SUCCESS" | "REFUND" | "NOTPAY" | "CLOSED" | "REVOKED" | "USERPAYING" | "PAYERROR";
  trade_state_desc: string;
  bank_type?: string;
  attach?: string;
  success_time: string;
  payer: { openid: string };
  amount: { total: number; payer_total: number; currency: string };
}

/** Decrypted resource for refund.success / refund.abnormal events. */
export interface WechatRefundEvent {
  mchid: string;
  out_trade_no: string;
  transaction_id: string;
  out_refund_no: string;
  refund_id: string;
  refund_status: "SUCCESS" | "CLOSED" | "PROCESSING" | "ABNORMAL";
  success_time?: string;
  amount: { total: number; refund: number; payer_total: number; payer_refund: number };
  user_received_account?: string;
}
