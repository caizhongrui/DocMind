import { useEffect, useState } from "react";
import { Button, Typography, message } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RerankerStatus } from "../types";

/**
 * 一次性提示横幅:首次启动 v0.2 后,如果发现 reranker 模型还没下载,
 * 在顶部弹一条非阻塞条,让用户一键开始下载。
 *
 * 行为规则:
 * 1. 启动后查 `get_reranker_status`;若 available=false 才显示
 * 2. 用户点"立即下载" → 后台下载,进度由 SettingsDrawer 展示完整版,
 *    这里只显示状态切换
 * 3. 用户点"稍后" → 写 localStorage,永远不再弹(除非重置该 key)
 * 4. 下载完成 → `reranker-ready` 事件触发,横幅自隐
 *
 * 设计上**故意非阻塞** —— 不下载也能用,只是召回质量回到 v0.1 水平。
 */
const DISMISS_KEY = "docmind.reranker_banner_dismissed_v1";

export function RerankerBanner() {
  const [visible, setVisible] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const dismissed = localStorage.getItem(DISMISS_KEY) === "1";

    invoke<RerankerStatus>("get_reranker_status")
      .then((status) => {
        if (cancelled) return;
        // 已就绪 / 用户曾点过"稍后" → 不弹
        if (status.available || dismissed) {
          setVisible(false);
        } else {
          setVisible(true);
        }
      })
      .catch(() => setVisible(false));

    const unProg = listen<{ file: string; done: number; total: number }>(
      "reranker-download-progress",
      (e) => setProgress({ done: e.payload.done, total: e.payload.total }),
    );
    const unReady = listen("reranker-ready", () => {
      setDownloading(false);
      setProgress(null);
      setVisible(false);
      message.success("答案精排模型已就绪,问答精度立即提升");
    });

    return () => {
      cancelled = true;
      unProg.then((u) => u());
      unReady.then((u) => u());
    };
  }, []);

  const handleDownload = () => {
    setDownloading(true);
    setProgress(null);
    invoke("download_reranker").catch((e: unknown) => {
      message.error(`下载失败：${e instanceof Error ? e.message : String(e)}`);
      setDownloading(false);
      setProgress(null);
    });
  };

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setVisible(false);
  };

  if (!visible) return null;

  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div
      style={{
        padding: "8px 16px",
        background: "linear-gradient(90deg, rgba(99,102,241,0.08) 0%, rgba(99,102,241,0.03) 100%)",
        borderBottom: "1px solid var(--color-border)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: 12,
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 14 }}>✨</span>
      <Typography.Text style={{ fontSize: 12, flex: 1, color: "var(--color-text)" }}>
        {downloading ? (
          <>
            正在下载答案精排模型 · {progress ? `${(progress.done / 1024 / 1024).toFixed(1)} / ${(progress.total / 1024 / 1024).toFixed(1)} MB · ${pct}%` : "连接中..."}
          </>
        ) : (
          <>
            <b>升级提示</b>:下载 ~80 MB 的答案精排模型可大幅减少"答非所问 / 漏文件",
            不下载也能正常使用。
          </>
        )}
      </Typography.Text>
      {!downloading && (
        <>
          <Button type="primary" size="small" onClick={handleDownload} style={{ borderRadius: 6 }}>
            立即下载
          </Button>
          <Button type="text" size="small" onClick={handleDismiss} style={{ color: "var(--color-text-muted)" }}>
            稍后再说
          </Button>
        </>
      )}
    </div>
  );
}
