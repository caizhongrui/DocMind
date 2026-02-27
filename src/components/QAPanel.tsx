import {
  Button,
  Input,
  Spin,
  Typography,
  Progress,
  Tag,
  List,
  Space,
  Switch,
  Tooltip,
  message,
} from "antd";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  SendOutlined,
  StopOutlined,
  FolderOpenOutlined,
  DownloadOutlined,
  CheckCircleOutlined,
  RobotOutlined,
  UserOutlined,
  ImportOutlined,
  DeleteOutlined,
  ExportOutlined,
  MessageOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useState, useEffect, useRef } from "react";
import type { SourceRef, Message, GgufModelInfo } from "../types";

interface DownloadProgress {
  model_id: string;
  done: number;
  total: number;
}

const LAST_MODEL_KEY = "docmind_last_llm_model_path";

// 各模型的描述与建议标签
const MODEL_META: Record<string, { desc: string; tag?: string; tagColor?: string }> = {
  "qwen3-0.6b-q4": {
    desc: "超轻量，内存占用最低（约 600MB），速度最快，适合 4GB 内存及低配设备，回答深度有限",
    tag: "低配",
    tagColor: "#64748b",
  },
  "qwen3-1.7b-q4": {
    desc: "性能与资源最均衡，中文理解好，文档问答质量优秀，适合绝大多数用户",
    tag: "推荐",
    tagColor: "#1677ff",
  },
  "qwen3-4b-q4": {
    desc: "推理能力更强，长文档理解与逻辑分析更准确，需 8GB+ 内存，生成速度较慢",
    tag: "高质量",
    tagColor: "#7c3aed",
  },
};

