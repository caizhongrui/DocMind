// 所有平台使用真实 llama.cpp 推理
// macOS：Metal GPU 加速（with_n_gpu_layers = 999）
// Windows / Linux：CPU 推理（with_n_gpu_layers = 0）

use anyhow::{anyhow, Result};
use encoding_rs::UTF_8;
use llama_cpp_2::{
    context::params::LlamaContextParams,
    llama_backend::LlamaBackend,
    llama_batch::LlamaBatch,
    model::{params::LlamaModelParams, AddBos, LlamaModel},
    sampling::LlamaSampler,
};
use std::{num::NonZero, path::Path};

pub struct Llm {
    // 字段 drop 顺序 = 声明顺序：model 先释放（llama_free_model），
    // 再释放 backend（llama_backend_free / Metal 上下文）。
    // 若 backend 先 drop，Metal 设备已被释放，model drop 时 llama_free_model
    // 尝试释放 Metal buffer 会陷入死锁 / crash，导致线程挂死。
    model: LlamaModel,
    backend: LlamaBackend,
}

// llama-cpp-2 的 LlamaBackend / LlamaModel 内部是裸指针，
// 但在单线程使用模式下（Mutex 保护）我们手动声明 Send。
// SAFETY: AppState 通过 Mutex<Option<Llm>> 确保同一时刻只有一个线程访问。
unsafe impl Send for Llm {}

impl Llm {
    pub fn load(model_path: &Path) -> Result<Self> {
        let backend = LlamaBackend::init()?;

        // macOS：所有层卸载到 Metal GPU；Windows/Linux：仅使用 CPU
        #[cfg(target_os = "macos")]
        let model_params = LlamaModelParams::default().with_n_gpu_layers(999);
        #[cfg(not(target_os = "macos"))]
        let model_params = LlamaModelParams::default().with_n_gpu_layers(0);

        let model = LlamaModel::load_from_file(&backend, model_path, &model_params)?;
        Ok(Self { backend, model })
    }

    pub fn rag_max_chunks(&self) -> usize {
        let n = self.model.n_params();
        match n {
            0..=1_000_000_000 => 4,
            1_000_000_001..=3_000_000_000 => 6,
            3_000_000_001..=7_000_000_000 => 10,
            _ => 16,
        }
    }

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
                batch
                    .add(tokens[i], i as i32, &[0], is_last)
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

        // 关键:跨 token 持有同一个 UTF-8 decoder。
        //   Qwen3 的 tokenizer 把单个汉字(3 字节)经常拆成 2-3 个 byte-level
        //   token。如果每次都 `token_to_str` 新建 decoder,半截字节会被
        //   replacement-char 化或直接丢失,导致"公司"→"司"、"税号"→"号"
        //   这种首字丢失。`token_to_piece` 接受外部 decoder,partial bytes
        //   在 decoder state 里保留,等下一个 token 把字补全。
        let mut decoder = UTF_8.new_decoder();

        loop {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            if token == eos || n_cur >= n_prompt + max_new_tokens {
                break;
            }
            // **不要直接用 `token_to_piece`**:它内部 `String::with_capacity(bytes.len())`,
            // 当一个 token 只贡献 1 字节(比如 Qwen 把"公"E5,85,AC 拆成 [...85] 和 [AC]
            // 两个 token,后者只 1 字节),decoder 要输出"公"3 字节,但 String 只有 1 字节
            // 容量 → `OutputFull` → 字节被丢 → "公"消失。
            //
            // 自己手动 token_to_bytes + 给 String 留充裕 capacity(32 字节,足够
            // 容纳累计缓存 + 当前 token 的所有可能输出),完美绕过这个 bug。
            let piece_bytes = self
                .model
                .token_to_bytes(token, llama_cpp_2::model::Special::Plaintext)
                .map_err(|e| anyhow!("token_to_bytes error: {e}"))?;
            let mut piece = String::with_capacity(piece_bytes.len() + 16);
            let _ = decoder.decode_to_string(&piece_bytes, &mut piece, /* last= */ false);
            if piece == "<|im_end|>" || piece == "<|endoftext|>" {
                break;
            }
            if !piece.is_empty() {
                on_token(&piece);
            }
            sampler.accept(token);
            batch.clear();
            batch
                .add(token, n_cur as i32, &[0], true)
                .map_err(|e| anyhow!("batch.add error: {e}"))?;
            ctx.decode(&mut batch)
                .map_err(|e| anyhow!("decode error: {e}"))?;
            n_cur += 1;
            token = sampler.sample(&ctx, 0);
        }

        // 循环结束时,如果 decoder 里还有 buffered 字节(不太可能,但保险),
        // 给它一个机会冲刷出来
        let mut tail = String::new();
        let _ = decoder.decode_to_string(&[], &mut tail, /* last= */ true);
        if !tail.is_empty() {
            on_token(&tail);
        }

        Ok(())
    }

    #[allow(deprecated)]
    pub fn generate(&self, prompt: &str, max_new_tokens: usize) -> Result<String> {
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(Some(NonZero::new(16384u32).unwrap()))
            .with_n_batch(512);

        let mut ctx = self.model.new_context(&self.backend, ctx_params)?;

        let tokens = self
            .model
            .str_to_token(prompt, AddBos::Never)
            .map_err(|e| anyhow!("tokenize error: {e}"))?;

        if tokens.is_empty() {
            return Ok(String::new());
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
                batch
                    .add(tokens[i], i as i32, &[0], is_last)
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
        let last_batch_idx = ((n_prompt - 1) % n_batch) as i32;
        let mut token = sampler.sample(&ctx, last_batch_idx);
        let mut n_cur = n_prompt;

        // 跨 token 持有同一 decoder,避免半截 UTF-8 字节被丢弃(汉字丢字 bug)
        let mut decoder = UTF_8.new_decoder();

        loop {
            if token == eos || n_cur >= n_prompt + max_new_tokens {
                break;
            }
            // 同 streaming 路径:绕开 token_to_piece 的容量 bug
            let piece_bytes = self
                .model
                .token_to_bytes(token, llama_cpp_2::model::Special::Plaintext)
                .map_err(|e| anyhow!("token_to_bytes error: {e}"))?;
            let mut piece = String::with_capacity(piece_bytes.len() + 16);
            let _ = decoder.decode_to_string(&piece_bytes, &mut piece, /* last= */ false);
            if piece == "<|im_end|>" || piece == "<|endoftext|>" {
                break;
            }
            output.push_str(&piece);
            sampler.accept(token);
            batch.clear();
            batch
                .add(token, n_cur as i32, &[0], true)
                .map_err(|e| anyhow!("batch.add error: {e}"))?;
            ctx.decode(&mut batch)
                .map_err(|e| anyhow!("decode error: {e}"))?;
            n_cur += 1;
            token = sampler.sample(&ctx, 0);
        }

        // 冲刷 decoder 里残留的字节
        let _ = decoder.decode_to_string(&[], &mut output, /* last= */ true);

        Ok(output)
    }
}
