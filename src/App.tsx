import { Layout, Button, Spin, Drawer } from "antd";
import { SettingOutlined, RobotOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { useState, useEffect } from "react";
import SearchBar from "./components/SearchBar";
import ResultList from "./components/ResultList";
import PreviewPanel from "./components/PreviewPanel";
import Onboarding from "./pages/Onboarding";
import SettingsDrawer from "./components/SettingsDrawer";
import ModelManager from "./pages/ModelManager";

const { Header, Content, Sider } = Layout;

interface ModelStatus {
  available: boolean;
  model_dir: string;
  model_version: string;
  embedding_count: number;
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [hasFolders, setHasFolders] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelAvailable, setModelAvailable] = useState(false);
  const [embeddingCount, setEmbeddingCount] = useState(0);

  useEffect(() => {
    Promise.all([
      invoke<string[]>("get_watched_folders"),
      invoke<ModelStatus>("get_model_status"),
    ])
      .then(([folders, modelStatus]) => {
        setHasFolders(folders.length > 0);
        setModelAvailable(modelStatus.available);
        setEmbeddingCount(modelStatus.embedding_count);
      })
      .catch(() => {
        setHasFolders(false);
        setModelAvailable(false);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          height: "100vh",
        }}
      >
        <Spin size="large" />
      </div>
    );
  }

  if (!hasFolders) {
    return <Onboarding onDone={() => setHasFolders(true)} />;
  }

  return (
    <>
      <Layout style={{ height: "100vh" }}>
        <Header
          style={{
            padding: "0 16px",
            display: "flex",
            alignItems: "center",
            background: "#fff",
            borderBottom: "1px solid #eee",
            gap: 8,
          }}
        >
          <SearchBar modelAvailable={modelAvailable} />
          <Button
            type="text"
            icon={<RobotOutlined />}
            onClick={() => setModelOpen(true)}
            style={{
              flexShrink: 0,
              color:
                modelAvailable && embeddingCount > 0
                  ? "#52c41a"           // 绿色：模型+索引均就绪
                  : modelAvailable
                  ? "#faad14"           // 橙色：模型已下载但需重建索引
                  : "#bfbfbf",          // 灰色：未下载
            }}
            title={
              modelAvailable && embeddingCount > 0
                ? "AI 语义搜索已就绪"
                : modelAvailable
                ? "模型已下载，需重新索引后才能使用语义搜索"
                : "点击配置 AI 语义搜索"
            }
          />
          <Button
            type="text"
            icon={<SettingOutlined />}
            onClick={() => setSettingsOpen(true)}
            style={{ flexShrink: 0 }}
          />
        </Header>
        <Layout>
          <Content style={{ overflow: "auto" }}>
            <ResultList />
          </Content>
          <Sider
            width={400}
            style={{
              overflow: "auto",
              borderLeft: "1px solid #eee",
              background: "#fff",
            }}
          >
            <PreviewPanel />
          </Sider>
        </Layout>
      </Layout>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <Drawer
        title="AI 语义搜索"
        open={modelOpen}
        onClose={() => setModelOpen(false)}
        width={600}
      >
        <ModelManager
          onModelReady={() => {
            setModelAvailable(true);
            // 重建后刷新 embedding_count
            invoke<ModelStatus>("get_model_status")
              .then((s) => setEmbeddingCount(s.embedding_count))
              .catch(() => {});
            setModelOpen(false);
          }}
        />
      </Drawer>
    </>
  );
}
