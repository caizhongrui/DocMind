# DocMind Monetization & Self-Hosted Backend Design

**Date:** 2026-05-08
**Scope:** 付费功能门控 + 自建 license / updater 后端
**Status:** Spec finalized,等待批准进入实施

---

## Goal

把 DocMind 从"开源/试用"形态升级为"Free + Pro"分层产品,所有付费基础设施(license 签发、支付、版本分发、管理后台)在备案的本地服务器上单 Docker 自建,完全国内可用,支持内网/离线场景。

## Non-Goals

- 不做多设备 license / 不做设备转移 / 不做客服解绑流程
- 不做月度订阅(只卖终身买断)
- 不做语义模型分级以外的"高级嵌入模型"等增项 — Pro 范围严格限定本 spec
- 不做用户账号体系(无注册、无登录,license key 即身份)
- 不做按量计费(无 API 调用付费、无文档份数计费)

---

## Pricing

| 档位 | 价格 | 说明 |
|---|---:|---|
| **Free** | ¥0 | 完整本地搜索能力,30 次/月 AI 调用(0.6B 模型) |
| **Pro 试用** | ¥0 | 首次安装自动开启 5 天全功能 Pro |
| **Pro 终身** | ¥20 | 一次买断,永久使用,绑定一台设备,**不可转移** |

**取消的方案**:
- ¥5/月 月付 — 与 ¥20 终身价差小、月付加复杂度,直接砍
- 多设备/家庭包 — 个人工具型产品,YAGNI

---

## Free vs Pro 功能矩阵

| 能力 | Free | Trial(5天)| Pro |
|---|:---:|:---:|:---:|
| **基础搜索** | | | |
| 全文搜索(Tantivy)| ✅ | ✅ | ✅ |
| 文件名搜索 | ✅ | ✅ | ✅ |
| 多文件夹监听(无限)| ✅ | ✅ | ✅ |
| 文件类型筛选 / 排序 / 历史 | ✅ | ✅ | ✅ |
| 全局快捷键 | ✅ | ✅ | ✅ |
| **预览** | | | |
| PDF / Office / 文本 / ZIP | ✅ | ✅ | ✅ |
| **AI** | | | |
| 语义搜索 | 🟡 30 次/月 | ✅ 无限 | ✅ 无限 |
| 文档问答(RAG)| 🟡 30 次/月 | ✅ 无限 | ✅ 无限 |
| 可用模型 | 0.6B only | 全部(0.6B/1.7B/4B)| 全部 |
| 自定义 GGUF 导入 | ❌ | ❌(防绕过)| ✅ |
| 批量摘要 | ❌ | ✅ | ✅ |
| **OCR** | | | |
| 图片 / 扫描 PDF 索引 | ❌ | ✅ | ✅ |
| **生产力** | | | |
| 对话导出(Markdown)| ❌ | ✅ | ✅ |
| CSV 大批量导出(>100 条)| ❌ | ✅ | ✅ |
| 定时重索引 | ❌ | ✅ | ✅ |

**配额计数(Free)**:
- 语义搜索 + 问答合并计入 30 次/月
- 本地 SQLite 计数器,按月本地重置(基于 system clock)
- 配额耗尽时:搜索栏右侧 chip 显示 `30/30`,语义/问答按钮 disabled,点击弹升级对话框

**Trial 限制(故意保留的)**:
- 不允许导入自定义 GGUF — 防止用户在试用期内"伪装"成 Pro,通过导入大模型绕过限制

---

## License 设计

### 协议

License 是 Ed25519 签名的 JSON,**完全离线验证**:

```json
{
  "v": 1,
  "key": "DM-XXXX-XXXX-XXXX-XXXX-XXXX",
  "plan": "lifetime",                       // "lifetime" | "trial"
  "fingerprint": "<sha256_hex_32>",         // 绑定的硬件指纹
  "issued_at": "2026-05-08T10:00:00Z",
  "expires_at": null,                       // lifetime: null;trial: issued_at + 5d
  "sig": "<ed25519_signature_base64>"       // 服务端私钥签名
}
```

