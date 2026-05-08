import { Modal, Typography, Button, Space, Divider } from "antd";
import { CrownOutlined, ThunderboltOutlined, CheckCircleOutlined } from "@ant-design/icons";
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLicenseStore } from "../stores/licenseStore";

const PORTAL_PRICING_URL = "https://doc-web.boyobang.com/pricing";

const REASON_TITLE: Record<string, string> = {
  custom_gguf: "导入自定义模型 — Pro 功能",
  model_tier: "高级模型档位 — Pro 功能",
  batch_summary: "批量摘要 — Pro 功能",
  ocr_indexing: "OCR / 扫描件索引 — Pro 功能",
  conversation_export: "导出对话 — Pro 功能",
  scheduled_reindex: "定时重索引 — Pro 功能",
  quota_exceeded: "本月免费 AI 配额已用完",
};

const REASON_DESC: Record<string, string> = {
  custom_gguf:
    "Pro 用户可以导入任意 .gguf 模型文件，自由切换适合自己机器的 LLM。Free / 试用版只能使用内置 0.6B 模型。",
  model_tier:
    "Free 用户只能使用 0.6B 轻量模型。升级 Pro 解锁 1.7B、4B 等更高参数量模型，问答深度显著提升。",
  batch_summary:
    "批量摘要会让 AI 同时阅读多份文档（最多 10 份）输出汇总报告，是合同对比、纪要提炼等场景的利器。Pro 解锁。",
  ocr_indexing:
    "扫描件 PDF 与图片需要 OCR 引擎提取文字，索引到搜索库中。Pro 解锁系统原生 OCR（macOS Vision / Windows OCR）支持。",
  conversation_export: "Pro 用户可将完整对话导出为 Markdown 文档。",
  scheduled_reindex: "Pro 用户可设置定时重索引（如每 30 分钟扫描一次新文件）。",
  quota_exceeded:
    "Free 用户每月可发起 30 次 AI 调用（语义搜索 + 问答合并计数）。本月配额已用完，将于下个月初自动重置。Pro 用户无配额限制。",
};

