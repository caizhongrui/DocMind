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
