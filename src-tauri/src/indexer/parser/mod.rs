pub mod archive;
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

pub fn parse_file(path: &Path) -> ParseResult {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "txt" | "md" | "csv" => text::parse(path),
        "pdf" => pdf::parse(path),
        "docx" | "pptx" => office::parse_xml(path),
        "xlsx" => office::parse_xlsx(path),
        "doc" => office::parse_doc(path),
        "zip" => archive::parse_zip(path),
        _ => ParseResult::failed(),
    }
}