**客户端验证流程**:
1. 读 `~/Library/Application Support/com.caizhongrui.docmind/license.json`
2. Ed25519 验签(公钥硬编码在客户端)
3. 检查 `fingerprint` == 当前硬件指纹
4. 若有 `expires_at` → 检查未过期
5. 全部通过 → 解锁 `plan` 对应能力

**绝不联网复核**(终身版生效后永远不再调服务器)。

### 硬件指纹

```
fingerprint = SHA256(
    platform_uuid +
    serial_or_machine_guid +
    APP_SECRET                  // 客户端硬编码,防外部伪造
)[..32]
```

**取值来源**:

| 平台 | 主源 | 辅源 |
|---|---|---|
| macOS | `IOPlatformUUID` | `IOPlatformSerialNumber` |
| Windows | `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` | `wmic csproduct get UUID` |
| Linux | `/etc/machine-id` | DMI product UUID |

**何时指纹会变(license 失效)**:
- 更换主板 / 更换主机
- 重装系统(machine_id 通常会变)
- 升级硬件改变 BIOS UUID

**用户在购买前必须见到的提示**(三处):
1. 落地页定价区
2. PayJS 支付前确认页(必须勾选 checkbox)
3. 客户端首次激活页

文案统一:
> ⚠️ License 绑定到当前设备的硬件指纹。一旦激活,无法转移到其他设备。换机、重装系统、更换主板都将导致 License 失效需重新购买。请确认在常用设备上完成激活。
> [ ] 我已了解上述限制,并同意完成购买

### Trial → Free 降级(防绕过)

5 天试用结束后,客户端必须**强制**回退到 Free 状态。**四道闸门**:

**闸门 1 — 启动期完整性校验**(无条件执行)
```rust
// src-tauri/src/lib.rs setup hook 的最早期
fn enforce_license_consistency(app: &AppHandle) -> Result<()> {
    let license = read_local_license()?;     // 可能是 trial / pro / free / 不存在
    let current_state = match license {
        None => LicenseState::Free,
        Some(l) if !verify_signature(&l) => LicenseState::Free,
        Some(l) if l.fingerprint != hardware_fingerprint() => LicenseState::Free,
        Some(l) if matches!(l.plan, Plan::Trial) && l.expires_at < now() => LicenseState::Free,
        Some(l) => LicenseState::Active(l),
    };
    
    // 强制对齐 last_llm_path 与 license 允许范围
    if !is_model_allowed(&db.get("last_llm_path"), &current_state) {
        db.set("last_llm_path", default_model_for(&current_state));
        emit_event("llm-downgraded");
    }
    Ok(())
}
```

**闸门 2 — 加载模型时**
`load_llm_model(path)` 命令开头校验:
```rust
let model_id = resolve_model_id(&path);  // qwen3-0.6b / 1.7b / 4b / custom
let state = license_state.read()?;
if !is_model_allowed(&model_id, &state) {
    return Err("PRO_REQUIRED:model_tier".into());
}
// 自定义 GGUF 一律视为 Pro
if model_id == "custom" && !state.is_pro_active() {
    return Err("PRO_REQUIRED:custom_gguf".into());
}
```

**闸门 3 — License 状态变化时**(试用期满或手动登出)
```rust
async fn force_downgrade_if_needed() {
    let current_loaded = llm_state.current_path();
    if !is_path_allowed_under_current_license(&current_loaded) {
        llm.unload();
        db.clear("last_llm_path");
        emit_event("llm-force-unloaded");
    }
}
```

**闸门 4 — Pro 命令防御**
所有 Pro Tauri 命令开头一律校验:
```rust
#[require_pro]   // 自定义宏
async fn import_custom_gguf(...) { ... }
```

宏展开为:
```rust
async fn import_custom_gguf(state: State<AppState>, ...) -> Result<...> {
    if !state.license.read().await.is_pro_active() {
        return Err("PRO_REQUIRED:custom_gguf".into());
    }
    // 原逻辑
}
```

