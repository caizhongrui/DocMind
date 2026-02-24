import { Input, Radio, Tooltip, message } from "antd";
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

  return (
    <div style={{ display: "flex", gap: 8, flex: 1 }}>
      <Input.Search
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onSearch={handleSearch}
        placeholder={mode === "semantic" ? "语义搜索（自然语言描述）..." : "搜索文件内容..."}
        allowClear
        style={{ flex: 1 }}
      />
      <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)} size="small">
        <Radio.Button value="fulltext">全文</Radio.Button>
        <Radio.Button value="filename">文件名</Radio.Button>
        <Tooltip title={modelAvailable ? "语义搜索（AI）" : "语义搜索不可用，请先下载模型"}>
          <Radio.Button
            value="semantic"
            disabled={!modelAvailable}
            style={modelAvailable ? { color: "#1677ff" } : {}}
          >
            <RobotOutlined /> 语义
          </Radio.Button>
        </Tooltip>
      </Radio.Group>
    </div>
  );
}
