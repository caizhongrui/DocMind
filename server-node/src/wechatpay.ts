/**
 * 微信支付 API v3 集成。
 *
 * 用 Native(扫码)支付。流程:
 *
 *   1. 服务器调用 POST /v3/pay/transactions/native 拿到 code_url。
 *   2. 服务器把 code_url 渲染成二维码,用户用微信扫码完成支付。
 *   3. 微信支付通过 notify_url 回调通知服务器,回调内容用 AES-256-GCM
 *      加密 + 平台证书 RSA 签名。
 *   4. 服务器验签 → 解密 → 拿到 out_trade_no、transaction_id 等。
 *
 * 所有需要的凭据来自商户后台:
 *   - 商户号 mchid
 *   - 应用 AppID(公众号 / 小程序 / 服务号 与商户绑定后的)
 *   - API v3 密钥(32 字符,商户后台手动设置,AES key)
 *   - 商户 API 私钥 PEM(apiclient_key.pem,出请求时签名用)
 *   - 商户证书序列号(40 字符 hex,与私钥配对)
 *   - 微信支付平台证书 PEM(验证回调签名用)
 *
 * 注意:平台证书会定期轮换(~1 年),需要手动更新或调
 * GET /v3/certificates 自动获取。本实现要求手动维护。
 */

import { createSign, createVerify, createDecipheriv, randomBytes } from "node:crypto";

export interface WechatPayCreds {
  mchId: string;
  appId: string;
  apiV3Key: string; // 32 chars (used as AES-256-GCM key)
  privateKey: string; // PEM
  certSerialNo: string; // 40-char hex
  platformCert: string; // PEM (public cert from /v3/certificates)
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
   * Verify a callback's RSA-SHA256 signature against the platform's
   * public cert. Inputs come from the request headers.
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
