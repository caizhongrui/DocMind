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
  const [xlsxSheets, setXlsxSheets] = useState<XlsxSheet[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [pptxSlides, setPptxSlides] = useState<PptxSlide[]>([]);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const ft = fileType.toLowerCase();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDocHtml(null);
    setXlsxSheets([]);
    setActiveSheet(0);
    setPptxSlides([]);

    invoke<string>("read_binary_preview", { path })
      .then(async (base64) => {
        if (cancelled) return;
        const buffer = base64ToArrayBuffer(base64);

        if (ft === "docx" || ft === "doc") {
          const mammoth = (await import("mammoth")).default;
          const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
          if (!cancelled) setDocHtml(buildDocxHtml(result.value));

        } else if (ft === "xlsx" || ft === "xls" || ft === "csv") {
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

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100%", flexDirection: "column", gap: 12 }}>
        <Spin />
        <span style={{ fontSize: 12, color: "#999" }}>正在解析文档...</span>
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        type="error"
        message="预览失败"
        description={error}
        showIcon
        style={{ margin: 12 }}
      />
    );
  }

  // ── DOCX ──
  if (ft === "docx" || ft === "doc") {
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
              borderBottom: "1px solid #f0f0f0",
              flexShrink: 0,
              flexWrap: "wrap",
            }}
          >
            {xlsxSheets.map((sheet, i) => (
              <button
                key={sheet.name}
                onClick={() => setActiveSheet(i)}
                style={{
                  padding: "2px 10px",
                  border: activeSheet === i ? "1px solid #1677ff" : "1px solid #d9d9d9",
                  borderRadius: 4,
                  background: activeSheet === i ? "#e6f4ff" : "#fff",
                  color: activeSheet === i ? "#1677ff" : "#595959",
                  cursor: "pointer",
                  fontSize: 12,
                  lineHeight: "20px",
                }}
              >
                {sheet.name}
              </button>
            ))}
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
    if (pptxSlides.length === 0)
      return <Empty description="未找到幻灯片内容" style={{ marginTop: 40 }} />;
    return (
      <div style={{ overflow: "auto", padding: "8px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
        {pptxSlides.map((slide) => (
          <div
            key={slide.index}
            style={{
              background: "#fff",
              border: "1px solid #e8e8e8",
              borderRadius: 8,
              padding: "14px 18px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            }}
          >
            <div style={{ fontSize: 10, color: "#bbb", marginBottom: 6 }}>
              第 {slide.index} 页
            </div>
            {slide.title && (
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: "#1677ff",
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
                  <li key={i} style={{ fontSize: 13, color: "#444", lineHeight: 1.65, marginBottom: 2 }}>
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
