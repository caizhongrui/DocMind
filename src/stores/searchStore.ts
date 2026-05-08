import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { invokePro } from "./licenseStore";
import type { SearchResult, SearchHistoryItem } from "../types";

interface SearchStore {
  query: string;
  mode: "filename" | "fulltext" | "semantic";
  results: SearchResult[];
  selected: SearchResult | null;
  loading: boolean;
  error: string | null;
  searchHistory: SearchHistoryItem[];
  setQuery: (q: string) => void;
  setMode: (m: "filename" | "fulltext" | "semantic") => void;
  setSelected: (r: SearchResult | null) => void;
  doSearch: () => Promise<void>;
  loadSearchHistory: () => Promise<void>;
  addToHistory: (query: string, mode: string) => Promise<void>;
  deleteHistoryItem: (id: number) => Promise<void>;
  sortBy: "relevance" | "modified" | "size";
  setSortBy: (s: "relevance" | "modified" | "size") => void;
}

export const useSearchStore = create<SearchStore>((set, get) => ({
  query: "",
  mode: "fulltext",
  results: [],
  selected: null,
  loading: false,
  error: null,
  searchHistory: [],
  sortBy: "relevance",
  setQuery: (query) => set({ query }),
  setMode: (mode) => set({ mode, results: [], selected: null }),
  setSelected: (selected) => set({ selected }),
  doSearch: async () => {
    const { query, mode } = get();
    if (!query.trim()) return set({ results: [] });
    set({ loading: true });
    try {
      // 注意：后端命令名是 search_files，不是 search
      const { sortBy } = get();
      // Use invokePro so semantic-search quota errors trigger the upgrade dialog.
      const results = await invokePro<SearchResult[]>("search_files", { query, mode, sortBy: sortBy === "relevance" ? null : sortBy });
      set({ results, error: null });
      get().addToHistory(query.trim(), mode);
    } catch (e) {
      console.error("Search error:", e);
      set({ results: [], error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },
  loadSearchHistory: async () => {
    try {
      const searchHistory = await invoke<SearchHistoryItem[]>("get_search_history");
      set({ searchHistory });
    } catch (e) {
      console.error("Load search history error:", e);
    }
  },
  addToHistory: async (query: string, mode: string) => {
    try {
      await invoke("add_search_history", { query, mode });
      await get().loadSearchHistory();
    } catch (e) {
      console.error("Add to history error:", e);
    }
  },
  deleteHistoryItem: async (id: number) => {
    try {
      await invoke("delete_search_history_item", { id });
      await get().loadSearchHistory();
    } catch (e) {
      console.error("Delete history item error:", e);
    }
  },
  setSortBy: (sortBy) => {
    set({ sortBy });
    // 如果当前有 query，自动重新搜索
    const { query } = get();
    if (query.trim()) get().doSearch();
  },
}));
