import { create } from "zustand";

/**
 * Holds the *Q&A scope* — the set of documents the user has chosen to
 * restrict their next AI question or summary to.
 *
 * Workflow:
 *   1. User picks 批量操作 in the result list, ticks N files
 *   2. Clicks "针对所选问答" or "生成摘要" — the result list copies the
 *      selected files into this store and opens the QAPanel drawer
 *   3. QAPanel reads scopeFiles; non-empty ⇒ shows a "已限定 N 份文档"
 *      banner, sends ask_question_scoped (instead of the global
 *      ask_question_stream) on submit
 *   4. User clicks "退出范围" to clear scopeFiles and go back to global
 *      Q&A.
 */
export interface ScopeFile {
  file_id: number;
  path: string;
  name: string;
  file_type: string;
}

interface SelectionStore {
  scopeFiles: ScopeFile[];

  setScope: (files: ScopeFile[]) => void;
  clearScope: () => void;
}

export const useSelectionStore = create<SelectionStore>((set) => ({
  scopeFiles: [],

  setScope: (files) => set({ scopeFiles: files }),
  clearScope: () => set({ scopeFiles: [] }),
}));
