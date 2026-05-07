import { Button, Progress, Typography } from "antd";
import {
  FileSearchOutlined,
  DownloadOutlined,
  CheckCircleOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useState, useEffect } from "react";

interface DownloadProgress {
  file: string;
  done: number;
  total: number;
}

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<"idle" | "downloading" | "done">("idle");
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<{ available: boolean }>("get_model_status")
      .then((s) => {
        if (s.available) setStep("done");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlistenProgress: (() => void) | null = null;
    let unlistenReady: (() => void) | null = null;

    listen<DownloadProgress>("model-download-progress", (e) => {
      if (!cancelled) setProgress(e.payload);
    }).then((f) => {
      if (cancelled) f();
      else unlistenProgress = f;
    });

    listen<string>("model-ready", () => {
      if (!cancelled) {
        setStep("done");
        setProgress(null);
      }
    }).then((f) => {
      if (cancelled) f();
      else unlistenReady = f;
    });

    return () => {
      cancelled = true;
      if (unlistenProgress) unlistenProgress();
      if (unlistenReady) unlistenReady();
    };
  }, []);

  const startDownload = async () => {
    setStep("downloading");
    setError(null);
    setProgress(null);
    try {
      await invoke("download_model");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("idle");
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const progressPercent =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 24px",
        background:
          "radial-gradient(circle at 50% 0%, var(--color-primary-bg) 0%, transparent 60%), var(--color-bg)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 440 }}>
        {/* Brand */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 32 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "var(--color-surface-elevated)",
              border: "1px solid var(--color-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <FileSearchOutlined style={{ fontSize: 16, color: "var(--color-primary)" }} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text)", lineHeight: 1.2 }}>
              DocMind
            </div>
            <div className="mono" style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>
              local document search · AI Q&A
            </div>
          </div>
        </div>

        {/* Step indicator */}
        <div className="section-label" style={{ marginBottom: 8 }}>
          Step 01
        </div>
        <Typography.Title
          level={3}
          style={{ margin: "0 0 6px", color: "var(--color-text)", fontWeight: 600, fontSize: 20 }}
        >
          {step === "done" ? "一切就绪" : "下载语义模型"}
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 13, lineHeight: 1.7 }}>
          {step === "done"
            ? "模型已部署到本地，所有推理在你的电脑上完成，不会上传任何数据。"
            : "为了启用语义搜索与 AI 问答，需要下载一个轻量的中文嵌入模型，约 100 MB。下载后所有推理本地运行，无需联网。"}
        </Typography.Text>

        {/* Model row */}
        <div
          style={{
            marginTop: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            background: "var(--color-surface-elevated)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              className="mono"
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--color-text)",
              }}
            >
              bge-small-zh-v1.5
            </span>
            <span className="chip">~100 MB</span>
            {step === "done" && <span className="chip chip-primary">Ready</span>}
          </div>
        </div>

        {/* Progress */}
        {step === "downloading" && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <Typography.Text className="mono" style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                {progress ? progress.file : "preparing…"}
              </Typography.Text>
              <Typography.Text className="mono" style={{ fontSize: 11, color: "var(--color-primary)" }}>
                {progress ? `${formatBytes(progress.done)} / ${formatBytes(progress.total)}` : ""}
              </Typography.Text>
            </div>
            <Progress percent={progressPercent} strokeColor="var(--color-primary)" showInfo={false} size="small" />
          </div>
        )}

        {/* Error */}
        {error && (
          <div
            style={{
              marginTop: 16,
              padding: "8px 12px",
              borderRadius: 6,
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.3)",
            }}
          >
            <Typography.Text style={{ display: "block", fontSize: 12, color: "#ef4444" }}>{error}</Typography.Text>
          </div>
        )}

        {/* Actions */}
        <div style={{ marginTop: 24 }}>
          {step === "idle" && (
            <Button
              type="primary"
              size="large"
              block
              icon={<DownloadOutlined />}
              onClick={startDownload}
              style={{ height: 40, borderRadius: 8, fontWeight: 500, fontSize: 13 }}
            >
              下载模型
            </Button>
          )}
          {step === "downloading" && (
            <Button size="large" block disabled loading style={{ height: 40, borderRadius: 8, fontSize: 13 }}>
              正在下载…
            </Button>
          )}
          {step === "done" && (
            <Button
              type="primary"
              size="large"
              block
              icon={<CheckCircleOutlined />}
              onClick={onDone}
              style={{ height: 40, borderRadius: 8, fontWeight: 500, fontSize: 13 }}
            >
              开始使用
            </Button>
          )}

          {step === "idle" && (
            <Typography.Text
              style={{
                display: "block",
                textAlign: "center",
                fontSize: 11,
                color: "var(--color-text-muted)",
                marginTop: 12,
              }}
            >
              全文搜索功能无需模型，文件夹可在设置中随时添加
            </Typography.Text>
          )}
        </div>

        {/* Footer hint */}
        <div
          style={{
            marginTop: 32,
            display: "flex",
            justifyContent: "center",
            gap: 12,
            fontSize: 11,
            color: "var(--color-text-muted)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span className="kbd">↵</span>
            confirm
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span className="kbd">esc</span>
            skip
          </span>
        </div>
      </div>
    </div>
  );
}
