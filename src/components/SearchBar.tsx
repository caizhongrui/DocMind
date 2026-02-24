import { Input, Radio } from "antd";
import { useSearchStore } from "../stores/searchStore";

export default function SearchBar() {
  const { query, mode, setQuery, setMode, doSearch } = useSearchStore();
  return (
    <div style={{ display: "flex", gap: 8, flex: 1 }}>
      <Input.Search
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onSearch={doSearch}
        placeholder="搜索文件内容..."
        allowClear
        style={{ flex: 1 }}
      />
      <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)} size="small">
        <Radio.Button value="fulltext">全文</Radio.Button>
        <Radio.Button value="filename">文件名</Radio.Button>
      </Radio.Group>
    </div>
  );
}
