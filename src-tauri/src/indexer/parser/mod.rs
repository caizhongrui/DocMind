pub mod archive;
pub mod image;
pub mod ocr;
pub mod office;
pub mod pdf;
pub mod text;

use std::path::Path;

#[derive(Debug, PartialEq, Clone)]
pub enum ParseStatus {
    Ok,
    Partial,
    Failed,
}

#[derive(Debug, Clone)]
pub struct ParseResult {
    pub content: String,
    pub status: ParseStatus,
}

impl ParseResult {
    pub fn failed() -> Self {
        Self { content: String::new(), status: ParseStatus::Failed }
    }
}

// ── 大文件保护 ──────────────────────────────────────────────────────────────
//
// txt/md/csv/rst/rtf：text.rs 内部用 take(10MB) 流式读取，上限较宽松。
// doc/ppt           ：全量字节扫描，严格限制。
// docx/pptx         ：ZIP entry 流式读，可承受较大文件。
// xls/xlsx          ：calamine 全量加载 workbook，严格限制。
// zip               ：entry 流式读，上限较宽松。
// pdf               ：pdf.rs 内部已有超时 + 大小检查，此处不再重复。
// 图片              ：OCR 前先解码，限制文件大小防 OOM。
//
// ──────────────────────────────────────────────────────────────────────────
const MAX_SIZE_TEXT: u64  = 500 * 1024 * 1024; // txt/md/csv/rst/rtf: 500 MB
const MAX_SIZE_DOC: u64   = 100 * 1024 * 1024; // doc/ppt:            100 MB
const MAX_SIZE_DOCX: u64  = 300 * 1024 * 1024; // docx/pptx:          300 MB
const MAX_SIZE_XLSX: u64  = 100 * 1024 * 1024; // xls/xlsx:           100 MB
const MAX_SIZE_ZIP: u64   = 300 * 1024 * 1024; // zip:                300 MB
const MAX_SIZE_IMAGE: u64 =  30 * 1024 * 1024; // 图片:                30 MB

/// 解析后内容字符数上限，超出时截断并改为 Partial 状态。
const MAX_CONTENT_CHARS: usize = 500_000;

pub fn parse_file(path: &Path) -> ParseResult {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // ── 文件大小检查 ──────────────────────────────────────────────────────
    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let max_size = match ext.as_str() {
        "txt" | "md" | "csv" | "rst" | "rtf"               => MAX_SIZE_TEXT,
        // Source code & config files: same generous text limit (rare to
        // see >100 MB source files; if present they're build artifacts).
        "py" | "js" | "ts" | "jsx" | "tsx" | "mjs" | "cjs"
        | "java" | "go" | "rs" | "c" | "cpp" | "cc" | "cxx" | "h" | "hpp"
        | "swift" | "kt" | "kts" | "scala" | "rb" | "php" | "cs"
        | "vue" | "svelte" | "html" | "htm" | "css" | "scss" | "less"
        | "yaml" | "yml" | "json" | "toml" | "ini" | "conf" | "xml"
        | "sh" | "bash" | "zsh" | "fish" | "ps1" | "bat" | "cmd"
        | "sql" | "graphql" | "proto" | "lua" | "pl" | "r" | "dart"
        | "log"                                             => MAX_SIZE_TEXT,
        "doc"  | "ppt"                                      => MAX_SIZE_DOC,
        "docx" | "pptx" | "epub"                            => MAX_SIZE_DOCX,
        "xls"  | "xlsx"                                     => MAX_SIZE_XLSX,
        "zip"                                               => MAX_SIZE_ZIP,
        "jpg" | "jpeg" | "png" | "bmp" | "tiff" | "tif"
        | "webp" | "heic" | "heif"                          => MAX_SIZE_IMAGE,
        _                                                   => u64::MAX, // pdf 由 pdf.rs 自己管
    };
    if file_size > max_size {
        eprintln!(
            "[parser] skipping oversized file ({:.1} MB, limit {:.0} MB): {}",
            file_size as f64 / 1024.0 / 1024.0,
            max_size as f64 / 1024.0 / 1024.0,
            path.display()
        );
        return ParseResult::failed();
    }

    // ── 解析 ──────────────────────────────────────────────────────────────
    let mut result = match ext.as_str() {
        "txt" | "md" | "csv" | "rst"                        => text::parse(path),
        "rtf"                                               => text::parse_rtf(path),
        // Code / config: route through the plain-text reader. The CJK
        // ngram tokenizer in Tantivy still indexes ascii substrings
        // sensibly (e.g. "throw new Error" → "throw", "new", "Error"),
        // so users searching for class names / variable names / log
        // strings still get hits.
        "py" | "js" | "ts" | "jsx" | "tsx" | "mjs" | "cjs"
        | "java" | "go" | "rs" | "c" | "cpp" | "cc" | "cxx" | "h" | "hpp"
        | "swift" | "kt" | "kts" | "scala" | "rb" | "php" | "cs"
        | "vue" | "svelte" | "html" | "htm" | "css" | "scss" | "less"
        | "yaml" | "yml" | "json" | "toml" | "ini" | "conf" | "xml"
        | "sh" | "bash" | "zsh" | "fish" | "ps1" | "bat" | "cmd"
        | "sql" | "graphql" | "proto" | "lua" | "pl" | "r" | "dart"
        | "log"                                             => text::parse(path),
        "pdf"                                               => pdf::parse(path),
        "docx" | "pptx"                                     => office::parse_xml(path),
        "epub"                                              => office::parse_epub(path),
        "xls"  | "xlsx"                                     => office::parse_xlsx(path),
        "doc"  | "ppt"                                      => office::parse_doc(path),
        "zip"                                               => archive::parse_zip(path),
        "jpg" | "jpeg" | "png" | "bmp" | "tiff" | "tif"
        | "webp" | "heic" | "heif"                          => image::parse_image(path),
        _                                                   => ParseResult::failed(),
    };

    // ── 兜底内容截断 ──────────────────────────────────────────────────────
    // 无论哪个解析器产生了超长内容，统一截断防止下游 OOM
    if result.content.chars().count() > MAX_CONTENT_CHARS {
        result.content = result.content.chars().take(MAX_CONTENT_CHARS).collect();
        result.status = ParseStatus::Partial;
    }

    result
}
