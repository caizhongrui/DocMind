import { useEffect, useRef, useState } from "react";
import { Modal, Button, Progress, Typography, Space } from "antd";
import { CloudDownloadOutlined } from "@ant-design/icons";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Background updater. Pings the server's `/api/v1/updates/...` endpoint
 * shortly after launch and again every 6 hours; surfaces a non-modal
 * banner-style modal when a newer signed bundle is available so the user
 * can decide whether to download right now or skip.
 *
 * The user's license (license.json in app_data_dir) is unaffected —
 * Tauri's updater only swaps the .app bundle, leaving user data alone.
 */
const FIRST_CHECK_DELAY_MS = 30_000;       // 30s after launch
const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60_000; // 6h
const SKIPPED_VERSIONS_KEY = "docmind.updater.skippedVersions";

type Phase = "idle" | "available" | "downloading" | "installed" | "error";

function loadSkipped(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SKIPPED_VERSIONS_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}
function rememberSkipped(version: string) {
  const cur = loadSkipped();
  cur.add(version);
  localStorage.setItem(SKIPPED_VERSIONS_KEY, JSON.stringify([...cur]));
}

export default function UpdateNotifier() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [downloaded, setDownloaded] = useState(0);
  const [contentLength, setContentLength] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isCheckingRef = useRef(false);

  // Periodic + startup check.
  useEffect(() => {
    let cancelled = false;
    const runCheck = async () => {
      if (isCheckingRef.current || cancelled) return;
      isCheckingRef.current = true;
      try {
        const u = await check();
        if (cancelled) return;
        if (!u) return; // up to date
        if (loadSkipped().has(u.version)) return; // user said no thanks
        setUpdate(u);
        setPhase("available");
      } catch (e) {
        // Quietly swallow check errors — server may be unreachable in dev.
        // Surface only when the user explicitly retries.
        console.warn("[updater] check failed:", e);
      } finally {
        isCheckingRef.current = false;
      }
    };

    const t1 = setTimeout(runCheck, FIRST_CHECK_DELAY_MS);
    const t2 = setInterval(runCheck, PERIODIC_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(t1);
      clearInterval(t2);
    };
  }, []);

  const handleSkip = () => {
    if (update) rememberSkipped(update.version);
    setUpdate(null);
    setPhase("idle");
  };

  const handleLater = () => {
    // Not skipping — we'll re-prompt next time.
    setUpdate(null);
    setPhase("idle");
  };

  const handleDownload = async () => {
    if (!update) return;
    setPhase("downloading");
    setProgress(0);
    setDownloaded(0);
    setContentLength(null);
    try {
      let total: number | null = null;
      let received = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          setContentLength(total);
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          setDownloaded(received);
          if (total) setProgress(Math.round((received / total) * 100));
        } else if (event.event === "Finished") {
          setProgress(100);
        }
      });
      setPhase("installed");
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRelaunch = async () => {
    try {
      await relaunch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!update && phase !== "installed" && phase !== "error") return null;

  return (
    <Modal
      open
      onCancel={phase === "downloading" ? undefined : handleLater}
      footer={null}
      width={420}
      centered
      maskClosable={phase !== "downloading"}
      destroyOnHidden
      closable={phase !== "downloading"}
    >
      <div style={{ padding: "8px 4px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div
            style={{
              width: 36, height: 36, borderRadius: 8,
              background: "var(--color-primary-bg)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <CloudDownloadOutlined style={{ color: "var(--color-primary)", fontSize: 18 }} />
          </div>
          <Typography.Title level={5} style={{ margin: 0, color: "var(--color-text)" }}>
            {phase === "installed" ? "更新已安装" : `发现新版本 v${update?.version ?? ""}`}
          </Typography.Title>
        </div>

        {phase === "available" && update && (
          <>
            <div
              style={{
                fontSize: 12, color: "var(--color-text-muted)",
                fontFamily: "var(--font-mono)", marginBottom: 8,
              }}
            >
              当前 v{update.currentVersion} → v{update.version}
              {update.date ? ` · ${update.date.split(" ")[0]}` : ""}
            </div>
            {update.body && (
              <div
                style={{
                  background: "var(--color-surface-elevated)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 6,
                  padding: "10px 12px",
                  maxHeight: 180,
                  overflow: "auto",
                  fontSize: 12,
                  lineHeight: 1.7,
                  color: "var(--color-text-secondary)",
                  marginBottom: 12,
                  whiteSpace: "pre-wrap",
                }}
              >
                {update.body}
              </div>
            )}
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 14 }}>
              你的 license 与本地数据不会受到影响。
            </div>
            <Space style={{ width: "100%", justifyContent: "space-between" }}>
              <Button type="link" size="small" onClick={handleSkip}>
                跳过此版本
              </Button>
              <Space>
                <Button size="small" onClick={handleLater}>稍后再说</Button>
                <Button type="primary" size="small" onClick={handleDownload}>
                  下载并安装
                </Button>
              </Space>
            </Space>
          </>
        )}

        {phase === "downloading" && (
          <>
            <Progress percent={progress} status="active" />
            <div
              className="mono"
              style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 8, textAlign: "center" }}
            >
              {contentLength
                ? `${formatBytes(downloaded)} / ${formatBytes(contentLength)}`
                : `${formatBytes(downloaded)} 已下载…`}
            </div>
          </>
        )}

        {phase === "installed" && (
          <>
            <Typography.Paragraph style={{ fontSize: 13, lineHeight: 1.7 }}>
              新版本已安装,需要重启 DocMind 才能生效。
            </Typography.Paragraph>
            <Space style={{ width: "100%", justifyContent: "flex-end" }}>
              <Button size="small" onClick={() => setPhase("idle")}>稍后重启</Button>
              <Button type="primary" size="small" onClick={handleRelaunch}>
                立即重启
              </Button>
            </Space>
          </>
        )}

        {phase === "error" && (
          <>
            <div
              style={{
                background: "rgba(239,68,68,0.08)",
                border: "1px solid rgba(239,68,68,0.25)",
                borderRadius: 6,
                padding: "8px 10px",
                fontSize: 12,
                color: "#dc2626",
                marginBottom: 12,
              }}
            >
              更新失败: {error}
            </div>
            <Space style={{ width: "100%", justifyContent: "flex-end" }}>
              <Button size="small" onClick={() => { setPhase("idle"); setError(null); setUpdate(null); }}>
                关闭
              </Button>
            </Space>
          </>
        )}
      </div>
    </Modal>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
