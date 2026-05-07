# DocMind UI Redesign — Raycast-Inspired Visual Language

**Date:** 2026-05-07
**Scope:** All pages (main view + Onboarding + ModelManager + Drawers)
**Theme strategy:** Dual theme equally polished, follow system

## Goal

将 DocMind 的整体 UI 从"通用 Ant Design 默认风"提升为参考 Raycast 的"安静、密集、工具型"视觉语言。保留蓝色 accent、保留双主题、不动业务逻辑。

## Non-Goals

- 不引入新的 UI 框架(tailwind / styled-components 等)
- 不动 state / Tauri commands / indexing 流水线
- 不重写 Ant Design,只通过 ConfigProvider token 接管
- 不做主题切换器 UI
- 不引入动画库

## Design Tokens

### 配色

**深色模式(主调更深、更冷,弱化 surface 阴影,增强细线层次)**

| Token | Value |
|---|---|
| `--color-bg` | `#0c0d10` |
| `--color-surface` | `#16181d` |
| `--color-surface-elevated` | `#1c1f26` |
| `--color-border` | `#23262d` |
| `--color-border-strong` | `#33373f` |
| `--color-primary` | `#3b82f6` |
| `--color-primary-hover` | `#60a5fa` |
| `--color-primary-bg` | `rgba(59,130,246,.16)` |
| `--color-text` | `#e6e8eb` |
| `--color-text-secondary` | `#8b8f99` |
| `--color-text-muted` | `#5b5f68` |
| `--color-hover` | `#1e2127` |
| `--color-selected` | `#1c1f26` |

**亮色模式(同语言、降饱和)**

| Token | Value |
|---|---|
| `--color-bg` | `#fafafa` |
| `--color-surface` | `#ffffff` |
| `--color-surface-elevated` | `#ffffff` |
| `--color-border` | `#ececec` |
| `--color-border-strong` | `#d4d4d4` |
| `--color-primary` | `#1677ff` |
| `--color-primary-hover` | `#4096ff` |
| `--color-primary-bg` | `rgba(22,119,255,.08)` |
| `--color-text` | `#16181d` |
| `--color-text-secondary` | `#6b7280` |
| `--color-text-muted` | `#9ca3af` |
| `--color-hover` | `#f4f5f7` |
| `--color-selected` | `#eef4ff` |

### 字体

- UI 字体栈保持现状(系统字体 + PingFang)
- 新增 mono 栈:`--font-mono: "SF Mono", "JetBrains Mono", "Cascadia Code", Consolas, monospace`
- 字号阶:11 / 12 / 13 / 14 / 16 / 20(去掉 15、超大字号)
- 正文行高 1.45,列表项 1.4

### 圆角 / 阴影 / 间距

- 圆角阶:`--radius-sm 6px / --radius-md 8px / --radius-lg 12px`
- 阴影:不用 drop shadow,改细线 + inset 高光
  - `--shadow-sm: 0 0 0 1px var(--color-border)`
  - `--shadow-md: 0 8px 24px rgba(0,0,0,.32), 0 0 0 1px var(--color-border)`(浮层)
  - `--shadow-inset-highlight: inset 0 1px 0 rgba(255,255,255,.04)`(深色面板顶部高光)
- 间距阶:4 / 6 / 8 / 12 / 16 / 24

### 全局视觉特征

1. `.kbd` 键盘徽标:深色 `#2a2d34` / 亮色 `#f4f5f7` 背景 + 1px 边 + mono + 11px
2. 聚焦环:`box-shadow: 0 0 0 2px var(--color-primary-bg)`,不用 outline
3. 滚动条:4px、默认透明、hover 才显
4. 过渡:统一 `120ms cubic-bezier(.2,.8,.2,1)`
5. 磨砂玻璃:仅用于 SearchBar + Drawer 头部,`backdrop-filter: blur(20px) saturate(1.5)`
6. Ant Design ConfigProvider 主题:把 token 灌给 antd

## 文件结构

### 新增

- `src/styles/tokens.css` — CSS 变量(双主题)
- `src/styles/typography.css` — 字体、字号阶、mono 工具类
- `src/styles/components.css` — `.kbd` `.chip` `.section-label` 等可复用类
- `src/theme/antdTheme.ts` — antd ConfigProvider 主题对象,从 token 读

### 改动(按改动量从大到小)

