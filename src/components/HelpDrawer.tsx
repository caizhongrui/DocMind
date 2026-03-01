import { Drawer, Typography, Button } from "antd";
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
import { useState } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  onStartTour?: () => void;
}

const FORMAT_GROUPS = [
  {
    label: "文档",
    color: "#2563eb",
    bg: "rgba(37,99,235,0.08)",
    formats: [
      { ext: "PDF",  desc: "PDF 文档" },
      { ext: "DOC",  desc: "Word 97-2003" },
      { ext: "DOCX", desc: "Word 文档" },
      { ext: "PPT",  desc: "PowerPoint 97-2003" },
      { ext: "PPTX", desc: "PowerPoint 演示" },
      { ext: "RTF",  desc: "富文本格式" },
    ],
  },
  {
    label: "表格",
    color: "#16a34a",
    bg: "rgba(22,163,74,0.08)",
    formats: [
      { ext: "XLS",  desc: "Excel 97-2003" },
      { ext: "XLSX", desc: "Excel 表格" },
      { ext: "CSV",  desc: "逗号分隔值" },
    ],
  },
  {
    label: "文本 / 标记",
    color: "#7c3aed",
    bg: "rgba(124,58,237,0.08)",
    formats: [
      { ext: "TXT", desc: "纯文本" },
      { ext: "MD",  desc: "Markdown" },
      { ext: "RST", desc: "reStructuredText" },
    ],
  },
  {
    label: "归档",
    color: "#ea580c",
    bg: "rgba(234,88,12,0.08)",
    formats: [
      { ext: "ZIP", desc: "解析内部所有支持格式" },
    ],
  },
  {
    label: "图片 (OCR)",
    color: "#0891b2",
    bg: "rgba(8,145,178,0.08)",
    formats: [
      { ext: "JPG",  desc: "JPEG 图片" },
      { ext: "PNG",  desc: "PNG 图片" },
      { ext: "BMP",  desc: "位图" },
      { ext: "TIFF", desc: "TIFF 图片" },
      { ext: "WEBP", desc: "WebP 图片" },
    ],
  },
];

const SHORTCUTS = [
  { keys: ["⌘", "K"],      desc: "聚焦搜索框（macOS）" },
  { keys: ["Ctrl", "K"],   desc: "聚焦搜索框（Windows / Linux）" },
  { keys: ["↑", "↓"],     desc: "搜索结果列表导航" },
  { keys: ["Enter"],       desc: "打开选中文件" },
  { keys: ["Shift", "Enter"], desc: "输入框换行（问答）" },
];

const FEATURES = [
  { icon: <FileSearchOutlined style={{ color: "#1677ff" }} />, title: "全文搜索", desc: "对文档内容实时全文检索，支持中英文混合关键词。" },
  { icon: <RobotOutlined style={{ color: "#7c3aed" }} />,      title: "语义搜索", desc: "基于本地 AI 向量模型，理解语义相似的内容，无需精确关键词。" },
  { icon: <MessageOutlined style={{ color: "#16a34a" }} />,    title: "文档问答", desc: "向 AI 提问，自动从文档库中检索相关段落并给出回答。" },
];

function SectionCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      background: "var(--color-surface)",
      borderRadius: 10,
      border: "1px solid var(--color-border)",
      overflow: "hidden",
      marginBottom: 16,
    }}>
      <div style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--color-border)",
        display: "flex", alignItems: "center", gap: 7,
      }}>
        {icon}
        <Typography.Text strong style={{ fontSize: 13 }}>{title}</Typography.Text>
      </div>
      <div style={{ padding: "14px 16px" }}>
        {children}
      </div>
    </div>
  );
}

const CONTACT_EMAIL = "qdzy_cai@163.com";

