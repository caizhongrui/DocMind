import { Empty, Typography, Spin } from "antd";
import { useSearchStore } from "../stores/searchStore";
import { invoke } from "@tauri-apps/api/core";
import { useState, useEffect } from "react";

export default function PreviewPanel() {
  const { selected } = useSearchStore();
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) {
      setContent("");
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    invoke<string>("read_file_preview", { path: selected.path })
      .then((text) => setContent(text))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setContent("");
      })
      .finally(() => setLoading(false));
  }, [selected?.path]);

  if (!selected) {
    return <Empty description="单击文件预览内容" style={{ marginTop: 60 }} />;
  }

  return (
    <div style={{ padding: 16, height: "100%", display: "flex", flexDirection: "column" }}>
      <Typography.Title level={5} style={{ marginBottom: 4 }}>{selected.name}</Typography.Title>
      <Typography.Text type="secondary" style={{ fontSize: 12, marginBottom: 12, display: "block" }}>
        {selected.path}
      </Typography.Text>
      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 40 }}>
          <Spin />
        </div>
      ) : error ? (
        <Typography.Text type="danger">{error}</Typography.Text>
      ) : (
        <div style={{ flex: 1, overflow: "auto" }}>
          <Typography.Paragraph
            style={{
              whiteSpace: "pre-wrap",
              fontSize: 13,
              lineHeight: 1.6,
              fontFamily: "monospace",
            }}
          >
            {content}
          </Typography.Paragraph>
        </div>
      )}
    </div>
  );
}
