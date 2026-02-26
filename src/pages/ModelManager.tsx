import {
  Button,
  Progress,
  Typography,
  Alert,
} from "antd";
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
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

  return (
    <div style={{ maxWidth: 520, margin: "0 auto" }}>
      {/* ── 标题区 ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        marginBottom: 20, padding: "16px 20px",
        background: "linear-gradient(135deg, #eff6ff 0%, #f5f3ff 100%)",
        borderRadius: 12,
        border: "1px solid #dbeafe",
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12,
          background: "linear-gradient(135deg, #1677ff, #4096ff)",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
          boxShadow: "0 2px 8px rgba(22,119,255,0.3)",
        }}>
          <RobotOutlined style={{ fontSize: 20, color: "#fff" }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Typography.Text strong style={{ fontSize: 15, color: "#1a1d23" }}>
              AI 语义搜索模型
            </Typography.Text>
            {status?.available && (
              <span style={{
                fontSize: 11, padding: "2px 8px", borderRadius: 10,
                background: "#dcfce7", color: "#16a34a", fontWeight: 600,
                display: "inline-flex", alignItems: "center", gap: 3,
              }}>
                <CheckCircleOutlined style={{ fontSize: 10 }} />
                已就绪
              </span>
            )}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            bge-small-zh-v1.5 · 本地运行
          </Typography.Text>
        </div>
      </div>

      {/* ── 状态卡片 ── */}
      {status && (
        <div style={{
          background: "#fff",
          borderRadius: 10,
          border: "1px solid #e8edf2",
          marginBottom: 16,
          overflow: "hidden",
        }}>
          <InfoRow
            icon={<RobotOutlined style={{ color: "#1677ff" }} />}
            label="模型版本"
            value={status.model_version}
          />
          <InfoRow
            icon={<CheckCircleOutlined style={{ color: status.available ? "#16a34a" : "#94a3b8" }} />}
            label="下载状态"
            value={
              status.available
                ? <span style={{ color: "#16a34a", fontWeight: 500 }}>已下载</span>
                : <span style={{ color: "#94a3b8" }}>未下载</span>
            }
          />
          {status.available && (
            <InfoRow
              icon={<DatabaseOutlined style={{ color: status.embedding_count > 0 ? "#16a34a" : "#f59e0b" }} />}
              label="已索引文本块"
              value={
                status.embedding_count > 0
                  ? <span style={{ color: "#16a34a", fontWeight: 500 }}>{status.embedding_count.toLocaleString()} 块</span>
                  : <span style={{ color: "#f59e0b", fontWeight: 500 }}>0 块（需重新索引）</span>
              }
            />
          )}
          <InfoRow
            icon={<FolderOutlined style={{ color: "#64748b" }} />}
            label="存储路径"
            value={
              <Typography.Text
                copyable
                ellipsis={{ tooltip: status.model_dir }}
                style={{ fontSize: 12, maxWidth: 280 }}
              >
                {status.model_dir}
              </Typography.Text>
            }
            last
          />
        </div>
      )}

      {/* ── 说明 ── */}
      <Alert
        type="info"
        showIcon
        message="关于语义搜索"
        description="使用 bge-small-zh-v1.5 本地 AI 模型，能理解自然语言含义，比全文搜索更智能。模型约 100MB，下载后完全本地运行，不联网。"
        style={{ marginBottom: 16, borderRadius: 10 }}
      />

      {/* ── 错误 ── */}
      {error && (
        <Alert
          type="error"
          message="下载失败"
          description={error}
          showIcon closable
          onClose={() => setError(null)}
          style={{ marginBottom: 16, borderRadius: 10 }}
        />
      )}

      {/* ── 下载进度 ── */}
      {downloading && (
        <div style={{
          background: "#f8faff",
          border: "1px solid #dbeafe",
          borderRadius: 10,
          padding: "14px 16px",
          marginBottom: 16,
        }}>
          <Typography.Text style={{ fontSize: 12, color: "#1677ff", display: "block", marginBottom: 8 }}>
            {progress
              ? `正在下载 ${progress.file}（${formatBytes(progress.done)} / ${formatBytes(progress.total)}）`
              : "正在连接服务器..."}
          </Typography.Text>
          <Progress
            percent={progressPercent}
            size="small"
            status="active"
            strokeColor={{ from: "#1677ff", to: "#4096ff" }}
            style={{ margin: 0 }}
          />
        </div>
      )}

      {/* ── 操作按钮 ── */}
      {!status?.available && (
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          onClick={startDownload}
          loading={downloading}
          block
          style={{ height: 42, borderRadius: 10, fontWeight: 500 }}
        >
          {downloading ? "正在下载模型..." : "下载语义搜索模型（约 100MB）"}
        </Button>
      )}

      {status?.available && status.embedding_count === 0 && (
        <Alert
          type="warning"
          showIcon
          message="模型已就绪，但还没有语义索引"
          description={
            <>
              需要重新索引文档才能使用语义搜索。请到
              <strong>「设置」→ 选择文件夹 → 删除后重新添加</strong>，
              索引过程中会自动生成语义向量。
            </>
          }
          style={{ borderRadius: 10 }}
        />
      )}
      {status?.available && status.embedding_count > 0 && (
        <Alert
          type="success"
          showIcon
          message={`模型已就绪，已索引 ${status.embedding_count.toLocaleString()} 个文本块`}
          description="回到主界面，搜索栏选择「语义」模式即可使用 AI 语义搜索。"
          style={{ borderRadius: 10 }}
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
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "10px 16px",
      borderBottom: last ? "none" : "1px solid #f0f2f5",
    }}>
      <span style={{ fontSize: 14, flexShrink: 0 }}>{icon}</span>
      <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0, width: 80 }}>
        {label}
      </Typography.Text>
      <div style={{ flex: 1, fontSize: 13 }}>{value}</div>
    </div>
  );
}
