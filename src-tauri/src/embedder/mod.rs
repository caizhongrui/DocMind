use anyhow::Result;
use ort::{session::Session, value::Tensor};
use std::path::Path;
use tokenizers::Tokenizer;

const MAX_LENGTH: usize = 512;

pub struct Embedder {
    session: Session,
    tokenizer: Tokenizer,
}

impl Embedder {
    /// 从指定目录加载模型。model_dir 需含 model.onnx 和 tokenizer.json
    pub fn load(model_dir: &Path) -> Result<Self> {
        // 限制 ONNX 推理线程数为 2，避免后台索引抢占全部 CPU 核心
        let session = Session::builder()?
            .with_intra_threads(2)?
            .commit_from_file(model_dir.join("model.onnx"))?;
        let tokenizer =
            Tokenizer::from_file(model_dir.join("tokenizer.json"))
                .map_err(|e| anyhow::anyhow!("tokenizer load error: {}", e))?;
        Ok(Self { session, tokenizer })
    }

    /// 是否可用（模型文件存在）
    pub fn is_available(model_dir: &Path) -> bool {
        model_dir.join("model.onnx").exists() && model_dir.join("tokenizer.json").exists()
    }

    /// 生成文本 embedding，返回归一化后的向量
    pub fn embed(&mut self, text: &str) -> Result<Vec<f32>> {
        let encoding = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| anyhow::anyhow!("encode error: {}", e))?;

        let ids: Vec<i64> = encoding.get_ids().iter().map(|&x| x as i64).collect();
        let mask: Vec<i64> = encoding
            .get_attention_mask()
            .iter()
            .map(|&x| x as i64)
            .collect();
        let token_type_ids: Vec<i64> = encoding
            .get_type_ids()
            .iter()
            .map(|&x| x as i64)
            .collect();

        let len = ids.len().min(MAX_LENGTH);
        let ids = ids[..len].to_vec();
        let mask = mask[..len].to_vec();
        let token_type_ids = token_type_ids[..len].to_vec();

        // Use (shape, data) tuple form for i64 tensors
        let ids_tensor = Tensor::<i64>::from_array(([1, len], ids))?;
        let mask_tensor = Tensor::<i64>::from_array(([1, len], mask))?;
        let tt_tensor = Tensor::<i64>::from_array(([1, len], token_type_ids))?;

        let outputs = self.session.run(ort::inputs![
            "input_ids" => ids_tensor.into_dyn(),
            "attention_mask" => mask_tensor.into_dyn(),
            "token_type_ids" => tt_tensor.into_dyn(),
        ])?;

        // CLS token pooling (first token of last_hidden_state)
        // shape: [1, seq_len, hidden_size] → take first token
        let (shape, data) = outputs["last_hidden_state"].try_extract_tensor::<f32>()?;
        // shape[2] is hidden_size
        let hidden_size = *shape.as_ref().get(2).ok_or_else(|| anyhow::anyhow!("unexpected output shape"))? as usize;
        // First token embedding: data[0..hidden_size]
        let embedding: Vec<f32> = data[..hidden_size].to_vec();
        Ok(normalize(&embedding))
    }
}

pub fn normalize(v: &[f32]) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm < 1e-12 {
        return v.to_vec();
    }
    v.iter().map(|x| x / norm).collect()
}

/// 将长文本分成若干 chunk，每 chunk 约 chunk_size 字符，相邻 chunk 有 overlap 重叠
pub fn chunk_text(text: &str, chunk_size: usize) -> Vec<String> {
    const OVERLAP: usize = 150; // 增大 overlap，减少知识点被截断
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= chunk_size {
        return vec![chars.iter().collect()];
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let end = (start + chunk_size).min(chars.len());
        chunks.push(chars[start..end].iter().collect());
        start += chunk_size.saturating_sub(OVERLAP);
    }
    chunks
}
