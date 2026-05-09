import { Drawer, Button, Typography, Progress, message, Modal, Statistic, InputNumber, Space } from "antd";
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
  FileSearchOutlined,
} from "@ant-design/icons";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n/index";
import { THEME_KEY, type ThemeMode } from "../main";
import { useLicenseStore } from "../stores/licenseStore";

// ── 文件类型分组定义 ──────────────────────────────────────────────────────────
//
// `pro: true` 的分组只有 Pro / Trial 用户可以勾选；Free 用户点 chip 会
// 直接弹升级对话框,reason="ocr_indexing"。
const FILE_TYPE_GROUPS = [
  { label: "文档", types: ["pdf", "docx", "doc", "pptx", "ppt", "rtf", "epub"] },
  { label: "表格", types: ["xlsx", "xls", "csv"] },
  { label: "文本/标记", types: ["txt", "md", "rst"] },
  { label: "代码", types: [
    "py", "js", "ts", "jsx", "tsx", "java", "go", "rs",
    "c", "cpp", "h", "swift", "kt", "rb", "php", "cs",
    "vue", "svelte", "html", "css", "scss",
    "yaml", "yml", "json", "toml", "xml",
    "sh", "sql",
  ] },
  { label: "归档", types: ["zip"] },
  { label: "图像 (OCR)", types: ["jpg", "jpeg", "png", "bmp", "tiff", "tif", "webp", "heic", "heif"], pro: true },
] as const;

const ALL_TYPES = FILE_TYPE_GROUPS.flatMap((g) => [...g.types]);
const PRO_ONLY_TYPES: Set<string> = new Set(
  FILE_TYPE_GROUPS.filter((g) => "pro" in g && g.pro).flatMap((g) => [...g.types]),
);