**Pro 命令清单**(全部加 `#[require_pro]`):
- `import_custom_gguf`
- `summarize_documents`
- `start_ocr_indexing`(新增,把 OCR 提取从默认管线分离)
- `export_conversation`
- `export_csv_large`(>100 条时)
- `set_reindex_interval`

---

## 服务端架构

### 部署形态(双子域共用单容器)

```
[客户机器 / 浏览器]
        ↓ HTTPS
┌────────────────────────────────────────────────────────────┐
│  备案服务器                                                 │
│  └── 单 Docker 容器 docmind/server:latest                  │
│      ├── Caddy(自动 ACME)                                 │
│      │   ├── docmind.app          → 静态门户站(Astro 产物)│
│      │   └── api.docmind.app      → Axum API + admin      │
│      ├── Axum API server                                   │
│      ├── 嵌入式 SQLite(/data/db/docmind.sqlite)           │
│      ├── 静态文件服务(/data/releases/)                    │
│      ├── 门户站静态产物(/app/portal/dist/)               │
│      └── 私钥(/data/keys/ed25519.priv)                    │
└────────────────────────────────────────────────────────────┘
```

**子域职责**:

| 子域 | 用途 | 技术 |
|---|---|---|
| `docmind.app` | 营销门户(SEO + 转化)| Astro 静态站,产品营销风(亮色) |
| `api.docmind.app` | License / 支付 / 更新 / 管理 / 激活 / 下载 | Axum |

两个子域指向同一台备案服务器同一容器,Caddy 通过 `Host` 头分流。

### 路由

**`docmind.app`(静态门户)**
```
/                         首页:Hero + 三大核心卖点 + 截图 + 主 CTA
/features                 功能详解:全文/语义/问答/OCR/隐私 五大分块
/pricing                  定价对比表 + 设备绑定提示 + 购买按钮
/download                 下载页:macOS/Windows 直链 + 系统要求 + sha256
/docs                     使用文档首页(侧边栏导航)
/docs/getting-started     入门
/docs/search-syntax       搜索语法
/docs/ai-qa               AI 问答指南
/docs/faq                 常见问题
/changelog                版本历史(构建期从 api 拉取)
/privacy                  隐私政策
/terms                    服务条款
/contact                  联系方式
sitemap.xml / robots.txt  SEO 必备
```

**`api.docmind.app`(动态服务)**
```
GET  /activate?key=DM-XXXX                  激活页(展示 key + 设备识别 + 提交)

POST /api/v1/license/activate               { key, fingerprint } → LicenseToken
POST /api/v1/payment/payjs/webhook          PayJS 异步通知
GET  /api/v1/releases/public                公开 changelog JSON(供门户站构建期拉取)

GET  /api/v1/updates/{platform}/{cur_ver}   Tauri updater manifest
GET  /releases/free/<platform>/<file>       免费版二进制(公开,记录下载)
GET  /releases/pro/<platform>/<file>        Pro 版二进制(需 Bearer license_token)

POST /admin/login                           Basic Auth
GET  /admin                                 概览
GET  /admin/licenses                        License 列表
GET  /admin/licenses/{key}                  License 详情(只读,无解绑)
GET  /admin/orders                          订单流水
GET  /admin/downloads                       下载日志
GET  /admin/releases                        版本管理
POST /admin/releases/upload                 上传新版本
```

**跨域协作**:
- 门户站的"立即购买"按钮 → 跳 `https://api.docmind.app/payment/checkout?plan=lifetime`
- 门户站的"输入 key 激活"按钮 → 跳 `https://api.docmind.app/activate`
- API 端的 `/api/v1/releases/public` 在门户站 build 期被拉取一次,渲染进 `/changelog` 静态页;新版本发布后重 build 镜像即可
- 门户站不需要 cookies / session,完全静态

### 数据库 Schema

