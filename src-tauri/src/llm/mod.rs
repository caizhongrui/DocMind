use anyhow::{anyhow, Result};
use llama_cpp_2::{
    context::params::LlamaContextParams,
    llama_backend::LlamaBackend,
    llama_batch::LlamaBatch,
    model::{params::LlamaModelParams, AddBos, LlamaModel, Special},
    sampling::LlamaSampler,
};
use std::{num::NonZero, path::Path};

/// 已加载的 LLM 实例（GGUF 格式，通过 llama.cpp 运行）
pub struct Llm {
    backend: LlamaBackend,
    model: LlamaModel,
}

// llama-cpp-2 的 LlamaBackend / LlamaModel 内部是裸指针，
// 但在单线程使用模式下（Mutex 保护）我们手动声明 Send。
// SAFETY: AppState 通过 Mutex<Option<Llm>> 确保同一时刻只有一个线程访问。
unsafe impl Send for Llm {}

impl Llm {
    /// 从 GGUF 文件加载模型
    pub fn load(model_path: &Path) -> Result<Self> {
        let backend = LlamaBackend::init()?;

        let model_params = LlamaModelParams::default()
            .with_n_gpu_layers(999); // Metal: 尽量 offload 到 GPU

        let model = LlamaModel::load_from_file(
            &backend,
            model_path,
            &model_params,
        )?;

        Ok(Self { backend, model })
    }

    /// 根据模型参数量推算 RAG 检索时合适的 chunk 上限
    ///
    /// 参数量越小的模型，处理长上下文的能力越弱，应传入更少的 chunk 以减少干扰：
    ///   < 1B  → 3 chunks
    ///   1–3B  → 5 chunks
    ///   3–7B  → 8 chunks
    ///   > 7B  → 12 chunks
    pub fn rag_max_chunks(&self) -> usize {
        let n = self.model.n_params();
        match n {
            0..=1_000_000_000 => 4,
            1_000_000_001..=3_000_000_000 => 6,
            3_000_000_001..=7_000_000_000 => 10,
            _ => 16,
        }
    }

    /// 流式生成文本，每产出一个 token 片段调用 on_token 回调
    #[allow(deprecated)]
    pub fn generate_stream<F>(
        &self,
        prompt: &str,
        max_new_tokens: usize,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
        mut on_token: F,
    ) -> anyhow::Result<()>
    where
        F: FnMut(&str),
    {
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(Some(NonZero::new(16384u32).unwrap()))
            .with_n_batch(512);

        let mut ctx = self.model.new_context(&self.backend, ctx_params)?;

        let tokens = self
            .model
            .str_to_token(prompt, AddBos::Never)
            .map_err(|e| anyhow!("tokenize error: {e}"))?;

        if tokens.is_empty() {
            return Ok(());
        }

        let n_prompt = tokens.len();
        let n_batch = 512usize;
        let mut batch = LlamaBatch::new(n_batch, 1);
        let mut pos = 0usize;
        while pos < n_prompt {
            batch.clear();
            let end = (pos + n_batch).min(n_prompt);
            for i in pos..end {
                let is_last = i == n_prompt - 1;
                batch.add(tokens[i], i as i32, &[0], is_last)
                    .map_err(|e| anyhow!("batch.add error: {e}"))?;
            }
            ctx.decode(&mut batch)
                .map_err(|e| anyhow!("decode error: {e}"))?;
            pos = end;
        }

        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::temp(0.3),
            LlamaSampler::top_p(0.9, 5),
            LlamaSampler::dist(42),
        ]);

        let eos = self.model.token_eos();
        let last_batch_idx = ((n_prompt - 1) % n_batch) as i32;
        let mut token = sampler.sample(&ctx, last_batch_idx);
        let mut n_cur = n_prompt;

        loop {
            // 检测取消请求
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }

            if token == eos || n_cur >= n_prompt + max_new_tokens {
                break;
            }

            let piece = self
                .model
                .token_to_str(token, Special::Plaintext)
                .map_err(|e| anyhow!("token_to_str error: {e}"))?;

            // 遇到 <|im_end|> 标记也停止（Qwen 等 chat 模型的回合结束符）
            if piece == "<|im_end|>" || piece == "<|endoftext|>" {
                break;
            }

            on_token(&piece);
            sampler.accept(token);

            batch.clear();
            batch.add(token, n_cur as i32, &[0], true)
                .map_err(|e| anyhow!("batch.add error: {e}"))?;
            ctx.decode(&mut batch)
                .map_err(|e| anyhow!("decode error: {e}"))?;
            n_cur += 1;

            token = sampler.sample(&ctx, 0);
        }

        Ok(())
    }

    /// 生成文本（阻塞），返回完整回答字符串
    #[allow(deprecated)]
    pub fn generate(&self, prompt: &str, max_new_tokens: usize) -> Result<String> {
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(Some(NonZero::new(16384u32).unwrap()))
            .with_n_batch(512);

        let mut ctx = self.model.new_context(&self.backend, ctx_params)?;

        // Tokenize
        let tokens = self
            .model
            .str_to_token(prompt, AddBos::Never)
            .map_err(|e| anyhow!("tokenize error: {e}"))?;

        if tokens.is_empty() {
            return Ok(String::new());
        }

        let n_prompt = tokens.len();

        // 分批处理 prompt（每批最多 512 个 token）
        let n_batch = 512usize;
        let mut batch = LlamaBatch::new(n_batch, 1);
        let mut pos = 0usize;
        while pos < n_prompt {
            batch.clear();
            let end = (pos + n_batch).min(n_prompt);
            for i in pos..end {
                let is_last = i == n_prompt - 1;
                batch.add(tokens[i], i as i32, &[0], is_last)
                    .map_err(|e| anyhow!("batch.add error: {e}"))?;
            }
            ctx.decode(&mut batch)
                .map_err(|e| anyhow!("decode error: {e}"))?;
            pos = end;
        }

        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::temp(0.3),
            LlamaSampler::top_p(0.9, 5),
            LlamaSampler::dist(42),
        ]);

        let eos = self.model.token_eos();
        let mut output = String::new();

        // 初始采样：从 prompt 最后一个 token 的 logits（batch 中唯一开启了 logits 的位置）
        // 分批处理完成后，最后一批中最后一个 token 的 batch index = (n_prompt-1) % n_batch
        let last_batch_idx = ((n_prompt - 1) % n_batch) as i32;
        let mut token = sampler.sample(&ctx, last_batch_idx);

        let mut n_cur = n_prompt;
        loop {
            if token == eos || n_cur >= n_prompt + max_new_tokens {
                break;
            }

            let piece = self
                .model
                .token_to_str(token, Special::Plaintext)
                .map_err(|e| anyhow!("token_to_str error: {e}"))?;

            if piece == "<|im_end|>" || piece == "<|endoftext|>" {
                break;
            }

            output.push_str(&piece);
            sampler.accept(token);

            // 自回归步骤：每次只有 1 个 token，batch index 始终为 0
            batch.clear();
            batch.add(token, n_cur as i32, &[0], true)
                .map_err(|e| anyhow!("batch.add error: {e}"))?;
            ctx.decode(&mut batch)
                .map_err(|e| anyhow!("decode error: {e}"))?;
            n_cur += 1;

            token = sampler.sample(&ctx, 0);
        }

        Ok(output)
    }
}