const DRAWER_STYLES = {
  wrapper: { width: 480 },
  body: { padding: "20px 24px", background: "var(--color-bg)" },
  header: { borderBottom: "1px solid var(--color-border)" },
};

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
  const [excludedDirs, setExcludedDirs] = useState("");
  const [savingExcluded, setSavingExcluded] = useState(false);

  // ── 文件类型过滤 ──
  const [enabledTypes, setEnabledTypes] = useState<string[]>([...ALL_TYPES]);
  const [savingTypes, setSavingTypes] = useState(false);

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
      invoke<number>("get_reindex_interval").then(v => setReindexInterval(v)).catch(() => {});
      invoke<string | null>("get_setting", { key: "excluded_dirs" })
        .then((v) => setExcludedDirs((v ?? "").split(",").filter((s) => s.trim().length > 0).join("\n")))
        .catch(() => {});
      invoke<string[]>("get_indexed_types")
        .then((types) => setEnabledTypes(types))
        .catch(() => setEnabledTypes([...ALL_TYPES]));
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
      // force=true → re-parse every file regardless of modtime. Without
      // this the scan would skip everything that hasn't changed and the
      // button would appear to "complete" instantly.
      await invoke("start_index", { folder, force: true });
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

  const licensePlan = useLicenseStore((s) => s.status?.plan);
  const showUpgrade = useLicenseStore((s) => s.showUpgrade);
  const isPro = licensePlan === "pro" || licensePlan === "trial";

  const toggleType = (ext: string) => {
    // Pro-only types: gate enabling. Disabling stays free so a user who
    // bought Pro then downgraded can still turn things off.
    if (PRO_ONLY_TYPES.has(ext) && !isPro && !enabledTypes.includes(ext)) {
      showUpgrade("ocr_indexing");
      return;
    }
    setEnabledTypes((prev) =>
      prev.includes(ext) ? prev.filter((e) => e !== ext) : [...prev, ext]
    );
  };

  const saveTypes = () => {
    Modal.confirm({
      title: "保存文件类型配置",
      content: (
        <div>
          <p style={{ marginBottom: 12 }}>是否同时清理已索引的被移除类型文件？</p>
          <p style={{ fontSize: 12, color: "#64748b" }}>
            "清理"会从索引中删除已不再启用类型的文件记录，下次搜索不再出现这些文件。
          </p>
        </div>
      ),
      okText: "清理并保存",
      cancelText: "仅对后续生效",
      onOk: async () => {
        setSavingTypes(true);
        try {
          await invoke("set_indexed_types", { types: enabledTypes, cleanupRemoved: true });
          message.success("文件类型配置已保存，被移除类型记录已清理");
        } catch (e: unknown) {
          message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
          setSavingTypes(false);
        }
      },
      onCancel: async () => {
        setSavingTypes(true);
        try {
          await invoke("set_indexed_types", { types: enabledTypes, cleanupRemoved: false });
          message.success("文件类型配置已保存");
        } catch (e: unknown) {
          message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
          setSavingTypes(false);
        }
      },
    });
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

  return (
    <Drawer
      title={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SettingOutlined style={{ color: "var(--color-text-secondary)" }} />
          <span>设置</span>
        </div>
      }
      open={drawerOpen}
      onClose={onClose}
      styles={DRAWER_STYLES}
    >
      {/* ── 监听文件夹 ── */}
      <div style={{
        background: "var(--color-surface)",
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        marginBottom: 16,
        overflow: "hidden",
      }}>
        <div style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <FolderOutlined style={{ color: "var(--color-text-secondary)", fontSize: 13 }} />
          <span className="section-label">Watched Folders</span>
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            onClick={loadStats}
            style={{ marginLeft: "auto", color: "var(--color-text-muted)", padding: "0 4px" }}
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
              { icon: <FileTextOutlined />, label: "文件数", value: stats.file_count.toLocaleString() },
              { icon: <DatabaseOutlined />, label: "文本块", value: stats.chunk_count.toLocaleString() },
              { icon: <DatabaseOutlined />, label: "索引大小", value: `${stats.db_size_mb.toFixed(1)} MB` },
            ].map((item, i) => (
              <div key={i} style={{
                flex: 1, textAlign: "center", padding: "10px 4px",
                borderRight: i < 2 ? "1px solid var(--color-border)" : "none",
                color: "var(--color-text-secondary)",
              }}>
                <div style={{ marginBottom: 4, fontSize: 13 }}>{item.icon}</div>
                <Statistic
                  value={item.value}
                  styles={{
                    content: { fontSize: 14, fontWeight: 600, color: "var(--color-text)", fontFamily: "var(--font-mono)" },
                  }}
                />
                <Typography.Text type="secondary" style={{ fontSize: 10 }}>{item.label}</Typography.Text>
              </div>
            ))}
          </div>
        )}

        {/* 索引进度 */}
        {indexing && (
          <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--color-border)", background: "var(--color-primary-bg)" }}>
            <Typography.Text style={{ fontSize: 12, color: "var(--color-primary)" }}>
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
            border: isDragOver ? "2px dashed var(--color-primary)" : "2px dashed transparent",
            borderRadius: 6,
            padding: 4,
            transition: "border-color var(--duration-fast) var(--easing-out)",
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
              background: "var(--color-primary-bg)",
              borderRadius: 6,
              fontSize: 12,
              color: "var(--color-primary)",
              pointerEvents: "none",
              zIndex: 1,
            }}>
              松开以添加文件夹
            </div>
          )}
          {folders.length === 0 ? (
            <div style={{ padding: "24px 16px", textAlign: "center", color: "var(--color-text-muted)", fontSize: 13 }}>
              暂未添加文件夹，点击下方按钮或拖拽文件夹到此处
            </div>
          ) : (
            <div>
              {folders.map((folder, idx) => (
                <div
                  key={folder}
                  style={{
                    padding: "10px 16px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    borderTop: idx === 0 ? undefined : "1px solid var(--color-border)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
                    <FolderOutlined style={{ color: "var(--color-text-secondary)", fontSize: 14, flexShrink: 0 }} />
                    <Typography.Text
                      ellipsis={{ tooltip: folder }}
                      className="mono"
                      style={{ fontSize: 12, color: "var(--color-text)" }}
                    >
                      {folder}
                    </Typography.Text>
                  </div>
                  <Space size={4}>
                    <Button
                      type="text"
                      size="small"
                      icon={<ReloadOutlined />}
                      loading={indexing === folder}
                      onClick={() => reindex(folder)}
                      style={{ fontSize: 12, color: "var(--color-text-secondary)" }}
                    >
                      重新索引
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      disabled={indexing !== null}
                      onClick={() => removeFolder(folder)}
                      style={{ fontSize: 12 }}
                    >
                      移除
                    </Button>
                  </Space>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 添加文件夹按钮 */}
        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--color-border)" }}>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={addFolder}
            loading={indexing !== null}
            block
            style={{ borderRadius: 8, height: 36 }}
          >
            添加文件夹
          </Button>
        </div>
      </div>

      {/* ── 检索文件类型 ── */}
      <div style={{
        background: "var(--color-surface)",
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        overflow: "hidden",
        marginBottom: 16,
      }}>
        <div style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <FileSearchOutlined style={{ color: "var(--color-text-secondary)", fontSize: 13 }} />
          <span className="section-label">File Types</span>
        </div>

        <div style={{ padding: "14px 16px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 14, lineHeight: 1.6 }}>
            只有启用的类型才会被索引和检索。修改后需重新索引已有文件夹才能完全生效。
          </Typography.Text>

          {FILE_TYPE_GROUPS.map((group) => {
            const isProGroup = "pro" in group && group.pro;
            const locked = isProGroup && !isPro;
            return (
              <div key={group.label} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {group.label}
                  </Typography.Text>
                  {isProGroup && (
                    <span
                      className="chip chip-pro"
                      style={{
                        height: 16,
                        padding: "0 6px",
                        fontSize: 9,
                        textTransform: "uppercase",
                      }}
                    >
                      Pro
                    </span>
                  )}
                  {locked && (
                    <Typography.Text style={{ fontSize: 10, color: "var(--color-text-muted)" }}>
                      升级解锁 OCR 扫描件 / 图片识别
                    </Typography.Text>
                  )}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {group.types.map((ext) => {
                    const active = enabledTypes.includes(ext);
                    return (
                      <button
                        key={ext}
                        onClick={() => toggleType(ext)}
                        className={active ? "chip chip-primary" : "chip"}
                        style={{
                          cursor: "pointer",
                          fontFamily: "var(--font-mono)",
                          height: 22,
                          padding: "0 8px",
                          fontSize: 11,
                          opacity: active ? 1 : (locked ? 0.4 : 0.6),
                        }}
                        title={locked ? "Pro 功能 — 点击升级" : undefined}
                      >
                        {ext}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Button
              size="small"
              onClick={() =>
                setEnabledTypes(
                  isPro
                    ? [...ALL_TYPES]
                    : ALL_TYPES.filter((t) => !PRO_ONLY_TYPES.has(t)),
                )
              }
              style={{ fontSize: 12 }}
            >
              全选
            </Button>
            <Button
              size="small"
              onClick={() => setEnabledTypes([])}
              style={{ fontSize: 12 }}
            >
              全不选
            </Button>
            <Button
              type="primary"
              size="small"
              loading={savingTypes}
              onClick={saveTypes}
              style={{ marginLeft: "auto", fontSize: 12 }}
            >
              保存
            </Button>
          </div>
        </div>
      </div>

      {/* ── 语义索引 ── */}
      <div style={{
        background: "var(--color-surface)",
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        overflow: "hidden",
      }}>
        <div style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <ThunderboltOutlined style={{ color: "var(--color-text-secondary)", fontSize: 13 }} />
          <span className="section-label">Semantic Index</span>
        </div>

        <div style={{ padding: "14px 16px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 14, lineHeight: 1.6 }}>
            语义搜索或 AI 问答结果异常时，可重建向量索引（会清空旧索引并重新生成）。
          </Typography.Text>

          {rebuilding && (
            <div style={{ marginBottom: 14 }}>
              <Typography.Text style={{ fontSize: 12, color: "var(--color-primary)" }}>
                {rebuildProgress
                  ? `正在生成向量：${rebuildProgress.current}（${rebuildProgress.done}/${rebuildProgress.total}）`
                  : "正在初始化..."}
              </Typography.Text>
              <Progress
                percent={rebuildProgress?.total ? Math.round((rebuildProgress.done / rebuildProgress.total) * 100) : 0}
                size="small"
                status="active"
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
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        overflow: "hidden",
        marginTop: 16,
      }}>
        <div style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <BgColorsOutlined style={{ color: "var(--color-text-secondary)", fontSize: 13 }} />
          <span className="section-label">Appearance</span>
        </div>
        <div style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {([
              { key: "system", label: t("settings.theme_system") },
              { key: "light",  label: t("settings.theme_light") },
              { key: "dark",   label: t("settings.theme_dark") },
            ] as { key: ThemeMode; label: string }[]).map((opt) => {
              const active = themeMode === opt.key;
              return (
                <button
                  key={opt.key}
                  onClick={() => changeTheme(opt.key)}
                  style={{
                    flex: 1,
                    padding: "7px 0",
                    borderRadius: 6,
                    border: `1px solid ${active ? "var(--color-primary)" : "var(--color-border)"}`,
                    background: active ? "var(--color-primary-bg)" : "var(--color-surface-elevated)",
                    color: active ? "var(--color-primary)" : "var(--color-text-secondary)",
                    fontSize: 12,
                    fontWeight: active ? 600 : 500,
                    cursor: "pointer",
                    transition: "all var(--duration-fast) var(--easing-out)",
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <div style={{ marginTop: 14 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
              {t("settings.language")} / Language
            </Typography.Text>
            <div style={{ display: "flex", gap: 6 }}>
              {[{ key: "zh", label: "中文" }, { key: "en", label: "English" }].map((opt) => {
                const active = i18n.language?.startsWith(opt.key);
                return (
                  <button
                    key={opt.key}
                    onClick={() => i18n.changeLanguage(opt.key)}
                    style={{
                      padding: "4px 12px",
                      borderRadius: 6,
                      border: `1px solid ${active ? "var(--color-primary)" : "var(--color-border)"}`,
                      background: active ? "var(--color-primary-bg)" : "var(--color-surface-elevated)",
                      color: active ? "var(--color-primary)" : "var(--color-text)",
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: active ? 600 : 500,
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── 全局快捷键 ── */}
      <div style={{
        background: "var(--color-surface)",
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        overflow: "hidden",
        marginTop: 16,
      }}>
        <div style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <GlobalOutlined style={{ color: "var(--color-text-secondary)", fontSize: 13 }} />
          <span className="section-label">Global Shortcut</span>
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
                  border: "1px solid var(--color-primary)",
                  boxShadow: "0 0 0 2px var(--color-primary-bg)",
                  borderRadius: 6,
                  padding: "6px 12px",
                  fontSize: 13,
                  color: "var(--color-primary)",
                  background: "var(--color-primary-bg)",
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
                  borderRadius: 6,
                  padding: "6px 12px",
                  fontSize: 13,
                  color: shortcut ? "var(--color-text)" : "var(--color-text-muted)",
                  background: "var(--color-surface-elevated)",
                  cursor: "pointer",
                  textAlign: "center",
                  fontFamily: shortcut ? "var(--font-mono)" : "inherit",
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
                style={{ color: "var(--color-text-muted)", fontSize: 12 }}
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
              style={{ borderRadius: 6 }}
            >
              保存
            </Button>
          </div>
        </div>
      </div>

      {/* ── 定时重索引 ── */}
      <div style={{ marginBottom: 0, marginTop: 16, borderRadius: 8, border: "1px solid var(--color-border)", overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface)", display: "flex", alignItems: "center", gap: 8 }}>
          <ReloadOutlined style={{ color: "var(--color-text-secondary)", fontSize: 13 }} />
          <span className="section-label">Auto Re-index</span>
        </div>
        <div style={{ padding: "14px 16px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
            自动定期重新扫描并更新文件索引。0 分钟 = 禁用。
          </Typography.Text>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Space.Compact>
              <InputNumber
                min={0} max={10080} step={60}
                value={reindexInterval}
                onChange={(v) => v !== null && setReindexInterval(v)}
                style={{ width: 100 }}
              />
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "0 11px",
                  height: 32,
                  border: "1px solid var(--color-border)",
                  borderLeft: "none",
                  borderRadius: "0 6px 6px 0",
                  background: "var(--color-surface-elevated)",
                  color: "var(--color-text-secondary)",
                  fontSize: 13,
                }}
              >
                分钟
              </span>
            </Space.Compact>
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

      {/* ── 排除目录 ── */}
      <div style={{ marginTop: 16, borderRadius: 8, border: "1px solid var(--color-border)", overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface)", display: "flex", alignItems: "center", gap: 8 }}>
          <DeleteOutlined style={{ color: "var(--color-text-secondary)", fontSize: 13 }} />
          <span className="section-label">Excluded Directories</span>
        </div>
        <div style={{ padding: "14px 16px" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 10, lineHeight: 1.7 }}>
            扫描时跳过这些子目录。下面这些是<strong>内置默认</strong>(始终生效),你可以再补充自定义的目录名。
          </Typography.Text>

          <div style={{
            background: "var(--color-surface-elevated)",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            padding: "8px 12px",
            marginBottom: 12,
            fontSize: 11,
            lineHeight: 1.7,
            color: "var(--color-text-secondary)",
            fontFamily: "var(--font-mono)",
            wordBreak: "break-all",
          }}>
            .git · .svn · .hg · node_modules · target · build · dist · .next · .cache ·{" "}
            __pycache__ · venv · .venv · .idea · .vscode · .DS_Store · Thumbs.db ·{" "}
            <span style={{ opacity: 0.7 }}>(以及所有以"."开头的隐藏目录)</span>
          </div>

          <Typography.Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>
            自定义排除目录(每行一个,只写目录名,不带路径):
          </Typography.Text>
          <textarea
            value={excludedDirs}
            onChange={(e) => setExcludedDirs(e.target.value)}
            placeholder={"例如:\nbackup\nlogs\nold-projects"}
            spellCheck={false}
            className="mono"
            rows={4}
            style={{
              width: "100%",
              padding: "8px 12px",
              fontSize: 12,
              background: "var(--color-surface-elevated)",
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              color: "var(--color-text)",
              outline: "none",
              fontFamily: "var(--font-mono)",
              resize: "vertical",
            }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, gap: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              修改后需要点上方文件夹的「重新索引」才生效。
            </Typography.Text>
            <Button
              size="small"
              type="primary"
              loading={savingExcluded}
              onClick={async () => {
                setSavingExcluded(true);
                try {
                  // Normalize: split on newlines / commas, trim, dedupe, rejoin with commas.
                  const items = excludedDirs
                    .split(/[,\n]/)
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0);
                  const normalized = Array.from(new Set(items)).join(",");
                  await invoke("set_setting", { key: "excluded_dirs", value: normalized });
                  setExcludedDirs(normalized.split(",").join("\n"));
                  message.success(items.length === 0 ? "已清空自定义排除目录" : `已保存 ${items.length} 项`);
                } catch (e) {
                  message.error(`保存失败:${e instanceof Error ? e.message : String(e)}`);
                } finally {
                  setSavingExcluded(false);
                }
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
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        overflow: "hidden",
        marginTop: 16,
      }}>
        <div style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <ClearOutlined style={{ color: "#ef4444", fontSize: 13 }} />
          <span className="section-label" style={{ color: "#ef4444" }}>Danger Zone</span>
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
            style={{ borderRadius: 6 }}
          >
            一键清除所有索引
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
