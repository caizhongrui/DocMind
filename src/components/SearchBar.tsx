import { useState, useRef, useEffect } from "react";
import { Input, Segmented, Tooltip, message, Dropdown } from "antd";
import type { InputRef } from "antd";
import { SearchOutlined, RobotOutlined, QuestionCircleOutlined, DeleteOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useSearchStore } from "../stores/searchStore";

export default function SearchBar({ modelAvailable }: { modelAvailable: boolean }) {
  const { t } = useTranslation();
  const { query, mode, setQuery, setMode, doSearch, searchHistory, loadSearchHistory, deleteHistoryItem } = useSearchStore();
  const [historyOpen, setHistoryOpen] = useState(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<InputRef>(null);
  const mouseDownInDropdown = useRef(false);

  // Ctrl+K / Cmd+K 聚焦搜索框
  useEffect(() => {
    const handleFocusEvent = () => inputRef.current?.focus();
    window.addEventListener("docmind-focus-search", handleFocusEvent);
    return () => window.removeEventListener("docmind-focus-search", handleFocusEvent);
  }, []);

  // 300ms 防抖自动搜索
  useEffect(() => {
    if (!query.trim()) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      doSearch().catch(() => {});
    }, 300);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query, doSearch]);

  const handleSearch = async () => {
    await doSearch();
    const currentError = useSearchStore.getState().error;
    if (currentError) {
      message.error(`搜索失败：${currentError}`);
    }
  };

  const semanticLabel = (
    <Tooltip
      title={
        modelAvailable
          ? "AI 语义搜索，理解自然语言含义"
          : "需先下载 AI 模型（点击顶栏机器人按钮）"
      }
    >
      <span style={{
        display: "flex", alignItems: "center", gap: 4,
        opacity: modelAvailable ? 1 : 0.4,
        cursor: modelAvailable ? "pointer" : "not-allowed",
      }}>
        <RobotOutlined style={{ fontSize: 12 }} />
        <span>语义</span>
      </span>
    </Tooltip>
  );

  const placeholder = t(`search.placeholder_${mode}`);

  const historyItems = searchHistory
    .filter(h => h.mode === mode)
    .slice(0, 5)
    .map(h => ({
      key: String(h.id),
      label: (
        <div
          onMouseDown={() => { mouseDownInDropdown.current = true; }}
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", minWidth: 200 }}
        >
          <span style={{ fontSize: 13 }}>{h.query}</span>
          <DeleteOutlined
            style={{ fontSize: 11, color: "#94a3b8", marginLeft: 8 }}
            onClick={(e) => {
              e.stopPropagation();
              deleteHistoryItem(h.id);
            }}
          />
        </div>
      ),
      onClick: () => {
        setQuery(h.query);
        setHistoryOpen(false);
        setTimeout(() => doSearch(), 0);
      },
    }));

  return (
    <div style={{ display: "flex", gap: 8, flex: 1, alignItems: "center" }}>
      <Dropdown
        open={historyOpen && historyItems.length > 0}
        menu={{ items: historyItems }}
        trigger={[]}
      >
        <Input
          id="tour-search-input"
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onPressEnter={async () => { setHistoryOpen(false); await handleSearch(); }}
          onFocus={() => { loadSearchHistory(); setHistoryOpen(true); }}
          onBlur={() => {
            setTimeout(() => {
              if (!mouseDownInDropdown.current) setHistoryOpen(false);
              mouseDownInDropdown.current = false;
            }, 150);
          }}
          placeholder={placeholder}
          allowClear
          prefix={<SearchOutlined style={{ color: "#94a3b8", fontSize: 14 }} />}
          style={{
            flex: 1,
            borderRadius: 8,
            background: "var(--color-bg)",
            borderColor: "var(--color-border)",
            fontSize: 13,
            height: 34,
          }}
        />
      </Dropdown>
      {mode === "fulltext" && (
        <Tooltip
          title={
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>全文搜索语法</div>
              <div><code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>合同 违约</code> → 包含任意词</div>
              <div><code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>合同 AND 违约</code> → 同时包含</div>
              <div><code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>合同 OR 协议</code> → 包含其一</div>
              <div><code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>合同 NOT 终止</code> → 排除词</div>
              <div><code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>"违约金条款"</code> → 精确短语</div>
            </div>
          }
          placement="bottomRight"
        >
          <QuestionCircleOutlined style={{ fontSize: 13, color: "#94a3b8", cursor: "pointer", flexShrink: 0 }} />
        </Tooltip>
      )}
      {mode === "semantic" && modelAvailable && (
        <Tooltip
          title={
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>语义搜索技巧</div>
              <div>用自然语言描述你要找的内容</div>
              <div>例如：<code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>关于项目进度的报告</code></div>
              <div>例如：<code style={{ background: "rgba(255,255,255,0.15)", padding: "1px 4px", borderRadius: 3 }}>合同违约相关条款</code></div>
              <div style={{ marginTop: 4, color: "#fbbf24" }}>💡 语义搜索理解含义，不需要精确关键词</div>
            </div>
          }
          placement="bottomRight"
        >
          <QuestionCircleOutlined style={{ fontSize: 13, color: "#94a3b8", cursor: "pointer", flexShrink: 0 }} />
        </Tooltip>
      )}
      <Segmented
        id="tour-search-mode"
        value={mode}
        onChange={(val) => {
          if (val === "semantic" && !modelAvailable) return;
          setMode(val as "filename" | "fulltext" | "semantic");
        }}
        options={[
          { label: "全文", value: "fulltext" },
          { label: "文件名", value: "filename" },
          { label: semanticLabel, value: "semantic", disabled: !modelAvailable },
        ]}
        size="small"
        style={{ flexShrink: 0, fontSize: 12 }}
      />
    </div>
  );
}
