# Task 0.1 验证结果：ort crate + bge 模型 PoC

## 执行日期
2026-02-24

## 环境信息
- 平台：macOS（Apple Silicon，Darwin 24.5.0）
- Rust：通过 cargo 构建
- 目标架构：aarch64-apple-darwin

## 测试的 Crate 版本

| Crate | 版本 | 结果 |
|-------|------|------|
| `ort` | `2.0.0-rc.11` | **编译成功，运行正常** |
| `ort` | `"2"`（无指定 RC） | 失败：需明确指定预发布版本号 |

## 编译结果

**最终配置（成功）：**

```toml
[dependencies]
ort = { version = "2.0.0-rc.11", features = ["download-binaries"] }
ndarray = "0.16"
anyhow = "1"
```

- 编译时间：约 17 秒（首次，含下载依赖）
- 运行输出：`PoC: ort crate 可以编译`
- 状态：**通过**

## 关键发现

### 1. ort 2.x 仍为预发布版
- 截至验证日期，`ort` crate 最新版为 `2.0.0-rc.11`（Release Candidate）
- Cargo 默认不选择预发布版本，必须在 `Cargo.toml` 中显式指定完整版本号

### 2. `download-binaries` feature 正常工作
- `ort` 的 `download-binaries` feature 会在构建时自动下载 onnxruntime 预编译二进制
- 在 macOS Apple Silicon 上下载和链接均成功，无需手动安装 onnxruntime

### 3. ort-sys 自动处理平台差异
- `ort-sys v2.0.0-rc.11` 作为底层 sys crate，封装了 onnxruntime C API
- Apple Silicon 平台支持良好

## 依赖树摘要（关键部分）
```
embedding-poc v0.1.0
├── ort v2.0.0-rc.11
│   └── ort-sys v2.0.0-rc.11（自动下载 onnxruntime 二进制）
├── ndarray v0.16.1
└── anyhow v1.0.102
```

## 下一步建议（Task 0.2）

1. **下载 bge-small-zh-v1.5 ONNX 模型**
   - 来源：Hugging Face `BAAI/bge-small-zh-v1.5`
   - 需要 `model.onnx` 和 `tokenizer.json`

2. **实现 tokenization**
   - 推荐使用 `tokenizers` crate（Hugging Face Rust 实现）
   - bge 模型使用 WordPiece tokenizer

3. **完整 embedding 推理代码骨架**
   ```rust
   use ort::{Environment, Session, Value};
   
   let env = Environment::builder().build()?;
   let session = Session::builder(&env)?
       .with_model_from_file("model.onnx")?;
   // tokenize -> inference -> normalize embedding
   ```

4. **性能基准测试**
   - 目标：单次 embedding 推理 < 50ms（Apple Silicon）

## 结论

**ort 2.0.0-rc.11 在 macOS Apple Silicon 上编译链接验证通过**，可作为 DocMind 项目的 embedding 推理基础。
