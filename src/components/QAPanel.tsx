import {
  Button,
  Input,
  Spin,
  Typography,
  Progress,
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
import { invokePro, localizeError } from "../stores/licenseStore";
import { useSelectionStore } from "../stores/selectionStore";

interface DownloadProgress {
  model_id: string;
  done: number;
  total: number;
}

const LAST_MODEL_KEY = "docmind_last_llm_model_path";

const MODEL_META: Record<string, { desc: string; tag?: string }> = {
  "qwen3-0.6b-q4": {
    desc: "超轻量，内存占用最低（约 600MB），速度最快，适合 4GB 内存及低配设备，回答深度有限",
    tag: "低配",
  },
  "qwen3-1.7b-q4": {
    desc: "性能与资源最均衡，中文理解好，文档问答质量优秀，适合绝大多数用户",
    tag: "推荐",
  },
  "qwen3-4b-q4": {
    desc: "推理能力更强，长文档理解与逻辑分析更准确，需 8GB+ 内存，生成速度较慢",
    tag: "高质量",
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
    try {
      const loadedPath = await invoke<string | null>("get_loaded_llm_path");
      if (loadedPath) {
        autoLoadedRef.current = true;
        setLoadedModel(resolveModelId(loadedPath, modelList));
        return;
      }
    } catch {}
    try {
      const dbPath = await invoke<string | null>("get_setting", { key: "last_llm_path" });
      if (dbPath && dbPath.trim()) {
        autoLoadedRef.current = true;
        setLoadingModel(resolveModelId(dbPath, modelList));
        return;
      }
    } catch {}
    const savedPath = localStorage.getItem(LAST_MODEL_KEY);
    if (!savedPath) return;
    autoLoadedRef.current = true;
    const modelId = resolveModelId(savedPath, modelList);
    setLoadingModel(modelId);
    // invokePro routes PRO_REQUIRED:* to the upgrade dialog. We swallow
    // the error here (already shown by the dialog) and forget the saved
    // path so the next launch falls back to picking a model the user has
    // permission for.
    invokePro("load_llm_model", { path: savedPath }).catch(() => {
      autoLoadedRef.current = false;
      setLoadingModel(null);
      localStorage.removeItem(LAST_MODEL_KEY);
    });
  };

  const refreshModels = () => {
    invoke<GgufModelInfo[]>("list_available_gguf_models")
      .then((list) => {
        setModels(list);
        autoLoadLastModel(list);
      })
      .catch(() => {});
  };

  const handleImportGguf = async () => {
    const selected = await openDialog({
      filters: [{ name: "GGUF 模型", extensions: ["gguf"] }],
    });
    if (!selected) return;
    try {
      const destPath = await invokePro<string>("import_custom_gguf", { path: selected as string });
      const filename = (destPath as string).split(/[\\/]/).pop() ?? "custom";
      setLoadingModel("custom");
      setModels((prev) => {
        if (prev.some((m) => m.path === destPath)) return prev;
        return [
          ...prev,
          {
            id: "custom",
            name: filename,
            filename,
            size_mb: 0,
            downloaded: true,
            path: destPath as string,
          },
        ];
      });
      await invokePro("load_llm_model", { path: destPath });
    } catch (e) {
      setLoadingModel(null);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `导入失败: ${localizeError(e)}`, error: true },
      ]);
    }
  };

  useEffect(() => {
    refreshModels();

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
            return [
              ...prevModels,
              { id: "custom", name: filename, filename, size_mb: 0, downloaded: true, path: loadedPath },
            ];
          }
        }
        return prevModels;
      });
    });

    const pAutoFailed = listen<string>("llm-auto-load-failed", () => {
      setLoadingModel(null);
    });

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
            return [
              ...prevModels,
              { id: "custom", name: filename, filename, size_mb: 0, downloaded: true, path: loadedPath },
            ];
          }
        }
        return prevModels;
      });
    });

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
          msgs[msgs.length - 1] = {
            ...last,
            content: ev.payload || "生成失败，请重试",
            error: true,
            streaming: false,
          };
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
      p0.then((fn) => fn());
      p2.then((fn) => fn());
      p3.then((fn) => fn());
      p4.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleDownload = (model: GgufModelInfo) => {
    setDownloadingModel(model.id);
    setDownloadProgress(0);
    invoke<string>("download_gguf_model", { modelId: model.id })
      .then(() => {
        refreshModels();
        setDownloadingModel(null);
      })
      .catch((e: unknown) => {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `下载失败: ${String(e)}`, error: true },
        ]);
        setDownloadingModel(null);
      });
  };

  const handleLoad = (model: GgufModelInfo) => {
    if (!model.path) return;
    setLoadingModel(model.id);
    invokePro("load_llm_model", { path: model.path }).catch((e: unknown) => {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `加载失败: ${localizeError(e)}`, error: true },
      ]);
      setLoadingModel(null);
    });
  };

  const handleAsk = () => {
    const q = input.trim();
    if (!q || asking) return;

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

    // If the user has scoped this conversation to a set of documents
    // (via the result-list batch toolbar), route to ask_question_scoped
    // so the LLM only sees those files. Otherwise the global RAG path.
    const scope = useSelectionStore.getState().scopeFiles;
    const cmd = scope.length > 0 ? "ask_question_scoped" : "ask_question_stream";
    const args: Record<string, unknown> = { question: q, history };
    if (scope.length > 0) args.paths = scope.map((s) => s.path);

    invokePro<SourceRef[]>(cmd, args)
      .then((sources) => {
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
          if (last?.role === "assistant")
            msgs[msgs.length - 1] = { ...last, content: String(e), error: true, streaming: false };
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

  const scopeFiles = useSelectionStore((s) => s.scopeFiles);
  const clearScope = useSelectionStore((s) => s.clearScope);

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>
          {scopeFiles.length > 0 && (
            <div
              style={{
                flexShrink: 0,
                marginBottom: 10,
                padding: "8px 12px",
                background: "var(--color-primary-bg)",
                border: "1px solid var(--color-primary)",
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--color-primary)",
                lineHeight: 1.5,
              }}
            >
              <span style={{ fontWeight: 600 }}>📑 已限定 {scopeFiles.length} 份文档</span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color: "var(--color-text-secondary)",
                  fontSize: 11,
                }}
                title={scopeFiles.map((f) => f.name).join("\n")}
              >
                {scopeFiles.slice(0, 3).map((f) => f.name).join(" · ")}
                {scopeFiles.length > 3 ? ` · +${scopeFiles.length - 3}` : ""}
              </span>
              <Button size="small" type="text" onClick={clearScope}>
                退出范围
              </Button>
            </div>
          )}
          {/* Model selection */}
          {!loadedModel && (
            <div
              style={{
                background: "var(--color-surface)",
                borderRadius: 8,
                border: "1px solid var(--color-border)",
                padding: "12px 14px",
                flexShrink: 0,
                marginBottom: 12,
              }}
            >
              <div className="section-label" style={{ marginBottom: 10 }}>
                选择模型
              </div>
              <div>
                {models.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 6,
                      marginBottom: 4,
                      background: m.downloaded ? "var(--color-surface-elevated)" : "transparent",
                      border: "1px solid var(--color-border)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 13, color: "var(--color-text)", fontWeight: 500 }}>{m.name}</span>
                        {MODEL_META[m.id]?.tag && (
                          <span className="chip" style={{ height: 16 }}>
                            {MODEL_META[m.id].tag}
                          </span>
                        )}
                        {m.downloaded && (
                          <span className="chip chip-primary" style={{ height: 16 }}>
                            已下载
                          </span>
                        )}
                      </div>
                      <div style={{ marginTop: 2 }}>
                        {MODEL_META[m.id]?.desc && (
                          <div
                            style={{
                              fontSize: 11,
                              color: "var(--color-text-secondary)",
                              lineHeight: 1.5,
                              marginBottom: 3,
                            }}
                          >
                            {MODEL_META[m.id].desc}
                          </div>
                        )}
                        <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>
                          {m.size_mb >= 1000 ? `${(m.size_mb / 1024).toFixed(1)} GB` : `${m.size_mb} MB`}
                        </Typography.Text>
                      </div>
                    </div>
                    <div style={{ flexShrink: 0 }}>
                      {m.downloaded ? (
                        <Button
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
                        <Space>
                          <Progress percent={downloadProgress} size="small" style={{ width: 70 }} showInfo={false} />
                          <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>
                            {downloadProgress}%
                          </Typography.Text>
                        </Space>
                      ) : (
                        <Button
                          size="small"
                          icon={<DownloadOutlined />}
                          onClick={() => handleDownload(m)}
                          disabled={downloadingModel !== null}
                          style={{ borderRadius: 6 }}
                        >
                          下载
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                <Button
                  type="dashed"
                  size="small"
                  block
                  icon={<ImportOutlined />}
                  onClick={handleImportGguf}
                  loading={loadingModel === "custom"}
                  style={{ borderRadius: 6, fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}
                >
                  导入本地 GGUF 文件
                </Button>
              </div>
            </div>
          )}

          {/* Loaded model status bar */}
          {loadedModel && (
            <div
              style={{
                background: "var(--color-surface-elevated)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                padding: "8px 12px",
                flexShrink: 0,
                marginBottom: 10,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "#22c55e",
                    boxShadow: "0 0 0 3px rgba(34,197,94,0.18)",
                  }}
                />
                <Typography.Text style={{ fontSize: 12, color: "var(--color-text)", fontWeight: 500 }}>
                  {models.find((m) => m.id === loadedModel)?.name ?? "模型"}
                </Typography.Text>
                <span className="chip" style={{ height: 16 }}>
                  Ready
                </span>
              </div>
              <Button
                size="small"
                type="text"
                style={{ color: "var(--color-text-secondary)", padding: "0 6px", fontSize: 12 }}
                onClick={() => setLoadedModel(null)}
              >
                切换
              </Button>
            </div>
          )}

          {/* Toolbar */}
          {loadedModel && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Tooltip title={continuous ? "当前：连续对话，AI 会记住上下文" : "当前：单次问答，每次独立检索"}>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                    onClick={() => setContinuous((v) => !v)}
                  >
                    {continuous ? (
                      <MessageOutlined style={{ fontSize: 12, color: "var(--color-primary)" }} />
                    ) : (
                      <FileTextOutlined style={{ fontSize: 12, color: "var(--color-text-secondary)" }} />
                    )}
                    <Typography.Text
                      style={{
                        fontSize: 12,
                        color: continuous ? "var(--color-primary)" : "var(--color-text-secondary)",
                        userSelect: "none",
                      }}
                    >
                      {continuous ? "连续对话" : "单次问答"}
                    </Typography.Text>
                    <Switch size="small" checked={continuous} onChange={setContinuous} style={{ marginLeft: 2 }} />
                  </div>
                </Tooltip>
              </div>

              {messages.length > 0 && (
                <div style={{ display: "flex", gap: 2 }}>
                  <Tooltip title="导出对话">
                    <Button
                      type="text"
                      size="small"
                      icon={<ExportOutlined />}
                      onClick={handleExportConversation}
                      style={{ color: "var(--color-text-muted)", fontSize: 12, padding: "0 6px" }}
                    />
                  </Tooltip>
                  <Tooltip title="清空对话">
                    <Button
                      type="text"
                      size="small"
                      icon={<DeleteOutlined />}
                      onClick={handleClear}
                      style={{ color: "var(--color-text-muted)", fontSize: 12, padding: "0 6px" }}
                    />
                  </Tooltip>
                </div>
              )}
            </div>
          )}

          {/* Conversation */}
          <div
            style={{
              flex: 1,
              overflow: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              paddingBottom: 4,
            }}
          >
            {messages.length === 0 && loadedModel && (
              <div style={{ textAlign: "center", marginTop: 48 }}>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 12,
                    background: "var(--color-surface-elevated)",
                    border: "1px solid var(--color-border)",
                    margin: "0 auto 14px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <RobotOutlined style={{ fontSize: 22, color: "var(--color-primary)" }} />
                </div>
                <Typography.Text style={{ fontSize: 13, color: "var(--color-text)", fontWeight: 600, display: "block", marginBottom: 4 }}>
                  向 AI 提问
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  我会从你的文档中寻找答案
                </Typography.Text>
              </div>
            )}

            {messages.map((msg, i) =>
              msg.role === "user" ? (
                /* User: left blue bar + plain text, no bubble */
                <div
                  key={i}
                  style={{
                    padding: "8px 12px 8px 14px",
                    boxShadow: "inset 2px 0 0 0 var(--color-primary)",
                    background: "transparent",
                  }}
                >
                  <div className="section-label" style={{ marginBottom: 4 }}>
                    你
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--color-text)", whiteSpace: "pre-wrap" }}>
                    {msg.content}
                    {!continuous && (
                      <span className="chip" style={{ marginLeft: 8, height: 16 }}>
                        单次
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                /* AI: elevated panel + hairline border */
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div
                    style={{
                      background: msg.error ? "rgba(239,68,68,0.08)" : "var(--color-surface-elevated)",
                      border: `1px solid ${msg.error ? "rgba(239,68,68,0.3)" : "var(--color-border)"}`,
                      borderRadius: 8,
                      padding: "10px 14px",
                      fontSize: 13,
                      lineHeight: 1.7,
                      color: msg.error ? "#dc2626" : "var(--color-text)",
                    }}
                    className={`qa-markdown${msg.streaming && !msg.error ? " qa-typing" : ""}`}
                  >
                    {msg.error ? (
                      msg.content
                    ) : msg.content ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    ) : (
                      <span style={{ color: "var(--color-text-muted)", fontStyle: "italic", fontSize: 12 }}>
                        思考中…
                      </span>
                    )}
                  </div>

                  {msg.sources && msg.sources.length > 0 && (
                    <div>
                      <Button
                        type="text"
                        size="small"
                        style={{
                          padding: "0 4px",
                          fontSize: 11,
                          height: "auto",
                          color: "var(--color-text-muted)",
                        }}
                        onClick={() => toggleSources(i)}
                      >
                        {expandedSources.has(i) ? "▾" : "▸"} 参考来源（{msg.sources.length}）
                      </Button>
                      {expandedSources.has(i) && (
                        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                          {msg.sources.map((src, si) => (
                            <div
                              key={si}
                              style={{
                                background: "var(--color-surface)",
                                border: "1px solid var(--color-border)",
                                borderRadius: 6,
                                padding: "6px 10px",
                                fontSize: 12,
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  marginBottom: src.snippet ? 4 : 0,
                                  gap: 6,
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 12,
                                    fontWeight: 500,
                                    color: "var(--color-text)",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    flex: 1,
                                    minWidth: 0,
                                  }}
                                >
                                  {src.name}
                                </span>
                                <Button
                                  type="text"
                                  size="small"
                                  icon={<FolderOpenOutlined style={{ fontSize: 12 }} />}
                                  style={{ padding: "0 4px", height: "auto", color: "var(--color-text-muted)" }}
                                  onClick={() => invoke("open_file", { path: src.path })}
                                />
                              </div>
                              {src.snippet && (
                                <Typography.Text
                                  type="secondary"
                                  style={{ fontSize: 11, display: "block", lineHeight: 1.5 }}
                                >
                                  {src.snippet.slice(0, 120)}
                                  {src.snippet.length > 120 ? "…" : ""}
                                </Typography.Text>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            )}

            {asking && messages[messages.length - 1]?.content === "" && (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Spin size="small" />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  正在检索文档…
                </Typography.Text>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div
            style={{
              paddingTop: 10,
              borderTop: "1px solid var(--color-border)",
              flexShrink: 0,
              display: "flex",
              gap: 8,
              alignItems: "flex-end",
            }}
          >
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleAsk();
                }
              }}
              placeholder={loadedModel ? "输入问题…  ↵ 发送  ⇧↵ 换行" : "请先加载模型"}
              disabled={!loadedModel || asking}
              autoSize={{ minRows: 1, maxRows: 5 }}
              style={{
                flex: 1,
                borderRadius: 8,
                resize: "none",
                fontSize: 13,
              }}
            />
            {asking ? (
              <Button danger icon={<StopOutlined />} onClick={() => invoke("stop_generation")} style={{ borderRadius: 8, height: 34 }}>
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
