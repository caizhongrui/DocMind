import { useState, useRef, useEffect } from "react";
import { Input, Tooltip, message, Dropdown } from "antd";
import type { InputRef } from "antd";
import { SearchOutlined, RobotOutlined, QuestionCircleOutlined, DeleteOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useSearchStore } from "../stores/searchStore";

type Mode = "filename" | "fulltext" | "semantic";

interface ModeOption {
  value: Mode;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  tooltip?: string;
}

export default function SearchBar({ modelAvailable }: { modelAvailable: boolean }) {
  const { t } = useTranslation();
  const { query, mode, setQuery, setMode, doSearch, searchHistory, loadSearchHistory, deleteHistoryItem } = useSearchStore();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [localQuery, setLocalQuery] = useState(query);
  const isComposing = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<InputRef>(null);
  const mouseDownInDropdown = useRef(false);

  useEffect(() => {
    if (!isComposing.current) setLocalQuery(query);
  }, [query]);

  useEffect(() => {
    const handleFocusEvent = () => inputRef.current?.focus();
    window.addEventListener("docmind-focus-search", handleFocusEvent);
    return () => window.removeEventListener("docmind-focus-search", handleFocusEvent);
  }, []);

  useEffect(() => {
    if (!query.trim()) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      doSearch().catch(() => {});
    }, 300);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query, mode, doSearch]);

  const handleSearch = async () => {
    await doSearch();
    const currentError = useSearchStore.getState().error;
    if (currentError) {
      message.error(`搜索失败：${currentError}`);
    }
  };

  const placeholder = t(`search.placeholder_${mode}`);

  const modeOptions: ModeOption[] = [
    { value: "fulltext", label: "全文" },
    { value: "filename", label: "文件名" },
    {
      value: "semantic",
      label: "语义",
      icon: <RobotOutlined style={{ fontSize: 11 }} />,
      disabled: !modelAvailable,
      tooltip: modelAvailable
        ? "AI 语义搜索，理解自然语言含义"
        : "需先下载 AI 模型（点击顶栏机器人按钮）",
    },
  ];

  const pickHistory = (q: string) => {
    setQuery(q);
    setLocalQuery(q);
    setHistoryOpen(false);
    inputRef.current?.blur();
    setTimeout(() => doSearch(), 0);
  };

  const historyItems = searchHistory
    .filter((h) => h.mode === mode)
    .slice(0, 5)
    .map((h) => ({
      key: String(h.id),
      label: (
        <div
          onMouseDown={(e) => {
            mouseDownInDropdown.current = true;
            // Fire selection on mousedown so it happens before input blur,
            // and preventDefault keeps the input from losing focus mid-click.
            const target = e.target as HTMLElement;
            if (target.closest("[data-history-delete]")) return;
            e.preventDefault();
            pickHistory(h.query);
          }}
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", minWidth: 220, cursor: "pointer" }}
        >
          <span style={{ fontSize: 13 }}>{h.query}</span>
          <DeleteOutlined
            data-history-delete
            style={{ fontSize: 11, color: "var(--color-text-muted)", marginLeft: 8 }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              deleteHistoryItem(h.id);
            }}
          />
        </div>
      ),
    }));

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        flex: 1,
        height: 36,
        padding: "0 6px 0 4px",
        borderRadius: 8,
        background: "var(--color-surface-elevated)",
        border: `1px solid ${isFocused ? "var(--color-primary)" : "var(--color-border)"}`,
        boxShadow: isFocused ? "0 0 0 2px var(--color-primary-bg)" : "var(--shadow-sm)",
        transition: "border-color var(--duration-fast) var(--easing-out), box-shadow var(--duration-fast) var(--easing-out)",
      }}
    >
      {/* Mode pill chips (left) */}
      <div
        id="tour-search-mode"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: 2,
          borderRadius: 6,
          background: "var(--color-hover)",
          flexShrink: 0,
        }}
      >
        {modeOptions.map((opt) => {
          const isActive = mode === opt.value;
          const chip = (
            <button
              key={opt.value}
              type="button"
              disabled={opt.disabled}
              onClick={() => {
                if (opt.disabled) return;
                setMode(opt.value);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                height: 24,
                padding: "0 10px",
                fontSize: 12,
                fontWeight: isActive ? 600 : 500,
                color: isActive
                  ? "var(--color-text)"
                  : opt.disabled
                  ? "var(--color-text-muted)"
                  : "var(--color-text-secondary)",
                background: isActive ? "var(--color-surface)" : "transparent",
                border: "none",
                borderRadius: 4,
                cursor: opt.disabled ? "not-allowed" : "pointer",
                transition: "background var(--duration-fast) var(--easing-out), color var(--duration-fast) var(--easing-out)",
                boxShadow: isActive ? "var(--shadow-sm)" : "none",
                opacity: opt.disabled ? 0.5 : 1,
              }}
            >
              {opt.icon}
              {opt.label}
            </button>
          );
          return opt.tooltip ? (
            <Tooltip key={opt.value} title={opt.tooltip}>
              <span style={{ display: "inline-flex" }}>{chip}</span>
            </Tooltip>
          ) : (
            chip
          );
        })}
      </div>

      {/* Search input (center) */}
      <Dropdown
        open={historyOpen && historyItems.length > 0}
        menu={{ items: historyItems }}
        trigger={[]}
      >
        <Input
          id="tour-search-input"
          ref={inputRef}
          variant="borderless"
          value={localQuery}
          onChange={(e) => {
            const val = e.target.value;
            setLocalQuery(val);
            if (!isComposing.current) setQuery(val);
          }}
          onCompositionStart={() => {
            isComposing.current = true;
          }}
          onCompositionEnd={(e) => {
            isComposing.current = false;
            const val = (e.target as HTMLInputElement).value;
            setLocalQuery(val);
            setQuery(val);
          }}
          onPressEnter={async () => {
            setHistoryOpen(false);
            await handleSearch();
          }}
          onFocus={() => {
            setIsFocused(true);
            loadSearchHistory();
            setHistoryOpen(true);
          }}
          onBlur={() => {
            setTimeout(() => {
              setIsFocused(false);
              if (!mouseDownInDropdown.current) setHistoryOpen(false);
              mouseDownInDropdown.current = false;
            }, 150);
          }}
          placeholder={placeholder}
          allowClear
          prefix={<SearchOutlined style={{ color: "var(--color-text-muted)", fontSize: 14 }} />}
          style={{
            flex: 1,
            background: "transparent",
            fontSize: 13,
            height: 32,
            padding: "0 4px",
          }}
        />
      </Dropdown>

      {/* Right-side helpers */}
      {mode === "fulltext" && (
        <Tooltip
          title={
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>全文搜索语法</div>
              <div>
                <code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>合同 违约</code> → 包含任意词
              </div>
              <div>
                <code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>合同 AND 违约</code> → 同时包含
              </div>
              <div>
                <code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>合同 OR 协议</code> → 包含其一
              </div>
              <div>
                <code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>合同 NOT 终止</code> → 排除词
              </div>
              <div>
                <code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>"违约金条款"</code> → 精确短语
              </div>
            </div>
          }
          placement="bottomRight"
        >
          <QuestionCircleOutlined style={{ fontSize: 13, color: "var(--color-text-muted)", cursor: "pointer", flexShrink: 0 }} />
        </Tooltip>
      )}
      {mode === "semantic" && modelAvailable && (
        <Tooltip
          title={
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>语义搜索技巧</div>
              <div>用自然语言描述你要找的内容</div>
              <div>
                例如：<code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>关于项目进度的报告</code>
              </div>
              <div>
                例如：<code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>合同违约相关条款</code>
              </div>
              <div style={{ marginTop: 4, color: "#fbbf24" }}>语义搜索理解含义，不需要精确关键词</div>
            </div>
          }
          placement="bottomRight"
        >
          <QuestionCircleOutlined style={{ fontSize: 13, color: "var(--color-text-muted)", cursor: "pointer", flexShrink: 0 }} />
        </Tooltip>
      )}

      {/* Keyboard hint */}
      <span className="kbd" style={{ flexShrink: 0, marginRight: 2 }}>
        {navigator.platform.toLowerCase().includes("mac") ? "⌘K" : "Ctrl K"}
      </span>
    </div>
  );
}
