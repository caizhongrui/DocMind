import { Layout } from "antd";
import SearchBar from "./components/SearchBar";
import ResultList from "./components/ResultList";
import PreviewPanel from "./components/PreviewPanel";

const { Header, Content, Sider } = Layout;

export default function App() {
  return (
    <Layout style={{ height: "100vh" }}>
      <Header style={{ padding: "0 16px", display: "flex", alignItems: "center", background: "#fff", borderBottom: "1px solid #eee" }}>
        <SearchBar />
      </Header>
      <Layout>
        <Content style={{ overflow: "auto" }}>
          <ResultList />
        </Content>
        <Sider width={400} style={{ overflow: "auto", borderLeft: "1px solid #eee", background: "#fff" }}>
          <PreviewPanel />
        </Sider>
      </Layout>
    </Layout>
  );
}
