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
            index.load(index_path.to_str().unwrap())?;
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

    pub fn len(&self) -> usize {
        self.index.size()
    }
}
