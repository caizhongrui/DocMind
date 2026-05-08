import { Tooltip, Popconfirm, message } from "antd";
import { CrownOutlined } from "@ant-design/icons";
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLicenseStore } from "../stores/licenseStore";

function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  const expires = new Date(iso).getTime();
  const now = Date.now();
  if (Number.isNaN(expires)) return null;
  return Math.max(0, Math.ceil((expires - now) / (1000 * 60 * 60 * 24)));
}

export default function LicenseStatusBar() {
  const status = useLicenseStore((s) => s.status);
  const refresh = useLicenseStore((s) => s.refresh);
  const showUpgrade = useLicenseStore((s) => s.showUpgrade);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!status) return null;

  if (status.plan === "pro") {
    const handleClear = async () => {
      try {
        await invoke("clear_license");
        await refresh();
        message.success("已清除本机激活");
      } catch (e) {
        message.error(`清除失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    return (
      <Popconfirm
        title="清除本机激活?"
        description={
          <div style={{ fontSize: 12, lineHeight: 1.6, maxWidth: 240 }}>
            <div>仅限本机生效。License Key 在服务端仍绑定到当前指纹,</div>
            <div>可随时再粘贴 token JSON 重新激活。</div>
          </div>
        }
        okText="清除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onConfirm={handleClear}
      >
        <Tooltip
          title={
            <div style={{ fontSize: 12, lineHeight: 1.6 }}>
              <div>已激活 DocMind Pro</div>
              <div style={{ opacity: 0.8 }}>License: {status.license_key?.slice(0, 19)}…</div>
              <div style={{ opacity: 0.8 }}>设备指纹: {status.fingerprint.slice(0, 16)}…</div>
              <div style={{ opacity: 0.6, marginTop: 4 }}>(点击可重置,用于本机测试)</div>
            </div>
          }
        >
          <button
            className="chip chip-pro"
            style={{
              height: 22,
              padding: "0 8px",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <CrownOutlined style={{ fontSize: 11 }} />
            Pro
          </button>
        </Tooltip>
      </Popconfirm>
    );
  }

  if (status.plan === "trial") {
    const left = daysLeft(status.expires_at);
    return (
      <Tooltip title="点击购买 Pro 永久解锁">
        <button
          onClick={() => showUpgrade("trial_promo")}
          className="chip chip-trial"
          style={{
            height: 22,
            padding: "0 8px",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <CrownOutlined style={{ fontSize: 11 }} />
          Trial · {left !== null ? `${left}d left` : "active"}
        </button>
      </Tooltip>
    );
  }

  // Free
  const used = status.quota.used;
  const limit = status.quota.limit;
  const remaining = status.quota.remaining;
  const lowQuota = remaining <= 5;

  return (
    <Tooltip
      title={
        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
          <div>本月 AI 调用 {used}/{limit}</div>
          <div style={{ opacity: 0.8 }}>升级 Pro 解锁无限调用与全部高级功能</div>
        </div>
      }
    >
      <button
        onClick={() => showUpgrade("free_promo")}
        className="chip"
        style={{
          height: 22,
          padding: "0 8px",
          cursor: "pointer",
          fontFamily: "inherit",
          // Low-quota → red border to flag urgency, distinct from
          // the Trial (amber) and Pro (gold) chips so plan and
          // quota stay decoupled visually.
          ...(lowQuota
            ? {
                color: "#dc2626",
                borderColor: "#dc2626",
                background: "rgba(239, 68, 68, 0.10)",
                fontWeight: 600,
              }
            : {}),
        }}
      >
        Free · <span className="mono">{used}/{limit}</span>
      </button>
    </Tooltip>
  );
}
