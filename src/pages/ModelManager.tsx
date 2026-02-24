import {
  Button,
  Progress,
  Typography,
  Space,
  Alert,
  Descriptions,
  Tag,
} from "antd";
import {
  DownloadOutlined,
  CheckCircleOutlined,
  RobotOutlined,
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
    <div style={{ maxWidth: 560, margin: "0 auto" }}>
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <RobotOutlined style={{ fontSize: 20, color: "#1677ff" }} />
          <Typography.Title level={5} style={{ margin: 0 }}>
            AI 语义搜索模型
          </Typography.Title>
          {status?.available && (
            <Tag color="success" icon={<CheckCircleOutlined />}>
              已就绪
            </Tag>
          )}
        </div>

        <Alert
          type="info"
          showIcon
          message="关于语义搜索"
          description="语义搜索使用 bge-small-zh-v1.5 本地 AI 模型，能理解自然语言含义，比全文搜索更智能。模型文件约 100MB，下载后完全本地运行，不联网。"
        />

        {status && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="模型版本">
              {status.model_version}
            </Descriptions.Item>
            <Descriptions.Item label="状态">
              {status.available ? (
                <Tag color="success">已下载</Tag>
              ) : (
                <Tag color="default">未下载</Tag>
              )}
            </Descriptions.Item>
            {status.available && (
              <Descriptions.Item label="已索引文本块">
                {status.embedding_count > 0 ? (
                  <Tag color="success">{status.embedding_count.toLocaleString()} 块</Tag>
                ) : (
                  <Tag color="warning">0 块（需要重新索引）</Tag>
                )}
              </Descriptions.Item>
            )}
            <Descriptions.Item label="存储路径">
              <Typography.Text
                copyable
                ellipsis={{ tooltip: status.model_dir }}
                style={{ fontSize: 12, maxWidth: 340 }}
              >
                {status.model_dir}
              </Typography.Text>
            </Descriptions.Item>
          </Descriptions>
        )}

        {error && (
          <Alert
            type="error"
            message="下载失败"
            description={error}
            showIcon
            closable
            onClose={() => setError(null)}
          />
        )}

        {downloading && progress && (
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              正在下载 {progress.file}
              {progress.total > 0 &&
                `（${formatBytes(progress.done)} / ${formatBytes(progress.total)}）`}
            </Typography.Text>
            <Progress
              percent={progressPercent}
              size="small"
              status="active"
              style={{ marginTop: 4 }}
            />
          </div>
        )}

        {downloading && !progress && (
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              正在连接服务器...
            </Typography.Text>
            <Progress percent={0} size="small" status="active" style={{ marginTop: 4 }} />
          </div>
        )}

        {!status?.available && (
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            onClick={startDownload}
            loading={downloading}
            block
          >
            {downloading ? "正在下载模型..." : "下载语义搜索模型（~100MB）"}
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
          />
        )}
        {status?.available && status.embedding_count > 0 && (
          <Alert
            type="success"
            showIcon
            message={`模型已就绪，已索引 ${status.embedding_count.toLocaleString()} 个文本块`}
            description="回到主界面，搜索栏选择「语义」模式即可使用 AI 语义搜索。"
          />
        )}
      </Space>
    </div>
  );
}
