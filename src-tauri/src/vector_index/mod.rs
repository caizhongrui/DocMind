use anyhow::Result;
use std::path::Path;
use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

pub struct VectorIndex {
    index: Index,
    path: std::path::PathBuf,
    dimensions: usize,
}

impl VectorIndex {
    pub fn open_or_create(index_path: &Path, dimensions: usize) -> Result<Self> {
        let mut options = IndexOptions::default();
        options.dimensions = dimensions;
        options.metric = MetricKind::Cos;
        options.quantization = ScalarKind::F16;

        let index = Index::new(&options)?;

        if index_path.exists() {
            match index.load(index_path.to_str().unwrap()) {
                Ok(()) => {
                    // load 后必须额外 reserve，否则 add 时内部扩容触发 null ptr crash
                    let sz = index.size();
                    index.reserve(sz + 100_000)?;
                }
                Err(e) => {
                    // 文件损坏（如上次 crash 留下的残留文件），删掉重建
                    eprintln!("[vector_index] corrupted index file, recreating: {e}");
                    let _ = std::fs::remove_file(index_path);
                    index.reserve(100_000)?;
                }
            }
        } else {
            index.reserve(100_000)?;
        }

        Ok(Self {
            index,
            path: index_path.to_path_buf(),
            dimensions,
        })
    }

    pub fn add(&self, chunk_id: u64, embedding: &[f32]) -> Result<()> {
        self.index.add(chunk_id, embedding)?;
        Ok(())
    }

    /// 从向量索引中删除指定 chunk_id 对应的向量条目
    pub fn remove(&self, chunk_id: u64) -> Result<()> {
        let _ = self.index.remove(chunk_id)?;
        Ok(())
    }

    pub fn search(&self, query: &[f32], top_k: usize) -> Result<Vec<(u64, f32)>> {
        let results = self.index.search(query, top_k)?;
        Ok(results
            .keys
            .iter()
            .zip(results.distances.iter())
            .map(|(&k, &d)| (k, d))
            .collect())
    }

    pub fn save(&self) -> Result<()> {
        self.index.save(self.path.to_str().unwrap())?;
        Ok(())
    }

    /// 清空向量索引，重新创建一个空索引（保留路径和维度配置）
    pub fn reset(&mut self) -> Result<()> {
        let _ = std::fs::remove_file(&self.path);
        let mut options = IndexOptions::default();
        options.dimensions = self.dimensions;
        options.metric = MetricKind::Cos;
        options.quantization = ScalarKind::F16;
        let new_index = Index::new(&options)?;
        new_index.reserve(100_000)?;
        self.index = new_index;
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.index.size()
    }
}
