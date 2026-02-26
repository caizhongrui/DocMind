import { Typography, Dropdown, Select, Tooltip, Button, message } from "antd";
import { List as VirtualList } from "react-window";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  FileSearchOutlined,
  FilePdfOutlined,
  FileWordOutlined,
  FileExcelOutlined,
  FilePptOutlined,
  FileTextOutlined,
  FileMarkdownOutlined,
  FileOutlined,
  CopyOutlined,
  FolderOpenOutlined,
  ExportOutlined,
  CheckSquareOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import { useSearchStore } from "../stores/searchStore";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { HighlightText } from "../utils/highlight";
import type { SearchResult } from "../types";

function formatFileSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

// 文件类型 → 图标 + 颜色
const FILE_TYPE_CONFIG: Record<string, { icon: React.ReactNode; color: string }> = {
  pdf:  { icon: <FilePdfOutlined />,      color: "#e53e3e" },
  docx: { icon: <FileWordOutlined />,     color: "#2563eb" },
  doc:  { icon: <FileWordOutlined />,     color: "#2563eb" },
  xlsx: { icon: <FileExcelOutlined />,    color: "#16a34a" },
  xls:  { icon: <FileExcelOutlined />,    color: "#16a34a" },
  csv:  { icon: <FileExcelOutlined />,    color: "#0891b2" },
  pptx: { icon: <FilePptOutlined />,      color: "#ea580c" },
  ppt:  { icon: <FilePptOutlined />,      color: "#ea580c" },
  txt:  { icon: <FileTextOutlined />,     color: "#64748b" },
  md:   { icon: <FileMarkdownOutlined />, color: "#7c3aed" },
};

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function FileTypeIcon({ type }: { type: string }) {
  const cfg = FILE_TYPE_CONFIG[type.toLowerCase()] ?? {
    icon: <FileOutlined />, color: "#94a3b8"
  };
  return (
    <div style={{
      width: 32, height: 32, borderRadius: 8,
      background: hexToRgba(cfg.color, 0.1), color: cfg.color,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 16, flexShrink: 0,
    }}>
      {cfg.icon}
    </div>
  );
}

// 文件类型分组（用于筛选）
const TYPE_GROUPS: { label: string; types: string[]; color: string }[] = [
  { label: "PDF",    types: ["pdf"],              color: "#e53e3e" },
  { label: "Word",   types: ["docx", "doc"],      color: "#2563eb" },
  { label: "Excel",  types: ["xlsx", "xls", "csv"], color: "#16a34a" },
  { label: "PPT",    types: ["pptx", "ppt"],      color: "#ea580c" },
  { label: "文本",   types: ["txt", "md"],        color: "#64748b" },
];

// react-window v2 rowProps 类型
type RowExtraProps = {
  filteredItems: SearchResult[];
  selectedFileId: number | undefined;
  focusedIndex: number;
  isSemantic: boolean;
  query: string;
  onSelect: (item: SearchResult, index: number) => void;
  onDoubleClick: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, item: SearchResult) => void;
  batchMode: boolean;
  selectedItems: Set<number>;
  toggleItemSelect: (fileId: number) => void;
};

