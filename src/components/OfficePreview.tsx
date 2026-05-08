import { useState, useEffect, useRef } from "react";
import { Spin, Alert, Empty } from "antd";
import { invoke } from "@tauri-apps/api/core";

interface PptxSlide {
  index: number;
  title: string;
  bullets: string[];
}

interface XlsxSheet {
  name: string;
  html: string;
}

interface Props {
  path: string;
  fileType: string;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Detect whether a buffer is the modern Office Open XML format (a ZIP)
 * or the legacy CFB binary format used by .doc / .xls / .ppt.
 *   - "ooxml":  PK\x03\x04 — what mammoth / xlsx / pptx-parser expect
 *   - "cfb":    \xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1 — Word97 / Excel97 /
 *               PowerPoint97 binary format. Pure-JS readers for this are
 *               heavy and unreliable, so we surface a helpful message
 *               instead of letting mammoth blow up with a zip error.
 *   - "unknown": neither magic matched.
 */
function detectOfficeFormat(buf: ArrayBuffer): "ooxml" | "cfb" | "unknown" {
  const v = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  if (v.length >= 4 && v[0] === 0x50 && v[1] === 0x4b && v[2] === 0x03 && v[3] === 0x04) {
    return "ooxml";
  }
  if (
    v.length >= 8 &&
    v[0] === 0xd0 && v[1] === 0xcf && v[2] === 0x11 && v[3] === 0xe0 &&
    v[4] === 0xa1 && v[5] === 0xb1 && v[6] === 0x1a && v[7] === 0xe1
  ) {
    return "cfb";
  }
  return "unknown";
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render a Rust-side text-extractor output (legacy .doc / .ppt) as a
 *  read-only document with a banner explaining the limited fidelity. */
function buildPlainTextHtml(text: string, banner: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, "Segoe UI", sans-serif; font-size: 13px;
           line-height: 1.7; padding: 16px 24px 24px; color: #333; margin: 0; }
    .banner {
      font-size: 11px; color: #92400e; background: rgba(245,158,11,0.10);
      border: 1px solid rgba(245,158,11,0.28); border-radius: 6px;
      padding: 6px 10px; margin-bottom: 14px;
    }
    pre { white-space: pre-wrap; word-wrap: break-word; font-family: inherit; margin: 0; }
  </style></head><body>
    <div class="banner">${htmlEscape(banner)} · 旧版二进制格式仅支持文本提取,无法保留图片 / 表格 / 排版。如需完整预览请另存为新格式。</div>
    <pre>${htmlEscape(text)}</pre>
  </body></html>`;
}

/**
 * macOS `textutil` produces a .docx where Word field codes
 * ( `TOC \o "1-3" \h \z \u`, `HYPERLINK \l _TocXXX`, `PAGEREF _TocXXX` )
 * are flattened into plain text runs instead of being evaluated. mammoth
 * then renders them verbatim. Strip the obvious patterns so the body
 * stays readable. (LibreOffice's converter doesn't have this problem.)
 */
function stripWordFieldCodes(html: string): string {
  return html
    // TOC instruction with all its switches: TOC \o "1-3" \h \z \u
    .replace(/TOC\s*\\o\s*"[^"]*"(?:\s*\\[a-z])*\s*/gi, "")
    // Hyperlink to a bookmark: HYPERLINK \l _Toc12345
    .replace(/HYPERLINK\s*\\l\s*_Toc\d+\s*/gi, "")
    // Page-number reference: PAGEREF _Toc12345
    .replace(/PAGEREF\s*_Toc\d+\s*/gi, "")
    // Trailing single-letter switches that escape the patterns above: \h \z \u
    .replace(/\s*\\[a-z](?=\s|<|$)/gi, "")
    // Common Word field wrappers that may also leak through
    .replace(/\bSEQ\s+\w+(?:\s+\\\*\s*\w+)?\s*/gi, "")
    .replace(/\bREF\s+_Ref\d+\s*/gi, "")
    // Collapse the runs of whitespace the strips leave behind
    .replace(/[ \t]{2,}/g, " ")
    .replace(/<p>\s*<\/p>/g, "");
}

function buildDocxHtml(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, "Segoe UI", sans-serif; font-size: 13px;
           line-height: 1.75; padding: 24px 28px; color: #333; margin: 0; }
    h1 { font-size: 20px; font-weight: 700; margin: 20px 0 8px; color: #111; }
    h2 { font-size: 17px; font-weight: 600; margin: 16px 0 6px; color: #222; }
    h3 { font-size: 15px; font-weight: 600; margin: 12px 0 4px; color: #333; }
    h4, h5, h6 { font-size: 13px; font-weight: 600; margin: 10px 0 4px; }
    p { margin: 5px 0; }
    table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 12px; }
    th, td { border: 1px solid #d9d9d9; padding: 5px 10px; text-align: left; }
    th { background: #f5f5f5; font-weight: 600; }
    ul, ol { margin: 5px 0; padding-left: 22px; }
    li { margin: 3px 0; }
    img { max-width: 100%; height: auto; border-radius: 4px; margin: 4px 0; }
    blockquote { border-left: 3px solid #d9d9d9; margin: 8px 0; padding-left: 12px; color: #666; }
    strong { font-weight: 600; }
    em { font-style: italic; }
    a { color: #1677ff; }
  </style></head><body>${body}</body></html>`;
}

function buildXlsxHtml(tableHtml: string): string {
  // sheet_to_html 返回完整 HTML 文档，需要加样式
  return tableHtml.replace(
    "<head>",
    `<head><meta charset="UTF-8"><style>
      body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; font-size: 12px; }
      table { border-collapse: collapse; min-width: 100%; }
      td, th { border: 1px solid #d9d9d9; padding: 4px 8px; white-space: nowrap;
               max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
      tr:first-child td, tr:first-child th { background: #f5f5f5; font-weight: 600;
               position: sticky; top: 0; z-index: 1; }
      tr:nth-child(even) { background: #fafafa; }
      tr:hover { background: #e6f4ff; }
    </style>`
  );
}

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";

async function parsePptxSlides(zip: import("jszip")): Promise<PptxSlide[]> {
  const slides: PptxSlide[] = [];
  let idx = 1;
  while (idx <= 300) {
    const slideFile = zip.file(`ppt/slides/slide${idx}.xml`);
    if (!slideFile) break;

    const xml = await slideFile.async("string");
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, "application/xml");

    let title = "";
    const bullets: string[] = [];

    const spList = doc.getElementsByTagNameNS(NS_P, "sp");
    for (const sp of Array.from(spList)) {
      const phList = sp.getElementsByTagNameNS(NS_P, "ph");
      const isTitle = Array.from(phList).some((ph) => {
        const t = ph.getAttribute("type");
        return t === "title" || t === "ctrTitle";
      });

      const pList = sp.getElementsByTagNameNS(NS_A, "p");
      for (const p of Array.from(pList)) {
        const tList = p.getElementsByTagNameNS(NS_A, "t");
        const text = Array.from(tList)
          .map((t) => t.textContent ?? "")
          .join("")
          .trim();
        if (text) {
          if (isTitle && !title) {
            title = text;
          } else {
            bullets.push(text);
          }
        }
      }
    }

    if (title || bullets.length > 0) {
      slides.push({ index: idx, title, bullets });
    }
    idx++;
  }
  return slides;
}

export default function OfficePreview({ path, fileType }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [docHtml, setDocHtml] = useState<string | null>(null);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [xlsxSheets, setXlsxSheets] = useState<XlsxSheet[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [pptxSlides, setPptxSlides] = useState<PptxSlide[]>([]);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const prevPdfUrlRef = useRef<string | null>(null);

  const ft = fileType.toLowerCase();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDocHtml(null);
    setPdfBlobUrl(null);
    if (prevPdfUrlRef.current) {
      URL.revokeObjectURL(prevPdfUrlRef.current);
      prevPdfUrlRef.current = null;
    }
    setXlsxSheets([]);
    setActiveSheet(0);
    setPptxSlides([]);

    invoke<string>("read_binary_preview", { path })
      .then(async (base64) => {
        if (cancelled) return;
        const buffer = base64ToArrayBuffer(base64);
        const fmt = detectOfficeFormat(buffer);

        if (ft === "docx" || ft === "doc") {
          if (fmt === "cfb") {
            // Legacy Word97 .doc — try a high-fidelity conversion path.
            // The Rust side prefers LibreOffice → PDF when available
            // (best fidelity), falling back to textutil → docx on
            // macOS. PDFs are rendered by the native WebKit PDF engine,
            // identical to opening the file in Preview.app.
            try {
              const conv = await invoke<{ format: string; base64: string }>(
                "convert_legacy_to_modern",
                { path },
              );
              const buf = base64ToArrayBuffer(conv.base64);
              if (conv.format === "pdf") {
                const blob = new Blob([buf], { type: "application/pdf" });
                const url = URL.createObjectURL(blob);
                prevPdfUrlRef.current = url;
                if (!cancelled) setPdfBlobUrl(url);
              } else {
                // docx — feed to mammoth, same as native .docx.
                const mammoth = (await import("mammoth")).default;
                const result = await mammoth.convertToHtml({ arrayBuffer: buf });
                if (!cancelled) setDocHtml(buildDocxHtml(stripWordFieldCodes(result.value)));
              }
            } catch (err) {
              // No converter installed → text fallback + install hint.
              const text = await invoke<string>("read_file_preview", { path });
              const banner = String(err) === "NO_CONVERTER"
                ? "Word 97-2003 (.doc) · 仅文本预览。安装 LibreOffice 可获得完整版式预览（macOS: brew install --cask libreoffice）"
                : `Word 97-2003 (.doc) · 仅文本预览（${String(err)}）`;
              if (!cancelled) setDocHtml(buildPlainTextHtml(text, banner));
            }
            return;
          }
          // Native .docx
          const mammoth = (await import("mammoth")).default;
          const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
          if (!cancelled) setDocHtml(buildDocxHtml(result.value));

        } else if (ft === "xlsx" || ft === "xls" || ft === "csv") {
          // xlsx CAN read legacy .xls (CFB) — let it try.
          const XLSX = await import("xlsx");
          const workbook = XLSX.read(new Uint8Array(buffer), { type: "array" });
          const sheets: XlsxSheet[] = workbook.SheetNames.map((name: string) => ({
            name,
            html: buildXlsxHtml(
              XLSX.utils.sheet_to_html(workbook.Sheets[name]) as string
            ),
          }));
          if (!cancelled) setXlsxSheets(sheets);

        } else if (ft === "pptx" || ft === "ppt") {
          if (fmt === "cfb") {
            // Legacy PowerPoint97 — same converter chain. soffice
            // produces a perfect-fidelity PDF; without LibreOffice we
            // can't do anything useful for .ppt (textutil doesn't
            // handle PowerPoint), so the fallback is text-only.
            try {
              const conv = await invoke<{ format: string; base64: string }>(
                "convert_legacy_to_modern",
                { path },
              );
              const buf = base64ToArrayBuffer(conv.base64);
              if (conv.format === "pdf") {
                const blob = new Blob([buf], { type: "application/pdf" });
                const url = URL.createObjectURL(blob);
                prevPdfUrlRef.current = url;
                if (!cancelled) setPdfBlobUrl(url);
                return;
              }
              // Shouldn't normally hit this — Rust never emits
              // pptx for legacy .ppt without soffice, but keep it
              // defensive.
              const JSZip = (await import("jszip")).default;
              const zip = await JSZip.loadAsync(buf);
              const slides = await parsePptxSlides(zip as import("jszip"));
              if (!cancelled) setPptxSlides(slides);
            } catch (err) {
              const text = await invoke<string>("read_file_preview", { path });
              const banner = String(err) === "NO_CONVERTER"
                ? "PowerPoint 97-2003 (.ppt) · 仅文本预览。安装 LibreOffice 可获得完整版式预览（macOS: brew install --cask libreoffice）"
                : `PowerPoint 97-2003 (.ppt) · 仅文本预览（${String(err)}）`;
              if (!cancelled) setDocHtml(buildPlainTextHtml(text, banner));
            }
            return;
          }
          const JSZip = (await import("jszip")).default;
          const zip = await JSZip.loadAsync(buffer);
          const slides = await parsePptxSlides(zip as import("jszip"));
          if (!cancelled) setPptxSlides(slides);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path, fileType]);

  // Revoke any leftover PDF blob URL on unmount.
  useEffect(() => {
    return () => {
      if (prevPdfUrlRef.current) URL.revokeObjectURL(prevPdfUrlRef.current);
    };
  }, []);

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100%", flexDirection: "column", gap: 12 }}>
        <Spin />
        <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>正在解析文档...</span>
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        type="error"
        title="预览失败"
        description={error}
        showIcon
        style={{ margin: 12 }}
      />
    );
  }

  // ── DOCX / DOC ──
  if (ft === "docx" || ft === "doc") {
    // Legacy .doc converted to PDF via LibreOffice — render natively.
    if (pdfBlobUrl) {
      return (
        <iframe
          src={pdfBlobUrl}
          style={{ flex: 1, width: "100%", height: "100%", border: "none" }}
          title="文档预览"
        />
      );
    }
    if (!docHtml) return <Empty description="文档内容为空" style={{ marginTop: 40 }} />;
    return (
      <iframe
        ref={iframeRef}
        srcDoc={docHtml}
        style={{ flex: 1, width: "100%", height: "100%", border: "none" }}
        title="文档预览"
      />
    );
  }

  // ── XLSX / XLS / CSV ──
  if (ft === "xlsx" || ft === "xls" || ft === "csv") {
    if (xlsxSheets.length === 0)
      return <Empty description="表格内容为空" style={{ marginTop: 40 }} />;
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {xlsxSheets.length > 1 && (
          <div
            style={{
              display: "flex",
              gap: 4,
              padding: "6px 8px",
              borderBottom: "1px solid var(--color-border)",
              flexShrink: 0,
              flexWrap: "wrap",
              background: "var(--color-surface)",
            }}
          >
            {xlsxSheets.map((sheet, i) => {
              const active = activeSheet === i;
              return (
                <button
                  key={sheet.name}
                  onClick={() => setActiveSheet(i)}
                  className={active ? "chip chip-primary" : "chip"}
                  style={{
                    cursor: "pointer",
                    fontFamily: "inherit",
                    height: 22,
                    padding: "0 10px",
                    fontSize: 12,
                    fontWeight: active ? 600 : 500,
                  }}
                >
                  {sheet.name}
                </button>
              );
            })}
          </div>
        )}
        <iframe
          srcDoc={xlsxSheets[activeSheet]?.html}
          style={{ flex: 1, width: "100%", border: "none" }}
          title="表格预览"
        />
      </div>
    );
  }

