// DocMind 共享类型定义

export interface SearchResult {
  file_id: number;
  path: string;
  name: string;
  file_type: string;
  score: number;
  snippet: string;
  size?: number;      // bytes
  modified?: number;  // Unix timestamp (seconds)
}

export interface SearchHistoryItem {
  id: number;
  query: string;
  mode: string;
  used_at: string;
}

export interface SourceRef {
  name: string;
  path: string;
  snippet: string;
}

/**
 * 单次问答的召回统计 — 后端 `AskStreamStart.recall`。
 * 让 UI 能告诉用户"我读了多少 / 涉及哪几份"。
 */
export interface AskRecallInfo {
  /** 第一轮(语义+BM25)合并去重后的候选总数 */
  initial_pool: number;
  /** 加上"每文件保底"补进来后的候选数 */
  after_threshold: number;
  /** 最终送进 LLM 上下文的 chunk 数(含邻居扩展) */
  used: number;
  /** 涉及不同文件数 */
  files: number;
  /** 精排实际状态:
   *  - "off"     用户在设置里关闭了精排
   *  - "absent"  reranker 模型未下载 / 未加载
   *  - "ok"      精排成功跑完
   *  - "failed"  精排尝试运行但中途出错(已 fallback 到 IDF)
   */
  reranker_state: "off" | "absent" | "ok" | "failed" | string;
}

/**
 * 流式问答启动返回值 — 后端 `AskStreamStart`,token 流到达前
 * 前端可立刻拿到 sources + recall,把"已分析 X 段..."先画出来。
 */
export interface AskStreamStart {
  sources: SourceRef[];
  recall: AskRecallInfo;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: SourceRef[];
  /** 召回统计 — 仅在全库问答(非 scoped)时由 ask_question_stream 返回 */
  recall?: AskRecallInfo;
  error?: boolean;
  streaming?: boolean;
}

export interface RerankerStatus {
  available: boolean;
  loaded: boolean;
  model_dir: string;
  model_version: string;
}

export interface ConversationInfo {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface MessageInfo {
  id: number;
  conversation_id: number;
  role: string;
  content: string;
  sources_json: string | null;
  created_at: string;
}

export interface GgufModelInfo {
  id: string;
  name: string;
  filename: string;
  size_mb: number;
  downloaded: boolean;
  path: string | null;
}

export interface ApiLlmConfig {
  enabled: boolean;
  endpoint: string;
  api_key: string;
  model_name: string;
  temperature: number;
  max_tokens: number;
  top_p: number;
}
