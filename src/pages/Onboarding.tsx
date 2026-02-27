import { Button, Progress, Typography } from "antd";
import {
  FileSearchOutlined,
  DownloadOutlined,
  CheckCircleOutlined,
  RobotOutlined,
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

  // 若模型已下载，直接显示完成状态
  useEffect(() => {
    invoke<{ available: boolean }>("get_model_status")
      .then((s) => { if (s.available) setStep("done"); })
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
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background:
          "linear-gradient(160deg, #f0f4ff 0%, #f8fafc 60%, #f4f6f9 100%)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 460,
          padding: "44px 40px",
          background: "#ffffff",
          borderRadius: 16,
          boxShadow:
            "0 8px 40px rgba(22, 119, 255, 0.08), 0 2px 8px rgba(0,0,0,0.06)",
          border: "1px solid rgba(22,119,255,0.08)",
        }}
      >
        {/* 品牌区 */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div
            style={{
              width: 60,
              height: 60,
              borderRadius: 16,
              background: "linear-gradient(135deg, #1677ff 0%, #4096ff 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px",
              boxShadow: "0 4px 16px rgba(22,119,255,0.3)",
            }}
          >
            <FileSearchOutlined style={{ fontSize: 28, color: "#fff" }} />
          </div>
          <Typography.Title
            level={3}
            style={{ margin: "0 0 6px", color: "#1a1d23", fontWeight: 700 }}
          >
            欢迎使用 DocMind
          </Typography.Title>
          <Typography.Text style={{ fontSize: 13, color: "#64748b" }}>
            本地文档全文搜索 · AI 语义检索 · 文档问答
          </Typography.Text>
        </div>

        {/* 模型信息卡片 */}
        <div
          style={{
            background: "#f8faff",
            borderRadius: 12,
            padding: "16px 20px",
            marginBottom: 24,
            border: "1px solid rgba(22,119,255,0.12)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 8,
            }}
          >
            <RobotOutlined style={{ fontSize: 18, color: "#1677ff" }} />
            <Typography.Text strong style={{ fontSize: 14 }}>
              bge-small-zh-v1.5
            </Typography.Text>
            <span
              style={{
                fontSize: 11,
                color: "#94a3b8",
                background: "#f1f5f9",
                padding: "1px 8px",
                borderRadius: 99,
              }}
            >
              ~100 MB
            </span>
          </div>
          <Typography.Text
            style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6 }}
          >
            中文语义嵌入模型，支持文档语义搜索与 AI
            问答功能。模型下载后本地运行，不联网推理。
          </Typography.Text>
        </div>

        {/* 下载进度 */}
        {step === "downloading" && (
          <div style={{ marginBottom: 20 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 6,
              }}
            >
              <Typography.Text style={{ fontSize: 12, color: "#64748b" }}>
                {progress ? `正在下载 ${progress.file}` : "准备下载..."}
              </Typography.Text>
              <Typography.Text style={{ fontSize: 12, color: "#1677ff" }}>
                {progress
                  ? `${formatBytes(progress.done)} / ${formatBytes(progress.total)}`
                  : ""}
              </Typography.Text>
            </div>
            <Progress
              percent={progressPercent}
              strokeColor={{ from: "#1677ff", to: "#4096ff" }}
              showInfo={false}
            />
          </div>
        )}

        {/* 完成提示 */}
        {step === "done" && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "#f0fdf4",
              borderRadius: 10,
              padding: "12px 16px",
              marginBottom: 20,
              border: "1px solid rgba(22,163,74,0.2)",
            }}
          >
            <CheckCircleOutlined
              style={{ color: "#16a34a", fontSize: 16 }}
            />
            <Typography.Text style={{ fontSize: 13, color: "#16a34a" }}>
              模型下载完成，可以开始使用了
            </Typography.Text>
          </div>
        )}

        {/* 错误提示 */}
        {error && (
          <Typography.Text
            style={{
              display: "block",
              fontSize: 12,
              color: "#ef4444",
              marginBottom: 16,
            }}
          >
            {error}
          </Typography.Text>
        )}

        {/* 操作按钮 */}
        {step === "idle" && (
          <Button
            type="primary"
            size="large"
            block
            icon={<DownloadOutlined />}
            onClick={startDownload}
            style={{
              height: 44,
              borderRadius: 10,
              fontWeight: 500,
              fontSize: 14,
            }}
          >
            下载语义模型
          </Button>
        )}
        {step === "downloading" && (
          <Button
            size="large"
            block
            disabled
            loading
            style={{ height: 44, borderRadius: 10, fontSize: 14 }}
          >
            正在下载...
          </Button>
        )}
        {step === "done" && (
          <Button
            type="primary"
            size="large"
            block
            icon={<CheckCircleOutlined />}
            onClick={onDone}
            style={{
              height: 44,
              borderRadius: 10,
              fontWeight: 500,
              fontSize: 14,
              background: "linear-gradient(135deg, #16a34a, #22c55e)",
              borderColor: "transparent",
            }}
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
              color: "#94a3b8",
              marginTop: 12,
            }}
          >
            全文搜索功能无需模型，文件夹可在设置中随时添加
          </Typography.Text>
        )}
      </div>
    </div>
  );
}
