# Guided Tour Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a step-by-step spotlight tour (using Ant Design 5's built-in `Tour` component) that guides first-time users through DocMind's core features, auto-triggering on first launch and re-triggerable from the Help drawer.

**Architecture:** Use `antd` `Tour` component with `target: () => document.getElementById(id)` to avoid prop drilling. Store `"docmind_tour_done"` in `localStorage` to control auto-trigger. Add `onStartTour` callback prop to `HelpDrawer` so users can replay the tour at any time.

**Tech Stack:** Ant Design 5 `Tour` + `TourProps`, React `useState`/`useEffect`, `localStorage`.

---

### Task 1: Add tour target IDs to SearchBar

**Files:**
- Modify: `src/components/SearchBar.tsx`

**Context:** The tour needs to highlight the search input and mode switcher. The cleanest approach is adding `id` attributes directly on the DOM elements — no prop changes needed elsewhere.

**Step 1: Add id to the Input element**

In `src/components/SearchBar.tsx`, find the `<Input` block (around line 97) and add `id="tour-search-input"`:

```tsx
<Input
  id="tour-search-input"
  ref={inputRef}
  value={query}
  onChange={(e) => setQuery(e.target.value)}
  // ... rest unchanged
/>
```

**Step 2: Add id to the Segmented element**

Find the `<Segmented` block (around line 155) and add `id="tour-search-mode"`:

```tsx
<Segmented
  id="tour-search-mode"
  value={mode}
  onChange={(val) => {
  // ... rest unchanged
/>
```

**Step 3: Verify TypeScript compiles**

Run from project root:
```bash
npx tsc --noEmit
```
Expected: no output (zero errors).

---

### Task 2: Add Tour state and component to App.tsx

**Files:**
- Modify: `src/App.tsx`

**Context:** App.tsx is the root component. It owns all drawer open/close state already. We add `tourOpen` here and place the `<Tour>` at the bottom of the JSX tree (alongside the other Drawers).

**Step 1: Add Tour and TourProps to the antd import**

Find the existing antd import at line 1:
```tsx
import { Layout, Button, Spin, Drawer, Tooltip, Typography, Progress, notification } from "antd";
```

Replace with:
```tsx
import { Layout, Button, Spin, Drawer, Tooltip, Typography, Progress, notification, Tour } from "antd";
import type { TourProps } from "antd";
```

**Step 2: Add tourOpen state**

After the existing `const [helpOpen, setHelpOpen] = useState(false);` line, add:

```tsx
const [tourOpen, setTourOpen] = useState(false);
```

**Step 3: Add auto-trigger useEffect**

After the existing `useEffect` that checks for updates (the one with `check_update`, around line 178), add:

```tsx
// ── 首次使用自动触发引导 ──
useEffect(() => {
  if (!loading && modelAvailable) {
    if (!localStorage.getItem("docmind_tour_done")) {
      const t = setTimeout(() => setTourOpen(true), 600);
      return () => clearTimeout(t);
    }
  }
}, [loading, modelAvailable]);
```

**Step 4: Add id attributes to the four toolbar buttons**

In the toolbar section (around line 297–332), add `id` props to the four buttons:

- AI model button → `id="tour-ai-btn"`:
```tsx
<Button
  id="tour-ai-btn"
  type="text" size="small"
  icon={<RobotOutlined style={{ fontSize: 16, color: aiIconColor }} />}
  onClick={() => setModelOpen(true)}
  style={{ width: 32, height: 32, borderRadius: 8 }}
/>
```

- QA button → `id="tour-qa-btn"`:
```tsx
<Button
  id="tour-qa-btn"
  type="text" size="small"
  icon={<MessageOutlined style={{ fontSize: 16, color: "#64748b" }} />}
  onClick={() => setQaOpen(true)}
  style={{ width: 32, height: 32, borderRadius: 8 }}
/>
```

- Settings button → `id="tour-settings-btn"`:
```tsx
<Button
  id="tour-settings-btn"
  type="text" size="small"
  icon={<SettingOutlined style={{ fontSize: 16, color: "#64748b" }} />}
  onClick={() => setSettingsOpen(true)}
  style={{ width: 32, height: 32, borderRadius: 8 }}
/>
```

- Help button → `id="tour-help-btn"`:
```tsx
<Button
  id="tour-help-btn"
  type="text" size="small"
  icon={<QuestionCircleOutlined style={{ fontSize: 16, color: "#64748b" }} />}
  onClick={() => setHelpOpen(true)}
  style={{ width: 32, height: 32, borderRadius: 8 }}
/>
```

**Step 5: Define tourSteps and close handler**

Add the following just before the `return (` statement in App():

