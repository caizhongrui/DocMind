use anyhow::Result;
use std::path::Path;
use tantivy::{
    schema::*,
    tokenizer::NgramTokenizer,
    Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument,
};

/// 自定义分词器名称（CJK unigram + bigram）
const TOKENIZER_NAME: &str = "cjk_ngram";
/// schema 版本标记文件，存在说明索引已用正确的 CJK tokenizer 建立
const SCHEMA_MARKER: &str = ".schema_cjk_v1";

pub struct FtsIndex {
    pub index: Index,
    pub schema: Schema,
    pub reader: IndexReader,
    pub field_id: Field,
    pub field_path: Field,
    pub field_name: Field,
    pub field_content: Field,
    pub field_file_type: Field,
}

impl FtsIndex {
    pub fn open_or_create(index_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(index_dir)?;

        let version_marker = index_dir.join(SCHEMA_MARKER);
        let has_valid_index =
            index_dir.join("meta.json").exists() && version_marker.exists();

        // 旧索引（无标记文件）→ 删除重建，避免分词器不兼容导致搜索为空
        if !has_valid_index && index_dir.join("meta.json").exists() {
            eprintln!("[tantivy] 检测到旧版索引（无 CJK tokenizer），正在重建...");
            std::fs::remove_dir_all(index_dir)?;
            std::fs::create_dir_all(index_dir)?;
        }

        let index = if has_valid_index {
            Index::open_in_dir(index_dir)?
        } else {
            // CJK n-gram 索引选项：unigram(1) + bigram(2)
            // "违约金" → ["违","约","金","违约","约金"]，支持"违约"精准搜中文
            let cjk_indexing = TextFieldIndexing::default()
                .set_tokenizer(TOKENIZER_NAME)
                .set_index_option(IndexRecordOption::WithFreqsAndPositions);

            let mut builder = Schema::builder();
            builder.add_u64_field("file_id", INDEXED | STORED);
            builder.add_text_field("path", STORED);
            builder.add_text_field(
                "name",
                TextOptions::default()
                    .set_indexing_options(cjk_indexing.clone())
                    .set_stored(),
            );
            builder.add_text_field(
                "content",
                TextOptions::default().set_indexing_options(cjk_indexing),
            );
            builder.add_text_field("file_type", STRING | STORED);
            let schema = builder.build();

            let idx = Index::create_in_dir(index_dir, schema)?;
            std::fs::write(&version_marker, b"")?;
            idx
        };

        // 注册 CJK n-gram 分词器（必须在 reader 创建前注册）
        index
            .tokenizers()
            .register(TOKENIZER_NAME, NgramTokenizer::new(1, 2, false)?);

        let schema = index.schema();
        let field_id = schema.get_field("file_id")?;
        let field_path = schema.get_field("path")?;
        let field_name = schema.get_field("name")?;
        let field_content = schema.get_field("content")?;
        let field_file_type = schema.get_field("file_type")?;

        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;

        Ok(Self {
            index,
            schema,
            reader,
            field_id,
            field_path,
            field_name,
            field_content,
            field_file_type,
        })
    }

    pub fn writer(&self) -> Result<IndexWriter<TantivyDocument>> {
        Ok(self.index.writer(50_000_000)?)
    }

    pub fn add_document(
        &self,
        writer: &IndexWriter<TantivyDocument>,
        file_id: u64,
        path: &str,
        name: &str,
        content: &str,
        file_type: &str,
    ) -> Result<()> {
        let mut doc = TantivyDocument::default();
        doc.add_u64(self.field_id, file_id);
        doc.add_text(self.field_path, path);
        doc.add_text(self.field_name, name);
        doc.add_text(self.field_content, content);
        doc.add_text(self.field_file_type, file_type);
        writer.add_document(doc)?;
        Ok(())
    }

    pub fn delete_document(
        &self,
        writer: &IndexWriter<TantivyDocument>,
        file_id: u64,
    ) -> Result<()> {
        let term = Term::from_field_u64(self.field_id, file_id);
        writer.delete_term(term);
        Ok(())
    }

    /// 清空全文索引中的所有文档
    pub fn clear_all(&self) -> Result<()> {
        let mut writer: IndexWriter<TantivyDocument> = self.index.writer(50_000_000)?;
        writer.delete_all_documents()?;
        writer.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_open_or_create_new() {
        let tmp = TempDir::new().unwrap();
        let _idx = FtsIndex::open_or_create(tmp.path()).unwrap();
        assert!(tmp.path().join("meta.json").exists());
    }

    #[test]
    fn test_open_existing() {
        let tmp = TempDir::new().unwrap();
        FtsIndex::open_or_create(tmp.path()).unwrap();
        let _idx = FtsIndex::open_or_create(tmp.path()).unwrap();
        assert!(tmp.path().join("meta.json").exists());
    }

    #[test]
    fn test_add_and_commit_document() {
        let tmp = TempDir::new().unwrap();
        let idx = FtsIndex::open_or_create(tmp.path()).unwrap();
        let writer = idx.writer().unwrap();
        idx.add_document(&writer, 1, "/tmp/test.txt", "test.txt", "hello world", "txt")
            .unwrap();
        writer.commit().unwrap();
    }

    #[test]
    fn test_cjk_partial_match() {
        // 验证"违约"能搜到"违约金"
        let tmp = TempDir::new().unwrap();
        let idx = FtsIndex::open_or_create(tmp.path()).unwrap();
        let writer = idx.writer().unwrap();
        idx.add_document(
            &writer,
            1,
            "/tmp/contract.txt",
            "合同",
            "违约金不得超过合同金额的20%",
            "txt",
        )
        .unwrap();
        writer.commit().unwrap();
    }
}