  // ── PPTX / PPT ──
  if (ft === "pptx" || ft === "ppt") {
    // Legacy .ppt converted to PDF via LibreOffice — render natively.
    if (pdfBlobUrl) {
      return (
        <iframe
          src={pdfBlobUrl}
          style={{ flex: 1, width: "100%", height: "100%", border: "none" }}
          title="文档预览"
        />
      );
    }
    // Legacy .ppt fallback path with text-only docHtml.
    if (docHtml) {
      return (
        <iframe
          ref={iframeRef}
          srcDoc={docHtml}
          style={{ flex: 1, width: "100%", height: "100%", border: "none" }}
          title="文档预览"
        />
      );
    }
    if (pptxSlides.length === 0)
      return <Empty description="未找到幻灯片内容" style={{ marginTop: 40 }} />;
    return (
      <div style={{ overflow: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
        {pptxSlides.map((slide) => (
          <div
            key={slide.index}
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              padding: "14px 18px",
            }}
          >
            <div className="mono" style={{ fontSize: 10, color: "var(--color-text-muted)", marginBottom: 6 }}>
              {String(slide.index).padStart(2, "0")} / {String(pptxSlides.length).padStart(2, "0")}
            </div>
            {slide.title && (
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: "var(--color-text)",
                  marginBottom: slide.bullets.length > 0 ? 8 : 0,
                  lineHeight: 1.4,
                }}
              >
                {slide.title}
              </div>
            )}
            {slide.bullets.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {slide.bullets.map((b, i) => (
                  <li key={i} style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.65, marginBottom: 2 }}>
                    {b}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    );
  }

  return null;
}
