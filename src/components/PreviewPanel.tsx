import {
  Typography,
  Spin,
  Button,
  Tooltip,
} from "antd";
import {
  FolderOpenOutlined,
  FileSearchOutlined,
  FileOutlined,
  FileZipOutlined,
} from "@ant-design/icons";
import { useSearchStore } from "../stores/searchStore";
import { invoke } from "@tauri-apps/api/core";
import { useState, useEffect, useRef } from "react";
import { HighlightText } from "../utils/highlight";
import OfficePreview from "./OfficePreview";

const PDF_TYPES = ["pdf"];
const IMAGE_TYPES = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "tiff", "tif"];
const OFFICE_TYPES = ["docx", "xlsx", "pptx", "doc", "xls", "ppt", "csv"];
// 可索引但无法有意义预览的类型（目前无）
const NO_PREVIEW_TYPES: string[] = [];

// ZIP 内容分段渲染：将 "--- filename ---" 标记解析为可视化文件头
function ZipContentView({ text, query }: { text: string; query: string }) {
  // 按 "--- filename ---" 行拆分（兼容有无前导空行）
  const parts = text.split(/(?:^|\n)(--- .+ ---)\n/);
  // parts: [pre, "--- a ---", content_a, "--- b ---", content_b, ...]
  const sections: { filename?: string; content: string }[] = [];
  if (parts[0].trim()) sections.push({ content: parts[0].trim() });
  for (let i = 1; i < parts.length; i += 2) {
    const filename = parts[i].replace(/^--- | ---$/g, "").trim();
    const content = (parts[i + 1] ?? "").trim();
    sections.push({ filename, content });
  }
  return (
    <>
      {sections.map((sec, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          {sec.filename && (
            <div style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "3px 8px", marginBottom: 6,
              background: "var(--color-bg-amber)",
              borderLeft: "3px solid #f59e0b",
              borderRadius: "0 4px 4px 0",
              fontSize: 11, fontWeight: 600, color: "#92400e",
            }}>
              <FileZipOutlined style={{ fontSize: 11 }} />
              {sec.filename}
            </div>
          )}
          {sec.content && (
            <Typography.Paragraph style={{
              whiteSpace: "pre-wrap", fontSize: 13,
              lineHeight: 1.75, margin: 0, color: "var(--color-text)",
            }}>
              <HighlightText text={sec.content} query={query} />
            </Typography.Paragraph>
          )}
        </div>
      ))}
    </>
  );
}

const MIME_MAP: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

