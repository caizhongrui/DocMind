use anyhow::Result;
use std::path::Path;
use tantivy::{schema::*, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument};

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

        let mut builder = Schema::builder();
        let field_id = builder.add_u64_field("file_id", INDEXED | STORED);
        let field_path = builder.add_text_field("path", STORED);
        let field_name = builder.add_text_field("name", TEXT | STORED);
        let field_content = builder.add_text_field("content", TEXT);
        let field_file_type = builder.add_text_field("file_type", STRING | STORED);
        let schema = builder.build();

        let index = if index_dir.join("meta.json").exists() {
            Index::open_in_dir(index_dir)?
        } else {
            Index::create_in_dir(index_dir, schema.clone())?
        };

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
        // 创建一次
        FtsIndex::open_or_create(tmp.path()).unwrap();
        // 再次打开
        let _idx = FtsIndex::open_or_create(tmp.path()).unwrap();
        assert!(tmp.path().join("meta.json").exists());
    }

    #[test]
    fn test_add_and_commit_document() {
        let tmp = TempDir::new().unwrap();
        let idx = FtsIndex::open_or_create(tmp.path()).unwrap();
        let mut writer = idx.writer().unwrap();
        idx.add_document(&writer, 1, "/tmp/test.txt", "test.txt", "hello world", "txt")
            .unwrap();
        writer.commit().unwrap();
    }
}