```tsx
const handleTourClose = () => {
  setTourOpen(false);
  localStorage.setItem("docmind_tour_done", "1");
};

const tourSteps: TourProps["steps"] = [
  {
    title: "第一步：添加文件夹",
    description:
      "点击设置按钮，将本地文件夹添加到监听列表。DocMind 会自动建立全文索引，之后可随时搜索文件内容。",
    target: () => document.getElementById("tour-settings-btn")!,
    placement: "bottomRight",
  },
  {
    title: "第二步：搜索文档",
    description:
      "在搜索框中输入关键词即可全文搜索。支持 AND / OR / NOT 逻辑运算符，以及双引号精确短语搜索。",
    target: () => document.getElementById("tour-search-input")!,
    placement: "bottom",
  },
  {
    title: "第三步：切换搜索模式",
    description:
      "全文：精确匹配内容关键词；文件名：按文件名查找；语义：AI 理解自然语言，无需精确关键词。",
    target: () => document.getElementById("tour-search-mode")!,
    placement: "bottom",
  },
  {
    title: "第四步：AI 语义搜索",
    description:
      "点击机器人按钮下载本地 AI 模型，开启语义搜索功能。模型完全本地运行，不联网推理。",
    target: () => document.getElementById("tour-ai-btn")!,
    placement: "bottomRight",
  },
  {
    title: "第五步：文档问答",
    description:
      "点击消息按钮打开文档问答面板，向 AI 提问，它会自动从你的文档中检索相关内容并生成回答。",
    target: () => document.getElementById("tour-qa-btn")!,
    placement: "bottomRight",
  },
  {
    title: "使用帮助",
    description:
      "随时点击帮助按钮查阅支持的文件格式、键盘快捷键以及联系方式。也可在此重新查看本引导。",
    target: () => document.getElementById("tour-help-btn")!,
    placement: "bottomRight",
  },
];
```

**Step 6: Render the Tour component**

After the `<HelpDrawer ... />` line (around line 388), add:

```tsx
<Tour
  open={tourOpen}
  onClose={handleTourClose}
  steps={tourSteps}
/>
```

**Step 7: Update HelpDrawer usage to pass onStartTour**

Change the `<HelpDrawer>` line from:
```tsx
<HelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
```
To:
```tsx
<HelpDrawer
  open={helpOpen}
  onClose={() => setHelpOpen(false)}
  onStartTour={() => {
    setHelpOpen(false);
    localStorage.removeItem("docmind_tour_done");
    setTimeout(() => setTourOpen(true), 300);
  }}
/>
```

**Step 8: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no output.

---

### Task 3: Add "重新查看引导" button to HelpDrawer

**Files:**
- Modify: `src/components/HelpDrawer.tsx`

**Context:** HelpDrawer currently has a Props interface with `open` and `onClose`. We add `onStartTour` as an optional callback so App.tsx can pass it without breaking anything.

**Step 1: Update Props interface**

Find:
```tsx
interface Props {
  open: boolean;
  onClose: () => void;
}
```

Replace with:
```tsx
interface Props {
  open: boolean;
  onClose: () => void;
  onStartTour?: () => void;
}
```

**Step 2: Destructure onStartTour in the component signature**

Find:
```tsx
export default function HelpDrawer({ open, onClose }: Props) {
```

Replace with:
```tsx
export default function HelpDrawer({ open, onClose, onStartTour }: Props) {
```

**Step 3: Add CompassOutlined to icon imports**

Find the existing icon imports block:
```tsx
import {
  FileSearchOutlined,
  QuestionCircleOutlined,
  KeyOutlined,
  FileTextOutlined,
  RobotOutlined,
  MessageOutlined,
  MailOutlined,
  CopyOutlined,
} from "@ant-design/icons";
```

Replace with:
```tsx
import {
  FileSearchOutlined,
  QuestionCircleOutlined,
  KeyOutlined,
  FileTextOutlined,
  RobotOutlined,
  MessageOutlined,
  MailOutlined,
  CopyOutlined,
  CompassOutlined,
} from "@ant-design/icons";
```

**Step 4: Add the tour button above the version info line**

Find the version info section at the bottom of the Drawer JSX:
```tsx
      {/* ── 版本信息 ── */}
      <div style={{ textAlign: "center", marginTop: 4, marginBottom: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          DocMind · 本地文档全文搜索 · AI 语义检索 · 文档问答
        </Typography.Text>
      </div>
```

Replace with:
```tsx
      {/* ── 重新查看引导 ── */}
      {onStartTour && (
        <div style={{ textAlign: "center", marginBottom: 12 }}>
          <Button
            type="default"
            size="small"
            icon={<CompassOutlined />}
            onClick={onStartTour}
            style={{ borderRadius: 8, fontSize: 12, color: "#1677ff", borderColor: "rgba(22,119,255,0.3)" }}
          >
            重新查看使用引导
          </Button>
        </div>
      )}

      {/* ── 版本信息 ── */}
      <div style={{ textAlign: "center", marginTop: 4, marginBottom: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          DocMind · 本地文档全文搜索 · AI 语义检索 · 文档问答
        </Typography.Text>
      </div>
```

**Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no output.

---

## Verification

After all three tasks are complete:

1. Run `npm run tauri dev`
2. Clear localStorage in DevTools: `localStorage.removeItem("docmind_tour_done")`
3. Reload — tour should auto-appear after ~600ms
4. Click through all 6 steps, verify each tooltip points to the correct element
5. Click "完成" on step 6 — tour closes and `docmind_tour_done` is set in localStorage
6. Reload again — tour should NOT appear
7. Open Help drawer → click "重新查看使用引导" → tour reopens

## Execution Order

Tasks must run in order: **1 → 2 → 3** (Task 2 depends on the IDs added in Task 1; Task 3 is independent but App.tsx in Task 2 passes `onStartTour` which Task 3 must accept).
