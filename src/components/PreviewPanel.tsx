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
const NO_PREVIEW_TYPES: string[] = [];

/**
 * Strip Word field codes that leak into legacy .doc / .ppt extracted
 * text (TOC, HYPERLINK \l _TocXXX, PAGEREF, ...). These come from the
 * Rust byte-scanner indexer and would otherwise render in the snippet
 * preview.
 */
function cleanFieldCodes(s: string): string {
  return s
    .replace(/TOC\s*\\o\s*"[^"]*"(?:\s*\\[a-z])*\s*/gi, "")
    .replace(/HYPERLINK\s*\\l\s*_Toc\d+\s*/gi, "")
    .replace(/PAGEREF\s*_Toc\d+\s*/gi, "")
    .replace(/\s*\\[a-z](?=\s|$)/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function ZipContentView({ text, query }: { text: string; query: string }) {
  const parts = text.split(/(?:^|\n)(--- .+ ---)\n/);
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
        <div key={i} style={{ marginBottom: 16 }}>
          {sec.filename && (
            <div
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 8px",
                marginBottom: 8,
                background: "var(--color-hover)",
                border: "1px solid var(--color-border)",
                borderRadius: 4,
                fontSize: 11,
                color: "var(--color-text-secondary)",
              }}
            >
              <FileZipOutlined style={{ fontSize: 11 }} />
              {sec.filename}
            </div>
          )}
          {sec.content && (
            <Typography.Paragraph
              style={{
                whiteSpace: "pre-wrap",
                fontSize: 13,
                lineHeight: 1.7,
                margin: 0,
                color: "var(--color-text)",
              }}
            >
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
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
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
    const isMac = navigator.platform.toLowerCase().includes("mac");
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 24px",
          gap: 14,
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: "var(--color-hover)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <FileOutlined style={{ fontSize: 22, color: "var(--color-text-muted)" }} />
        </div>
        <div style={{ textAlign: "center" }}>
          <Typography.Text style={{ display: "block", fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 6 }}>
            选择文件以预览
          </Typography.Text>
          <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span className="kbd">↑</span>
            <span className="kbd">↓</span>
            <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>导航</span>
            <span style={{ fontSize: 11, color: "var(--color-text-muted)", marginLeft: 8 }}>·</span>
            <span className="kbd">{isMac ? "↵" : "Enter"}</span>
            <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>打开</span>
          </div>
        </div>
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
    <div
      style={{
        padding: "12px 16px",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        gap: 12,
      }}
    >
      {/* Header */}
      <div
        style={{
          flexShrink: 0,
          paddingBottom: 10,
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 8,
            marginBottom: 4,
          }}
        >
          <Typography.Text
            strong
            ellipsis={{ tooltip: selected.name }}
            style={{ flex: 1, fontSize: 14, color: "var(--color-text)", lineHeight: 1.5 }}
          >
            {selected.name}
          </Typography.Text>
          <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            <Tooltip title="用系统应用打开">
              <Button
                size="small"
                type="text"
                icon={<FolderOpenOutlined style={{ fontSize: 13, color: "var(--color-text-secondary)" }} />}
                onClick={() => invoke("open_file", { path: selected.path })}
                style={{ width: 26, height: 26, borderRadius: 6 }}
              />
            </Tooltip>
            <Tooltip title="在访达中显示">
              <Button
                size="small"
                type="text"
                icon={<FileSearchOutlined style={{ fontSize: 13, color: "var(--color-text-secondary)" }} />}
                onClick={() => invoke("reveal_in_finder", { path: selected.path })}
                style={{ width: 26, height: 26, borderRadius: 6 }}
              />
            </Tooltip>
          </div>
        </div>
        <Typography.Text
          className="mono"
          type="secondary"
          style={{ fontSize: 11, display: "block", wordBreak: "break-all", lineHeight: 1.5, color: "var(--color-text-muted)" }}
        >
          {selected.path}
        </Typography.Text>
      </div>

      {/* Match snippet */}
      {hasSnippet && (
        <div
          style={{
            flexShrink: 0,
            background: "var(--color-surface-elevated)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            padding: "10px 12px",
          }}
        >
          <div className="section-label" style={{ marginBottom: 6 }}>
            {isSemantic ? "Semantic Match" : "Keyword Match"}
          </div>
          <Typography.Text
            style={{ fontSize: 12, lineHeight: 1.7, display: "block", color: "var(--color-text)" }}
          >
            {isSemantic
              ? cleanFieldCodes(selected.snippet)
              : <HighlightText text={cleanFieldCodes(selected.snippet)} query={query} />}
          </Typography.Text>
        </div>
      )}

      {/* Content preview */}
      <div
        style={{
          flex: 1,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--color-border)",
          borderRadius: 8,
          background: "var(--color-surface)",
        }}
      >
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
          <div style={{ flex: 1, overflow: "auto", textAlign: "center", padding: 16 }}>
            <img
              src={blobUrl}
              alt={selected.name}
              style={{ maxWidth: "100%", borderRadius: 6, border: "1px solid var(--color-border)" }}
            />
          </div>
        ) : (
          <div style={{ flex: 1, overflow: "auto", padding: "12px 16px" }}>
            {ft === "zip" ? (
              <ZipContentView text={textContent} query={query} />
            ) : (
              <Typography.Paragraph
                style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.7, margin: 0, color: "var(--color-text)" }}
              >
                <HighlightText text={textContent} query={query} />
              </Typography.Paragraph>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