export default function UpgradeDialog() {
  const upgradeRequest = useLicenseStore((s) => s.upgradeRequest);
  const closeUpgrade = useLicenseStore((s) => s.closeUpgrade);
  const status = useLicenseStore((s) => s.status);

  const [activationOpen, setActivationOpen] = useState(false);
  const [activationMode, setActivationMode] = useState<"online" | "offline">("online");
  const [keyInput, setKeyInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [fingerprintCopied, setFingerprintCopied] = useState(false);

  const visible = upgradeRequest !== null;

  useEffect(() => {
    if (!visible) {
      setActivationOpen(false);
      setActivationMode("online");
      setKeyInput("");
      setTokenInput("");
      setActivationError(null);
      setFingerprintCopied(false);
    }
  }, [visible]);

  if (!visible) return null;

  const reason = upgradeRequest?.reason ?? "";
  const title = REASON_TITLE[reason] ?? "解锁 Pro 功能";
  const desc =
    upgradeRequest?.message ?? REASON_DESC[reason] ?? "升级到 Pro 解锁此功能。";

  const handleBuy = () => {
    invoke("plugin:opener|open_url", { url: PORTAL_PRICING_URL }).catch(() => {
      window.open(PORTAL_PRICING_URL, "_blank");
    });
  };

  const handleActivate = async () => {
    setActivationError(null);
    setActivating(true);
    try {
      const fingerprint = await invoke<string>("get_hardware_fingerprint");
      const apiBase = "https://doc-api.boyobang.com";
      const resp = await fetch(`${apiBase}/api/v1/license/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: keyInput.trim(), fingerprint }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`服务器返回 ${resp.status}: ${text}`);
      }
      const data = (await resp.json()) as { token_json: string };
      await invoke("install_license_token", { input: { token_json: data.token_json } });
      closeUpgrade();
    } catch (e) {
      setActivationError(e instanceof Error ? e.message : String(e));
    } finally {
      setActivating(false);
    }
  };

  const handleOfflineActivate = async () => {
    setActivationError(null);
    setActivating(true);
    try {
      const trimmed = tokenInput.trim();
      if (!trimmed) throw new Error("请粘贴管理员发给你的 token JSON");
      // sanity check: should parse as JSON
      try {
        JSON.parse(trimmed);
      } catch {
        throw new Error("不是合法的 JSON,请检查复制是否完整");
      }
      await invoke("install_license_token", { input: { token_json: trimmed } });
      closeUpgrade();
    } catch (e) {
      setActivationError(e instanceof Error ? e.message : String(e));
    } finally {
      setActivating(false);
    }
  };

  const copyFingerprint = async () => {
    if (!status?.fingerprint) return;
    try {
      await navigator.clipboard.writeText(status.fingerprint);
      setFingerprintCopied(true);
      setTimeout(() => setFingerprintCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <Modal
      open={visible}
      onCancel={closeUpgrade}
      footer={null}
      width={460}
      centered
      maskClosable
      destroyOnHidden
    >
      <div style={{ padding: "8px 4px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: "var(--color-primary-bg)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <CrownOutlined style={{ color: "var(--color-primary)", fontSize: 18 }} />
          </div>
          <Typography.Title level={5} style={{ margin: 0, color: "var(--color-text)" }}>
            {title}
          </Typography.Title>
        </div>

        <Typography.Paragraph type="secondary" style={{ fontSize: 13, lineHeight: 1.7 }}>
          {desc}
        </Typography.Paragraph>

        {/* Pricing summary */}
        <div
          style={{
            background: "var(--color-surface-elevated)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            padding: "12px 14px",
            marginBottom: 12,
          }}
        >
          <div className="section-label" style={{ marginBottom: 8 }}>
            DocMind Pro
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 8 }}>
            <span style={{ fontSize: 24, fontWeight: 700, color: "var(--color-text)" }}>¥20</span>
            <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>终身买断</span>
          </div>
          <Space direction="vertical" size={4} style={{ fontSize: 12 }}>
            {[
              "无限 AI 问答 / 语义搜索",
              "全部模型档位（0.6B / 1.7B / 4B）+ 自定义 GGUF",
              "OCR 索引扫描件与图片",
              "批量摘要 / 对话导出 / 定时重索引",
              "终身免费更新",
            ].map((line) => (
              <div key={line} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <CheckCircleOutlined style={{ color: "#22c55e", fontSize: 11 }} />
                <span style={{ color: "var(--color-text-secondary)" }}>{line}</span>
              </div>
            ))}
          </Space>
          <div
            style={{
              marginTop: 10,
              padding: "6px 10px",
              borderRadius: 6,
              background: "rgba(245,158,11,0.08)",
              border: "1px solid rgba(245,158,11,0.25)",
              fontSize: 11,
              color: "#92400e",
              lineHeight: 1.6,
            }}
          >
            ⚠️ License 绑定到当前设备，无法转移到其他机器。请确认在常用设备上完成激活。
          </div>
        </div>

        {!activationOpen ? (
          <Space style={{ width: "100%", justifyContent: "space-between" }}>
            <Button type="link" size="small" onClick={() => setActivationOpen(true)}>
              已购买，激活
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={handleBuy}
              style={{ borderRadius: 6 }}
            >
              立即购买
            </Button>
          </Space>
        ) : (
          <div>
            <Divider style={{ margin: "8px 0 12px" }} />

            {/* Mode tabs */}
            <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
              <button
                type="button"
                onClick={() => {
                  setActivationMode("online");
                  setActivationError(null);
                }}
                style={{
                  flex: 1,
                  padding: "6px 12px",
                  fontSize: 12,
                  fontWeight: activationMode === "online" ? 600 : 500,
                  color: activationMode === "online" ? "var(--color-primary)" : "var(--color-text-secondary)",
                  background: activationMode === "online" ? "var(--color-primary-bg)" : "transparent",
                  border: `1px solid ${activationMode === "online" ? "var(--color-primary)" : "var(--color-border)"}`,
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                在线激活
              </button>
              <button
                type="button"
                onClick={() => {
                  setActivationMode("offline");
                  setActivationError(null);
                }}
                style={{
                  flex: 1,
                  padding: "6px 12px",
                  fontSize: 12,
                  fontWeight: activationMode === "offline" ? 600 : 500,
                  color: activationMode === "offline" ? "var(--color-primary)" : "var(--color-text-secondary)",
                  background: activationMode === "offline" ? "var(--color-primary-bg)" : "transparent",
                  border: `1px solid ${activationMode === "offline" ? "var(--color-primary)" : "var(--color-border)"}`,
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                离线激活
              </button>
            </div>

            {activationMode === "online" ? (
              <>
                <div className="section-label" style={{ marginBottom: 8 }}>
                  输入激活码
                </div>
                <input
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="DM-XXXX-XXXX-XXXX-XXXX-XXXX"
                  spellCheck={false}
                  autoFocus
                  className="mono"
                  style={{
                    width: "100%",
                    height: 36,
                    padding: "0 12px",
                    fontSize: 13,
                    background: "var(--color-surface-elevated)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    color: "var(--color-text)",
                    outline: "none",
                  }}
                />
                <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 6 }}>
                  当前设备指纹:
                  <span className="mono" style={{ marginLeft: 4 }}>
                    {status?.fingerprint?.slice(0, 16) ?? "...."}…
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="section-label" style={{ marginBottom: 8 }}>
                  Step 1 — 把这串硬件指纹发给客服
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    background: "var(--color-surface-elevated)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    padding: "8px 12px",
                    marginBottom: 12,
                  }}
                >
                  <code
                    className="mono"
                    style={{
                      flex: 1,
                      fontSize: 12,
                      color: "var(--color-text)",
                      wordBreak: "break-all",
                    }}
                  >
                    {status?.fingerprint ?? "..."}
                  </code>
                  <Button size="small" onClick={copyFingerprint}>
                    {fingerprintCopied ? "已复制" : "复制"}
                  </Button>
                </div>

                <div className="section-label" style={{ marginBottom: 8 }}>
                  Step 2 — 粘贴客服返回的 token JSON
                </div>
                <textarea
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder='{"v":1,"key":"DM-...","plan":"lifetime","fingerprint":"...","issued_at":"...","sig":"..."}'
                  spellCheck={false}
                  className="mono"
                  rows={6}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    fontSize: 11,
                    background: "var(--color-surface-elevated)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    color: "var(--color-text)",
                    outline: "none",
                    fontFamily: "var(--font-mono)",
                    resize: "vertical",
                  }}
                />
              </>
            )}

            {activationError && (
              <div
                style={{
                  marginTop: 8,
                  padding: "6px 10px",
                  borderRadius: 6,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.25)",
                  fontSize: 12,
                  color: "#dc2626",
                }}
              >
                {activationError}
              </div>
            )}
            <Space style={{ marginTop: 12, width: "100%", justifyContent: "flex-end" }}>
              <Button size="small" onClick={() => setActivationOpen(false)}>
                返回
              </Button>
              {activationMode === "online" ? (
                <Button
                  type="primary"
                  size="small"
                  loading={activating}
                  disabled={keyInput.trim().length < 10}
                  onClick={handleActivate}
                >
                  激活
                </Button>
              ) : (
                <Button
                  type="primary"
                  size="small"
                  loading={activating}
                  disabled={tokenInput.trim().length < 50}
                  onClick={handleOfflineActivate}
                >
                  离线激活
                </Button>
              )}
            </Space>
          </div>
        )}
      </div>
    </Modal>
  );
}
