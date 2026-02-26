import "./i18n/index";
import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";

export const THEME_KEY = "docmind_theme";
export type ThemeMode = "system" | "light" | "dark";

function Root() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    () => (localStorage.getItem(THEME_KEY) as ThemeMode) || "system"
  );
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  // 监听系统深色模式变化
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // 监听来自 SettingsDrawer 的主题切换事件
  useEffect(() => {
    const handler = (e: Event) => {
      const mode = (e as CustomEvent<ThemeMode>).detail;
      setThemeMode(mode);
    };
    window.addEventListener("docmind-theme", handler as EventListener);
    return () => window.removeEventListener("docmind-theme", handler as EventListener);
  }, []);

  const isDark =
    themeMode === "dark" ? true : themeMode === "light" ? false : systemDark;

  // 同步主题到 html 元素：同时写 data-theme 属性 + 直接注入 CSS 变量到 inline style
  // 后者优先级最高，可绕过 Tauri WebKit 中 CSS 属性选择器失效的问题
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("data-theme", isDark ? "dark" : "light");
    el.style.colorScheme = isDark ? "dark" : "light";

    if (isDark) {
      const vars: Record<string, string> = {
        "--color-bg": "#0f1117",
        "--color-surface": "#1a1d23",
        "--color-border": "#2d3340",
        "--color-border-light": "#242832",
        "--color-primary": "#3b82f6",
        "--color-primary-hover": "#60a5fa",
        "--color-primary-bg": "#1e2d45",
        "--color-text": "#e2e8f0",
        "--color-text-secondary": "#94a3b8",
        "--color-text-muted": "#475569",
        "--color-hover": "#1e2330",
        "--color-selected": "#1e2d45",
        "--color-bg-purple": "rgba(124,58,237,0.1)",
        "--color-bg-amber": "rgba(245,158,11,0.08)",
        "--color-bg-green": "rgba(34,197,94,0.08)",
        "--color-border-purple": "rgba(124,58,237,0.25)",
        "--color-border-amber": "rgba(245,158,11,0.2)",
        "--color-border-green": "rgba(34,197,94,0.2)",
        "--color-text-green": "#4ade80",
        "--color-text-amber": "#fbbf24",
      };
      Object.entries(vars).forEach(([k, v]) => el.style.setProperty(k, v));
    } else {
      [
        "--color-bg", "--color-surface", "--color-border", "--color-border-light",
        "--color-primary", "--color-primary-hover", "--color-primary-bg",
        "--color-text", "--color-text-secondary", "--color-text-muted",
        "--color-hover", "--color-selected",
        "--color-bg-purple", "--color-bg-amber", "--color-bg-green",
        "--color-border-purple", "--color-border-amber", "--color-border-green",
        "--color-text-green", "--color-text-amber",
      ].forEach(k => el.style.removeProperty(k));
    }
  }, [isDark]);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: "#1677ff",
          borderRadius: 8,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
          // 加速所有 Ant Design 动画（Drawer/Modal/Dropdown 等）
          motionDurationFast: "0.08s",
          motionDurationMid:  "0.12s",
          motionDurationSlow: "0.18s",
        },
      }}
    >
      <App />
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
