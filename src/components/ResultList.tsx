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

const FILE_TYPE_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  pdf:  { icon: <FilePdfOutlined />,      color: "#e53e3e", label: "PDF"  },
  docx: { icon: <FileWordOutlined />,     color: "#2563eb", label: "DOCX" },
  doc:  { icon: <FileWordOutlined />,     color: "#2563eb", label: "DOC"  },
  xlsx: { icon: <FileExcelOutlined />,    color: "#16a34a", label: "XLSX" },
  xls:  { icon: <FileExcelOutlined />,    color: "#16a34a", label: "XLS"  },
  csv:  { icon: <FileExcelOutlined />,    color: "#0891b2", label: "CSV"  },
  pptx: { icon: <FilePptOutlined />,      color: "#ea580c", label: "PPTX" },
  ppt:  { icon: <FilePptOutlined />,      color: "#ea580c", label: "PPT"  },
  txt:  { icon: <FileTextOutlined />,     color: "#64748b", label: "TXT"  },
  md:   { icon: <FileMarkdownOutlined />, color: "#7c3aed", label: "MD"   },
};

function FileTypeIcon({ type }: { type: string }) {
  const cfg = FILE_TYPE_CONFIG[type.toLowerCase()] ?? {
    icon: <FileOutlined />, color: "var(--color-text-muted)", label: type.toUpperCase(),
  };
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        color: cfg.color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 16,
        flexShrink: 0,
      }}
    >
      {cfg.icon}
    </div>
  );
}

