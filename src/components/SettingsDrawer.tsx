import { Drawer, Button, List, Typography, Progress, message, Modal, Statistic, Input, InputNumber, Switch } from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  FolderOutlined,
  SettingOutlined,
  ClearOutlined,
  FileTextOutlined,
  DatabaseOutlined,
  BgColorsOutlined,
  GlobalOutlined,
} from "@ant-design/icons";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n/index";
import { THEME_KEY, type ThemeMode } from "../main";
import type { ApiLlmConfig } from "../types";

interface IndexProgress {
  total: number;
  done: number;
  current: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsDrawer({ open: drawerOpen, onClose }: Props) {
  const { t } = useTranslation();
  const [folders, setFolders] = useState<string[]>([]);
  const [indexing, setIndexing] = useState<string | null>(null);
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState<IndexProgress | null>(null);
  const [stats, setStats] = useState<{ file_count: number; chunk_count: number; db_size_mb: number } | null>(null);
  const [clearing, setClearing] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // ── API LLM 配置 ──
  const [apiConfig, setApiConfig] = useState<ApiLlmConfig>({
    enabled: false,
    endpoint: "https://api.openai.com/v1/chat/completions",
    api_key: "",
    model_name: "gpt-4o-mini",
    temperature: 0.7,
    max_tokens: 2048,
    top_p: 1.0,
  });
  const [savingApiConfig, setSavingApiConfig] = useState(false);

  // ── 外观 ──
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    () => (localStorage.getItem(THEME_KEY) as ThemeMode) || "system"
  );

  // ── 快捷键 ──
  const [shortcut, setShortcut] = useState("");
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const [savingShortcut, setSavingShortcut] = useState(false);

  // ── 定时重索引 ──
  const [reindexInterval, setReindexInterval] = useState(0);

  const checkFolderConflict = (newPath: string, existingFolders: string[]): string | null => {
    const norm = (p: string) => p.endsWith("/") ? p : p + "/";
    const newN = norm(newPath);
    for (const existing of existingFolders) {
      const existN = norm(existing);
      if (newN === existN) {
        return `该文件夹已在监听列表中`;
      }
      if (newN.startsWith(existN)) {
        return `已监听上级目录 "${existing}"，无需重复添加`;
      }
      if (existN.startsWith(newN)) {
        return `该目录包含已监听的子目录 "${existing}"`;
      }
    }
    return null;
  };

  const loadFolders = useCallback(() => {
    invoke<string[]>("get_watched_folders")
      .then(setFolders)
      .catch(() => setFolders([]));
  }, []);

  const loadStats = useCallback(() => {
    invoke<{ file_count: number; chunk_count: number; db_size_mb: number }>("get_index_stats")
      .then(setStats)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (drawerOpen) {
      loadFolders();
      loadStats();
      invoke<string | null>("get_global_shortcut")
        .then((s) => setShortcut(s ?? ""))
        .catch(() => {});
      invoke<ApiLlmConfig>("get_api_llm_config")
        .then(setApiConfig)
        .catch(() => {});
      invoke<number>("get_reindex_interval").then(v => setReindexInterval(v)).catch(() => {});
    }
  }, [drawerOpen, loadFolders, loadStats]);