export default function HelpDrawer({ open, onClose, onStartTour }: Props) {
  const [copied, setCopied] = useState(false);

  const copyEmail = () => {
    navigator.clipboard.writeText(CONTACT_EMAIL).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Drawer
      title={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <QuestionCircleOutlined style={{ color: "#1677ff" }} />
          <span>帮助</span>
        </div>
      }
      open={open}
      onClose={onClose}
      width={480}
      styles={{
        body: { padding: "20px 24px", background: "var(--color-bg)" },
      }}
    >
      {/* ── 功能简介 ── */}
      <SectionCard
        title="功能简介"
        icon={<FileSearchOutlined style={{ color: "#1677ff", fontSize: 14 }} />}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {FEATURES.map((f) => (
            <div key={f.title} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <div style={{
                width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 14,
              }}>
                {f.icon}
              </div>
              <div>
                <Typography.Text strong style={{ fontSize: 13, display: "block" }}>{f.title}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: 1.6 }}>{f.desc}</Typography.Text>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* ── 支持的文件格式 ── */}
      <SectionCard
        title="支持的文件格式"
        icon={<FileTextOutlined style={{ color: "#f59e0b", fontSize: 14 }} />}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {FORMAT_GROUPS.map((group) => (
            <div key={group.label}>
              <Typography.Text
                style={{ fontSize: 11, fontWeight: 600, color: group.color, display: "block", marginBottom: 7, textTransform: "uppercase", letterSpacing: 0.5 }}
              >
                {group.label}
              </Typography.Text>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {group.formats.map((f) => (
                  <div
                    key={f.ext}
                    title={f.desc}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 5,
                      padding: "3px 10px",
                      borderRadius: 6,
                      background: group.bg,
                      border: `1px solid ${group.color}22`,
                      cursor: "default",
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 700, color: group.color, fontFamily: "monospace" }}>
                      .{f.ext.toLowerCase()}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                      {f.desc}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div style={{
            marginTop: 4, padding: "8px 12px", borderRadius: 8,
            background: "var(--color-bg)", border: "1px solid var(--color-border)",
          }}>
            <Typography.Text type="secondary" style={{ fontSize: 11, lineHeight: 1.7, display: "block" }}>
              💡 <strong>图片型 PDF</strong>（扫描件）因无文字层无法提取内容，将跳过全文 / 语义索引，但文件名仍可检索。<br />
              📦 <strong>ZIP</strong> 支持解析压缩包内的 PDF、Word、Excel、PPT 及文本文件，每个文件最大 20 MB。<br />
              🖼️ <strong>图片</strong>（JPG/PNG 等）通过系统内置 OCR 引擎提取文字（macOS / Windows），单张限 30 MB。<br />
              📄 <strong>PPT / DOC</strong> 采用字节扫描提取文字，效果可能不如 PPTX / DOCX。
            </Typography.Text>
          </div>
        </div>
      </SectionCard>

      {/* ── 键盘快捷键 ── */}
      <SectionCard
        title="键盘快捷键"
        icon={<KeyOutlined style={{ color: "#64748b", fontSize: 14 }} />}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {SHORTCUTS.map((s, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.desc}</Typography.Text>
              <div style={{ display: "flex", gap: 4 }}>
                {s.keys.map((k, ki) => (
                  <kbd key={ki} style={{
                    display: "inline-block",
                    padding: "2px 7px",
                    borderRadius: 5,
                    background: "var(--color-bg)",
                    border: "1px solid var(--color-border)",
                    fontSize: 11,
                    fontFamily: "monospace",
                    color: "var(--color-text)",
                    boxShadow: "0 1px 0 var(--color-border)",
                  }}>
                    {k}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* ── 联系我们 ── */}
      <SectionCard
        title="联系我们"
        icon={<MailOutlined style={{ color: "#1677ff", fontSize: 14 }} />}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: 1.8, display: "block", marginBottom: 14 }}>
          如果你有以下需求，欢迎通过邮件联系我们：
        </Typography.Text>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
          {[
            { dot: "#1677ff", text: "商业合作 — 产品授权、渠道合作、品牌定制" },
            { dot: "#7c3aed", text: "项目开发 — 定制功能开发、企业内部知识库搭建" },
            { dot: "#16a34a", text: "问题反馈 — Bug 报告、功能建议、使用咨询" },
          ].map((item) => (
            <div key={item.text} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <div style={{
                width: 6, height: 6, borderRadius: "50%",
                background: item.dot, flexShrink: 0, marginTop: 5,
              }} />
              <Typography.Text style={{ fontSize: 12, color: "var(--color-text)", lineHeight: 1.6 }}>
                {item.text}
              </Typography.Text>
            </div>
          ))}
        </div>

        {/* 邮箱展示 */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px",
          borderRadius: 8,
          background: "var(--color-primary-bg)",
          border: "1px solid rgba(22,119,255,0.2)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <MailOutlined style={{ color: "#1677ff", fontSize: 14 }} />
            <Typography.Text
              style={{ fontSize: 13, fontWeight: 600, color: "#1677ff", fontFamily: "monospace", userSelect: "all" }}
            >
              {CONTACT_EMAIL}
            </Typography.Text>
          </div>
          <Button
            type="text"
            size="small"
            icon={<CopyOutlined style={{ fontSize: 13 }} />}
            onClick={copyEmail}
            style={{ color: copied ? "#16a34a" : "#64748b", padding: "0 6px" }}
          >
            <span style={{ fontSize: 11 }}>{copied ? "已复制" : "复制"}</span>
          </Button>
        </div>
      </SectionCard>

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
    </Drawer>
  );
}