| 文件 | 行数 | 主要改动 |
|---|---:|---|
| `src/components/SettingsDrawer.tsx` | 957 | 分组小标题、统一控件样式、文件夹列表风格 |
| `src/components/QAPanel.tsx` | 776 | 用户/AI 气泡重做、引用源 chip、输入区毛玻璃 |
| `src/components/ResultList.tsx` | 644 | 高密度行 + 选中态左条 + 文件类型细线 chip + 关键词高亮 |
| `src/App.tsx` | 508 | ConfigProvider 接入、布局微调 |
| `src/components/HelpDrawer.tsx` | 329 | 段落排版、章节小标题 |
| `src/components/PreviewPanel.tsx` | 324 | 头部条、阅读区净化 |
| `src/components/OfficePreview.tsx` | 309 | token 替换 |
| `src/pages/ModelManager.tsx` | 308 | 卡片样式优化(结构保留) |
| `src/pages/Onboarding.tsx` | 305 | 步骤布局重排 + 键盘提示 |
| `src/components/SearchBar.tsx` | 194 | 命令面板化 + 模式 chip + 键盘徽标 |
| `src/App.css` | 234 | 收敛为入口,import 新文件 |
| `src/main.tsx` | - | 接入 ConfigProvider |

预估总 diff:约 +900 / -600 行,净增 300。

## 各组件改造点

### SearchBar
- 结构:`[模式 Segmented] [输入框 圆角 8] [⌘K 徽标]`
- 输入无外框、贴合面板;聚焦时 2px 蓝光晕
- 模式切换从 antd Segmented → 自绘 pill chip(`⌘1/⌘2/⌘3`)

### ResultList
- 行高 ~52px:`[icon 16] [name 13 / path 11 mono] ... [type chip] [mtime 11 mono]`
- 选中态:左 2px 蓝条 + 行底色 elevated,**整行不变蓝**
- Hover:仅底色,无阴影
- 文件类型用细线 chip(透明背景 + 1px 边 + 11 mono)
- 关键词高亮:`--color-primary-bg` 底 + `--color-primary` 字
- 空态:icon + 说明 + mono 提示

### PreviewPanel
- 头部条:文件名 + 路径(mono) + ghost 操作按钮组
- 去阴影,只用 surface + 顶 1px 边
- 内容区字号 13、行高 1.6、内边距 24

### QAPanel
- 用户气泡:无背景、左 2px 蓝条、文字直铺
- AI 气泡:elevated 面板 + 1px 边 + 圆角 8
- 引用源:行内 chip 可点
- 输入区粘底,毛玻璃

### SettingsDrawer / HelpDrawer
- antd Drawer 主题接管;头部毛玻璃,内容 bg 比 surface 暗一档
- 设置项分组:11px mono 全大写小标题(`INDEXING` / `APPEARANCE`)
- 文件夹列表风格同 ResultList(icon + path mono + 删除)

### Onboarding
- 居中卡片 → 左对齐多步骤布局,`01 / 02 / 03` mono 大字 + 标题 + 操作
- 顶部 logo + 应用名,底部 `←/→ ⏎ skip` 键盘提示
- 深色背景加单点径向高光,亮色纯白

### ModelManager
- 现状已是卡片(InfoRow),只换样式
- 当前选中模型左 2px 蓝条 + `Active` 细线 chip
- 下载进度用 2px 细条替代 antd Progress 圈

### App.tsx 主布局
- Splitter 分隔条:1px `--color-border` + hover 时 2px primary
- 全局右下角迷你状态条:`[索引中... 1234/5678]` mono(可选)

## 提交策略

按"先底层、后表层"分 5 个 commit,每步可独立编译运行:

1. `feat(theme): introduce design tokens & antd theme integration`
2. `refactor(search): SearchBar + ResultList Raycast-style redesign`
3. `refactor(preview): PreviewPanel + QAPanel quiet reading & chat`
4. `refactor(drawers): Settings/Help drawer redesign with section labels`
5. `refactor(pages): Onboarding & ModelManager redesign`

每步完成 → 启动应用 → 看 → commit。

## 验收点

1. **Token 接入后**:深/亮切换不掉色,antd 组件圆角/字号统一
2. **SearchBar/ResultList**:聚焦光晕、模式 chip、选中态、空态、键盘徽标
3. **Preview/QA**:长文滚动顺畅、流式输出动画、引用 chip 可点
4. **Drawer**:分组小标题、Switch/Select 一致、文件夹列表统一
5. **Onboarding/ModelManager**:首次引导、模型切换/下载进度

## 风险

- antd ConfigProvider 主题 token 名映射有边界(Drawer 头部背景需单独处理),可能需少量 CSS override
- QAPanel 776 行较复杂,流式 + Markdown 既要保功能又要换样式
- pdfium 预览容器 Tauri 拉起,样式不归我们,只能改外层