```sql
-- License 主表(支付成功后落库,激活时绑定 fingerprint)
CREATE TABLE licenses (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    key             TEXT UNIQUE NOT NULL,           -- "DM-XXXX-XXXX-XXXX-XXXX-XXXX"
    plan            TEXT NOT NULL,                  -- "lifetime"
    order_id        TEXT,                           -- PayJS 订单号
    buyer_email     TEXT,                           -- 可选,购买时收集
    bound_fingerprint  TEXT,                        -- 激活时填入,之后永不修改
    bound_at        TIMESTAMP,                      -- 激活时间
    machine_label   TEXT,                           -- 用户输入的机器名(可选)
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    note            TEXT                            -- admin 备注
);
CREATE INDEX idx_licenses_email ON licenses(buyer_email);
CREATE INDEX idx_licenses_order ON licenses(order_id);

-- 订单流水(PayJS webhook 写入)
CREATE TABLE orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    payjs_order_id  TEXT UNIQUE NOT NULL,
    out_trade_no    TEXT UNIQUE NOT NULL,           -- 我方订单号
    amount          INTEGER NOT NULL,               -- 单位:分(2000 = ¥20)
    paid_at         TIMESTAMP,
    payment_type    TEXT,                           -- "alipay" / "wechat"
    license_key     TEXT,                           -- 关联生成的 license
    raw_payload     TEXT,                           -- webhook 原始 body,便于排查
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 下载日志(每次访问 /releases/* 都记录)
CREATE TABLE downloads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    version         TEXT NOT NULL,                  -- "0.2.0"
    platform        TEXT NOT NULL,                  -- "darwin-aarch64" 等
    edition         TEXT NOT NULL,                  -- "free" | "pro"
    license_key     TEXT,                           -- pro 下载时的 key
    ip              TEXT NOT NULL,
    user_agent      TEXT,
    bytes_served    INTEGER
);
CREATE INDEX idx_downloads_ts ON downloads(ts);
CREATE INDEX idx_downloads_license ON downloads(license_key);

-- 版本元信息(发布版本时写入)
CREATE TABLE releases (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    version         TEXT NOT NULL,                  -- "0.2.0"
    platform        TEXT NOT NULL,                  -- "darwin-aarch64" 等
    edition         TEXT NOT NULL,                  -- "free" | "pro"
    file_path       TEXT NOT NULL,                  -- 相对 /data/releases/
    sha256          TEXT NOT NULL,
    size            INTEGER NOT NULL,
    signature       TEXT NOT NULL,                  -- Tauri updater 用的签名
    notes           TEXT,                           -- 更新日志
    published_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(version, platform, edition)
);
```

### 服务端校验关键点

**激活校验**(`POST /api/v1/license/activate`):
```rust
async fn activate(req: ActivateReq) -> Result<LicenseToken> {
    let lic = db.find_license(req.key)?;
    
    if lic.bound_fingerprint.is_some() {
        if lic.bound_fingerprint == Some(req.fingerprint) {
            // 同一设备重复激活,允许(用户重装应用)
            return Ok(sign_token(&lic));
        }
        return Err("DEVICE_BOUND".into());        // 已绑定其他设备 → 拒绝
    }
    
    db.bind_license(lic.key, req.fingerprint, req.machine_label)?;
    Ok(sign_token(&lic))
}
```

**Pro 二进制下载**(`GET /releases/pro/*`):
```rust
async fn pro_download(req: HttpRequest) -> Response {
    let token = req.bearer_token().ok_or(StatusCode::UNAUTHORIZED)?;
    let claims = verify_token(&token)?;             // 验签 + 检查 fingerprint
    if !claims.is_pro() { return forbidden(); }
    
    log_download(&claims.key, ...);
    serve_file(...)
}
```

---

## Docker 部署

`docker-compose.yml`(用户复制即用):

