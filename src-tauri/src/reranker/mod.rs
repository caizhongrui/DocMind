//! BGE 跨编码器重排序模型(ONNX 推理)。
//!
//! 用于 RAG 第二阶段:把混合检索召回的 50-100 个候选 chunk 按"查询-文档"
//! 真实相关性重新排序,比单 embedding 准很多。
//!
//! ## 设计要点
//! - 模型放在 `<data_dir>/models/bge-reranker-v2-m3/`,首次启动时由前端
//!   触发下载(同 embedder 路径,但**可选**——缺失时优雅跳过)。
//! - 推理输入是 (query, passage) 对,tokenize 时拼成 `[CLS] q [SEP] p [SEP]`。
//! - 输出 logits → sigmoid → 相关性分数 ∈ [0, 1]。
//! - 单次推理是 batch=1,score N 个候选就跑 N 次。bge-reranker-base 在
//!   M1 CPU 上一次约 30-60ms,50 个候选总共 1.5-3 秒,可接受。

use anyhow::Result;
use ort::{session::Session, value::Tensor};
use std::path::Path;
use tokenizers::Tokenizer;

/// reranker 的最大序列长度。query + passage 一起 ≤ 这个值;
/// 超过的 passage 会被截断(前端 chunk 一般 800 字符 ≈ ≤ 500 tokens,有富余)。
const MAX_LENGTH: usize = 512;

pub struct Reranker {
    session: Session,
    tokenizer: Tokenizer,
    /// 是否需要 `token_type_ids` 输入(None = 还没探测过)。
    /// 第一次推理时 try-then-fallback 探测一次,后续直接走对的路径。
    /// 不同版本 ONNX:
    /// - BAAI 官方:通常有
    /// - Xenova(transformers.js)转换:经常没有
    has_token_type_ids: Option<bool>,
}

impl Reranker {
    /// 从指定目录加载模型。model_dir 需含 model.onnx + tokenizer.json。
    /// 优先尝试量化版 `model_quantized.onnx`(~70MB),fallback 到 `model.onnx`。
    pub fn load(model_dir: &Path) -> Result<Self> {
        let quantized = model_dir.join("model_quantized.onnx");
        let model_path = if quantized.exists() {
            quantized
        } else {
            model_dir.join("model.onnx")
        };
        let session = Session::builder()?
            .with_intra_threads(2)?
            .commit_from_file(&model_path)?;
        let tokenizer = Tokenizer::from_file(model_dir.join("tokenizer.json"))
            .map_err(|e| anyhow::anyhow!("reranker tokenizer load: {}", e))?;
        Ok(Self { session, tokenizer, has_token_type_ids: None })
    }

    /// 是否本地已就绪(任一 ONNX 文件 + tokenizer 存在即视为可用)。
    pub fn is_available(model_dir: &Path) -> bool {
        let has_onnx = model_dir.join("model_quantized.onnx").exists()
            || model_dir.join("model.onnx").exists();
        has_onnx && model_dir.join("tokenizer.json").exists()
    }

    /// 启动时跑一次空查询,触发 ONNX graph JIT 初始化,避免**用户的第一次
    /// 真实问答**承担 1-3 秒的冷启动延迟。失败也不影响后续使用,只是首次
    /// 实际推理会慢一点。
    pub fn warmup(&mut self) {
        let start = std::time::Instant::now();
        match self.score_one("warmup", "dummy passage for graph initialization") {
            Ok(_) => eprintln!("[reranker] warmup done in {}ms", start.elapsed().as_millis()),
            Err(e) => eprintln!("[reranker] warmup failed (will retry lazily): {e}"),
        }
    }

    /// 给一组 (query, passage) 打分,返回每个 passage 的相关性分数 ∈ [0, 1]。
    ///
    /// 调用方应避免对同一 query 重复 tokenize —— 但实现里我们逐对 encode
    /// 是为了简单,性能损失可控(tokenize 只占几个百分点)。
    pub fn score_batch(&mut self, query: &str, passages: &[&str]) -> Result<Vec<f32>> {
        let mut scores = Vec::with_capacity(passages.len());
        for p in passages {
            scores.push(self.score_one(query, p)?);
        }
        Ok(scores)
    }

