/**
 * Tiny HTML helpers for the server-rendered admin UI.
 *
 * Intentionally simple: no template engine, no SPA. Each admin page builds
 * a `body` string and passes it to [`layout`], which wraps it with the nav
 * and shared CSS.
 */

const BASE_CSS = `
:root {
  --bg: #0c0d10;
  --surface: #16181d;
  --surface-elevated: #1c1f26;
  --border: #23262d;
  --text: #e6e8eb;
  --text-secondary: #8b8f99;
  --text-muted: #5b5f68;
  --primary: #3b82f6;
  --primary-bg: rgba(59,130,246,.16);
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  --font-mono: "SF Mono", "JetBrains Mono", Consolas, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--font-ui); background: var(--bg); color: var(--text); font-size: 13px; line-height: 1.5; }
.nav { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 24px; display: flex; align-items: center; gap: 18px; }
.nav-brand { font-weight: 600; letter-spacing: -0.3px; font-size: 14px; margin-right: 8px; }
.nav a { color: var(--text-secondary); text-decoration: none; font-size: 12px; }
.nav a:hover { color: var(--text); }
.nav .spacer { flex: 1; }
.main { max-width: 1100px; margin: 0 auto; padding: 24px; }
h1 { font-size: 18px; font-weight: 600; margin: 0 0 16px; }
h2 { font-size: 12px; font-weight: 600; margin: 24px 0 8px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--font-mono); }
table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 12px; }
th { background: var(--surface-elevated); color: var(--text-secondary); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
tr:last-child td { border-bottom: none; }
.mono { font-family: var(--font-mono); }
.chip { display: inline-flex; align-items: center; padding: 1px 6px; font-family: var(--font-mono); font-size: 11px; border: 1px solid var(--border); border-radius: 4px; color: var(--text-secondary); }
.chip-primary { color: var(--primary); border-color: var(--primary); background: var(--primary-bg); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
.stat-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--font-mono); margin-bottom: 6px; }
.stat-value { font-size: 22px; font-weight: 600; font-family: var(--font-mono); }
input, textarea, select { background: var(--surface-elevated); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; color: var(--text); font-family: inherit; }
input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary-bg); }
button, .btn { display: inline-flex; align-items: center; gap: 4px; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-elevated); color: var(--text); font-size: 12px; cursor: pointer; text-decoration: none; font-family: inherit; }
button.primary, .btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
button:hover { border-color: var(--primary); }
.alert { padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 12px; }
.alert-error { background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.3); color: #ef4444; }
.alert-success { background: rgba(34,197,94,0.08); border: 1px solid rgba(34,197,94,0.3); color: #22c55e; }
a { color: var(--primary); }
form { display: inline; }
.row { display: flex; gap: 8px; align-items: center; }
.row > * { flex: 0 0 auto; }
`;

const STANDALONE_CSS = `
body.standalone-bg { background: linear-gradient(180deg, var(--bg) 0%, var(--surface) 100%); display: flex; align-items: center; justify-content: center; min-height: 100vh; }
.login-box { width: 360px; padding: 32px 28px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
.login-box h1 { text-align: center; margin-bottom: 24px; font-size: 16px; }
.login-box label { display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--font-mono); margin: 12px 0 6px; }
.login-box input { width: 100%; height: 36px; }
`;

export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render a page with the admin nav. */
export function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${htmlEscape(title)} · DocMind Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>${BASE_CSS}</style>
</head>
<body>
  <nav class="nav">
    <span class="nav-brand">DocMind Admin</span>
    <a href="/admin">概览</a>
    <a href="/admin/licenses">License</a>
    <a href="/admin/orders">订单</a>
    <a href="/admin/downloads">下载日志</a>
    <a href="/admin/releases">版本</a>
    <span class="spacer"></span>
    <form method="POST" action="/admin/logout" style="margin: 0;">
      <button type="submit">登出</button>
    </form>
  </nav>
  <main class="main">${body}</main>
</body>
</html>`;
}

/** Render a standalone page without the admin nav (login, public activate). */
export function standalone(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${htmlEscape(title)} · DocMind</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>${BASE_CSS}${STANDALONE_CSS}</style>
</head>
<body class="standalone-bg">
  ${body}
</body>
</html>`;
}