export default function ResultList() {
  const { results, selected, setSelected, loading, query, mode, sortBy, setSortBy } = useSearchStore();
  const [activeTypes, setActiveTypes] = useState<string[]>([]);
  const isSemantic = mode === "semantic";

  const [batchMode, setBatchMode] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<number>>(new Set());

  const listContainerRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(500);

  useEffect(() => {
    const el = listContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setListHeight(el.clientHeight));
    ro.observe(el);
    setListHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);


  const toggleItemSelect = (fileId: number) => {
    setSelectedItems(prev => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  };

  const selectAll = () => setSelectedItems(new Set(filtered.map(r => r.file_id)));
  const clearSelection = () => setSelectedItems(new Set());

  // 右键菜单 state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: (typeof results)[number];
  } | null>(null);

  // 键盘导航 state
  const [focusedIndex, setFocusedIndex] = useState(-1);

  // 筛选后的结果（需在 useEffect 之前声明，供键盘导航 useEffect 引用）
  const filtered = activeTypes.length === 0
    ? results
    : results.filter((r) => activeTypes.includes(r.file_type.toLowerCase()));

  // 动态行高：根据是否有摘要/元数据计算每行高度
  const getRowHeight = useCallback((index: number) => {
    const item = filtered[index];
    if (!item) return 72;
    const hasMetadata = !!(item.size || item.modified);
    const hasSnippet = !!item.snippet;
    if (hasSnippet && hasMetadata) return 134;
    if (hasSnippet) return 116;
    if (hasMetadata) return 86;
    return 68;
  }, [filtered]);

  // 点击其他地方关闭菜单
  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  // 键盘导航 useEffect
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (filtered.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex(prev => {
          const next = Math.min(prev + 1, filtered.length - 1);
          document.querySelector(`[data-result-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex(prev => {
          const next = Math.max(prev - 1, 0);
          document.querySelector(`[data-result-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (e.key === "Enter" && focusedIndex >= 0) {
        const item = filtered[focusedIndex];
        if (item) invoke("open_file", { path: item.path });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filtered, focusedIndex]);

  // 生成右键菜单项
  const getContextMenuItems = (result: (typeof results)[number]) => {
    const filename = result.name || result.path.split("/").pop() || result.path;
    return [
      {
        key: "reveal",
        icon: <FolderOpenOutlined />,
        label: "在 Finder 中显示",
        onClick: () => invoke("reveal_in_finder", { path: result.path }),
      },
      {
        key: "copy-path",
        icon: <CopyOutlined />,
        label: "复制完整路径",
        onClick: () => navigator.clipboard.writeText(result.path),
      },
      {
        key: "copy-name",
        icon: <FileOutlined />,
        label: "复制文件名",
        onClick: () => navigator.clipboard.writeText(filename),
      },
      { type: "divider" as const },
      {
        key: "open",
        label: "用默认应用打开",
        onClick: () => invoke("open_file", { path: result.path }),
      },
    ];
  };

  const toggleType = (types: string[]) => {
    setActiveTypes((prev) => {
      const isActive = types.every((t) => prev.includes(t));
      if (isActive) return prev.filter((t) => !types.includes(t));
      return [...new Set([...prev, ...types])];
    });
  };

  const handleExportCsv = async () => {
    if (filtered.length === 0) return;
    const BOM = "\uFEFF";
    const header = "文件名,路径,类型,得分\n";
    const rows = filtered.map(r => {
      const name = `"${r.name.replace(/"/g, '""')}"`;
      const path = `"${r.path.replace(/"/g, '""')}"`;
      return `${name},${path},${r.file_type},${r.score.toFixed(4)}`;
    }).join("\n");
    const content = BOM + header + rows;
    try {
      const savePath = await saveDialog({
        defaultPath: `search-results-${Date.now()}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!savePath) return;
      await invoke("write_text_file", { path: savePath, content });
      message.success(`已导出 ${filtered.length} 条结果`);
    } catch (e: unknown) {
      message.error(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const emptyText = (
    <div style={{ padding: "60px 24px", textAlign: "center" }}>
      <div style={{
        width: 64, height: 64, borderRadius: 16,
        background: "var(--color-bg)", margin: "0 auto 16px",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <FileSearchOutlined style={{ fontSize: 28, color: "#cbd5e1" }} />
      </div>
      {query.trim() ? (
        <>
          <Typography.Text style={{ display: "block", fontSize: 14, fontWeight: 500, color: "var(--color-text)", marginBottom: 6 }}>
            未找到相关文件
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            没有找到与 <strong style={{ color: "#1677ff" }}>"{query}"</strong> 匹配的内容
          </Typography.Text>
        </>
      ) : (
        <>
          <Typography.Text style={{ display: "block", fontSize: 14, fontWeight: 500, color: "var(--color-text)", marginBottom: 6 }}>
            开始搜索文件
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            输入关键词搜索文件内容、文件名
          </Typography.Text>
        </>
      )}
    </div>
  );

  // 计算每个分组的结果数量
  const groupCounts = TYPE_GROUPS.map((g) => ({
    ...g,
    count: results.filter((r) => g.types.includes(r.file_type.toLowerCase())).length,
  }));

  // react-window v2 rowComponent
  const RowComponent = ({
    index,
    style,
    filteredItems,
    selectedFileId,
    focusedIndex: fi,
    isSemantic: semantic,
    query: q,
    onSelect,
    onDoubleClick,
    onContextMenu,
    batchMode: bm,
    selectedItems: si,
    toggleItemSelect: toggleItem,
  }: {
    ariaAttributes: { "aria-posinset": number; "aria-setsize": number; role: "listitem" };
    index: number;
    style: React.CSSProperties;
  } & RowExtraProps) => {
    const item = filteredItems[index];
    if (!item) return null;
    const isSelected = selectedFileId === item.file_id;
    const isBatchSelected = bm && si.has(item.file_id);
    return (
      <div
        style={{
          ...style,
          cursor: "pointer",
          padding: "10px 14px",
          borderLeft: isSelected
            ? "3px solid var(--color-primary)"
            : fi === index
            ? "3px solid #93c5fd"
            : "3px solid transparent",
          background: isSelected
            ? "rgba(59,130,246,0.18)"
            : isBatchSelected
            ? "rgba(99,102,241,0.1)"
            : fi === index
            ? "var(--color-hover)"
            : "var(--color-surface)",
          boxSizing: "border-box",
        }}
        data-result-index={index}
        onClick={() => onSelect(item, index)}
        onDoubleClick={() => onDoubleClick(item.path)}
        onContextMenu={(e) => onContextMenu(e, item)}
      >
        <div style={{ display: "flex", gap: 10, width: "100%", minWidth: 0 }}>
          {bm && (
            <input
              type="checkbox"
              checked={si.has(item.file_id)}
              onChange={() => toggleItem(item.file_id)}
              style={{ marginRight: 8, marginTop: 6, flexShrink: 0, cursor: "pointer" }}
              onClick={(e) => e.stopPropagation()}
            />
          )}
          <FileTypeIcon type={item.file_type} />

          <div style={{ flex: 1, minWidth: 0 }}>
            {/* 文件名行 */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text)", wordBreak: "break-all", lineHeight: 1.4 }}>
                <HighlightText text={item.name} query={q} />
              </span>
              {semantic && (
                <span style={{
                  fontSize: 10, padding: "1px 6px", borderRadius: 10,
                  background: "var(--color-bg-purple)", color: "#7c3aed", fontWeight: 500,
                }}>
                  语义
                </span>
              )}
            </div>

            {/* 路径 */}
            <div style={{
              fontSize: 11, color: "var(--color-text-secondary)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              marginBottom: 2,
            }}>
              {item.path}
            </div>
            {/* 元数据：文件大小 · 修改日期 */}
            {(item.size || item.modified) && (
              <div style={{
                fontSize: 10, color: "var(--color-text-muted)",
                marginBottom: item.snippet ? 4 : 0,
              }}>
                {[item.size ? formatFileSize(item.size) : null, item.modified ? formatDate(item.modified) : null]
                  .filter(Boolean).join(" · ")}
              </div>
            )}

            {/* 片段预览 */}
            {item.snippet && (
              <div style={{
                fontSize: 12, lineHeight: 1.55, color: "var(--color-text-secondary)",
                borderLeft: `2px solid ${semantic ? "#a78bfa" : "#fbbf24"}`,
                paddingLeft: 8,
                background: semantic ? "var(--color-bg-purple)" : "var(--color-bg-amber)",
                borderRadius: "0 4px 4px 0",
                padding: "4px 8px",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}>
                {semantic
                  ? item.snippet
                  : <HighlightText text={item.snippet} query={q} />}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* 排序控制栏 */}
      {results.length > 0 && (
        <div style={{
          padding: "4px 12px",
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-bg)",
        }}>
          <Tooltip title="导出搜索结果 CSV">
            <Button
              size="small"
              type="text"
              icon={<ExportOutlined />}
              onClick={handleExportCsv}
              style={{ color: "#94a3b8", marginRight: "auto" }}
            />
          </Tooltip>
          <Tooltip title={batchMode ? "退出批量模式" : "批量操作"}>
            <Button
              size="small"
              type={batchMode ? "primary" : "text"}
              icon={<CheckSquareOutlined />}
              onClick={() => { setBatchMode(v => !v); clearSelection(); }}
              style={{ color: batchMode ? undefined : "#94a3b8" }}
            />
          </Tooltip>
          <Select
            size="small"
            value={sortBy}
            onChange={setSortBy}
            style={{ width: 100, fontSize: 12 }}
            options={[
              { value: "relevance", label: "相关度" },
              { value: "modified", label: "修改时间" },
              { value: "size", label: "文件大小" },
            ]}
          />
        </div>
      )}

      {/* 批量工具栏 */}
      {batchMode && selectedItems.size > 0 && (
        <div style={{
          padding: "6px 12px",
          display: "flex", alignItems: "center", gap: 8,
          background: "var(--color-primary-bg)",
          borderBottom: "1px solid rgba(22,119,255,0.2)",
          fontSize: 12,
          flexWrap: "wrap",
        }}>
          <span style={{ color: "var(--color-primary)" }}>已选 {selectedItems.size} 个文件</span>
          <Button size="small" onClick={selectAll}>全选</Button>
          <Button size="small" onClick={clearSelection}>取消</Button>
          <Button
            size="small"
            icon={<ExportOutlined />}
            onClick={async () => {
              const paths = filtered.filter(r => selectedItems.has(r.file_id)).map(r => r.path);
              const content = "\uFEFF文件名,路径\n" + paths.map(p => {
                const name = p.split("/").pop() ?? p;
                return `"${name}","${p}"`;
              }).join("\n");
              const savePath = await saveDialog({ defaultPath: "selected-files.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
              if (savePath) {
                await invoke("write_text_file", { path: savePath, content });
                message.success(`已导出 ${paths.length} 个文件`);
              }
            }}
          >
            导出选中
          </Button>
          <Button
            size="small"
            onClick={async () => {
              for (const item of filtered.filter(r => selectedItems.has(r.file_id))) {
                await invoke("open_file", { path: item.path });
              }
            }}
          >
            批量打开
          </Button>
          <Button
            size="small"
            icon={<RobotOutlined />}
            disabled={selectedItems.size === 0 || selectedItems.size > 10}
            onClick={async () => {
              const paths = filtered.filter(r => selectedItems.has(r.file_id)).map(r => r.path);
              try {
                await invoke("summarize_documents", { paths });
                message.info("摘要生成中，请打开「文档问答」面板查看结果");
              } catch (e) {
                message.error(`摘要生成失败：${e}`);
              }
            }}
          >
            生成摘要
          </Button>
        </div>
      )}

      {/* 筛选栏：仅在有结果且存在多种文件类型时显示 */}
      {results.length > 0 && groupCounts.some((g) => g.count > 0) && (
        <div style={{
          padding: "8px 12px 6px",
          display: "flex", gap: 6, flexWrap: "wrap",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-bg)",
        }}>
          {groupCounts.filter((g) => g.count > 0).map((g) => {
            const isActive = g.types.every((t) => activeTypes.includes(t));
            return (
              <button
                key={g.label}
                onClick={() => toggleType(g.types)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  padding: "2px 10px",
                  borderRadius: 20,
                  border: `1px solid ${isActive ? g.color : "var(--color-border)"}`,
                  background: isActive ? g.color + "18" : "var(--color-surface)",
                  color: isActive ? g.color : "var(--color-text-secondary)",
                  fontSize: 12, fontWeight: isActive ? 600 : 400,
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
              >
                {g.label}
                <span style={{
                  fontSize: 10, minWidth: 16, height: 16,
                  borderRadius: 8, padding: "0 4px",
                  background: isActive ? g.color : "var(--color-border)",
                  color: isActive ? "#fff" : "var(--color-text-secondary)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontWeight: 600,
                }}>
                  {g.count}
                </span>
              </button>
            );
          })}
          {activeTypes.length > 0 && (
            <button
              onClick={() => setActiveTypes([])}
              style={{
                padding: "2px 8px", borderRadius: 20,
                border: "1px solid var(--color-border)",
                background: "var(--color-surface)", color: "var(--color-text-muted)",
                fontSize: 11, cursor: "pointer",
              }}
            >
              清除
            </button>
          )}
        </div>
      )}

      {/* 加载中状态 */}
      {loading && (
        <div style={{ textAlign: "center", padding: 40 }}>
          <span style={{ color: "#94a3b8", fontSize: 13 }}>搜索中…</span>
        </div>
      )}

      {/* 空状态 */}
      {!loading && filtered.length === 0 && (
        <div style={{ padding: "40px 20px", textAlign: "center" }}>
          {emptyText}
        </div>
      )}

      {/* 虚拟滚动列表 */}
      <div ref={listContainerRef} style={{ flex: 1, minHeight: 0, overflow: "hidden", background: "var(--color-surface)" }}>
        {!loading && filtered.length > 0 && (
          <VirtualList
            rowComponent={RowComponent}
            rowCount={filtered.length}
            rowHeight={getRowHeight}
            overscanCount={5}
            style={{ height: listHeight, background: "var(--color-surface)" }}
            rowProps={{
              filteredItems: filtered,
              selectedFileId: selected?.file_id,
              focusedIndex,
              isSemantic,
              query,
              onSelect: (item: SearchResult, index: number) => {
                setSelected(item);
                setFocusedIndex(index);
              },
              onDoubleClick: (path: string) => invoke("open_file", { path }),
              onContextMenu: (e: React.MouseEvent, item: SearchResult) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, item });
              },
              batchMode,
              selectedItems,
              toggleItemSelect,
            }}
          />
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <Dropdown
          open={true}
          onOpenChange={(open) => { if (!open) setContextMenu(null); }}
          menu={{ items: getContextMenuItems(contextMenu.item) }}
          trigger={[]}
        >
          <div
            style={{
              position: "fixed",
              left: contextMenu.x,
              top: contextMenu.y,
              width: 1,
              height: 1,
              zIndex: 9999,
            }}
          />
        </Dropdown>
      )}
    </div>
  );
}
