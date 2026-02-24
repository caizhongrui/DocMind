import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

interface SearchResult {
  file_id: number;
  path: string;
  name: string;
  file_type: string;
  score: number;
  snippet: string;
}

interface SearchStore {
  query: string;
  mode: "filename" | "fulltext";
  results: SearchResult[];
  selected: SearchResult | null;
  loading: boolean;
  error: string | null;
  setQuery: (q: string) => void;
  setMode: (m: "filename" | "fulltext") => void;
  setSelected: (r: SearchResult | null) => void;
  doSearch: () => Promise<void>;
}

export const useSearchStore = create<SearchStore>((set, get) => ({
  query: "",
  mode: "fulltext",
  results: [],
  selected: null,
  loading: false,
  error: null,
  setQuery: (query) => set({ query }),
  setMode: (mode) => set({ mode }),
  setSelected: (selected) => set({ selected }),
  doSearch: async () => {
    const { query, mode } = get();
    if (!query.trim()) return set({ results: [] });
    set({ loading: true });
    try {
      // 注意：后端命令名是 search_files，不是 search
      const results = await invoke<SearchResult[]>("search_files", { query, mode });
      set({ results, error: null });
    } catch (e) {
      console.error("Search error:", e);
      set({ results: [], error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },
}));