export default function PreviewPanel() {
  const { selected, query, mode } = useSearchStore();
  const [textContent, setTextContent] = useState<string>("");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prevBlobUrl = useRef<string | null>(null);
  const isSemantic = mode === "semantic";

  useEffect(() => {
    if (prevBlobUrl.current) {
      URL.revokeObjectURL(prevBlobUrl.current);
      prevBlobUrl.current = null;
    }
    setBlobUrl(null);
    setTextContent("");
    setError(null);

    if (!selected) return;

    const ft = selected.file_type.toLowerCase();

    // 不支持内容预览的类型直接跳过，展示友好提示
    if (NO_PREVIEW_TYPES.includes(ft)) return;

    if (PDF_TYPES.includes(ft) || IMAGE_TYPES.includes(ft)) {
      setLoading(true);
      invoke<string>("read_binary_preview", { path: selected.path })
        .then((base64) => {
          const mime = MIME_MAP[ft] ?? "application/octet-stream";
          const byteChars = atob(base64);
          const byteArr = new Uint8Array(byteChars.length);
          for (let i = 0; i < byteChars.length; i++) {
            byteArr[i] = byteChars.charCodeAt(i);
          }
          const blob = new Blob([byteArr], { type: mime });
          const url = URL.createObjectURL(blob);
          prevBlobUrl.current = url;
          setBlobUrl(url);
        })
        .catch((e: unknown) =>
          setError(e instanceof Error ? e.message : String(e))
        )
        .finally(() => setLoading(false));

    } else if (OFFICE_TYPES.includes(ft)) {
      setLoading(false);

    } else {
      setLoading(true);
      const hint = selected.snippet || null;
      invoke<string>("read_file_preview", { path: selected.path, hint })
        .then((text) => setTextContent(text))
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e));
          setTextContent("");
        })
        .finally(() => setLoading(false));
    }
  }, [selected?.path, selected?.snippet]);

  useEffect(() => {
    return () => {
      if (prevBlobUrl.current) URL.revokeObjectURL(prevBlobUrl.current);
    };
  }, []);

  if (!selected) {
    return (
      <div style={{
        height: "100%", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        padding: "0 24px", gap: 12,
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: 14,
          background: "var(--color-bg)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <FileOutlined style={{ fontSize: 26, color: "#cbd5e1" }} />
        </div>
        <Typography.Text style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
          单击左侧文件预览内容
        </Typography.Text>
      </div>
    );
  }

  const ft = selected.file_type.toLowerCase();
  const isPdf = PDF_TYPES.includes(ft);
  const isImage = IMAGE_TYPES.includes(ft);
  const isOffice = OFFICE_TYPES.includes(ft);
  const isNoPreview = NO_PREVIEW_TYPES.includes(ft);
  const hasSnippet = !!selected.snippet;

  return (
    <div style={{
      padding: "12px 14px",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      gap: 10,
    }}>
      {/* ── 标题栏 ── */}
      <div style={{
        flexShrink: 0,
        paddingBottom: 10,
        borderBottom: "1px solid var(--color-border)",
      }}>
        <div style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 4,
        }}>
          <Typography.Text
            strong
            ellipsis={{ tooltip: selected.name }}
            style={{ flex: 1, fontSize: 13, color: "var(--color-text)", lineHeight: 1.5 }}
          >
            {selected.name}
          </Typography.Text>
          <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            <Tooltip title="用系统应用打开">
              <Button
                size="small" type="text"
                icon={<FolderOpenOutlined style={{ fontSize: 13, color: "#64748b" }} />}
                onClick={() => invoke("open_file", { path: selected.path })}
                style={{ width: 26, height: 26, borderRadius: 6 }}
              />
            </Tooltip>
            <Tooltip title="在访达中显示">
              <Button
                size="small" type="text"
                icon={<FileSearchOutlined style={{ fontSize: 13, color: "#64748b" }} />}
                onClick={() => invoke("reveal_in_finder", { path: selected.path })}
                style={{ width: 26, height: 26, borderRadius: 6 }}
              />
            </Tooltip>
          </div>
        </div>
        <Typography.Text
          type="secondary"
          style={{ fontSize: 11, display: "block", wordBreak: "break-all", lineHeight: 1.4 }}
        >
          {selected.path}
        </Typography.Text>
      </div>

      {/* ── 匹配片段 ── */}
      {hasSnippet && (
        <div style={{
          flexShrink: 0,
          background: isSemantic ? "var(--color-bg-purple)" : "var(--color-bg-amber)",
          border: `1px solid ${isSemantic ? "var(--color-border-purple)" : "var(--color-border-amber)"}`,
          borderLeft: `3px solid ${isSemantic ? "#a78bfa" : "#fbbf24"}`,
          borderRadius: "0 6px 6px 0",
          padding: "8px 12px",
        }}>
          <span style={{
            display: "inline-block",
            fontSize: 10, fontWeight: 600,
            color: isSemantic ? "#7c3aed" : "var(--color-text-amber)",
            background: isSemantic ? "rgba(124,58,237,0.15)" : "var(--color-bg-amber)",
            padding: "1px 6px", borderRadius: 8,
            marginBottom: 6,
            letterSpacing: 0.2,
          }}>
            {isSemantic ? "语义匹配" : "关键词匹配"}
          </span>
          <Typography.Text style={{ fontSize: 12, lineHeight: 1.7, display: "block", color: "var(--color-text)" }}>
            {isSemantic
              ? selected.snippet
              : <HighlightText text={selected.snippet} query={query} />}
          </Typography.Text>
        </div>
      )}

      {/* ── 内容预览区 ── */}
      <div style={{
        flex: 1,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        background: "var(--color-bg)",
      }}>
        {isNoPreview ? (
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", flex: 1 }}>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              此文件类型不支持内容预览
            </Typography.Text>
          </div>

        ) : isOffice ? (
          <OfficePreview path={selected.path} fileType={ft} />

        ) : loading ? (
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", flex: 1 }}>
            <Spin size="small" />
          </div>

        ) : error ? (
          <div style={{ padding: "16px 14px" }}>
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {error}
            </Typography.Text>
          </div>

        ) : isPdf && blobUrl ? (
          <iframe
            src={blobUrl}
            style={{ flex: 1, width: "100%", height: "100%", border: "none", borderRadius: 8 }}
            title={selected.name}
          />

        ) : isImage && blobUrl ? (
          <div style={{ flex: 1, overflow: "auto", textAlign: "center", padding: 12 }}>
            <img
              src={blobUrl}
              alt={selected.name}
              style={{ maxWidth: "100%", borderRadius: 6, boxShadow: "0 2px 8px rgba(0,0,0,0.08)" }}
            />
          </div>

        ) : (
          <div style={{ flex: 1, overflow: "auto", padding: "10px 14px" }}>
            {ft === "zip"
              ? <ZipContentView text={textContent} query={query} />
              : (
                <Typography.Paragraph
                  style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.75, margin: 0, color: "var(--color-text)" }}
                >
                  <HighlightText text={textContent} query={query} />
                </Typography.Paragraph>
              )
            }
          </div>
        )}
      </div>
    </div>
  );
}
