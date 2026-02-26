import { Button, Steps, Typography, message } from "antd";
import {
  FileSearchOutlined,
  FolderOpenOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
} from "@ant-design/icons";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useState, useEffect } from "react";

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState(0);
  const [folder, setFolder] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });

  useEffect(() => {
    let cancelled = false;
    let unlistenProgress: (() => void) | null = null;
    let unlistenComplete: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;

    listen<{ done: number; total: number; current: string }>(
      "index-progress",
      (e) => {
        if (!cancelled) setProgress(e.payload);
      }
    ).then((f) => {
      if (cancelled) f();
      else unlistenProgress = f;
    });

    listen<string>("index-complete", () => {
      if (!cancelled) setCurrent(3);
    }).then((f) => {
      if (cancelled) f();
      else unlistenComplete = f;
    });

    listen<{ folder: string; error: string }>("index-error", (e) => {
      if (!cancelled) {
        message.error(`索引失败：${e.payload.error}`);
        setCurrent(1);
      }
    }).then((f) => {
      if (cancelled) f();
      else unlistenError = f;
    });

    return () => {
      cancelled = true;
      if (unlistenProgress) unlistenProgress();
      if (unlistenComplete) unlistenComplete();
      if (unlistenError) unlistenError();
    };
  }, []);

  const pickFolder = async () => {
    const selected = await open({ directory: true });
    if (selected) {
      setFolder(selected as string);
      setCurrent(1);
    }
  };

  const startIndex = async () => {
    setCurrent(2);
    try {
      await invoke("start_index", { folder });
    } catch (e) {
      message.error(String(e));
      setCurrent(1);
    }
  };

  return (
    <div style={{
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      background: "linear-gradient(160deg, #f0f4ff 0%, #f8fafc 60%, #f4f6f9 100%)",
    }}>
      <div style={{
        width: "100%",
        maxWidth: 460,
        padding: "44px 40px",
        background: "#ffffff",
        borderRadius: 16,
        boxShadow: "0 8px 40px rgba(22, 119, 255, 0.08), 0 2px 8px rgba(0,0,0,0.06)",
        border: "1px solid rgba(22,119,255,0.08)",
      }}>
        {/* 品牌区 */}
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{
            width: 60, height: 60,
            borderRadius: 16,
            background: "linear-gradient(135deg, #1677ff 0%, #4096ff 100%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 16px",
            boxShadow: "0 4px 16px rgba(22,119,255,0.3)",
          }}>
            <FileSearchOutlined style={{ fontSize: 28, color: "#fff" }} />
          </div>
          <Typography.Title level={3} style={{ margin: "0 0 6px", color: "#1a1d23", fontWeight: 700 }}>
            欢迎使用 DocMind
          </Typography.Title>
          <Typography.Text style={{ fontSize: 13, color: "#64748b" }}>
            本地文档全文搜索 · AI 语义检索 · 文档问答
          </Typography.Text>
        </div>

        {/* 步骤 */}
        <Steps
          current={current}
          direction="vertical"
          size="small"
          style={{ marginBottom: 28 }}
          items={[
            {
              icon: current > 0 ? undefined : <FolderOpenOutlined />,
              title: <span style={{ fontSize: 13, fontWeight: 500 }}>选择文件夹</span>,
              description: folder ? (
                <Typography.Text style={{ fontSize: 12 }} type="secondary" ellipsis={{ tooltip: folder }}>
                  {folder}
                </Typography.Text>
              ) : (
                <span style={{ fontSize: 12, color: "#94a3b8" }}>选择要建立索引的本地文件夹</span>
              ),
            },
            {
              icon: current > 1 ? undefined : <ThunderboltOutlined />,
              title: <span style={{ fontSize: 13, fontWeight: 500 }}>建立索引</span>,
              description: (
                <span style={{ fontSize: 12, color: "#94a3b8" }}>扫描文件内容，建立全文与语义索引</span>
              ),
            },
            {
              title: <span style={{ fontSize: 13, fontWeight: 500 }}>索引中</span>,
              description: current === 2 ? (
                <span style={{ fontSize: 12, color: "#1677ff" }}>
                  {progress.total > 0
                    ? `已处理 ${progress.done} / ${progress.total} 个文件`
                    : "正在扫描文件..."}
                </span>
              ) : (
                <span style={{ fontSize: 12, color: "#94a3b8" }}>自动处理文件</span>
              ),
            },
            {
              icon: current === 3 ? <CheckCircleOutlined /> : undefined,
              title: <span style={{ fontSize: 13, fontWeight: 500 }}>完成</span>,
              description: current === 3 ? (
                <span style={{ fontSize: 12, color: "#16a34a" }}>索引完成，可以开始搜索了</span>
              ) : "",
            },
          ]}
        />

        {/* 操作按钮 */}
        {current === 0 && (
          <Button
            type="primary" size="large" block
            icon={<FolderOpenOutlined />}
            onClick={pickFolder}
            style={{ height: 44, borderRadius: 10, fontWeight: 500, fontSize: 14 }}
          >
            选择文件夹
          </Button>
        )}
        {current === 1 && (
          <Button
            type="primary" size="large" block
            icon={<ThunderboltOutlined />}
            onClick={startIndex}
            style={{ height: 44, borderRadius: 10, fontWeight: 500, fontSize: 14 }}
          >
            开始索引
          </Button>
        )}
        {current === 2 && (
          <Button
            size="large" block disabled loading
            style={{ height: 44, borderRadius: 10, fontSize: 14 }}
          >
            正在索引...
          </Button>
        )}
        {current === 3 && (
          <Button
            type="primary" size="large" block
            icon={<CheckCircleOutlined />}
            onClick={onDone}
            style={{
              height: 44, borderRadius: 10, fontWeight: 500, fontSize: 14,
              background: "linear-gradient(135deg, #16a34a, #22c55e)",
              borderColor: "transparent",
            }}
          >
            开始使用
          </Button>
        )}
      </div>
    </div>
  );
}