```yaml
services:
  docmind-server:
    image: docmind/server:latest
    container_name: docmind-server
    restart: unless-stopped
    ports:
      - "80:80"      # ACME HTTP-01 challenge
      - "443:443"
    volumes:
      - ./data:/data
    environment:
      DOMAIN: license.docmind.app
      ADMIN_PASSWORD: ${ADMIN_PASSWORD}
      ADMIN_USERNAME: admin
      PAYJS_MERCHANT_ID: ${PAYJS_MID}
      PAYJS_KEY: ${PAYJS_KEY}
      PAYJS_NOTIFY_URL: https://${DOMAIN}/api/v1/payment/payjs/webhook
      ACME_EMAIL: you@example.com
```

`install.sh`(一键安装):
```bash
#!/usr/bin/env bash
set -e
mkdir -p /var/docmind && cd /var/docmind
curl -O https://license.docmind.app/install/docker-compose.yml
curl -O https://license.docmind.app/install/.env.example
mv .env.example .env
echo "请编辑 .env 配置 PayJS 密钥和管理员密码,然后运行:"
echo "  docker compose up -d"
```

**首次启动容器自动**:
1. 检测 `/data/keys/ed25519.priv` → 不存在则生成新密钥对,打印公钥供烧入客户端
2. 检测 SQLite → migrate
3. Caddy 自动签 Let's Encrypt 证书
4. 启动 Axum 服务

**升级**:
```bash
docker pull docmind/server:latest
docker compose up -d
```
数据卷不变,平滑升级。

**备份**(用户自行 cron):
```bash
0 3 * * * tar czf /backup/docmind-$(date +\%F).tar.gz /var/docmind/data
```

---

## 管理后台范围

服务端渲染 HTML(Askama 模板),不引入 SPA。Basic Auth 保护。

| 页面 | 内容 |
|---|---|
| `/admin` | 概览:今日 / 本月销售 + 总用户数 + 活跃版本 + 最近 10 条订单 |
| `/admin/licenses` | License 表(搜索 key/email,筛选已绑定/未激活)|
| `/admin/licenses/{key}` | 只读详情:绑定的 fingerprint、绑定时间、机器标签、关联订单 |
| `/admin/orders` | 订单流水 + 每条订单关联的 license |
| `/admin/downloads` | 下载日志(按版本聚合 / 时间序列 / IP 列表)|
| `/admin/releases` | 版本列表 + 上传新版本表单 |

**手动签发 license**(异常处理时用,如赠送/退款重发):
- `/admin/licenses/issue` 表单填邮箱 → 生成新 license key → 入库 → 邮件发送(可选)
- 不做任何"解绑"按钮 — 设计目标就是没有

---

## Updater

客户端配置(`tauri.conf.json`):
```json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://license.docmind.app/api/v1/updates/{{target}}/{{current_version}}"
      ],
      "pubkey": "<TAURI_UPDATER_PUBLIC_KEY>"
    }
  }
}
```

服务端响应 manifest(标准 Tauri 格式):
```json
{
  "version": "0.2.0",
  "notes": "新增付费功能,支持 OCR 索引扫描件",
  "pub_date": "2026-05-08T10:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<base64_signature>",
      "url": "https://license.docmind.app/releases/free/darwin-aarch64/docmind_0.2.0.tar.gz"
    },
    "windows-x86_64": { ... }
  }
}
```

**Edition 选择**:
- updater 只分发 `free` edition 二进制(包含 Pro 功能代码,但默认锁住)
- Pro 功能通过 license 解锁,**不需要单独的 Pro 二进制包**
- 因此 updater 极简,所有用户走同一个版本流

---

## 营销门户站(docmind.app)

### 设计风格 — 产品营销路线(明确区别于客户端)

客户端是 Raycast 风(暗色优先、密集、工具感),门户站走**亮色 + 高转化**方向:

- **配色**:白色为主背景 + 蓝色品牌色(`#1677ff`)+ 大量留白
- **Hero**:大字标题 + 一句话价值主张 + 屏幕截图悬浮卡片 + 渐变背景
- **CTA**:鲜明的购买/下载按钮,首屏可见
- **截图**:每个功能配上动图或截图,展示真实体验
- **社交证明**:用户数 / 下载量 / 用户证言(早期可不放)
- **响应式**:桌面优先,但移动端不能挂

