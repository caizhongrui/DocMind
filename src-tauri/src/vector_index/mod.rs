use anyhow::Result;
use std::collections::HashMap;
use std::path::Path;
use std::sync::RwLock;

/// 纯 Rust 向量索引（替代 usearch，跨平台无 C++ 依赖）
///
/// 采用暴力余弦距离搜索。对于桌面端文档搜索场景（< 100k 向量，384 维），
/// 单次查询耗时 < 100ms，完全可接受。
pub struct VectorIndex {
    vectors: RwLock<HashMap<u64, Vec<f32>>>,
    path: std::path::PathBuf,
    dimensions: usize,
}

impl VectorIndex {
    pub fn open_or_create(index_path: &Path, dimensions: usize) -> Result<Self> {
        let vectors = if index_path.exists() {
            match Self::load_from_file(index_path) {
                Ok(m) => m,
                Err(e) => {
                    // 文件损坏（如旧格式 usearch 文件）或读取失败，删掉重建
                    eprintln!("[vector_index] corrupted index file, recreating: {e}");
                    let _ = std::fs::remove_file(index_path);
                    HashMap::new()
                }
            }
        } else {
            HashMap::new()
        };

        Ok(Self {
            vectors: RwLock::new(vectors),
            path: index_path.to_path_buf(),
            dimensions,
        })
    }

    /// 二进制格式：[count: u64][id: u64, dims: u32, f32 values...]+
    fn load_from_file(path: &Path) -> Result<HashMap<u64, Vec<f32>>> {
        let data = std::fs::read(path)?;
        if data.len() < 8 {
            return Err(anyhow::anyhow!("file too small"));
        }
        let count = u64::from_le_bytes(data[0..8].try_into()?) as usize;
        // 每条记录最少 12 字节（id:8 + dims:4 + 0个向量值），用文件大小做上界校验
        // 防止旧格式文件（如 usearch 二进制）的头部被误读为超大 count 导致 OOM panic
        let max_possible = data.len().saturating_sub(8) / 12;
        if count > max_possible {
            return Err(anyhow::anyhow!(
                "invalid count {} (file size {} bytes, max possible entries {})",
                count, data.len(), max_possible
            ));
        }
        let mut cursor = 8usize;
        let mut map = HashMap::with_capacity(count);
        for _ in 0..count {
            if cursor + 12 > data.len() {
                return Err(anyhow::anyhow!("truncated header"));
            }
            let id = u64::from_le_bytes(data[cursor..cursor + 8].try_into()?);
            cursor += 8;
            let dims = u32::from_le_bytes(data[cursor..cursor + 4].try_into()?) as usize;
            cursor += 4;
            let byte_len = dims * 4;
            if cursor + byte_len > data.len() {
                return Err(anyhow::anyhow!("truncated vector data"));
            }
            let values: Vec<f32> = data[cursor..cursor + byte_len]
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                .collect();
            cursor += byte_len;
            map.insert(id, values);
        }
        Ok(map)
    }

    /// 添加向量（保持与 usearch 相同的 &self 接口，内部用 RwLock）
    pub fn add(&self, chunk_id: u64, embedding: &[f32]) -> Result<()> {
        let mut guard = self
            .vectors
            .write()
            .map_err(|_| anyhow::anyhow!("vector index write lock poisoned"))?;
        guard.insert(chunk_id, embedding.to_vec());
        Ok(())
    }

    /// 删除向量
    pub fn remove(&self, chunk_id: u64) -> Result<()> {
        let mut guard = self
            .vectors
            .write()
            .map_err(|_| anyhow::anyhow!("vector index write lock poisoned"))?;
        guard.remove(&chunk_id);
        Ok(())
    }

    /// 余弦距离暴力搜索，返回 (chunk_id, distance) 升序（越小越相似）
    pub fn search(&self, query: &[f32], top_k: usize) -> Result<Vec<(u64, f32)>> {
        let guard = self
            .vectors
            .read()
            .map_err(|_| anyhow::anyhow!("vector index read lock poisoned"))?;

        if guard.is_empty() {
            return Ok(vec![]);
        }

        let q_norm: f32 = query.iter().map(|x| x * x).sum::<f32>().sqrt();
        if q_norm == 0.0 {
            return Ok(vec![]);
        }

        let mut scores: Vec<(u64, f32)> = guard
            .iter()
            .map(|(&id, vec)| {
                let dot: f32 = query.iter().zip(vec.iter()).map(|(a, b)| a * b).sum();
                let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
                // cosine distance: 0=完全相同, 1=正交, 2=完全相反
                let distance = if norm == 0.0 {
                    1.0
                } else {
                    1.0 - dot / (q_norm * norm)
                };
                (id, distance)
            })
            .collect();

        scores.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        scores.truncate(top_k);
        Ok(scores)
    }

    /// 持久化到磁盘
    pub fn save(&self) -> Result<()> {
        let guard = self
            .vectors
            .read()
            .map_err(|_| anyhow::anyhow!("vector index read lock poisoned"))?;

        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let count = guard.len();
        let mut data = Vec::with_capacity(8 + count * (8 + 4 + self.dimensions * 4));
        data.extend_from_slice(&(count as u64).to_le_bytes());
        for (&id, values) in guard.iter() {
            data.extend_from_slice(&id.to_le_bytes());
            data.extend_from_slice(&(values.len() as u32).to_le_bytes());
            for &v in values {
                data.extend_from_slice(&v.to_le_bytes());
            }
        }
        std::fs::write(&self.path, data)?;
        Ok(())
    }

    /// 清空索引（&mut self，由 Mutex<Option<VectorIndex>> 的 as_mut() 调用）
    pub fn reset(&mut self) -> Result<()> {
        let mut guard = self
            .vectors
            .write()
            .map_err(|_| anyhow::anyhow!("vector index write lock poisoned"))?;
        guard.clear();
        let _ = std::fs::remove_file(&self.path);
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.vectors.read().map(|g| g.len()).unwrap_or(0)
    }
}
