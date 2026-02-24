import { Empty, Typography } from "antd";
import { useSearchStore } from "../stores/searchStore";

export default function PreviewPanel() {
  const { selected } = useSearchStore();
  if (!selected) {
    return <Empty description="单击文件预览内容" style={{ marginTop: 60 }} />;
  }
  return (
    <div style={{ padding: 16 }}>
      <Typography.Title level={5}>{selected.name}</Typography.Title>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {selected.path}
      </Typography.Text>
      <div style={{ marginTop: 12 }}>
        <Typography.Paragraph>
          {selected.snippet || "（预览内容加载中）"}
        </Typography.Paragraph>
      </div>
    </div>
  );
}