**字体**:`-apple-system` 系列做正文,标题用 **Inter** 增强西文质感,代码块/数据用 mono。

### 技术栈

| 层 | 选择 |
|---|---|
| **框架** | **Astro 4**(零 JS 输出 + 局部 React 岛屿,SEO 极佳)|
| **样式** | Tailwind CSS(快、约束清晰,适合营销页迭代)|
| **内容** | `/content/` 下 markdown 文件,Astro Content Collections 管理 docs/changelog |
| **图标** | `lucide-react` |
| **构建产物** | 纯静态 `dist/`(HTML/CSS/JS),Caddy 直接 serve |
| **构建** | 在客户端 Dockerfile 里:`pnpm build` → COPY 进容器 |

### 页面清单(10 个页面 + 站点资源)

| 路径 | 内容要点 |
|---|---|
| `/` | Hero(标题 + 副标题 + 主 CTA) / 三大核心卖点(本地隐私 / AI 语义 / 全格式)/ 功能截图轮播 / 用户场景 / 定价摘要 / FAQ 摘要 / 底部 CTA |
| `/features` | 五大分块:**全文搜索**(Tantivy + 文件类型 + 速度)/ **语义搜索**(本地嵌入)/ **AI 问答**(RAG + 引用源)/ **OCR**(扫描件 + 图片)/ **隐私**(零上传 + 离线推理) |
| `/pricing` | Free vs Pro 对比表(沿用 spec 矩阵) + 设备绑定**红色提示**(强制可见) + 立即购买按钮(跳 api 子域) + 已购用户激活入口 |
| `/download` | 平台选择卡片(macOS Apple Silicon / macOS Intel / Windows x64) + 系统要求 + SHA256 + 历史版本链接 + 安装指引 |
| `/docs` | Docs 首页:侧边栏导航 + 快速入门链接 + 搜索框(可选,DocSearch / Pagefind 本地索引)|
| `/docs/getting-started` | 装包 → 加文件夹 → 第一次搜索 → 触发问答 |
| `/docs/search-syntax` | AND/OR/NOT/精确短语 + 中英文混合 + 实例 |
| `/docs/ai-qa` | 模型档位说明 / 提问技巧 / 引用源解读 / 性能调优 |
| `/docs/faq` | ~15 条:为什么收费?换电脑怎么办?数据上传吗?支持 M1 吗?... |
| `/changelog` | 按版本倒序,从 `api/v1/releases/public` 构建期拉取后渲染 |
| `/privacy` | 数据归属:用户本地。模型推理:本地。下载日志:服务器仅留 IP/版本/时间。无 telemetry |
| `/terms` | License 范围(单设备 + 不可转移)、退款政策(7 天无条件 / 已激活后看情况)、责任限制 |
| `/contact` | 邮箱 + 微信(可选)+ GitHub Issues(可选)|

### 内容初稿策略

我会写出:
- **首页 hero 文案**(主+副标题,3 个版本备选)
- **三大卖点段落**(每段 ~50 字 + emoji/icon)
- **5 个 features 分块文案**(每块 ~150 字 + 关键截图位)
- **15 条 FAQ 初稿**
- **隐私 / 服务条款** 模板(基于通用模板改写)

你来定稿、提供截图、签发布。

### SEO 基础

- 每页独立 `<title>` + `<meta description>` + `<meta og:*>` + `<meta twitter:*>`
- `sitemap.xml` 自动生成(Astro 插件)
- `robots.txt`:`Allow: /`,屏蔽 `/admin`(api 子域)
- 结构化数据:`SoftwareApplication` schema(首页) + `FAQPage` schema(FAQ)
- 关键词主线:`本地文档搜索`、`AI 文档问答`、`PDF 全文搜索`、`隐私优先 文档管理`

### 部署集成

