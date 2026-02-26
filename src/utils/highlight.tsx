import type { ReactNode } from "react";

/**
 * 在文本中高亮所有匹配的查询词，返回 React 节点。
 *
 * 分词规则：
 *   - 按空格拆分 → 每个 token 独立高亮（OR 逻辑）
 *   - 无空格的整体短语 → 先尝试精确匹配；若找不到则对纯中文部分
 *     提取长度 ≥ 2 的子串降级高亮（保证中文查询总能有高亮）
 *
 * 示例：
 *   "违约金 大于 20%"     → 分别高亮 "违约金"、"大于"、"20%"
 *   "违约金大于20%"       → 先高亮完整短语；不存在时高亮 "违约金"、"大于" 等子串
 */
export function HighlightText({
  text,
  query,
}: {
  text: string;
  query: string;
}): ReactNode {
  if (!text || !query.trim()) return text;

  const rawTerms = query.trim().split(/\s+/).filter(Boolean);
  if (!rawTerms.length) return text;

  // 展开 terms：对无法在文本中精确找到的单词，尝试提取中文子串作为降级高亮词
  const terms: string[] = [];
  for (const raw of rawTerms) {
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactFound = new RegExp(escaped, "i").test(text);
    if (exactFound) {
      terms.push(escaped);
    } else {
      // 降级：提取连续中文字符序列（≥2字）作为高亮候选
      const cjkRuns = raw.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g) ?? [];
      if (cjkRuns.length > 0) {
        cjkRuns.forEach((r) =>
          terms.push(r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        );
      } else {
        // 非中文（如 "20%"）退回精确词
        terms.push(escaped);
      }
    }
  }

  if (!terms.length) return text;

  // 长词优先，防止短词切断长词匹配
  terms.sort((a, b) => b.length - a.length);

  const regex = new RegExp(`(${terms.join("|")})`, "gi");
  const parts = text.split(regex);

  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark
        key={i}
        style={{ background: "#ffe58f", padding: "0 1px", borderRadius: 2 }}
      >
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}
