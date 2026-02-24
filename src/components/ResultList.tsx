import { List, Tag } from "antd";
import { useSearchStore } from "../stores/searchStore";
import { invoke } from "@tauri-apps/api/core";

const FILE_TYPE_COLOR: Record<string, string> = {
  pdf: "red",
  docx: "blue",
  xlsx: "green",
  pptx: "orange",
  txt: "default",
  md: "purple",
};

export default function ResultList() {
  const { results, selected, setSelected, loading } = useSearchStore();
  return (
    <List
      loading={loading}
      dataSource={results}
      renderItem={(item) => (
        <List.Item
          style={{
            cursor: "pointer",
            background: selected?.file_id === item.file_id ? "#e6f4ff" : undefined,
            padding: "8px 16px",
          }}
          onClick={() => setSelected(item)}
          onDoubleClick={() => invoke("open_file", { path: item.path })}
        >
          <List.Item.Meta
            title={
              <>
                <Tag color={FILE_TYPE_COLOR[item.file_type] ?? "default"}>{item.file_type}</Tag>
                {item.name}
              </>
            }
            description={
              <span style={{ fontSize: 12, color: "#888" }}>{item.path}</span>
            }
          />
        </List.Item>
      )}
    />
  );
}
