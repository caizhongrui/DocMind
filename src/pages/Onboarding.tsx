import { Button, Steps, Typography, message } from "antd";
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
      // start_index 立即返回，index-complete 事件触发后推进到步骤 3
    } catch (e) {
      message.error(String(e));
      setCurrent(1);
    }
  };

  return (
    <div style={{ maxWidth: 500, margin: "80px auto", padding: 24 }}>
      <Typography.Title level={3}>欢迎使用 DocMind</Typography.Title>
      <Steps
        current={current}
        direction="vertical"
        style={{ marginTop: 24 }}
        items={[
          { title: "选择文件夹", description: folder || "点击选择要索引的文件夹" },
          { title: "开始索引" },
          {
            title: "索引中",
            description:
              progress.total > 0
                ? `${progress.done}/${progress.total} - ${progress.current}`
                : "正在扫描文件...",
          },
          { title: "完成" },
        ]}
      />
      {current === 0 && (
        <Button type="primary" onClick={pickFolder} style={{ marginTop: 24 }}>
          选择文件夹
        </Button>
      )}
      {current === 1 && (
        <Button type="primary" onClick={startIndex} style={{ marginTop: 24 }}>
          开始索引
        </Button>
      )}
      {current === 3 && (
        <Button type="primary" onClick={onDone} style={{ marginTop: 24 }}>
          开始使用
        </Button>
      )}
    </div>
  );
}