    /// 单对评分。
    pub fn score_one(&mut self, query: &str, passage: &str) -> Result<f32> {
        // BGE-reranker 使用 cross-encoder:把 query 和 passage 拼成一对
        // 让 tokenizer 自动加 [CLS]/[SEP]。
        let encoding = self
            .tokenizer
            .encode((query, passage), true)
            .map_err(|e| anyhow::anyhow!("reranker encode: {}", e))?;

        let ids: Vec<i64> = encoding.get_ids().iter().map(|&x| x as i64).collect();
        let mask: Vec<i64> = encoding
            .get_attention_mask()
            .iter()
            .map(|&x| x as i64)
            .collect();

        let len = ids.len().min(MAX_LENGTH);
        let ids = ids[..len].to_vec();
        let mask = mask[..len].to_vec();

        let ids_tensor = Tensor::<i64>::from_array(([1, len], ids))?;
        let mask_tensor = Tensor::<i64>::from_array(([1, len], mask))?;
        let token_type_ids: Vec<i64> = encoding
            .get_type_ids()
            .iter()
            .take(len)
            .map(|&x| x as i64)
            .collect();

        // 按缓存的探测结果选择输入集;首次调用为 None,试错一遍并记下
        // 正确路径,后续不再多花一次失败 retry。
        let outputs = match self.has_token_type_ids {
            Some(true) => {
                let tt_tensor = Tensor::<i64>::from_array(([1, len], token_type_ids))?;
                self.session.run(ort::inputs![
                    "input_ids" => ids_tensor.into_dyn(),
                    "attention_mask" => mask_tensor.into_dyn(),
                    "token_type_ids" => tt_tensor.into_dyn(),
                ])?
            }
            Some(false) => self.session.run(ort::inputs![
                "input_ids" => ids_tensor.into_dyn(),
                "attention_mask" => mask_tensor.into_dyn(),
            ])?,
            None => {
                // 第一次:试不带 token_type_ids(更常见),失败 → 再试带的版本。
                // 注意 SessionOutputs<'_> 持有 session 的引用,不能让它在
                // retry 时存活,否则第二次 run() 会重复借用。
                // 做法:在 try-without 分支里**直接消耗 outputs 解析出标量分数**,
                //   然后只保留 f32 + 探测结果两个 Copy 值跨越分支返回。
                let ids_t = Tensor::<i64>::from_array(
                    ([1, len], encoding.get_ids().iter().take(len).map(|&x| x as i64).collect::<Vec<_>>()))?;
                let mask_t = Tensor::<i64>::from_array(
                    ([1, len], encoding.get_attention_mask().iter().take(len).map(|&x| x as i64).collect::<Vec<_>>()))?;
                let try_without_score: std::result::Result<f32, String> = match self.session.run(ort::inputs![
                    "input_ids" => ids_t.into_dyn(),
                    "attention_mask" => mask_t.into_dyn(),
                ]) {
                    Ok(out) => {
                        // 内联解析,避免 SessionOutputs 跨分支存活。
                        // 这里用 String 错误而不是 anyhow,所以单独包一层 (|| ...)()。
                        (|| -> std::result::Result<f32, String> {
                            let first = out
                                .iter()
                                .next()
                                .ok_or_else(|| "no output tensor".to_string())?;
                            let (_shape, data) = first
                                .1
                                .try_extract_tensor::<f32>()
                                .map_err(|e| e.to_string())?;
                            if data.is_empty() {
                                return Err("empty output".to_string());
                            }
                            let logit = if data.len() >= 2 { data[1] - data[0] } else { data[0] };
                            Ok(sigmoid(logit))
                        })()
                    }
                    Err(e) => Err(e.to_string()),
                };
                match try_without_score {
                    Ok(score) => {
                        eprintln!("[reranker] detected: model does NOT need token_type_ids");
                        self.has_token_type_ids = Some(false);
                        return Ok(score); // 已经算出分数,直接返回
                    }
                    Err(e1) => {
                        eprintln!("[reranker] without token_type_ids failed ({e1}); retrying with token_type_ids");
                        let ids_t2 = Tensor::<i64>::from_array(
                            ([1, len], encoding.get_ids().iter().take(len).map(|&x| x as i64).collect::<Vec<_>>()))?;
                        let mask_t2 = Tensor::<i64>::from_array(
                            ([1, len], encoding.get_attention_mask().iter().take(len).map(|&x| x as i64).collect::<Vec<_>>()))?;
                        let tt_t2 = Tensor::<i64>::from_array(([1, len], token_type_ids))?;
                        let out = self.session.run(ort::inputs![
                            "input_ids" => ids_t2.into_dyn(),
                            "attention_mask" => mask_t2.into_dyn(),
                            "token_type_ids" => tt_t2.into_dyn(),
                        ])?;
                        eprintln!("[reranker] detected: model DOES need token_type_ids");
                        self.has_token_type_ids = Some(true);
                        out
                    }
                }
            }
        };

        // 输出名取首个张量,跨权重版本兼容("logits" / "score" 均见过)。
        // 必须把 ValueRef 绑定到一个 let,避免 try_extract_tensor 的借用
        // 引用一个临时 tuple 而被立即释放。
        let first_output = outputs
            .iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("reranker: no output tensor"))?;
        let (_shape, data) = first_output.1.try_extract_tensor::<f32>()?;
        if data.is_empty() {
            return Err(anyhow::anyhow!("reranker: empty output"));
        }
        // 模型输出可能是 [1, 1](单 logit)或 [1, 2](二分类 logits)
        let logit = if data.len() >= 2 {
            // 二分类时取 "相关" 类(index 1)的概率
            data[1] - data[0] // 等价于 sigmoid 之后的对数赔率,排序意义保留
        } else {
            data[0]
        };
        Ok(sigmoid(logit))
    }
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}