  useEffect(() => {
    let cancelled = false;
    let unlistenProgress: (() => void) | null = null;
    let unlistenComplete: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;

    listen<IndexProgress>("index-progress", (e) => {
      if (!cancelled) setProgress(e.payload);
    }).then((f) => {
      if (cancelled) f();
      else unlistenProgress = f;
    });

    listen<string>("index-complete", () => {
      if (!cancelled) {
        message.success("索引完成");
        setIndexing(null);
        setProgress(null);
        loadFolders();
      }
    }).then((f) => {
      if (cancelled) f();
      else unlistenComplete = f;
    });

    listen<{ folder: string; error: string }>("index-error", (e) => {
      if (!cancelled) {
        message.error(`索引失败：${e.payload.error}`);
        setIndexing(null);
        setProgress(null);
      }
    }).then((f) => {
      if (cancelled) f();
      else unlistenError = f;
    });

    let unlistenEmbedProgress: (() => void) | null = null;
    let unlistenEmbedComplete: (() => void) | null = null;

    listen<IndexProgress>("embed-progress", (e) => {
      if (!cancelled) setRebuildProgress(e.payload);
    }).then((f) => {
      if (cancelled) f();
      else unlistenEmbedProgress = f;
    });

    listen<{ status: string }>("embed-rebuild-complete", () => {
      if (!cancelled) {
        message.success("语义索引重建完成");
        setRebuilding(false);
        setRebuildProgress(null);
      }
    }).then((f) => {
      if (cancelled) f();
      else unlistenEmbedComplete = f;
    });

    return () => {
      cancelled = true;
      if (unlistenProgress) unlistenProgress();
      if (unlistenComplete) unlistenComplete();
      if (unlistenError) unlistenError();
      if (unlistenEmbedProgress) unlistenEmbedProgress();
      if (unlistenEmbedComplete) unlistenEmbedComplete();
    };
  }, [loadFolders]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        setIsDragOver(true);
      } else if (event.payload.type === "drop") {
        setIsDragOver(false);
        const payload = event.payload;
        const paths: string[] = "paths" in payload ? (payload as { paths: string[] }).paths : [];
        (async () => {
          const results = await Promise.allSettled(
            paths.map((p: string) => {
              const conflict = checkFolderConflict(p, folders);
              if (conflict) {
                message.warning(conflict);
                return Promise.reject(new Error(conflict));
              }
              return invoke("start_index", { folder: p });
            })
          );
          const succeeded = results.filter(r => r.status === "fulfilled").length;
          const failed = results.filter(r => r.status === "rejected").length;
          if (succeeded > 0) {
            message.success(`已添加 ${succeeded} 个文件夹`);
            loadFolders();
          }
          if (failed > 0) {
            message.error(`${failed} 个文件夹添加失败`);
          }
        })();
      } else {
        setIsDragOver(false);
      }
    }).then(fn => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, [loadFolders]);

  const addFolder = async () => {
    const selected = await open({ directory: true });
    if (!selected) return;
    const folder = selected as string;
    const conflict = checkFolderConflict(folder, folders);
    if (conflict) {
      message.warning(conflict);
      return;
    }
    setIndexing(folder);
    setProgress(null);
    try {
      await invoke("start_index", { folder });
    } catch (e: unknown) {
      message.error(`索引失败：${e instanceof Error ? e.message : String(e)}`);
      setIndexing(null);
      setProgress(null);
    }
  };

  const reindex = async (folder: string) => {
    setIndexing(folder);
    setProgress(null);
    try {
      await invoke("start_index", { folder });
    } catch (e: unknown) {
      message.error(`索引失败：${e instanceof Error ? e.message : String(e)}`);
      setIndexing(null);
      setProgress(null);
    }
  };

  const removeFolder = async (folder: string) => {
    try {
      await invoke("remove_folder", { folder });
      loadFolders();
      loadStats();
      message.success("已移除文件夹");
    } catch (e: unknown) {
      message.error(`移除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const clearAllIndex = () => {
    Modal.confirm({
      title: "确认清除所有索引？",
      content: "此操作将删除所有已索引的文件记录、全文索引和语义向量，操作不可撤销。",
      okText: "确认清除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        setClearing(true);
        try {
          await invoke("clear_all_index");
          loadFolders();
          loadStats();
          message.success("索引已全部清除");
        } catch (e: unknown) {
          message.error(`清除失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
          setClearing(false);
        }
      },
    });
  };

  const rebuildVectorIndex = async () => {
    setRebuilding(true);
    setRebuildProgress(null);
    try {
      await invoke("rebuild_vector_index");
    } catch (e: unknown) {
      message.error(`重建失败：${e instanceof Error ? e.message : String(e)}`);
      setRebuilding(false);
      setRebuildProgress(null);
    }
  };

  const changeTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    localStorage.setItem(THEME_KEY, mode);
    window.dispatchEvent(new CustomEvent("docmind-theme", { detail: mode }));
  };

  const formatShortcutFromEvent = (e: React.KeyboardEvent): string | null => {
    const key = e.key;
    // 忽略单独的修饰键按下
    if (["Meta", "Control", "Alt", "Shift", "CapsLock"].includes(key)) return null;

    const parts: string[] = [];
    if (e.metaKey || e.ctrlKey) parts.push("CmdOrCtrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");

    const keyMap: Record<string, string> = {
      ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      " ": "Space", Escape: "Escape", Tab: "Tab", Enter: "Return",
      Backspace: "Backspace", Delete: "Delete",
    };
    const mapped = keyMap[key] ?? (key.length === 1 ? key.toUpperCase() : /^F\d+$/.test(key) ? key : null);
    if (!mapped) return null;
    // 需要至少一个修饰键才能作为全局快捷键
    if (parts.length === 0) return null;

    parts.push(mapped);
    return parts.join("+");
  };

  const handleShortcutKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { setRecordingShortcut(false); return; }
    const result = formatShortcutFromEvent(e);
    if (result) {
      setShortcut(result);
      setRecordingShortcut(false);
    }
  };

  const saveShortcut = async () => {
    setSavingShortcut(true);
    try {
      // 在保存前检测冲突
      if (shortcut) {
        try {
          const available = await invoke<boolean>("check_shortcut_conflict", { shortcut });
          if (!available) {
            message.error(`快捷键 ${shortcut} 已被其他应用占用，请选择其他组合`);
            // 检测后需要恢复之前保存的快捷键
            const savedShortcut = await invoke<string | null>("get_global_shortcut");
            if (savedShortcut) {
              await invoke("set_global_shortcut", { shortcut: savedShortcut });
            }
            return;
          }
        } catch {
          // 检测失败时不阻止保存
        }
      }
      await invoke("set_global_shortcut", { shortcut: shortcut || null });
      message.success(shortcut ? `快捷键已设置：${shortcut}` : "快捷键已清除");
    } catch (e: unknown) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingShortcut(false);
    }
  };

  const saveApiConfig = async () => {
    setSavingApiConfig(true);
    try {
      await invoke("set_api_llm_config", { config: apiConfig });
      message.success("API 配置已保存");
    } catch (e: unknown) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingApiConfig(false);
    }
  };

  return (
    <Drawer
      title={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SettingOutlined style={{ color: "#1677ff" }} />
          <span>设置</span>
        </div>
      }
      open={drawerOpen}
      onClose={onClose}
      width={480}
      styles={{
        body: { padding: "20px 24px", background: "var(--color-bg)" },
      }}
      footer={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={addFolder}
          loading={indexing !== null}
          block
          style={{ borderRadius: 8, height: 38 }}
        >
          添加文件夹
        </Button>
      }
    >
      {/* ── 监听文件夹 ── */}
      <div style={{
        background: "var(--color-surface)",
        borderRadius: 10,
        border: "1px solid var(--color-border)",
        marginBottom: 16,
        overflow: "hidden",
      }}>
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex", alignItems: "center", gap: 7,
        }}>
          <FolderOutlined style={{ color: "#1677ff", fontSize: 14 }} />
          <Typography.Text strong style={{ fontSize: 13 }}>
            已监听的文件夹
          </Typography.Text>
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            onClick={loadStats}
            style={{ marginLeft: "auto", color: "#94a3b8", padding: "0 4px" }}
            title="刷新统计"
          />
        </div>

        {/* 索引统计 */}
        {stats && (
          <div style={{
            display: "flex", gap: 0,
            borderBottom: "1px solid var(--color-border)",
          }}>
            {[
              { icon: <FileTextOutlined style={{ color: "#1677ff" }} />, label: "文件数", value: stats.file_count.toLocaleString() },
              { icon: <DatabaseOutlined style={{ color: "#7c3aed" }} />, label: "文本块", value: stats.chunk_count.toLocaleString() },
              { icon: <DatabaseOutlined style={{ color: "#16a34a" }} />, label: "索引大小", value: `${stats.db_size_mb.toFixed(1)} MB` },
            ].map((item, i) => (
              <div key={i} style={{
                flex: 1, textAlign: "center", padding: "10px 4px",
                borderRight: i < 2 ? "1px solid var(--color-border)" : "none",
              }}>
                <div style={{ marginBottom: 2 }}>{item.icon}</div>
                <Statistic
                  value={item.value}
                  valueStyle={{ fontSize: 14, fontWeight: 600, color: "#1a1d23" }}
                />
                <Typography.Text type="secondary" style={{ fontSize: 10 }}>{item.label}</Typography.Text>
              </div>
            ))}
          </div>
        )}

        {/* 索引进度 */}
        {indexing && (
          <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--color-border)", background: "var(--color-primary-bg)" }}>
            <Typography.Text style={{ fontSize: 12, color: "#1677ff" }}>
              {progress ? `正在索引：${progress.current}` : "正在扫描文件..."}
            </Typography.Text>
            <Progress
              percent={progress?.total ? Math.round((progress.done / progress.total) * 100) : 0}
              size="small"
              status="active"
              style={{ marginTop: 6, marginBottom: 0 }}
            />
          </div>
        )}

        <div
          style={{
            border: isDragOver ? "2px dashed #1677ff" : "2px dashed transparent",
            borderRadius: 8,
            padding: 4,
            transition: "border-color 0.2s",
            minHeight: 60,
            position: "relative",
          }}
        >
          {isDragOver && (
            <div style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(22,119,255,0.05)",
              borderRadius: 8,
              fontSize: 12,
              color: "#1677ff",
              pointerEvents: "none",
              zIndex: 1,
            }}>
              松开以添加文件夹
            </div>
          )}
          {folders.length === 0 ? (
            <div style={{ padding: "24px 16px", textAlign: "center", color: "var(--color-text-muted)", fontSize: 13 }}>
              暂未添加文件夹，点击下方按钮添加
            </div>
          ) : (
            <List
              dataSource={folders}
              renderItem={(folder) => (
                <List.Item
                  style={{ padding: "10px 16px" }}
                  actions={[
                    <Button
                      key="reindex"
                      type="text"
                      size="small"
                      icon={<ReloadOutlined />}
                      loading={indexing === folder}
                      onClick={() => reindex(folder)}
                      style={{ fontSize: 12, color: "var(--color-text-secondary)" }}
                    >
                      重新索引
                    </Button>,
                    <Button
                      key="remove"
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      disabled={indexing !== null}
                      onClick={() => removeFolder(folder)}
                      style={{ fontSize: 12 }}
                    >
                      移除
                    </Button>,
                  ]}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: 7,
                      background: "#fffbeb",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      flexShrink: 0,
                    }}>
                      <FolderOutlined style={{ color: "#f59e0b", fontSize: 14 }} />
                    </div>
                    <Typography.Text
                      ellipsis={{ tooltip: folder }}
                      style={{ fontSize: 13, color: "var(--color-text)" }}
                    >
                      {folder}
                    </Typography.Text>
                  </div>
                </List.Item>
              )}
            />
          )}
        </div>
      </div>

      {/* ── 语义索引 ── */}
      <div style={{
        background: "var(--color-surface)",
        borderRadius: 10,
        border: "1px solid var(--color-border)",
        overflow: "hidden",
      }}>
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex", alignItems: "center", gap: 7,
        }}>
          <ThunderboltOutlined style={{ color: "#7c3aed", fontSize: 14 }} />
          <Typography.Text strong style={{ fontSize: 13 }}>
            语义索引
          </Typography.Text>
        </div>

        <div style={{ padding: "14px 16px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 14, lineHeight: 1.6 }}>
            语义搜索或 AI 问答结果异常时，可重建向量索引（会清空旧索引并重新生成）。
          </Typography.Text>

          {rebuilding && (
            <div style={{ marginBottom: 14 }}>
              <Typography.Text style={{ fontSize: 12, color: "#7c3aed" }}>
                {rebuildProgress
                  ? `正在生成向量：${rebuildProgress.current}（${rebuildProgress.done}/${rebuildProgress.total}）`
                  : "正在初始化..."}
              </Typography.Text>
              <Progress
                percent={rebuildProgress?.total ? Math.round((rebuildProgress.done / rebuildProgress.total) * 100) : 0}
                size="small"
                status="active"
                strokeColor="#7c3aed"
                style={{ marginTop: 6, marginBottom: 0 }}
              />
            </div>
          )}

          <Button
            icon={<ThunderboltOutlined />}
            loading={rebuilding}
            disabled={indexing !== null}
            onClick={rebuildVectorIndex}
            style={{ borderRadius: 8 }}
          >
            重建语义索引
          </Button>
        </div>
      </div>

      {/* ── 外观 ── */}
      <div style={{
        background: "var(--color-surface)",
        borderRadius: 10,
        border: "1px solid var(--color-border)",
        overflow: "hidden",
        marginTop: 16,
      }}>
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex", alignItems: "center", gap: 7,
        }}>
          <BgColorsOutlined style={{ color: "#f59e0b", fontSize: 14 }} />
          <Typography.Text strong style={{ fontSize: 13 }}>外观</Typography.Text>
        </div>
        <div style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {([
              { key: "system", label: t("settings.theme_system") },
              { key: "light",  label: t("settings.theme_light") },
              { key: "dark",   label: t("settings.theme_dark") },
            ] as { key: ThemeMode; label: string }[]).map((opt) => (
              <button
                key={opt.key}
                onClick={() => changeTheme(opt.key)}
                style={{
                  flex: 1,
                  padding: "7px 0",
                  borderRadius: 8,
                  border: `1px solid ${themeMode === opt.key ? "#1677ff" : "var(--color-border)"}`,
                  background: themeMode === opt.key ? "var(--color-selected)" : "var(--color-bg)",
                  color: themeMode === opt.key ? "#1677ff" : "var(--color-text-secondary)",
                  fontSize: 12,
                  fontWeight: themeMode === opt.key ? 600 : 400,
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {/* 语言切换 */}
          <div style={{ marginTop: 12 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
              {t("settings.language")} / Language
            </Typography.Text>
            <div style={{ display: "flex", gap: 6 }}>
              {[{ key: "zh", label: "中文" }, { key: "en", label: "English" }].map(opt => (
                <button
                  key={opt.key}
                  onClick={() => i18n.changeLanguage(opt.key)}
                  style={{
                    padding: "4px 12px",
                    borderRadius: 6,
                    border: "1px solid var(--color-border)",
                    background: "var(--color-bg)",
                    color: "var(--color-text)",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── 在线 API ── */}
      <div style={{
        background: "var(--color-surface)",
        borderRadius: 10,
        border: "1px solid var(--color-border)",
        overflow: "hidden",
        marginTop: 16,
      }}>
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex", alignItems: "center", gap: 7,
        }}>
          <GlobalOutlined style={{ color: "#16a34a", fontSize: 14 }} />
          <Typography.Text strong style={{ fontSize: 13 }}>在线 API（OpenAI 兼容）</Typography.Text>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {apiConfig.enabled ? "已启用" : "已禁用"}
            </Typography.Text>
            <Switch
              size="small"
              checked={apiConfig.enabled}
              onChange={(v) => setApiConfig(prev => ({ ...prev, enabled: v }))}
            />
          </div>
        </div>
        <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>API 端点</Typography.Text>
            <Input
              size="small"
              value={apiConfig.endpoint}
              onChange={(e) => setApiConfig(prev => ({ ...prev, endpoint: e.target.value }))}
              placeholder="https://api.openai.com/v1/chat/completions"
              style={{ borderRadius: 6 }}
            />
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>API Key</Typography.Text>
            <Input.Password
              size="small"
              value={apiConfig.api_key}
              onChange={(e) => setApiConfig(prev => ({ ...prev, api_key: e.target.value }))}
              placeholder="sk-..."
              style={{ borderRadius: 6 }}
            />
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>模型名称</Typography.Text>
            <Input
              size="small"
              value={apiConfig.model_name}
              onChange={(e) => setApiConfig(prev => ({ ...prev, model_name: e.target.value }))}
              placeholder="gpt-4o-mini"
              style={{ borderRadius: 6 }}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>温度</Typography.Text>
              <InputNumber
                size="small"
                min={0} max={2} step={0.1}
                value={apiConfig.temperature}
                onChange={(v) => v !== null && setApiConfig(prev => ({ ...prev, temperature: v }))}
                style={{ width: "100%", borderRadius: 6 }}
              />
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>最大 Token</Typography.Text>
              <InputNumber
                size="small"
                min={128} max={8192} step={256}
                value={apiConfig.max_tokens}
                onChange={(v) => v !== null && setApiConfig(prev => ({ ...prev, max_tokens: v }))}
                style={{ width: "100%", borderRadius: 6 }}
              />
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>Top P</Typography.Text>
              <InputNumber
                size="small"
                min={0} max={1} step={0.05}
                value={apiConfig.top_p}
                onChange={(v) => v !== null && setApiConfig(prev => ({ ...prev, top_p: v }))}
                style={{ width: "100%", borderRadius: 6 }}
              />
            </div>
          </div>
          <Button
            type="primary"
            size="small"
            loading={savingApiConfig}
            onClick={saveApiConfig}
            style={{ borderRadius: 8, alignSelf: "flex-start" }}
          >
            保存配置
          </Button>
        </div>
      </div>

      {/* ── 全局快捷键 ── */}
      <div style={{
        background: "var(--color-surface)",
        borderRadius: 10,
        border: "1px solid var(--color-border)",
        overflow: "hidden",
        marginTop: 16,
      }}>
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex", alignItems: "center", gap: 7,
        }}>
          <GlobalOutlined style={{ color: "#1677ff", fontSize: 14 }} />
          <Typography.Text strong style={{ fontSize: 13 }}>全局快捷键</Typography.Text>
        </div>
        <div style={{ padding: "14px 16px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12, lineHeight: 1.6 }}>
            在任意窗口按下快捷键即可唤醒 DocMind 搜索窗口。
          </Typography.Text>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {recordingShortcut ? (
              <div
                tabIndex={0}
                autoFocus
                onKeyDown={handleShortcutKeyDown}
                onBlur={() => setRecordingShortcut(false)}
                style={{
                  flex: 1,
                  border: "2px solid #1677ff",
                  borderRadius: 8,
                  padding: "6px 12px",
                  fontSize: 13,
                  color: "#1677ff",
                  background: "#eff6ff",
                  cursor: "text",
                  outline: "none",
                  textAlign: "center",
                }}
              >
                按下快捷键…（Esc 取消）
              </div>
            ) : (
              <div
                onClick={() => setRecordingShortcut(true)}
                style={{
                  flex: 1,
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  padding: "6px 12px",
                  fontSize: 13,
                  color: shortcut ? "var(--color-text)" : "var(--color-text-muted)",
                  background: "var(--color-bg)",
                  cursor: "pointer",
                  textAlign: "center",
                  fontFamily: shortcut ? '"SFMono-Regular", Menlo, monospace' : "inherit",
                  fontWeight: shortcut ? 600 : 400,
                }}
              >
                {shortcut || "点击录制快捷键"}
              </div>
            )}
            {shortcut && !recordingShortcut && (
              <Button
                size="small"
                type="text"
                style={{ color: "#94a3b8", fontSize: 12 }}
                onClick={() => setShortcut("")}
              >
                清除
              </Button>
            )}
            <Button
              size="small"
              type="primary"
              loading={savingShortcut}
              disabled={recordingShortcut}
              onClick={saveShortcut}
              style={{ borderRadius: 8 }}
            >
              保存
            </Button>
          </div>
        </div>
      </div>

      {/* ── 定时重索引 ── */}
      <div style={{ marginBottom: 0, marginTop: 16, borderRadius: 10, border: "1px solid var(--color-border)", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface)", display: "flex", alignItems: "center", gap: 8 }}>
          <ReloadOutlined style={{ color: "#64748b" }} />
          <Typography.Text strong style={{ fontSize: 13 }}>定时重索引</Typography.Text>
        </div>
        <div style={{ padding: "14px 16px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
            自动定期重新扫描并更新文件索引。0 分钟 = 禁用。
          </Typography.Text>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <InputNumber
              min={0} max={10080} step={60}
              value={reindexInterval}
              onChange={(v) => v !== null && setReindexInterval(v)}
              style={{ width: 100 }}
              addonAfter="分钟"
            />
            <Button
              size="small"
              type="primary"
              onClick={async () => {
                await invoke("set_reindex_interval", { minutes: reindexInterval });
                message.success(reindexInterval === 0 ? "已禁用定时重索引" : `已设置每 ${reindexInterval} 分钟重索引`);
              }}
            >
              保存
            </Button>
          </div>
        </div>
      </div>

      {/* ── 数据管理 ── */}
      <div style={{
        background: "var(--color-surface)",
        borderRadius: 10,
        border: "1px solid #fee2e2",
        overflow: "hidden",
        marginTop: 16,
      }}>
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid #fee2e2",
          display: "flex", alignItems: "center", gap: 7,
        }}>
          <ClearOutlined style={{ color: "#ef4444", fontSize: 14 }} />
          <Typography.Text strong style={{ fontSize: 13, color: "#ef4444" }}>
            数据管理
          </Typography.Text>
        </div>
        <div style={{ padding: "14px 16px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12, lineHeight: 1.6 }}>
            清除所有索引数据（文件记录、全文索引、语义向量）。此操作不可撤销，清除后需重新添加文件夹建立索引。
          </Typography.Text>
          <Button
            danger
            icon={<ClearOutlined />}
            loading={clearing}
            disabled={indexing !== null || rebuilding}
            onClick={clearAllIndex}
            style={{ borderRadius: 8 }}
          >
            一键清除所有索引
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
