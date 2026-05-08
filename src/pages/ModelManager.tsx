import { Button, Progress, Typography, Alert } from "antd";
import {
  DownloadOutlined,
  CheckCircleOutlined,
  RobotOutlined,
  DatabaseOutlined,
  FolderOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useState, useEffect } from "react";

interface ModelStatus {
  available: boolean;
  model_dir: string;
  model_version: string;
  embedding_count: number;
}

interface DownloadProgress {
  file: string;
  done: number;
  total: number;
}

export default function ModelManager({
  onModelReady,
}: {
  onModelReady: () => void;
}) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<ModelStatus>("get_model_status")
      .then(setStatus)
      .catch(() => setStatus(null));
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
        setDownloading(false);
        setProgress(null);
        invoke<ModelStatus>("get_model_status")
          .then((s) => {
            setStatus(s);
            if (s.available) onModelReady();
          })
          .catch(() => {});
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
  }, [onModelReady]);

  const startDownload = async () => {
    setDownloading(true);
    setError(null);
    setProgress(null);
    try {
      await invoke("download_model");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDownloading(false);
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
    <div style={{ maxWidth: 520, margin: "0 auto" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 20,
          padding: "14px 16px",
          background: "var(--color-surface)",
          borderRadius: 8,
          border: "1px solid var(--color-border)",
        }}
      >
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: "var(--color-surface-elevated)",
            border: "1px solid var(--color-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <RobotOutlined style={{ fontSize: 18, color: "var(--color-primary)" }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Typography.Text strong style={{ fontSize: 14, color: "var(--color-text)" }}>
              AI 语义搜索模型
            </Typography.Text>
            {status?.available && (
              <span className="chip chip-primary" style={{ height: 18 }}>
                <CheckCircleOutlined style={{ fontSize: 10 }} />
                Ready
              </span>
            )}
          </div>
          <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>
            bge-small-zh-v1.5 · local
          </Typography.Text>
        </div>
      </div>

      {/* Status card */}
      {status && (
        <div
          style={{
            background: "var(--color-surface)",
            borderRadius: 8,
            border: "1px solid var(--color-border)",
            marginBottom: 16,
            overflow: "hidden",
          }}
        >
          <InfoRow
            icon={<RobotOutlined />}
            label="模型版本"
            value={<span className="mono" style={{ fontSize: 12 }}>{status.model_version}</span>}
          />
          <InfoRow
            icon={<CheckCircleOutlined />}
            label="下载状态"
            value={
              status.available ? (
                <span style={{ color: "var(--color-text)", fontWeight: 500 }}>已下载</span>
              ) : (
                <span style={{ color: "var(--color-text-muted)" }}>未下载</span>
              )
            }
          />
          {status.available && (
            <InfoRow
              icon={<DatabaseOutlined />}
              label="已索引文本块"
              value={
                status.embedding_count > 0 ? (
                  <span className="mono" style={{ color: "var(--color-text)", fontWeight: 500 }}>
                    {status.embedding_count.toLocaleString()}
                  </span>
                ) : (
                  <span style={{ color: "#f59e0b", fontWeight: 500 }}>0（需重新索引）</span>
                )
              }
            />
          )}
          <InfoRow
            icon={<FolderOutlined />}
            label="存储路径"
            value={
              <Typography.Text
                copyable
                ellipsis={{ tooltip: status.model_dir }}
                className="mono"
                style={{ fontSize: 11, maxWidth: 280, color: "var(--color-text-secondary)" }}
              >
                {status.model_dir}
              </Typography.Text>
            }
            last
          />
        </div>
      )}

      {/* Info */}
      <Alert
        type="info"
        showIcon
        title="关于语义搜索"
        description="使用 bge-small-zh-v1.5 本地 AI 模型，能理解自然语言含义，比全文搜索更智能。模型约 100MB，下载后完全本地运行，不联网。"
        style={{ marginBottom: 16, borderRadius: 8 }}
      />

      {/* Error */}
      {error && (
        <Alert
          type="error"
          title="下载失败"
          description={error}
          showIcon
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 16, borderRadius: 8 }}
        />
      )}

      {/* Progress */}
      {downloading && (
        <div
          style={{
            background: "var(--color-surface-elevated)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            padding: "12px 14px",
            marginBottom: 16,
          }}
        >
          <Typography.Text className="mono" style={{ fontSize: 11, color: "var(--color-primary)", display: "block", marginBottom: 8 }}>
            {progress
              ? `${progress.file}  ${formatBytes(progress.done)} / ${formatBytes(progress.total)}`
              : "connecting…"}
          </Typography.Text>
          <Progress
            percent={progressPercent}
            size="small"
            status="active"
            strokeColor="var(--color-primary)"
            style={{ margin: 0 }}
            showInfo={false}
          />
        </div>
      )}

      {/* Actions */}
      {!status?.available && (
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          onClick={startDownload}
          loading={downloading}
          block
          style={{ height: 38, borderRadius: 8, fontWeight: 500 }}
        >
          {downloading ? "正在下载模型..." : "下载语义搜索模型（约 100MB）"}
        </Button>
      )}

      {status?.available && status.embedding_count === 0 && (
        <Alert
          type="warning"
          showIcon
          title="模型已就绪，但还没有语义索引"
          description={
            <>
              需要重新索引文档才能使用语义搜索。请到
              <strong>「设置」→ 选择文件夹 → 删除后重新添加</strong>， 索引过程中会自动生成语义向量。
            </>
          }
          style={{ borderRadius: 8 }}
        />
      )}
      {status?.available && status.embedding_count > 0 && (
        <Alert
          type="success"
          showIcon
          title={`模型已就绪，已索引 ${status.embedding_count.toLocaleString()} 个文本块`}
          description="回到主界面，搜索栏选择「语义」模式即可使用 AI 语义搜索。"
          style={{ borderRadius: 8 }}
        />
      )}
    </div>
  );
}

function InfoRow({
  icon,
  label,
  value,
  last = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        borderBottom: last ? "none" : "1px solid var(--color-border)",
      }}
    >
      <span style={{ fontSize: 13, flexShrink: 0, color: "var(--color-text-secondary)" }}>{icon}</span>
      <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0, width: 84 }}>
        {label}
      </Typography.Text>
      <div style={{ flex: 1, fontSize: 13, color: "var(--color-text)" }}>{value}</div>
    </div>
  );
}
