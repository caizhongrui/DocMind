import type { ThemeConfig } from "antd";
import { theme } from "antd";

/**
 * Build the Ant Design theme object from DocMind design tokens.
 * Keep values synced with src/styles/tokens.css and the inline-style
 * injection in src/main.tsx.
 */
export function getAntdTheme(isDark: boolean): ThemeConfig {
  const tokens = isDark
    ? {
        primary: "#3b82f6",
        primaryHover: "#60a5fa",
        bg: "#0c0d10",
        surface: "#16181d",
        surfaceElevated: "#1c1f26",
        border: "#23262d",
        borderSecondary: "#1c1f26",
        text: "#e6e8eb",
        textSecondary: "#8b8f99",
        textMuted: "#5b5f68",
        fillSecondary: "#1e2127",
        fillTertiary: "#1c1f26",
      }
    : {
        primary: "#1677ff",
        primaryHover: "#4096ff",
        bg: "#fafafa",
        surface: "#ffffff",
        surfaceElevated: "#ffffff",
        border: "#ececec",
        borderSecondary: "#f0f0f0",
        text: "#16181d",
        textSecondary: "#6b7280",
        textMuted: "#9ca3af",
        fillSecondary: "#f4f5f7",
        fillTertiary: "#fafafa",
      };

  return {
    algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: tokens.primary,
      colorPrimaryHover: tokens.primaryHover,
      colorBgContainer: tokens.surface,
      colorBgElevated: tokens.surfaceElevated,
      colorBgLayout: tokens.bg,
      colorBorder: tokens.border,
      colorBorderSecondary: tokens.borderSecondary,
      colorText: tokens.text,
      colorTextSecondary: tokens.textSecondary,
      colorTextTertiary: tokens.textMuted,
      colorFillSecondary: tokens.fillSecondary,
      colorFillTertiary: tokens.fillTertiary,
      borderRadius: 8,
      borderRadiusLG: 12,
      borderRadiusSM: 6,
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
      fontSize: 13,
      motionDurationFast: "0.08s",
      motionDurationMid: "0.12s",
      motionDurationSlow: "0.18s",
      boxShadow: `0 0 0 1px ${tokens.border}`,
      boxShadowSecondary: isDark
        ? `0 8px 24px rgba(0,0,0,0.32), 0 0 0 1px ${tokens.border}`
        : `0 8px 24px rgba(0,0,0,0.1), 0 0 0 1px ${tokens.border}`,
    },
    components: {
      Drawer: {
        colorBgElevated: tokens.surface,
      },
      Modal: {
        colorBgElevated: tokens.surface,
      },
      Tooltip: {
        colorBgSpotlight: isDark ? "#1c1f26" : "#16181d",
        colorTextLightSolid: "#e6e8eb",
      },
      Button: {
        controlHeight: 32,
        controlHeightSM: 26,
        defaultBorderColor: tokens.border,
      },
      Input: {
        controlHeight: 32,
        activeBorderColor: tokens.primary,
        hoverBorderColor: tokens.primary,
      },
      Tag: {
        defaultBg: "transparent",
        defaultColor: tokens.textSecondary,
      },
      Segmented: {
        itemSelectedBg: tokens.surfaceElevated,
        trackBg: tokens.fillSecondary,
      },
      Tabs: {
        cardBg: tokens.fillSecondary,
        itemSelectedColor: tokens.primary,
      },
      Card: {
        colorBgContainer: tokens.surface,
      },
    },
  };
}

/**
 * The set of CSS variables to inject as inline styles on <html>.
 * Tauri WebKit can be flaky with attribute selectors in stylesheets,
 * so the inline injection is the actual source of truth at runtime.
 */
export function getCssVars(isDark: boolean): Record<string, string> {
  if (isDark) {
    return {
      "--color-bg": "#0c0d10",
      "--color-surface": "#16181d",
      "--color-surface-elevated": "#1c1f26",
      "--color-border": "#23262d",
      "--color-border-strong": "#33373f",
      "--color-primary": "#3b82f6",
      "--color-primary-hover": "#60a5fa",
      "--color-primary-bg": "rgba(59,130,246,0.16)",
      "--color-text": "#e6e8eb",
      "--color-text-secondary": "#8b8f99",
      "--color-text-muted": "#5b5f68",
      "--color-hover": "#1e2127",
      "--color-selected": "#1c1f26",
      "--color-bg-purple": "rgba(124,58,237,0.1)",
      "--color-bg-amber": "rgba(245,158,11,0.08)",
      "--color-bg-green": "rgba(34,197,94,0.08)",
      "--color-border-purple": "rgba(124,58,237,0.25)",
      "--color-border-amber": "rgba(245,158,11,0.2)",
      "--color-border-green": "rgba(34,197,94,0.2)",
      "--color-text-green": "#4ade80",
      "--color-text-amber": "#fbbf24",
      "--shadow-sm": "0 0 0 1px #23262d",
      "--shadow-md": "0 8px 24px rgba(0,0,0,0.32), 0 0 0 1px #23262d",
      "--shadow-inset-highlight": "inset 0 1px 0 rgba(255,255,255,0.04)",
    };
  }
  return {
    "--color-bg": "#fafafa",
    "--color-surface": "#ffffff",
    "--color-surface-elevated": "#ffffff",
    "--color-border": "#ececec",
    "--color-border-strong": "#d4d4d4",
    "--color-primary": "#1677ff",
    "--color-primary-hover": "#4096ff",
    "--color-primary-bg": "rgba(22,119,255,0.08)",
    "--color-text": "#16181d",
    "--color-text-secondary": "#6b7280",
    "--color-text-muted": "#9ca3af",
    "--color-hover": "#f4f5f7",
    "--color-selected": "#eef4ff",
    "--color-bg-purple": "#faf5ff",
    "--color-bg-amber": "#fffbeb",
    "--color-bg-green": "#f0fdf4",
    "--color-border-purple": "#e9d5ff",
    "--color-border-amber": "#fde68a",
    "--color-border-green": "#bbf7d0",
    "--color-text-green": "#166534",
    "--color-text-amber": "#92400e",
    "--shadow-sm": "0 0 0 1px #ececec",
    "--shadow-md": "0 8px 24px rgba(0,0,0,0.1), 0 0 0 1px #ececec",
    "--shadow-inset-highlight": "inset 0 1px 0 rgba(255,255,255,0.6)",
  };
}

const CSS_VAR_KEYS = Object.keys(getCssVars(true));
export const ALL_TOKEN_KEYS = CSS_VAR_KEYS;
