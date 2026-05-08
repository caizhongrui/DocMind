import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Plan = "free" | "trial" | "pro";

export interface QuotaSnapshot {
  period: string;
  used: number;
  limit: number;
  remaining: number;
}

export interface LicenseStatus {
  plan: Plan;
  reason: string;
  fingerprint: string;
  expires_at: string | null;
  license_key: string | null;
  quota: QuotaSnapshot;
}

interface UpgradeRequest {
  reason: string; // e.g. "custom_gguf" / "batch_summary" / "model_tier"
  message?: string;
}

interface LicenseStore {
  status: LicenseStatus | null;
  loading: boolean;
  upgradeRequest: UpgradeRequest | null;
  refresh: () => Promise<void>;
  showUpgrade: (reason: string, message?: string) => void;
  closeUpgrade: () => void;
  initListeners: () => void;
}

export const useLicenseStore = create<LicenseStore>((set, get) => ({
  status: null,
  loading: false,
  upgradeRequest: null,

  async refresh() {
    set({ loading: true });
    try {
      const s = await invoke<LicenseStatus>("get_license_status");
      set({ status: s });
    } catch {
      // ignore — backend may still be booting
    } finally {
      set({ loading: false });
    }
  },

  showUpgrade(reason, message) {
    set({ upgradeRequest: { reason, message } });
  },

  closeUpgrade() {
    set({ upgradeRequest: null });
  },

  initListeners() {
    // Backend pushes license-updated when activate / clear succeed.
    listen("license-updated", () => {
      get().refresh();
    });
    // Backend pushes quota-consumed every time a Free user's AI call is
    // accepted, with the fresh quota snapshot in the payload. Patch it
    // straight into the existing status to avoid an extra round-trip.
    listen<QuotaSnapshot>("quota-consumed", (ev) => {
      const cur = get().status;
      if (!cur) {
        get().refresh();
        return;
      }
      set({ status: { ...cur, quota: ev.payload } });
    });
  },
}));

/**
 * Convenience helper: invokes a Tauri command, intercepts PRO_REQUIRED:* and
 * QUOTA_EXCEEDED:* errors and routes them to the upgrade dialog.
 *
 * Re-throws every other error so callers can still surface their own messages.
 */
export async function invokePro<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    const msg = String(err);
    if (msg.startsWith("PRO_REQUIRED:")) {
      const reason = msg.slice("PRO_REQUIRED:".length);
      useLicenseStore.getState().showUpgrade(reason);
    } else if (msg.startsWith("QUOTA_EXCEEDED:")) {
      useLicenseStore.getState().showUpgrade("quota_exceeded", "本月免费 AI 调用配额已用完");
    }
    throw err;
  }
}

/**
 * Map backend error strings (e.g. "PRO_REQUIRED:model_tier") to a
 * user-facing Chinese message. Unknown errors are returned as-is so we
 * still surface something rather than swallowing them silently.
 */
const PRO_REQUIRED_MESSAGES: Record<string, string> = {
  custom_gguf: "导入自定义模型是 Pro 功能,请升级或试用",
  model_tier: "该模型档位需要 Pro,免费版仅支持 0.6B 轻量模型",
  batch_summary: "批量摘要是 Pro 功能,请升级或试用",
  ocr_indexing: "OCR / 扫描件索引是 Pro 功能,请升级或试用",
  conversation_export: "导出对话是 Pro 功能,请升级或试用",
  scheduled_reindex: "定时重索引是 Pro 功能,请升级或试用",
};

export function localizeError(err: unknown): string {
  const msg = String(err);
  if (msg.startsWith("PRO_REQUIRED:")) {
    const reason = msg.slice("PRO_REQUIRED:".length);
    return PRO_REQUIRED_MESSAGES[reason] ?? `该功能需要 Pro 版本: ${reason}`;
  }
  if (msg.startsWith("QUOTA_EXCEEDED:")) {
    return "本月免费 AI 调用配额已用完";
  }
  if (msg === "FINGERPRINT_MISMATCH") {
    return "License 绑定的设备指纹与本机不符,无法激活";
  }
  if (msg === "EXPIRED_TOKEN") {
    return "License token 已过期";
  }
  if (msg.startsWith("INVALID_TOKEN:")) {
    return `License token 无效: ${msg.slice("INVALID_TOKEN:".length)}`;
  }
  return msg.replace(/^Error:\s*/, "");
}