`Dockerfile` 多阶段构建:
```dockerfile
# Stage 1 - Portal build
FROM node:20-alpine AS portal-builder
WORKDIR /portal
COPY portal/ .
RUN corepack enable && pnpm install && pnpm build
# 产物:/portal/dist

# Stage 2 - API build
FROM rust:1.83 AS api-builder
WORKDIR /api
COPY server/ .
RUN cargo build --release

# Stage 3 - Runtime
FROM debian:bookworm-slim
COPY --from=portal-builder /portal/dist /app/portal
COPY --from=api-builder /api/target/release/docmind-server /usr/local/bin/
COPY Caddyfile /etc/caddy/Caddyfile
# Caddy 配置里 docmind.app 指向 /app/portal,api.docmind.app 反代到 :8080
ENTRYPOINT ["/entrypoint.sh"]
```

`Caddyfile`:
```
docmind.app {
    root * /app/portal
    file_server
    encode gzip zstd
    try_files {path} {path}.html /index.html
}

api.docmind.app {
    reverse_proxy localhost:8080
}
```

部署仍然是 `docker compose up -d` 一条命令,门户和 API 一起起。

---

## 客户端集成点

### 新增模块

```
src-tauri/src/license/
    mod.rs              入口
    fingerprint.rs      跨平台硬件指纹生成
    token.rs            LicenseToken 解析 + 验签
    storage.rs          license.json 读写
    state.rs            运行时 LicenseState 共享状态
    activate.rs         激活流程(调服务端)

src-tauri/src/quota/
    mod.rs              AI 调用配额计数(SQLite)

src-tauri/src/commands/
    license.rs          Tauri 命令:get_license_status / activate_license / start_trial
    [现有命令加 #[require_pro] 装饰]

src/components/
    LicenseStatusBar.tsx        顶栏右侧迷你状态条(Free/Trial/Pro)
    UpgradeDialog.tsx           升级对话框(被 PRO_REQUIRED 错误触发)
    ActivationPage.tsx          首次激活引导
    QuotaIndicator.tsx          搜索栏的 30/30 配额显示

src/stores/licenseStore.ts      Zustand: { state, plan, expiresAt, refresh() }
```

### 体验关键点

**首次启动**(无 license):
1. 自动判定为 Trial 起点
2. 写入本地 trial license(无需联网),标记 `expires_at = now + 5d`
3. 顶栏显示 `Trial · 4d 23h left` 倒计时

**Trial 过期**:
1. 闸门 1-4 联动,模型回退 + 数据保留
2. 弹一次性提示:"试用已结束,Free 模式可继续使用基础搜索。升级 Pro 解锁所有功能"
3. 顶栏变为 `Free · 30/30 quota`

**配额耗尽**:
1. 语义/问答按钮 disabled,加锁图标
2. 点击弹 UpgradeDialog,展示价格 + 立即购买按钮 + 已激活? 输入 key 链接

**激活流程**:
1. 用户访问 `https://license.docmind.app` → PayJS 付款 → 邮件收到 license key
2. 客户端"输入 license key"对话框
3. 客户端 POST `/api/v1/license/activate { key, fingerprint, machine_label }`
4. 服务端绑定 + 返回 LicenseToken
5. 客户端写入 `license.json`,刷新 UI 状态
6. 之后**永不联网**

---

## 实施阶段

按功能领域分组,可独立验收:

### Group 1 — 客户端付费基础(2.5 d)
| 阶段 | 内容 | 工作量 |
|---|---|---:|
| **4a** | License 协议 + 硬件指纹 + 客户端校验 crate | 0.5 d |
| **4h** | 客户端门控(`#[require_pro]` 宏 + 四道闸门)| 1 d |
| **4i** | 客户端 UI(LicenseStatusBar + UpgradeDialog + ActivationPage)| 1 d |

### Group 2 — 服务端核心(2.5 d)
| 阶段 | 内容 | 工作量 |
|---|---|---:|
| **4b** | 服务端骨架(Axum + SQLite + Caddy 双子域配置)| 0.5 d |
| **4c** | License 签发 / 激活 / 设备绑定 endpoints | 0.5 d |
| **4d** | PayJS 接入 + webhook + 订单管理 | 0.5 d |
| **4e** | Updater endpoint + 二进制管理 + 下载日志 | 0.5 d |
| **4f** | Admin UI(server-rendered)+ 激活页 | 0.5 d |

