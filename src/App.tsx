import { Layout, Button, Spin } from "antd";
import { SettingOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { useState, useEffect } from "react";
import SearchBar from "./components/SearchBar";
import ResultList from "./components/ResultList";
import PreviewPanel from "./components/PreviewPanel";
import Onboarding from "./pages/Onboarding";

const { Header, Content, Sider } = Layout;

export default function App() {
  const [loading, setLoading] = useState(true);
  const [hasFolders, setHasFolders] = useState(false);

  useEffect(() => {
    invoke<string[]>("get_watched_folders")
      .then((folders) => {
        setHasFolders(folders.length > 0);
      })
      .catch(() => {
        setHasFolders(false);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!hasFolders) {
    return <Onboarding onDone={() => setHasFolders(true)} />;
  }

  return (
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
        <SearchBar />
        <Button
          type="text"
          icon={<SettingOutlined />}
          onClick={() => console.log("open settings")}
          style={{ flexShrink: 0 }}
        />
      </Header>
      <Layout>
        <Content style={{ overflow: "auto" }}>
          <ResultList />
        </Content>
        <Sider
          width={400}
          style={{ overflow: "auto", borderLeft: "1px solid #eee", background: "#fff" }}
        >
          <PreviewPanel />
        </Sider>
      </Layout>
    </Layout>
  );
}
