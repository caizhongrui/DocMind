import { Layout, Button, Spin, Drawer, Tooltip, Typography, Progress, Tour } from "antd";
import type { TourProps } from "antd";
import {
  SettingOutlined,
  RobotOutlined,
  MessageOutlined,
  FileSearchOutlined,
  QuestionCircleOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useState, useEffect, useRef, useCallback } from "react";
import SearchBar from "./components/SearchBar";
import ResultList from "./components/ResultList";
import PreviewPanel from "./components/PreviewPanel";
import Onboarding from "./pages/Onboarding";
import SettingsDrawer from "./components/SettingsDrawer";
import ModelManager from "./pages/ModelManager";
import QAPanel from "./components/QAPanel";
import HelpDrawer from "./components/HelpDrawer";
import LicenseStatusBar from "./components/LicenseStatusBar";
import UpgradeDialog from "./components/UpgradeDialog";
import UpdateNotifier from "./components/UpdateNotifier";
import { useLicenseStore } from "./stores/licenseStore";

const { Header } = Layout;

const SIDER_WIDTH_KEY = "docmind_sider_width";
const DEFAULT_SIDER_WIDTH = 420;
const MIN_SIDER_WIDTH = 200;
const MAX_SIDER_WIDTH = 840;

// Hoisted out of the component so antd doesn't see a fresh `styles` object
// on every render — that causes a 1-frame flash during the close animation.
const QA_DRAWER_STYLES = {
  wrapper: { width: 520 },
  header: { borderBottom: "1px solid var(--color-border)", paddingBottom: 12 },
  body: {
    display: "flex" as const,
    flexDirection: "column" as const,
    height: "100%",
    padding: 16,
    background: "var(--color-bg)",
  },
};
const MODEL_DRAWER_STYLES = { wrapper: { width: 600 } };

interface ModelStatus {
  available: boolean;
  model_dir: string;
  model_version: string;
  embedding_count: number;
}

