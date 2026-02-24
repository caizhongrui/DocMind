import { Input, Radio, message } from "antd";
import { useSearchStore } from "../stores/searchStore";

export default function SearchBar() {
  const { query, mode, setQuery, setMode, doSearch } = useSearchStore();

  const handleSearch = async () => {
    await doSearch();
    // 检查 error 状态在 doSearch 后
    // 由于 Zustand store 更新是同步的，这里需要直接读取 store
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
