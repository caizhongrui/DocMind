import "./App.css";
import "./i18n/index";
import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import { getAntdTheme, getCssVars, ALL_TOKEN_KEYS } from "./theme/antdTheme";

export const THEME_KEY = "docmind_theme";
export type ThemeMode = "system" | "light" | "dark";

function Root() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    () => (localStorage.getItem(THEME_KEY) as ThemeMode) || "system"
  );
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const mode = (e as CustomEvent<ThemeMode>).detail;
      setThemeMode(mode);
    };
    window.addEventListener("docmind-theme", handler as EventListener);
    return () =>
      window.removeEventListener("docmind-theme", handler as EventListener);
  }, []);

  const isDark =
    themeMode === "dark" ? true : themeMode === "light" ? false : systemDark;

  // Sync theme to <html>: data-theme attribute + inline-style CSS variables.
  // The inline-style injection is the runtime source of truth — Tauri WebKit
  // can be flaky with attribute-selector based stylesheets.
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("data-theme", isDark ? "dark" : "light");
    el.style.colorScheme = isDark ? "dark" : "light";

    // Clear all known token keys, then set the ones for the current theme.
    ALL_TOKEN_KEYS.forEach((k) => el.style.removeProperty(k));
    Object.entries(getCssVars(isDark)).forEach(([k, v]) =>
      el.style.setProperty(k, v)
    );
  }, [isDark]);

  return (
    <ConfigProvider locale={zhCN} theme={getAntdTheme(isDark)}>
      <App />
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