interface EmbedProgress {
  done: number;
  total: number;
  current: string;
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [, setHasFolders] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [qaOpen, setQaOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [modelAvailable, setModelAvailable] = useState(false);
  const [embeddingCount, setEmbeddingCount] = useState(0);
  const [embedProgress, setEmbedProgress] = useState<EmbedProgress | null>(null);
  // (Legacy update banner state removed — handled by <UpdateNotifier />.)

  // License store: refresh on mount and start listening for backend events.
  const refreshLicense = useLicenseStore((s) => s.refresh);
  const initLicenseListeners = useLicenseStore((s) => s.initListeners);
  useEffect(() => {
    refreshLicense();
    initLicenseListeners();
  }, [refreshLicense, initLicenseListeners]);

  const [siderWidth, setSiderWidth] = useState(() => {
    const saved = localStorage.getItem(SIDER_WIDTH_KEY);
    if (saved) {
      const n = parseInt(saved, 10);
      if (!isNaN(n) && n >= MIN_SIDER_WIDTH && n <= MAX_SIDER_WIDTH) return n;
    }
    return DEFAULT_SIDER_WIDTH;
  });
  const [dividerActive, setDividerActive] = useState(false);
  const latestWidth = useRef(siderWidth);

  useEffect(() => {
    latestWidth.current = siderWidth;
  }, [siderWidth]);

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = latestWidth.current;
    setDividerActive(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_SIDER_WIDTH, Math.min(MAX_SIDER_WIDTH, startWidth + startX - ev.clientX));
      setSiderWidth(w);
      latestWidth.current = w;
    };
    const onUp = () => {
      setDividerActive(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      localStorage.setItem(SIDER_WIDTH_KEY, String(latestWidth.current));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  useEffect(() => {
    Promise.all([
      invoke<string[]>("get_watched_folders"),
      invoke<ModelStatus>("get_model_status"),
    ])
      .then(([folders, modelStatus]) => {
        setHasFolders(folders.length > 0);
        setModelAvailable(modelStatus.available);
        setEmbeddingCount(modelStatus.embedding_count);
      })
      .catch(() => {
        setHasFolders(false);
        setModelAvailable(false);
      })
      .finally(() => setLoading(false));
  }, []);

  // ── 全局监听 embedding 进度 ──
  useEffect(() => {
    let cancelled = false;
    let unEmbed: (() => void) | null = null;
    let unEmbedComplete: (() => void) | null = null;
    let unEmbedRebuild: (() => void) | null = null;

    listen<EmbedProgress>("embed-progress", (e) => {
      if (!cancelled) setEmbedProgress(e.payload);
    }).then((f) => { if (cancelled) f(); else unEmbed = f; });

    // embed-rebuild-complete 由设置抽屉的"重建语义索引"触发
    listen<{ status: string }>("embed-rebuild-complete", () => {
      if (!cancelled) {
        setEmbedProgress(null);
        // 刷新 embedding 数量
        invoke<ModelStatus>("get_model_status")
          .then((s) => setEmbeddingCount(s.embedding_count))
          .catch(() => {});
      }
    }).then((f) => { if (cancelled) f(); else unEmbedRebuild = f; });

    // 首次索引完成后 embedding 生成也会结束，监听 embed-rebuild-complete 已够用
    // 但 index-complete 之后 embedding 会静默完成，不会再发 embed-rebuild-complete
    // 因此用超时自动隐藏进度条（embedding 全部完成后没有专属结束事件）
    listen<string>("index-complete", () => {
      // 索引完成后，embedding 进度条会随 embed-progress 事件自然更新到 done==total 后消失
    }).then((f) => { if (cancelled) f(); else unEmbedComplete = f; });

    return () => {
      cancelled = true;
      unEmbed?.();
      unEmbedRebuild?.();
      unEmbedComplete?.();
    };
  }, []);

  // Ctrl+K / Cmd+K 聚焦搜索框
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("docmind-focus-search"));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 监听托盘"快速搜索"菜单项
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen("tray-focus-search", () => {
      window.dispatchEvent(new CustomEvent("docmind-focus-search"));
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // 当 embed-progress.done === embed-progress.total 时自动隐藏
  useEffect(() => {
    if (embedProgress && embedProgress.done >= embedProgress.total) {
      const timer = setTimeout(() => setEmbedProgress(null), 1500);
      return () => clearTimeout(timer);
    }
  }, [embedProgress]);

  // ── 首次使用自动触发引导 ──
  useEffect(() => {
    if (!loading && modelAvailable) {
      if (!localStorage.getItem("docmind_tour_done")) {
        const t = setTimeout(() => setTourOpen(true), 600);
        return () => clearTimeout(t);
      }
    }
  }, [loading, modelAvailable]);

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh", background: "var(--color-bg)" }}>
        <div style={{ textAlign: "center" }}>
          <FileSearchOutlined style={{ fontSize: 36, color: "#1677ff", marginBottom: 16, display: "block" }} />
          <Spin size="large" />
        </div>
      </div>
    );
  }

  if (!modelAvailable) {
    return <Onboarding onDone={() => setModelAvailable(true)} />;
  }

  const aiIconColor = modelAvailable && embeddingCount > 0
    ? "#22c55e"
    : modelAvailable ? "#f59e0b" : "#cbd5e1";

  // embedding 进度百分比
  const embedPct = embedProgress
    ? Math.round(((embedProgress?.done ?? 0) / Math.max(embedProgress?.total ?? 1, 1)) * 100)
    : 0;

  const handleTourClose = () => {
    setTourOpen(false);
    localStorage.setItem("docmind_tour_done", "1");
  };

  const tourSteps: TourProps["steps"] = [
    {
      title: "第一步：添加文件夹",
      description:
        "点击设置按钮，将本地文件夹添加到监听列表。DocMind 会自动建立全文索引，之后可随时搜索文件内容。",
      target: () => document.getElementById("tour-settings-btn")!,
      placement: "bottomRight",
    },
    {
      title: "第二步：搜索文档",
      description:
        "在搜索框中输入关键词即可全文搜索。支持 AND / OR / NOT 逻辑运算符，以及双引号精确短语搜索。",
      target: () => document.getElementById("tour-search-input")!,
      placement: "bottom",
    },
    {
      title: "第三步：切换搜索模式",
      description:
        "全文：精确匹配内容关键词；文件名：按文件名查找；语义：AI 理解自然语言，无需精确关键词。",
      target: () => document.getElementById("tour-search-mode")!,
      placement: "bottom",
    },
    {
      title: "第四步：AI 语义搜索",
      description:
        "点击机器人按钮下载本地 AI 模型，开启语义搜索功能。模型完全本地运行，不联网推理。",
      target: () => document.getElementById("tour-ai-btn")!,
      placement: "bottomRight",
    },
    {
      title: "第五步：文档问答",
      description:
        "点击消息按钮打开文档问答面板，向 AI 提问，它会自动从你的文档中检索相关内容并生成回答。",
      target: () => document.getElementById("tour-qa-btn")!,
      placement: "bottomRight",
    },
    {
      title: "使用帮助",
      description:
        "随时点击帮助按钮查阅支持的文件格式、键盘快捷键以及联系方式。也可在此重新查看本引导。",
      target: () => document.getElementById("tour-help-btn")!,
      placement: "bottomRight",
    },
  ];

  return (
    <>
      <Layout style={{ height: "100vh", background: "var(--color-bg)" }}>
        {/* ── 顶部导航栏 ── */}
        <Header
          style={{
            padding: "0 12px 0 16px",
            height: 52,
            lineHeight: "52px",
            display: "flex",
            alignItems: "center",
            background: "var(--color-surface)",
            borderBottom: "1px solid var(--color-border)",
            boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
            gap: 10,
            flexShrink: 0,
            zIndex: 100,
          }}
        >
          {/* 品牌 */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0, marginRight: 6 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: "linear-gradient(135deg, #1677ff 0%, #4096ff 100%)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <FileSearchOutlined style={{ fontSize: 15, color: "#fff" }} />
            </div>
            <Typography.Text strong style={{ fontSize: 15, color: "var(--color-text)", letterSpacing: -0.3 }}>
              DocMind
            </Typography.Text>
          </div>

          <SearchBar modelAvailable={modelAvailable} />

          {/* License status pill */}
          <div style={{ flexShrink: 0 }}>
            <LicenseStatusBar />
          </div>

          {/* 工具栏按钮组 */}
          <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
            {/* Embedding 进度指示 */}
            {embedProgress && (
              <Tooltip title={`正在生成语义索引 ${embedProgress?.done}/${embedProgress?.total}：${embedProgress?.current}`}>
                <div style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "0 8px", height: 28, borderRadius: 6,
                  background: "var(--color-primary-bg)",
                  border: "1px solid rgba(22,119,255,0.2)",
                  cursor: "default",
                }}>
                  <RobotOutlined style={{ fontSize: 12, color: "var(--color-primary)" }} />
                  <div style={{ width: 60 }}>
                    <Progress
                      percent={embedPct}
                      size="small"
                      showInfo={false}
                      strokeColor="var(--color-primary)"
                      trailColor="rgba(22,119,255,0.15)"
                      style={{ marginBottom: 0 }}
                    />
                  </div>
                  <span style={{ fontSize: 11, color: "var(--color-primary)", whiteSpace: "nowrap" }}>
                    {embedPct}%
                  </span>
                </div>
              </Tooltip>
            )}

            {/* (Update notifications now come from <UpdateNotifier />.) */}

            <Tooltip title={
              modelAvailable && embeddingCount > 0 ? "AI 语义搜索已就绪"
              : modelAvailable ? "模型已下载，需重建索引"
              : "配置 AI 语义搜索"
            }>
              <Button
                id="tour-ai-btn"
                type="text" size="small"
                icon={<RobotOutlined style={{ fontSize: 16, color: aiIconColor }} />}
                onClick={() => setModelOpen(true)}
                style={{ width: 32, height: 32, borderRadius: 8 }}
              />
            </Tooltip>
            <Tooltip title="文档问答">
              <Button
                id="tour-qa-btn"
                type="text" size="small"
                icon={<MessageOutlined style={{ fontSize: 16, color: "#64748b" }} />}
                onClick={() => setQaOpen(true)}
                style={{ width: 32, height: 32, borderRadius: 8 }}
              />
            </Tooltip>
            <Tooltip title="设置">
              <Button
                id="tour-settings-btn"
                type="text" size="small"
                icon={<SettingOutlined style={{ fontSize: 16, color: "#64748b" }} />}
                onClick={() => setSettingsOpen(true)}
                style={{ width: 32, height: 32, borderRadius: 8 }}
              />
            </Tooltip>
            <Tooltip title="帮助">
              <Button
                id="tour-help-btn"
                type="text" size="small"
                icon={<QuestionCircleOutlined style={{ fontSize: 16, color: "#64748b" }} />}
                onClick={() => setHelpOpen(true)}
                style={{ width: 32, height: 32, borderRadius: 8 }}
              />
            </Tooltip>
          </div>
        </Header>

        {/* ── 主内容区 ── */}
        <div style={{ display: "flex", flex: 1, overflow: "hidden", background: "var(--color-bg)" }}>
          {/* 左：搜索结果 */}
          <div style={{ flex: 1, overflow: "hidden", minWidth: 180, background: "var(--color-surface)", display: "flex", flexDirection: "column" }}>
            <ResultList />
          </div>

          {/* 拖拽分隔条（8px 可点击区域 + 居中 2px 视觉线） */}
          <div
            onMouseDown={handleDividerMouseDown}
            style={{
              width: 8,
              flexShrink: 0,
              cursor: "col-resize",
              position: "relative",
              zIndex: 20,
              display: "flex",
              alignItems: "stretch",
              justifyContent: "center",
              background: "transparent",
            }}
            onMouseEnter={(e) => {
              const line = e.currentTarget.querySelector(".divider-line") as HTMLDivElement | null;
              if (line) { line.style.background = "#93c5fd"; line.style.width = "3px"; }
            }}
            onMouseLeave={(e) => {
              if (!dividerActive) {
                const line = e.currentTarget.querySelector(".divider-line") as HTMLDivElement | null;
                if (line) { line.style.background = "var(--color-border)"; line.style.width = "2px"; }
              }
            }}
          >
            <div
              className="divider-line"
              style={{
                width: dividerActive ? 3 : 2,
                background: dividerActive ? "#1677ff" : "var(--color-border)",
                transition: "width 0.1s, background 0.15s",
                pointerEvents: "none",
                flexShrink: 0,
              }}
            />
          </div>

          {/* 右：预览面板 */}
          <div style={{ width: siderWidth, flexShrink: 0, overflow: "auto", background: "var(--color-surface)" }}>
            <PreviewPanel />
          </div>
        </div>
      </Layout>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <HelpDrawer
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        onStartTour={() => {
          setHelpOpen(false);
          localStorage.removeItem("docmind_tour_done");
          setTimeout(() => setTourOpen(true), 300);
        }}
      />
      <Tour open={tourOpen} onClose={handleTourClose} steps={tourSteps} />

      <Drawer
        title={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <MessageOutlined style={{ color: "#1677ff" }} />
            <span>文档问答</span>
          </div>
        }
        open={qaOpen}
        onClose={() => setQaOpen(false)}
        forceRender
        styles={QA_DRAWER_STYLES}
      >
        <QAPanel />
      </Drawer>

      <Drawer
        title={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <RobotOutlined style={{ color: "#1677ff" }} />
            <span>AI 语义搜索</span>
          </div>
        }
        open={modelOpen}
        onClose={() => setModelOpen(false)}
        forceRender
        styles={MODEL_DRAWER_STYLES}
      >
        <ModelManager
          onModelReady={() => {
            setModelAvailable(true);
            invoke<ModelStatus>("get_model_status")
              .then((s) => setEmbeddingCount(s.embedding_count))
              .catch(() => {});
            setModelOpen(false);
          }}
        />
      </Drawer>

      {/* Global upgrade prompt — opens whenever a Pro feature is gated */}
      <UpgradeDialog />

      {/* Self-update: checks the server 30s after launch and every 6h */}
      <UpdateNotifier />
    </>
  );
}
