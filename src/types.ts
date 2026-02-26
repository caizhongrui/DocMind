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

export interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: SourceRef[];
  error?: boolean;
  streaming?: boolean;
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