const TYPE_GROUPS: { label: string; types: string[] }[] = [
  { label: "PDF",   types: ["pdf"] },
  { label: "Word",  types: ["docx", "doc"] },
  { label: "Excel", types: ["xlsx", "xls", "csv"] },
  { label: "PPT",   types: ["pptx", "ppt"] },
  { label: "文本",  types: ["txt", "md"] },
];

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
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  };

  const selectAll = () => setSelectedItems(new Set(filtered.map((r) => r.file_id)));
  const clearSelection = () => setSelectedItems(new Set());

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: (typeof results)[number];
  } | null>(null);

  const [focusedIndex, setFocusedIndex] = useState(-1);

  const filtered = activeTypes.length === 0
    ? results
    : results.filter((r) => activeTypes.includes(r.file_type.toLowerCase()));

  const getRowHeight = useCallback(
    (index: number) => {
      const item = filtered[index];
      if (!item) return 60;
      const hasMetadata = !!(item.size || item.modified);
      const hasSnippet = !!item.snippet;
      if (hasSnippet && hasMetadata) return 116;
      if (hasSnippet) return 100;
      if (hasMetadata) return 70;
      return 56;
    },
    [filtered]
  );

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (filtered.length === 0) return;
      // Don't hijack arrows/Enter when the user is typing in an input,
      // textarea, contenteditable, or the search box itself.
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          t.isContentEditable ||
          t.closest('[contenteditable="true"]')
        ) {
          return;
        }
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((prev) => {
          const next = Math.min(prev + 1, filtered.length - 1);
          document.querySelector(`[data-result-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((prev) => {
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
    const BOM = "﻿";
    const header = "文件名,路径,类型,得分\n";
    const rows = filtered
      .map((r) => {
        const name = `"${r.name.replace(/"/g, '""')}"`;
        const path = `"${r.path.replace(/"/g, '""')}"`;
        return `${name},${path},${r.file_type},${r.score.toFixed(4)}`;
      })
      .join("\n");
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

  const isMac = navigator.platform.toLowerCase().includes("mac");
  const cmdKey = isMac ? "⌘" : "Ctrl";

  const emptyText = (
    <div style={{ padding: "60px 24px", textAlign: "center" }}>
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 12,
          background: "var(--color-hover)",
          margin: "0 auto 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <FileSearchOutlined style={{ fontSize: 22, color: "var(--color-text-muted)" }} />
      </div>
      {query.trim() ? (
        <>
          <Typography.Text style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--color-text)", marginBottom: 6 }}>
            未找到相关文件
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            没有找到与{" "}
            <code className="mono" style={{ color: "var(--color-primary)", padding: "1px 4px", borderRadius: 3, background: "var(--color-primary-bg)" }}>
              {query}
            </code>{" "}
            匹配的内容
          </Typography.Text>
        </>
      ) : (
        <>
          <Typography.Text style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--color-text)", marginBottom: 6 }}>
            开始搜索文件
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            输入关键词搜索文件内容、文件名
          </Typography.Text>
          <div style={{ marginTop: 12, display: "flex", justifyContent: "center", gap: 6, alignItems: "center" }}>
            <span className="kbd">{cmdKey}</span>
            <span className="kbd">K</span>
            <span style={{ fontSize: 11, color: "var(--color-text-muted)", marginLeft: 4 }}>聚焦搜索框</span>
          </div>
        </>
      )}
    </div>
  );

  const groupCounts = TYPE_GROUPS.map((g) => ({
    ...g,
    count: results.filter((r) => g.types.includes(r.file_type.toLowerCase())).length,
  }));

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
    const isFocused = fi === index && !isSelected;
    const isBatchSelected = bm && si.has(item.file_id);
    const cfg = FILE_TYPE_CONFIG[item.file_type.toLowerCase()];
    const typeLabel = cfg?.label ?? item.file_type.toUpperCase();

    return (
      <div
        style={{
          ...style,
          cursor: "pointer",
          padding: "8px 14px",
          background: isSelected
            ? "var(--color-selected)"
            : isBatchSelected
            ? "var(--color-primary-bg)"
            : isFocused
            ? "var(--color-hover)"
            : "transparent",
          boxShadow: isSelected ? "inset 2px 0 0 0 var(--color-primary)" : "none",
          borderBottom: "1px solid var(--color-border)",
          transition: "background var(--duration-fast) var(--easing-out)",
          boxSizing: "border-box",
        }}
        data-result-index={index}
        onClick={() => onSelect(item, index)}
        onDoubleClick={() => onDoubleClick(item.path)}
        onContextMenu={(e) => onContextMenu(e, item)}
      >
        <div style={{ display: "flex", gap: 10, width: "100%", minWidth: 0, alignItems: "flex-start" }}>
          {bm && (
            <input
              type="checkbox"
              checked={si.has(item.file_id)}
              onChange={() => toggleItem(item.file_id)}
              style={{ marginTop: 8, flexShrink: 0, cursor: "pointer", accentColor: "var(--color-primary)" }}
              onClick={(e) => e.stopPropagation()}
            />
          )}
          <FileTypeIcon type={item.file_type} />

          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Filename + chips */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 1 }}>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: isSelected ? "var(--color-text)" : "var(--color-text)",
                  wordBreak: "break-all",
                  lineHeight: 1.4,
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                <HighlightText text={item.name} query={q} />
              </span>
              <span className="chip" style={{ flexShrink: 0 }}>
                {typeLabel}
              </span>
              {semantic && (
                <span className="chip chip-primary" style={{ flexShrink: 0 }}>
                  AI
                </span>
              )}
            </div>

            {/* Path */}
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--color-text-secondary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                marginBottom: 2,
              }}
            >
              {item.path}
            </div>

            {/* Meta */}
            {(item.size || item.modified) && (
              <div
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--color-text-muted)",
                  marginBottom: item.snippet ? 6 : 0,
                  display: "flex",
                  gap: 8,
                }}
              >
                {item.size && <span>{formatFileSize(item.size)}</span>}
                {item.modified && <span>{formatDate(item.modified)}</span>}
              </div>
            )}

            {/* Snippet */}
            {item.snippet && (
              <div
                style={{
                  fontSize: 12,
                  lineHeight: 1.55,
                  color: "var(--color-text-secondary)",
                  borderLeft: "2px solid var(--color-border-strong)",
                  paddingLeft: 8,
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {semantic ? item.snippet : <HighlightText text={item.snippet} query={q} />}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Toolbar */}
      {results.length > 0 && (
        <div
          style={{
            padding: "6px 12px",
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            borderBottom: "1px solid var(--color-border)",
            background: "var(--color-surface)",
            gap: 4,
          }}
        >
          <Tooltip title="导出搜索结果 CSV">
            <Button
              size="small"
              type="text"
              icon={<ExportOutlined />}
              onClick={handleExportCsv}
              style={{ color: "var(--color-text-muted)", marginRight: "auto" }}
            />
          </Tooltip>
          <Tooltip title={batchMode ? "退出批量模式" : "批量操作"}>
            <Button
              size="small"
              type={batchMode ? "primary" : "text"}
              icon={<CheckSquareOutlined />}
              onClick={() => {
                setBatchMode((v) => !v);
                clearSelection();
              }}
              style={{ color: batchMode ? undefined : "var(--color-text-muted)" }}
            />
          </Tooltip>
          <Select
            size="small"
            variant="borderless"
            value={sortBy}
            onChange={setSortBy}
            style={{ width: 96, fontSize: 12 }}
            options={[
              { value: "relevance", label: "相关度" },
              { value: "modified", label: "修改时间" },
              { value: "size", label: "文件大小" },
            ]}
          />
        </div>
      )}

      {/* Batch toolbar */}
      {batchMode && selectedItems.size > 0 && (
        <div
          style={{
            padding: "6px 12px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "var(--color-primary-bg)",
            borderBottom: "1px solid var(--color-border)",
            fontSize: 12,
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: "var(--color-primary)", fontWeight: 500 }}>已选 {selectedItems.size} 个文件</span>
          <Button size="small" onClick={selectAll}>全选</Button>
          <Button size="small" onClick={clearSelection}>取消</Button>
          <Button
            size="small"
            icon={<ExportOutlined />}
            onClick={async () => {
              const paths = filtered.filter((r) => selectedItems.has(r.file_id)).map((r) => r.path);
              const content =
                "﻿文件名,路径\n" +
                paths
                  .map((p) => {
                    const name = p.split("/").pop() ?? p;
                    return `"${name}","${p}"`;
                  })
                  .join("\n");
              const savePath = await saveDialog({
                defaultPath: "selected-files.csv",
                filters: [{ name: "CSV", extensions: ["csv"] }],
              });
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
              for (const item of filtered.filter((r) => selectedItems.has(r.file_id))) {
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
              const paths = filtered.filter((r) => selectedItems.has(r.file_id)).map((r) => r.path);
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

      {/* Type filter chips */}
      {results.length > 0 && groupCounts.some((g) => g.count > 0) && (
        <div
          style={{
            padding: "8px 12px",
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            borderBottom: "1px solid var(--color-border)",
            background: "var(--color-surface)",
          }}
        >
          {groupCounts
            .filter((g) => g.count > 0)
            .map((g) => {
              const isActive = g.types.every((t) => activeTypes.includes(t));
              return (
                <button
                  key={g.label}
                  onClick={() => toggleType(g.types)}
                  className={isActive ? "chip chip-primary" : "chip"}
                  style={{
                    cursor: "pointer",
                    fontFamily: "inherit",
                    height: 22,
                    padding: "0 8px",
                    fontSize: 12,
                  }}
                >
                  <span style={{ fontWeight: isActive ? 600 : 500 }}>{g.label}</span>
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      opacity: 0.7,
                    }}
                  >
                    {g.count}
                  </span>
                </button>
              );
            })}
          {activeTypes.length > 0 && (
            <button
              onClick={() => setActiveTypes([])}
              className="chip chip-muted"
              style={{
                cursor: "pointer",
                fontFamily: "inherit",
                height: 22,
                padding: "0 8px",
                fontSize: 11,
              }}
            >
              清除
            </button>
          )}
        </div>
      )}

      {loading && (
        <div style={{ textAlign: "center", padding: 40 }}>
          <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>搜索中…</span>
        </div>
      )}

      {!loading && filtered.length === 0 && <div>{emptyText}</div>}

      {/* Virtual list */}
      <div
        ref={listContainerRef}
        style={{ flex: 1, minHeight: 0, overflow: "hidden", background: "var(--color-surface)" }}
      >
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

      {contextMenu && (
        <Dropdown
          open={true}
          onOpenChange={(open) => {
            if (!open) setContextMenu(null);
          }}
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
