import { Button, Steps, Typography } from "antd";
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
    let unlistenFn: (() => void) | null = null;

    listen<{ done: number; total: number; current: string }>(
      "index-progress",
      (e) => {
        if (!cancelled) setProgress(e.payload);
      }
    ).then((f) => {
      if (cancelled) {
        f();
      } else {
        unlistenFn = f;
      }
    });

    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
    };
  }, []);

  const pickFolder = async () => {
    const selected = await open({ directory: true });
    if (selected) {
      setFolder(selected as string);
      setCurrent(1); // 选择后自动推进到"开始索引"步骤
    }
  };

  const startIndex = async () => {
    setCurrent(2);
    await invoke("start_index", { folder });
    setCurrent(3);
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
                : "",
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