### Group 3 — 营销门户(2.5 d)
| 阶段 | 内容 | 工作量 |
|---|---|---:|
| **4k** | 门户站骨架(Astro + Tailwind + 主题 + 路由)| 0.5 d |
| **4l** | 静态页面实现(首页 / 定价 / 下载 / 联系)| 1 d |
| **4m** | 文档系统(MD + 侧边栏 + 5 篇 docs)| 0.5 d |
| **4n** | Changelog + 隐私 + 服务条款 + SEO + 内容初稿 | 0.5 d |

### Group 4 — 部署与联调(1 d)
| 阶段 | 内容 | 工作量 |
|---|---|---:|
| **4g** | Dockerfile(多阶段)+ docker-compose + install.sh + 部署文档 | 0.5 d |
| **4j** | 端到端联调(下单→收 key→激活→功能解锁→门户站跳转→更新版本)| 0.5 d |

### 总计

**8.5 个工作日**(原 6.5 + 门户 2 余).可以按 Group 顺序串行,也可在客户端 Group 1 跑通后并行 Group 2 与 Group 3。

---

## 风险与对策

| 风险 | 对策 |
|---|---|
| 服务器宕机导致用户无法激活 | 终身版激活后永不联网,只影响新增激活;Docker 容器自带 healthcheck + restart |
| 私钥泄漏导致 license 可伪造 | 私钥只存服务器 `/data/keys/`,容器内只读权限;轮换密钥需要全部用户重新激活,所以一开始就严格防护 |
| 用户改系统时间绕过 trial | 5 天试用本身价值有限,容忍;真要解决可加"启动时间序列单调性"检查,但 YAGNI |
| 硬件指纹算法不稳定(同机器多次取值不同)| 启动时缓存第一次的指纹到本地配置,后续都对比缓存值,只在用户主动重新激活时重新采样 |
| 用户重装系统后无法用 | 已在购买前充分提示,重装=重买,统一规则 |
| PayJS 跑路 / 政策变化 | webhook 抽象,可换底层支付通道(虎皮椒/彩虹易支付)而不动业务逻辑 |
| 下载日志暴增吃磁盘 | 30 天定期 archive 到压缩文件,SQLite 表只保留近期 |

---

## 验收点

1. **客户端**
   - 全新安装 → 自动进入 5 天 Trial,顶栏倒计时
   - Trial 期内可用 OCR / 高级模型 / 批量摘要
   - Trial 结束 → 自动降级到 Free,1.7B/4B 模型卸载,last_llm_path 清空
   - Free 配额耗尽 → 升级对话框正确弹出
   - 激活后所有功能立即解锁,断网继续可用
   - Free 状态拖入 license.json 伪造文件 → 验签失败,继续按 Free 处理

2. **服务端**
   - PayJS 测试单 → webhook 收到 → 自动生成 key → 邮件发送
   - 激活已绑定 license → 返回 DEVICE_BOUND
   - Admin 后台能看到所有订单 / license / 下载记录
   - `docker compose up -d` 一键起服务,Caddy 自动 HTTPS

3. **更新**
   - 客户端启动检测到新版本 → 提示用户更新
   - 服务端能管理多版本,精确 manifest 返回

---

## Out of Scope(下一阶段考虑)

- 用户账号体系 / 邮箱登录
- 团队/企业版多席位
- 灰度发布 / A/B 测试
- 海外支付(Stripe / PayPal)
- 推荐返利 / 折扣码
- 用户自助查询 license 状态(目前需联系客服)
- 对象存储迁移(达到 100 GB 出站/月再考虑)
- **博客 / SEO 内容运营**(首发不做,有用户后再加)
- **门户站英文版 / i18n**(海外推广再加)
- **门户站 A/B 测试 / Heatmap**
