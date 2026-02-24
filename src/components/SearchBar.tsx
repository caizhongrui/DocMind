import { Input, Segmented, Tooltip, message } from "antd";
import { RobotOutlined } from "@ant-design/icons";
import { useSearchStore } from "../stores/searchStore";

export default function SearchBar({ modelAvailable }: { modelAvailable: boolean }) {
  const { query, mode, setQuery, setMode, doSearch } = useSearchStore();

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
          : "需先下载 AI 模型（点击顶栏 🤖 按钮）"
      }
    >
      <span style={{ opacity: modelAvailable ? 1 : 0.4, cursor: modelAvailable ? "pointer" : "not-allowed" }}>
        <RobotOutlined /> 语义
      </span>
    </Tooltip>
  );

  return (
    <div style={{ display: "flex", gap: 8, flex: 1, alignItems: "center" }}>
      <Input.Search
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onSearch={handleSearch}
        placeholder={
          mode === "semantic"
            ? "用自然语言描述要找的内容..."
            : mode === "filename"
            ? "按文件名搜索..."
            : "搜索文件内容..."
        }
        allowClear
        style={{ flex: 1 }}
      />
      <Segmented
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
      />
    </div>
  );
}