export default function QAPanel() {
  const [models, setModels] = useState<GgufModelInfo[]>([]);
  const [loadedModel, setLoadedModel] = useState<string | null>(null);
  const [loadingModel, setLoadingModel] = useState<string | null>(null);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [expandedSources, setExpandedSources] = useState<Set<number>>(new Set());
  // true = 连续对话（保留历史），false = 单次问答（每次独立）
  const [continuous, setContinuous] = useState(true);

  const bottomRef = useRef<HTMLDivElement>(null);
  const autoLoadedRef = useRef(false);

  const handleClear = () => {
    setMessages([]);
    setExpandedSources(new Set());
  };

  const toggleSources = (idx: number) => {
    setExpandedSources((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const resolveModelId = (path: string, modelList: GgufModelInfo[]) => {
    const match = modelList.find((m) => m.path === path);
    const modelId = match?.id ?? "custom";
    if (!match) {
      const filename = path.split(/[\\/]/).pop() ?? "custom";
      setModels((prev) =>
        prev.some((m) => m.path === path)
          ? prev
          : [...prev, { id: "custom", name: filename, filename, size_mb: 0, downloaded: true, path }]
      );
    }
    return modelId;
  };

  const autoLoadLastModel = async (modelList: GgufModelInfo[]) => {
    if (autoLoadedRef.current) return;

    // 1. 先检查后端是否已经完成自动加载（最快路径，无需重复加载）
    try {
      const loadedPath = await invoke<string | null>("get_loaded_llm_path");
      if (loadedPath) {
        autoLoadedRef.current = true;
        setLoadedModel(resolveModelId(loadedPath, modelList));
        return;
      }
    } catch {}

    // 2. 检查 DB 是否有已保存的路径（后端正在自动加载中）
    // 此时绝对不能从前端也调用 load_llm_model，否则两个 LlamaBackend 实例
    // 共享 Metal 全局状态，导致退出时 ggml_abort crash
    try {
      const dbPath = await invoke<string | null>("get_setting", { key: "last_llm_path" });
      if (dbPath && dbPath.trim()) {
        autoLoadedRef.current = true;
        // 只展示 loading 状态，等 llm-auto-loaded 事件通知完成
        setLoadingModel(resolveModelId(dbPath, modelList));
        return;
      }
    } catch {}

    // 3. DB 中没有路径（老用户首次使用新版本），从 localStorage 手动加载一次
    const savedPath = localStorage.getItem(LAST_MODEL_KEY);
    if (!savedPath) return;
    autoLoadedRef.current = true;
    const modelId = resolveModelId(savedPath, modelList);
    setLoadingModel(modelId);
    // load_llm_model 立即返回，结果由 llm-loaded / llm-load-failed 事件处理
    invoke("load_llm_model", { path: savedPath })
      .catch(() => {
        // 立即校验失败（文件不存在）
        autoLoadedRef.current = false;
        setLoadingModel(null);
        localStorage.removeItem(LAST_MODEL_KEY);
      });
  };

  const refreshModels = () => {
    invoke<GgufModelInfo[]>("list_available_gguf_models")
      .then((list) => { setModels(list); autoLoadLastModel(list); })
      .catch(() => {});
  };

  const handleImportGguf = async () => {
    const selected = await openDialog({
      filters: [{ name: "GGUF 模型", extensions: ["gguf"] }],
    });
    if (!selected) return;
    try {
      const destPath = await invoke<string>("import_custom_gguf", { path: selected as string });
      // 自动加载导入的模型（后台异步，结果由 llm-loaded / llm-load-failed 事件处理）
      const filename = (destPath as string).split(/[\\/]/).pop() ?? "custom";
      setLoadingModel("custom");
      // 先将自定义模型加入列表（invoke 立即返回，加载在后台进行）
      setModels((prev) => {
        if (prev.some((m) => m.path === destPath)) return prev;
        return [...prev, {
          id: "custom",
          name: filename,
          filename,
          size_mb: 0,
          downloaded: true,
          path: destPath as string,
        }];
      });
      await invoke("load_llm_model", { path: destPath });
    } catch (e) {
      setLoadingModel(null);
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: `导入失败: ${String(e)}`,
        error: true,
      }]);
    }
  };

  useEffect(() => {
    refreshModels();

    // 监听后端自动加载完成事件，更新 UI 状态
    const pAutoLoaded = listen<string>("llm-auto-loaded", (ev) => {
      const loadedPath = ev.payload;
      setModels((prevModels) => {
        const match = prevModels.find((m) => m.path === loadedPath);
        const modelId = match?.id ?? "custom";
        setLoadedModel((current) => current ?? modelId);
        setLoadingModel(null);
        if (!match) {
          const filename = loadedPath.split(/[\\/]/).pop() ?? "custom";
          if (!prevModels.some((m) => m.path === loadedPath)) {
            return [...prevModels, { id: "custom", name: filename, filename, size_mb: 0, downloaded: true, path: loadedPath }];
          }
        }
        return prevModels;
      });
    });

    // 监听后端自动加载失败事件（模型文件不存在或加载出错）
    const pAutoFailed = listen<string>("llm-auto-load-failed", () => {
      setLoadingModel(null);
    });

    // 监听手动 load_llm_model 完成事件（后台线程异步加载结果）
    const pLoaded = listen<string>("llm-loaded", (ev) => {
      const loadedPath = ev.payload;
      setModels((prevModels) => {
        const match = prevModels.find((m) => m.path === loadedPath);
        const modelId = match?.id ?? "custom";
        setLoadedModel(modelId);
        setLoadingModel(null);
        localStorage.setItem(LAST_MODEL_KEY, loadedPath);
        if (!match) {
          const filename = loadedPath.split(/[\\/]/).pop() ?? "custom";
          if (!prevModels.some((m) => m.path === loadedPath)) {
            return [...prevModels, { id: "custom", name: filename, filename, size_mb: 0, downloaded: true, path: loadedPath }];
          }
        }
        return prevModels;
      });
    });

    // 监听手动 load_llm_model 失败事件
    const pLoadFailed = listen<string>("llm-load-failed", (ev) => {
      setLoadingModel(null);
      setMessages((prev) => [...prev, { role: "assistant", content: ev.payload, error: true }]);
    });

    const p0 = listen<DownloadProgress>("gguf-download-progress", (ev) => {
      const { done, total } = ev.payload;
      if (total > 0) setDownloadProgress(Math.round((done / total) * 100));
    });

    const p2 = listen<string>("ask-token", (ev) => {
      setMessages((prev) => {
        const msgs = [...prev];
        const last = msgs[msgs.length - 1];
        if (last?.role === "assistant") {
          msgs[msgs.length - 1] = { ...last, content: last.content + ev.payload, streaming: true };
        }
        return msgs;
      });
    });

    const p3 = listen<null>("ask-done", () => {
      setAsking(false);
      setMessages((prev) => {
        const msgs = [...prev];
        const last = msgs[msgs.length - 1];
        if (last?.role === "assistant") {
          msgs[msgs.length - 1] = { ...last, streaming: false };
        }
        return msgs;
      });
    });

    const p4 = listen<string>("ask-error", (ev) => {
      setMessages((prev) => {
        const msgs = [...prev];
        const last = msgs[msgs.length - 1];
        if (last?.role === "assistant") {
          msgs[msgs.length - 1] = { ...last, content: ev.payload || "生成失败，请重试", error: true, streaming: false };
        }
        return msgs;
      });
      setAsking(false);
    });

    return () => {
      pAutoLoaded.then((fn) => fn());
      pAutoFailed.then((fn) => fn());
      pLoaded.then((fn) => fn());
      pLoadFailed.then((fn) => fn());
      p0.then((fn) => fn()); p2.then((fn) => fn());
      p3.then((fn) => fn()); p4.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleDownload = (model: GgufModelInfo) => {
    setDownloadingModel(model.id);
    setDownloadProgress(0);
    invoke<string>("download_gguf_model", { modelId: model.id })
      .then(() => { refreshModels(); setDownloadingModel(null); })
      .catch((e: unknown) => {
        setMessages((prev) => [...prev, { role: "assistant", content: `下载失败: ${String(e)}`, error: true }]);
        setDownloadingModel(null);
      });
  };

  const handleLoad = (model: GgufModelInfo) => {
    if (!model.path) return;
    setLoadingModel(model.id);
    // load_llm_model 立即返回，实际加载在后台进行
    // 结果通过 llm-loaded / llm-load-failed 事件通知（见上方 useEffect 监听器）
    invoke("load_llm_model", { path: model.path })
      .catch((e: unknown) => {
        // 只处理立即校验错误（如文件不存在），异步加载错误由事件处理
        setMessages((prev) => [...prev, { role: "assistant", content: `加载失败: ${String(e)}`, error: true }]);
        setLoadingModel(null);
      });
  };

  const handleAsk = () => {
    const q = input.trim();
    if (!q || asking) return;

    // 连续对话模式传历史，单次问答模式传空数组（每次独立检索）
    const history = continuous
      ? messages.filter((m) => !m.error && m.content).map((m) => ({ role: m.role, content: m.content }))
      : [];

    const userMessage = q;

    setMessages((prev) => [
      ...prev,
      { role: "user", content: userMessage },
      { role: "assistant", content: "", streaming: true },
    ]);
    setInput("");
    setAsking(true);

    invoke<SourceRef[]>("ask_question_stream", { question: q, history })
      .then((sources) => {
        // invoke 返回后 React state 已提交，可安全附加 sources 到最后一条 assistant 消息
        setMessages((prev) => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant") msgs[msgs.length - 1] = { ...last, sources };
          return msgs;
        });
      })
      .catch((e: unknown) => {
        setMessages((prev) => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant") msgs[msgs.length - 1] = { ...last, content: String(e), error: true, streaming: false };
          return msgs;
        });
        setAsking(false);
      });
  };

  const handleExportConversation = async () => {
    if (messages.length === 0) return;
    const lines: string[] = ["# 对话导出\n"];
    for (const msg of messages) {
      if (msg.role === "user") {
        lines.push(`## 用户\n\n${msg.content}\n`);
      } else {
        lines.push(`## AI\n\n${msg.content}\n`);
        if (msg.sources && msg.sources.length > 0) {
          lines.push("**参考来源：**\n");
          msg.sources.forEach((s) => lines.push(`- ${s.name}: ${s.path}\n`));
        }
      }
    }
    const content = lines.join("\n");
    try {
      const savePath = await saveDialog({
        defaultPath: `conversation-${Date.now()}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!savePath) return;
      await invoke("write_text_file", { path: savePath, content });
      message.success("对话已导出");
    } catch (e: unknown) {
      message.error(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* 主对话区域 */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>

          {/* ── 模型选择区 ── */}
          {!loadedModel && (
            <div style={{
              background: "var(--color-surface)",
              borderRadius: 12,
              border: "1px solid var(--color-border)",
              padding: "14px 16px",
              flexShrink: 0,
              marginBottom: 12,
              boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
                <RobotOutlined style={{ color: "#1677ff", fontSize: 15 }} />
                <Typography.Text strong style={{ fontSize: 13, color: "var(--color-text)" }}>
                  选择对话模型
                </Typography.Text>
              </div>
              <List
                size="small"
                dataSource={models}
                split={false}
                footer={
                  <Button
                    type="dashed"
                    size="small"
                    block
                    icon={<ImportOutlined />}
                    onClick={handleImportGguf}
                    loading={loadingModel === "custom"}
                    style={{ borderRadius: 8, fontSize: 12, color: "#64748b" }}
                  >
                    导入本地 GGUF 文件
                  </Button>
                }
                renderItem={(m) => (
                  <List.Item
                    style={{
                      padding: "8px 10px",
                      borderRadius: 8,
                      marginBottom: 4,
                      background: m.downloaded ? "var(--color-primary-bg)" : "var(--color-bg)",
                      border: "1px solid var(--color-border)",
                    }}
                    actions={[
                      m.downloaded ? (
                        <Button
                          key="load"
                          size="small"
                          type="primary"
                          ghost={loadedModel === m.id}
                          icon={loadedModel === m.id ? <CheckCircleOutlined /> : undefined}
                          loading={loadingModel === m.id}
                          onClick={() => handleLoad(m)}
                          style={{ borderRadius: 6 }}
                        >
                          {loadedModel === m.id ? "已加载" : "加载"}
                        </Button>
                      ) : downloadingModel === m.id ? (
                        <Space key="dl">
                          <Progress percent={downloadProgress} size="small" style={{ width: 70 }} showInfo={false} />
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>{downloadProgress}%</Typography.Text>
                        </Space>
                      ) : (
                        <Button
                          key="download"
                          size="small"
                          icon={<DownloadOutlined />}
                          onClick={() => handleDownload(m)}
                          disabled={downloadingModel !== null}
                          style={{ borderRadius: 6 }}
                        >
                          下载
                        </Button>
                      ),
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 13, color: "var(--color-text)", fontWeight: 500 }}>{m.name}</span>
                          {MODEL_META[m.id]?.tag && (
                            <span style={{
                              fontSize: 10, padding: "1px 7px", borderRadius: 99,
                              background: (MODEL_META[m.id].tagColor ?? "#64748b") + "18",
                              color: MODEL_META[m.id].tagColor ?? "#64748b",
                              fontWeight: 600, border: `1px solid ${MODEL_META[m.id].tagColor ?? "#64748b"}30`,
                            }}>
                              {MODEL_META[m.id].tag}
                            </span>
                          )}
                          {m.downloaded && (
                            <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 10, background: "#dcfce7", color: "#16a34a", fontWeight: 500 }}>
                              已下载
                            </span>
                          )}
                        </div>
                      }
                      description={
                        <div style={{ marginTop: 2 }}>
                          {MODEL_META[m.id]?.desc && (
                            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.5, marginBottom: 3 }}>
                              {MODEL_META[m.id].desc}
                            </div>
                          )}
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                            {m.size_mb >= 1000 ? `${(m.size_mb / 1024).toFixed(1)} GB` : `${m.size_mb} MB`}
                          </Typography.Text>
                        </div>
                      }
                    />
                  </List.Item>
                )}
              />
            </div>
          )}

          {/* ── 已加载模型状态条 ── */}
          {loadedModel && (
            <div style={{
              background: "var(--color-bg-green)",
              border: "1px solid var(--color-border-green)",
              borderRadius: 10,
              padding: "8px 14px",
              flexShrink: 0,
              marginBottom: 12,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <CheckCircleOutlined style={{ color: "#22c55e", fontSize: 14 }} />
                <Typography.Text style={{ fontSize: 12, color: "var(--color-text-green)", fontWeight: 500 }}>
                  {models.find((m) => m.id === loadedModel)?.name ?? "模型"} 已就绪
                </Typography.Text>
              </div>
              <Button size="small" type="link" style={{ color: "var(--color-text-green)", padding: 0, fontSize: 12 }} onClick={() => setLoadedModel(null)}>
                切换模型
              </Button>
            </div>
          )}

          {/* ── 工具栏：模式切换 + 历史 + 清空 ── */}
          {loadedModel && (
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
              flexShrink: 0,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Tooltip title={continuous ? "当前：连续对话，AI 会记住上下文" : "当前：单次问答，每次独立检索"}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }} onClick={() => setContinuous((v) => !v)}>
                    {continuous
                      ? <MessageOutlined style={{ fontSize: 13, color: "#1677ff" }} />
                      : <FileTextOutlined style={{ fontSize: 13, color: "#64748b" }} />
                    }
                    <Typography.Text style={{ fontSize: 12, color: continuous ? "#1677ff" : "#64748b", userSelect: "none" }}>
                      {continuous ? "连续对话" : "单次问答"}
                    </Typography.Text>
                    <Switch
                      size="small"
                      checked={continuous}
                      onChange={setContinuous}
                      style={{ marginLeft: 2 }}
                    />
                  </div>
                </Tooltip>
              </div>

              {messages.length > 0 && (
                <div style={{ display: "flex", gap: 4 }}>
                  <Tooltip title="导出对话">
                    <Button
                      type="text"
                      size="small"
                      icon={<ExportOutlined />}
                      onClick={handleExportConversation}
                      style={{ color: "#94a3b8", fontSize: 12, padding: "0 6px" }}
                    />
                  </Tooltip>
                  <Tooltip title="清空对话">
                    <Button
                      type="text"
                      size="small"
                      icon={<DeleteOutlined />}
                      onClick={handleClear}
                      style={{ color: "#94a3b8", fontSize: 12, padding: "0 6px" }}
                    >
                      清空
                    </Button>
                  </Tooltip>
                </div>
              )}
            </div>
          )}

          {/* ── 对话区 ── */}
          <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 14, paddingBottom: 4 }}>

            {messages.length === 0 && loadedModel && (
              <div style={{ textAlign: "center", marginTop: 48 }}>
                <div style={{
                  width: 52, height: 52, borderRadius: 14,
                  background: "linear-gradient(135deg, #eff6ff, #dbeafe)",
                  margin: "0 auto 12px",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <RobotOutlined style={{ fontSize: 24, color: "#1677ff" }} />
                </div>
                <Typography.Text style={{ fontSize: 14, color: "var(--color-text)", fontWeight: 500, display: "block", marginBottom: 4 }}>
                  向 AI 提问
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  我会从你的文档中寻找答案
                </Typography.Text>
              </div>
            )}

            {messages.map((msg, i) =>
              msg.role === "user" ? (
                /* 用户气泡 */
                <div key={i} style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "flex-end" }}>
                  <div style={{
                    background: "linear-gradient(135deg, #1677ff, #3b82f6)",
                    color: "#fff",
                    borderRadius: "14px 14px 3px 14px",
                    padding: "9px 14px",
                    maxWidth: "82%",
                    fontSize: 13,
                    lineHeight: 1.6,
                    boxShadow: "0 2px 8px rgba(22,119,255,0.25)",
                  }}>
                    {msg.content}
                    {!continuous && (
                      <div style={{ fontSize: 10, opacity: 0.7, marginTop: 4 }}>单次问答</div>
                    )}
                  </div>
                  <div style={{
                    width: 28, height: 28, borderRadius: "50%",
                    background: "#dbeafe", flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <UserOutlined style={{ fontSize: 13, color: "#1677ff" }} />
                  </div>
                </div>
              ) : (
                /* AI 气泡 */
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: "50%", flexShrink: 0, marginTop: 2,
                    background: msg.error ? "#fee2e2" : "linear-gradient(135deg, #eff6ff, #dbeafe)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <RobotOutlined style={{ fontSize: 13, color: msg.error ? "#ef4444" : "#1677ff" }} />
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        background: msg.error ? "#fef2f2" : "var(--color-surface)",
                        border: `1px solid ${msg.error ? "#fecaca" : "var(--color-border)"}`,
                        borderRadius: "3px 14px 14px 14px",
                        padding: "10px 14px",
                        fontSize: 13,
                        lineHeight: 1.7,
                        color: msg.error ? "#dc2626" : "var(--color-text)",
                        boxShadow: msg.error ? "none" : "0 1px 3px rgba(0,0,0,0.06)",
                      }}
                      className={`qa-markdown${msg.streaming && !msg.error ? " qa-typing" : ""}`}
                    >
                      {msg.error ? (
                        msg.content
                      ) : msg.content ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                      ) : (
                        <span style={{ color: "#94a3b8", fontStyle: "italic", fontSize: 12 }}>思考中…</span>
                      )}
                    </div>

                    {/* 参考来源 */}
                    {msg.sources && msg.sources.length > 0 && (
                      <div style={{ marginTop: 6 }}>
                        <Button
                          type="text"
                          size="small"
                          style={{ padding: "0 4px", fontSize: 11, height: "auto", color: "#94a3b8" }}
                          onClick={() => toggleSources(i)}
                        >
                          {expandedSources.has(i) ? "▾" : "▸"} 参考来源（{msg.sources.length}）
                        </Button>
                        {expandedSources.has(i) && (
                          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                            {msg.sources.map((src, si) => (
                              <div key={si} style={{
                                background: "var(--color-primary-bg)",
                                border: "1px solid var(--color-border)",
                                borderRadius: 8,
                                padding: "6px 10px",
                                fontSize: 12,
                              }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: src.snippet ? 4 : 0 }}>
                                  <Tag color="blue" style={{ margin: 0, fontSize: 11, borderRadius: 6 }}>{src.name}</Tag>
                                  <Button
                                    type="text" size="small"
                                    icon={<FolderOpenOutlined style={{ fontSize: 12 }} />}
                                    style={{ padding: "0 4px", height: "auto", color: "#94a3b8" }}
                                    onClick={() => invoke("open_file", { path: src.path })}
                                  />
                                </div>
                                {src.snippet && (
                                  <Typography.Text type="secondary" style={{ fontSize: 11, display: "block", lineHeight: 1.5 }}>
                                    {src.snippet.slice(0, 120)}{src.snippet.length > 120 ? "…" : ""}
                                  </Typography.Text>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            )}

            {asking && messages[messages.length - 1]?.content === "" && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: 36 }}>
                <Spin size="small" />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>正在检索文档…</Typography.Text>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* ── 输入区 ── */}
          <div style={{
            paddingTop: 10,
            borderTop: "1px solid var(--color-border)",
            flexShrink: 0,
            display: "flex",
            gap: 8,
            alignItems: "flex-end",
          }}>
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAsk(); }
              }}
              placeholder={loadedModel ? "输入问题… (Enter 发送，Shift+Enter 换行)" : "请先加载模型"}
              disabled={!loadedModel || asking}
              autoSize={{ minRows: 1, maxRows: 5 }}
              style={{
                flex: 1, borderRadius: 12,
                resize: "none", fontSize: 13,
                background: "var(--color-bg)",
                borderColor: "var(--color-border)",
              }}
            />
            {asking ? (
              <Button
                danger
                icon={<StopOutlined />}
                onClick={() => invoke("stop_generation")}
                style={{ borderRadius: 8, height: 34 }}
              >
                停止
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<SendOutlined />}
                onClick={handleAsk}
                disabled={!input.trim() || !loadedModel}
                style={{ borderRadius: 8, height: 34 }}
              >
                发送
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
