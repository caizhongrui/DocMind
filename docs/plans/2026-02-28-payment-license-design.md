# DocMind 订阅付费与授权体系设计文档

**版本：** v1.1
**日期：** 2026-02-28
**状态：** 设计阶段（已决策）

**已决策：**
- 付费模式：买断制（永久授权，`expires_at: "lifetime"`）
- 定价：后端动态配置，客户端启动时拉取
- 激活码：支持，用于促销/礼品码/批量授权
- 自动升级：支持，应用内下载安装，license 持久化不受影响
- 管理后台：版本管理 + 收费管理统一在一个后台

---

## 目录

1. [总体架构](#总体架构)
2. [功能分层](#功能分层)
3. [License 格式与密码学](#license-格式与密码学)
4. [客户端验证流程](#客户端验证流程)
5. [后端 API 设计](#后端-api-设计)
6. [数据库设计](#数据库设计)
7. [微信支付接入流程](#微信支付接入流程)
8. [激活码体系](#激活码体系)
9. [自动升级](#自动升级)
10. [管理后台](#管理后台)
11. [防破解设计](#防破解设计)
12. [换机与售后流程](#换机与售后流程)

---

## 总体架构

```
┌─────────────────────────────────────────────────────┐
│                  DocMind 客户端 (Tauri)              │
│                                                     │
│  React/TS 前端  ←─invoke─→  Rust 后端               │
│  （付费 UI）              （license 验证 + 格式控制） │
│                                 ↑                   │
│                         内嵌 RSA 公钥               │
│                         本地 license 文件            │
└──────────────┬──────────────────────────────────────┘
               │ HTTPS（创建订单 / 换机申请）
               ▼
┌─────────────────────────────┐
│   Java 后端 (Spring Boot)   │
│                             │
│  订单管理  微信支付回调处理  │
│  License 生成（RSA 私钥）   │
│  换机激活 API               │
└──────────────┬──────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
  微信支付 API       MySQL 数据库
```

**核心原则：所有权限判断在 Rust 层执行，TypeScript 层不参与任何授权逻辑。**

---

## 功能分层

### 免费版（Free）

| 功能 | 说明 |
|------|------|
| 文件格式 | doc, docx, xls, xlsx, txt |
| 全文搜索 | ✅ |
| 文件名搜索 | ✅ |
| 语义搜索 | ❌ |
| 文档问答 | ❌ |

### 付费版（Pro）

| 功能 | 说明 |
|------|------|
| 文件格式 | 免费全部 + pdf, ppt, pptx, csv, md, rst, rtf, zip |
| 全文搜索 | ✅ |
| 文件名搜索 | ✅ |
| 语义搜索 | ✅ |
| 文档问答 | ✅ |
| OCR（未来） | ✅ |

### 格式限制执行位置

格式限制在 `src-tauri/src/indexer/mod.rs` 的 `SUPPORTED_EXTS` 动态决定，由 `AppState.plan` 字段控制。**绝不在前端 TypeScript 做判断。**

---

## License 格式与密码学

### 算法选型

使用 **RSA-2048 + SHA-256**（PKCS#1 v1.5 或 PSS 均可）：

- 后端持有 **私钥**，用于签名生成 license
- 客户端二进制内嵌 **公钥**，用于离线验证
- 攻击者即使拥有公钥，也无法伪造 license（非对称加密的核心保证）

未来可迁移至 **Ed25519**（签名更短、性能更好），但 RSA-2048 工具链更成熟。

### License Payload 结构

```json
{
  "version": 1,
  "plan": "pro",
  "mac": "aa:bb:cc:dd:ee:ff",
  "issued_at": "2026-02-28",
  "expires_at": "lifetime",
  "order_id": "WX20260228XXXXXXXX",
  "features": ["pdf", "ppt", "pptx", "csv", "md", "rst", "rtf", "zip", "semantic", "qa"]
}
```

字段说明：
- `version`：payload 结构版本，便于未来兼容升级
- `mac`：绑定的网卡 MAC 地址（小写、冒号分隔）
- `expires_at`：买断制填 `"lifetime"`，年费填 `"2027-02-28"`
- `features`：显式列出允许的格式和功能，后端可按需扩展（比如加 OCR 时不改验证逻辑）

### License Key 编码格式

```
<Base64url(payload_json)>.<Base64url(rsa_signature)>
```

示例（已截断）：
```
eyJ2ZXJzaW9uIjoxLCJwbGFuIjoicHJvIiwi...
.MEUCIQDxxx...
```

存储位置（按优先级）：
1. **macOS Keychain**（`security` 命令写入，最安全）
2. `~/.config/docmind/license.key`（fallback）

### MAC 地址获取策略

- 取第一个物理网卡（排除 `lo`、`utun`、`vmnet` 等虚拟接口）
- 用 Rust `mac_address` crate（`0.1.x`），失败时 fallback 到 `ifconfig` 命令解析
- 统一转为小写 + 冒号格式：`aa:bb:cc:dd:ee:ff`

---

## 客户端验证流程

### 启动时验证

```
App 启动
  │
  ├─ 读取 Keychain / 文件中的 license key
  │     │
  │     ├─ 不存在 → plan = Free，跳到主界面
  │     │
  │     └─ 存在
  │           │
  │           ├─ RSA 公钥验签失败 → plan = Free，记录日志
  │           │
  │           ├─ 验签通过
  │           │     │
  │           │     ├─ MAC 不匹配 → plan = Free，提示"设备不匹配"
  │           │     │
  │           │     ├─ 已过期（非 lifetime）→ plan = Free，提示续费
  │           │     │
  │           │     └─ 全部通过 → plan = Pro，解锁对应 features
  │           │
  │           └─ JSON 解析失败 → plan = Free（静默处理）
  │
  └─ AppState.plan 写入，后续所有命令从 state 读取
```

### 权限检查时机（多点验证）

| 触发场景 | 检查内容 |
|----------|----------|
| App 启动 | 完整验签流程 |
| 添加文件夹时 | 检查文件夹内是否含付费格式文件，给出提示 |
| 索引文件时 | `parse_file` 前检查扩展名是否在当前 plan 允许列表内 |
| 语义搜索时 | 检查 `plan == Pro` |
| 文档问答时 | 检查 `plan == Pro` |

---

## 后端 API 设计

### 基础信息

- Base URL: `https://api.docmind.xxx/v1`
- 认证：内部服务无需 Token，依赖服务器防火墙策略
- 所有请求/响应使用 JSON

### 接口列表

#### 0. 获取产品信息（含动态定价）

```
GET /api/product/info
```

响应：
```json
{
  "product_id": "pro_lifetime",
  "name": "DocMind Pro 永久版",
  "description": "解锁所有格式解析、AI 语义搜索与文档问答",
  "price": 9800,
  "price_display": "¥98",
  "original_price": 12800,
  "original_price_display": "¥128",
  "discount_label": "限时特惠",
  "features": [
    "支持 PDF、PPT、CSV、MD 等全部格式",
    "AI 语义搜索",
    "文档问答（RAG）",
    "后续 OCR 功能免费升级"
  ],
  "active": true
}
```

说明：
- 客户端启动后台静默拉取，用于付费页展示，失败时展示本地缓存价格
- 后端可随时调整 `price`、`discount_label`、`active` 字段，无需客户端更新
- `active: false` 时客户端隐藏付费入口（用于下架或维护）

后端管理：在数据库 `products` 表中维护，提供后台管理页面或直接改表。

#### 1. 创建支付订单

```
POST /api/order/create
```

请求体：
```json
{
  "product_id": "pro_lifetime",
  "mac_address": "aa:bb:cc:dd:ee:ff",
  "client_version": "1.2.0"
}
```

响应：
```json
{
  "order_id": "DM20260228000001",
  "code_url": "weixin://wxpay/bizpayurl?pr=xxxxxx",
  "amount": 9900,
  "expires_in": 300
}
```

说明：
- `code_url` 由客户端转为二维码图片展示
- `expires_in`：二维码有效期（秒），超时需重新创建订单

#### 2. 查询订单状态（轮询）

```
GET /api/order/status/{order_id}
```

响应：
```json
{
  "status": "paid",
  "license_key": "eyJ2ZXJzaW9uIjox....<签名>",
  "message": "支付成功"
}
```

`status` 枚举：`pending`（待支付）、`paid`（已支付）、`expired`（已过期）、`failed`（失败）

#### 3. 微信支付回调（内部，仅微信服务器调用）

```
POST /api/wechat/notify
```

- 微信调用此接口通知支付结果
- 后端验签 → 更新订单状态 → 生成 license key → 存入数据库
- 返回微信要求的 `{ "code": "SUCCESS" }`

#### 4. 激活码激活

```
POST /api/license/activate-by-code
```

请求体：
```json
{
  "code": "DOCM-XXXX-XXXX-XXXX",
  "mac_address": "aa:bb:cc:dd:ee:ff"
}
```

响应（成功）：
```json
{
  "license_key": "eyJ2ZXJzaW9u...",
  "order_id": "CODE-20260228-0001"
}
```

响应（失败）：
```json
{
  "error": "code_not_found",
  "message": "激活码不存在或已使用"
}
```

错误码：
- `code_not_found`：激活码不存在
- `code_used`：已被其他设备激活（可联系客服换绑）
- `code_expired`：激活码已过期（用于限时促销码）

---

## 数据库设计

### 产品表 `products`（用于动态定价）

```sql
CREATE TABLE products (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  product_id      VARCHAR(32) UNIQUE NOT NULL,   -- pro_lifetime
  name            VARCHAR(64) NOT NULL,
  description     TEXT,
  price           INT NOT NULL,                  -- 单位：分
  original_price  INT,                           -- 划线价，NULL 表示不展示
  price_display   VARCHAR(16),                   -- ¥98（冗余字段，方便前端）
  discount_label  VARCHAR(32),                   -- 限时特惠（NULL 表示不展示）
  features        JSON,                          -- 功能列表
  active          BOOLEAN DEFAULT TRUE,          -- FALSE 时前端隐藏付费入口
  updated_at      DATETIME DEFAULT NOW() ON UPDATE NOW()
);

-- 初始化数据
INSERT INTO products VALUES (
  1, 'pro_lifetime', 'DocMind Pro 永久版',
  '解锁所有格式解析、AI 语义搜索与文档问答',
  9800, 12800, '¥98', '限时特惠',
  '["支持 PDF/PPT/CSV/MD 等全部格式","AI 语义搜索","文档问答","后续 OCR 免费升级"]',
  TRUE, NOW()
);
```

### 订单表 `orders`

```sql
CREATE TABLE orders (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id     VARCHAR(64) UNIQUE NOT NULL,     -- 业务订单号
  wx_order_id  VARCHAR(64),                     -- 微信支付订单号
  product_id   VARCHAR(32) NOT NULL,            -- pro_lifetime / pro_annual
  mac_address  VARCHAR(32) NOT NULL,            -- 绑定 MAC
  amount       INT NOT NULL,                    -- 金额（分）
  status       ENUM('pending','paid','expired','refunded') DEFAULT 'pending',
  license_key  TEXT,                            -- 生成后存储
  paid_at      DATETIME,
  created_at   DATETIME DEFAULT NOW(),
  updated_at   DATETIME DEFAULT NOW() ON UPDATE NOW()
);
```

### 激活码表 `activate_codes`

```sql
CREATE TABLE activate_codes (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  code          VARCHAR(32) UNIQUE NOT NULL,   -- DOCM-XXXX-XXXX-XXXX
  product_id    VARCHAR(32) NOT NULL,
  batch_tag     VARCHAR(64),                   -- 批次标签，如 "2026双十一" / "KOL-张三"
  used          BOOLEAN DEFAULT FALSE,
  mac_address   VARCHAR(32),                   -- 激活时绑定，永久绑定不可换机
  license_key   TEXT,                          -- 激活后生成的 license
  expires_at    DATE,                          -- 激活码本身的有效期（NULL = 永久有效）
  used_at       DATETIME,
  created_at    DATETIME DEFAULT NOW()
);
```

说明：
- `batch_tag` 用于区分不同渠道/活动的激活码，方便统计
- `expires_at` 是激活码的使用截止日期，与 license 的 `expires_at` 不同（license 是 lifetime）
- 激活码一旦使用即**永久绑定该 MAC**，不支持换机，换机须重新购买

---

## 微信支付接入流程

### 前置准备

1. 前往 [pay.weixin.qq.com](https://pay.weixin.qq.com) 注册商户号，提交营业执照
2. 申请 API 证书，下载 `apiclient_key.pem` 和 `apiclient_cert.pem`
3. 在商户后台生成 APIv3 密钥（用于回调通知解密）
4. 配置回调地址：`https://api.docmind.xxx/v1/api/wechat/notify`

### Java SDK 接入

```xml
<!-- pom.xml -->
<dependency>
  <groupId>com.github.wechatpay-apiv3</groupId>
  <artifactId>wechatpay-java</artifactId>
  <version>0.2.14</version>
</dependency>
```

### 核心流程代码（伪代码）

```java
// 1. 创建 Native 支付订单
NativePayService service = new NativePayService.Builder()
    .config(rsaAutoCertificateConfig)
    .build();

PrepayRequest request = new PrepayRequest();
request.setAppid(appId);
request.setMchid(mchId);
request.setDescription("DocMind Pro 版");
request.setOutTradeNo(orderId);
request.setNotifyUrl(notifyUrl);
request.setAmount(new Amount().setTotal(9900));  // 99 元

PrepayResponse response = service.prepay(request);
String codeUrl = response.getCodeUrl();  // 返回给客户端

// 2. 处理回调通知
NotificationParser parser = new NotificationParser(config);
Transaction transaction = parser.parse(requestHeader, body, Transaction.class);
if ("SUCCESS".equals(transaction.getTradeState())) {
    // 查询对应订单 → 生成 license → 更新数据库
    String licenseKey = licenseService.generate(order.getMacAddress());
    orderService.markPaid(transaction.getOutTradeNo(), licenseKey);
}

// 3. 生成 License（RSA 签名）
public String generate(String macAddress) {
    LicensePayload payload = new LicensePayload();
    payload.setVersion(1);
    payload.setPlan("pro");
    payload.setMac(macAddress);
    payload.setIssuedAt(LocalDate.now().toString());
    payload.setExpiresAt("lifetime");
    payload.setFeatures(List.of("pdf","ppt","pptx","csv","md","rst","rtf","zip","semantic","qa"));

    String payloadJson = objectMapper.writeValueAsString(payload);
    String payloadBase64 = Base64.getUrlEncoder().encodeToString(payloadJson.getBytes());

    // RSA 签名
    Signature sig = Signature.getInstance("SHA256withRSA");
    sig.initSign(privateKey);
    sig.update(payloadBase64.getBytes());
    String signatureBase64 = Base64.getUrlEncoder().encodeToString(sig.sign());

    return payloadBase64 + "." + signatureBase64;
}
```

---

## 激活码体系

### 激活码格式

```
DOCM-XXXX-XXXX-XXXX
```

- 前缀 `DOCM` 固定，便于用户识别
- 后三组各 4 位大写字母+数字（排除易混淆字符 `0/O`、`1/I/L`）
- 示例：`DOCM-K7P2-M9XR-3FQN`

### 生成规则（Java 后端）

```java
private static final String CHARSET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 排除 0/O/1/I/L

public String generateCode() {
    SecureRandom random = new SecureRandom();
    StringBuilder sb = new StringBuilder("DOCM-");
    for (int group = 0; group < 3; group++) {
        for (int i = 0; i < 4; i++) {
            sb.append(CHARSET.charAt(random.nextInt(CHARSET.length())));
        }
        if (group < 2) sb.append("-");
    }
    return sb.toString();  // DOCM-K7P2-M9XR-3FQN
}

// 批量生成（后台管理接口）
public List<String> generateBatch(int count, String batchTag, LocalDate expiresAt) {
    List<String> codes = new ArrayList<>();
    for (int i = 0; i < count; i++) {
        String code = generateCode();
        activateCodeRepository.save(new ActivateCode(code, "pro_lifetime", batchTag, expiresAt));
        codes.add(code);
    }
    return codes;
}
```

### 激活流程

```
用户在客户端输入激活码
  │
  └─ POST /api/license/activate-by-code { code, mac_address }
        │
        ├─ 查询 activate_codes 表
        │     ├─ 不存在 → 返回 code_not_found
        │     ├─ 已使用 → 返回 code_used（提示联系客服换绑）
        │     └─ 已过期（expires_at < today）→ 返回 code_expired
        │
        └─ 有效 → 调用 LicenseService.generate(mac_address)
                 → 更新 activate_codes: used=true, mac, license_key, used_at
                 → 返回 license_key 给客户端
```

### 使用场景

| 场景 | 操作 |
|------|------|
| 限时促销活动 | 批量生成 N 个码，设置 `expires_at`，在官网/公众号发放 |
| KOL / 渠道合作 | 按渠道生成独立 `batch_tag` 的码，便于统计转化 |
| 赠送/礼品码 | 生成单个码，通过邮件/微信发送给用户 |
| 企业批量采购 | 生成多个码（每台机器一个），无需每台都走支付流程 |
| 客服补偿 | 生成单个码，直接发给需要补偿的用户 |

### 后台管理接口（仅内部使用）

```
POST /admin/codes/generate    批量生成激活码
GET  /admin/codes/list        查询激活码列表（含使用状态）
GET  /admin/codes/export      导出为 CSV
POST /admin/codes/reissue     重置某激活码的换机次数
```

这些接口通过 IP 白名单或独立管理 Token 保护，不对外暴露。

---

## 自动升级

### 现状

项目已具备：
- `tauri-plugin-updater` 已引入（`Cargo.toml`）
- minisign 公钥已内嵌（`tauri.conf.json` 的 `plugins.updater.pubkey`）
- 更新检测端点：`https://update.docmind.app/latest.json`
- `check_update` 命令：只返回 `bool`（是否有新版本）
- App.tsx：检测到更新后仅弹出通知，提示去 GitHub 手动下载

**缺失部分：** 应用内实际下载安装、下载进度展示、更新 manifest 的服务端、发布 CI/CD 流程。

---

### 整体流程

```
App 启动 5s 后
  │
  └─ check_update（已有）
        │
        ├─ 无更新 → 静默
        │
        └─ 有更新 → 顶栏显示更新按钮（已有 CloudDownloadOutlined）
                      │
                      └─ 用户点击 → 弹出更新对话框
                                      │
                                      ├─ 展示版本号 + 更新说明
                                      ├─ 点击"立即更新"
                                      │     │
                                      │     └─ Rust: download_and_install
                                      │           │
                                      │           ├─ 事件推送下载进度
                                      │           ├─ 验证 minisign 签名
                                      │           └─ 安装完成 → 提示重启
                                      │
                                      └─ 点击"稍后更新" → 关闭对话框
```

---

### 更新服务器架构（自建，适配国内网络）

GitHub Releases 在国内访问不稳定，更新包下载和 manifest 全部走自建服务，不依赖 GitHub。

```
客户端检测更新
  └─ GET https://update.docmind.app/api/update/latest.json
             （Java 后端，从数据库读取当前最新版本）
                    │
                    └─ 下载地址指向 阿里云 OSS + CDN
                       https://cdn.docmind.app/releases/v1.3.0/DocMind_aarch64.app.tar.gz
```

**为什么用 OSS + CDN 而不是直接放服务器：**
- 安装包体积大（macOS 约 30-80MB，Windows 约 50MB），直接走服务器带宽费用高
- OSS + CDN 国内回源快，下载速度稳定
- 推荐：**阿里云 OSS**（存储）+ **阿里云 CDN**（加速），或腾讯云 COS + CDN

---

### 更新 Manifest 格式（latest.json）

由 Java 后端 `GET /api/update/latest.json` 动态提供（从 `app_versions` 表读取）：

```json
{
  "version": "1.3.0",
  "notes": "### 更新内容\n- 新增 PDF 超时保护\n- 修复暗色模式显示异常\n- 性能优化",
  "pub_date": "2026-02-28T10:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "dW50cnVzdGVkIG...",
      "url": "https://cdn.docmind.app/releases/v1.3.0/DocMind_1.3.0_aarch64.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "dW50cnVzdGVkIG...",
      "url": "https://cdn.docmind.app/releases/v1.3.0/DocMind_1.3.0_x86_64.app.tar.gz"
    },
    "windows-x86_64": {
      "signature": "dW50cnVzdGVkIG...",
      "url": "https://cdn.docmind.app/releases/v1.3.0/DocMind_1.3.0_x64-setup.nsis.zip"
    }
  }
}
```

说明：
- `notes` 支持 Markdown，展示在更新对话框中
- `signature` 是每个平台包的 minisign 签名，Tauri 下载后强制验签，签名不对拒绝安装
- 下载 URL 全部指向国内 CDN，与 GitHub 无关

---

### 需新增的 Rust 命令

当前 `check_update` 只返回 bool，需补充两个命令：

**`get_update_info`** — 返回更新详情（版本号 + 更新说明）

```rust
#[derive(serde::Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: String,
    pub current_version: String,
}

#[tauri::command]
pub async fn get_update_info(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app.updater()?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        notes: u.body.clone().unwrap_or_default(),
        current_version: app.package_info().version.to_string(),
    }))
}
```

**`download_and_install_update`** — 实际下载安装，发送进度事件

```rust
#[tauri::command]
pub async fn download_and_install_update(app: tauri::AppHandle) -> Result<(), String> {
    let update = app.updater()?.check().await.map_err(|e| e.to_string())?;
    if let Some(update) = update {
        let handle = app.clone();
        update
            .download_and_install(
                |chunk_length, content_length| {
                    let _ = handle.emit("update-progress", serde_json::json!({
                        "downloaded": chunk_length,
                        "total": content_length,
                    }));
                },
                || {
                    let _ = handle.emit("update-ready", ());
                },
            )
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

前端监听 `update-progress` 展示进度条，监听 `update-ready` 展示"重启生效"按钮。

---

### CI/CD 发布流程（GitHub Actions + 阿里云 OSS）

```yaml
# .github/workflows/release.yml
on:
  push:
    tags:
      - 'v*'   # 推送 v1.3.0 标签时触发

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-latest
            target: aarch64-apple-darwin     # Apple Silicon
          - os: macos-13
            target: x86_64-apple-darwin      # Intel Mac
          - os: windows-latest
            target: x86_64-pc-windows-msvc

    steps:
      - uses: actions/checkout@v4

      - name: Build & Sign
        uses: tauri-apps/tauri-action@v0
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_KEY_PASSWORD }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: DocMind ${{ github.ref_name }}
          releaseBody: ${{ github.event.head_commit.message }}

      - name: Upload to Aliyun OSS
        uses: fangbinwei/aliyun-oss-website-action@v1
        with:
          accessKeyId: ${{ secrets.OSS_ACCESS_KEY_ID }}
          accessKeySecret: ${{ secrets.OSS_ACCESS_KEY_SECRET }}
          bucket: docmind-releases
          endpoint: oss-cn-hangzhou.aliyuncs.com
          folder: src-tauri/target/release/bundle  # Tauri 编译产物目录
          prefix: releases/${{ github.ref_name }}/

      - name: Notify backend to publish version
        run: |
          curl -X POST https://api.docmind.app/admin/versions/publish \
            -H "Authorization: Bearer ${{ secrets.ADMIN_API_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d '{
              "version": "${{ github.ref_name }}",
              "release_notes": "${{ github.event.head_commit.message }}",
              "platforms": {
                "darwin-aarch64": {
                  "url": "https://cdn.docmind.app/releases/${{ github.ref_name }}/DocMind_aarch64.app.tar.gz"
                },
                "darwin-x86_64": {
                  "url": "https://cdn.docmind.app/releases/${{ github.ref_name }}/DocMind_x86_64.app.tar.gz"
                },
                "windows-x86_64": {
                  "url": "https://cdn.docmind.app/releases/${{ github.ref_name }}/DocMind_x64-setup.nsis.zip"
                }
              }
            }'
```

**发布流程说明：**

```
推送 v1.3.0 标签
  │
  ├─ 1. GitHub Actions 编译三平台安装包
  ├─ 2. minisign 私钥签名（签名值附在安装包旁的 .sig 文件）
  ├─ 3. 上传安装包到阿里云 OSS（国内 CDN 加速）
  └─ 4. 调用后端 /admin/versions/publish
           │
           └─ 后端写入 app_versions 表
              将旧版 is_latest = FALSE
              新版 is_latest = TRUE
              客户端下次检测立即拿到新版信息
```

**后端 `/admin/versions/publish` 接口（Java）：**

```java
// 后端从 OSS 下载安装包读取 .sig 文件获得 signature，写入 platforms JSON
@PostMapping("/admin/versions/publish")
public void publishVersion(@RequestBody PublishRequest req) {
    // 1. 从 OSS 读取各平台 .sig 文件，获取 minisign signature
    // 2. 插入 app_versions 表，is_latest = TRUE
    // 3. 将旧版 is_latest 更新为 FALSE
    appVersionService.publish(req);
}
```

**密钥与凭证清单（全部存 GitHub Secrets）：**

| Secret 名称 | 内容 |
|------------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | minisign 私钥（base64）|
| `TAURI_SIGNING_KEY_PASSWORD` | 私钥密码 |
| `OSS_ACCESS_KEY_ID` | 阿里云 OSS AccessKey |
| `OSS_ACCESS_KEY_SECRET` | 阿里云 OSS SecretKey |
| `ADMIN_API_TOKEN` | 后端发布接口的认证 Token |

---

### License 在升级时的持久化

| 存储位置 | 升级时行为 |
|----------|-----------|
| macOS Keychain | ✅ 完全不受影响，Keychain 与 App Bundle 解耦 |
| `~/.config/docmind/license.key` | ✅ 应用更新不会删除用户配置目录 |
| App Bundle 内部 | ❌ 禁止，更新会覆盖 Bundle |

实现时 license 写入 Keychain 或 `~/.config/docmind/`，更新前后 license 验证行为完全一致，用户无感知。

---

### 版本兼容策略

- **License payload `version` 字段**：当前为 `1`，若未来 payload 结构有变更，递增版本号，Rust 验证逻辑按版本分支处理，老 license 继续有效
- **最低版本强制升级**：在 `latest.json` 可加 `min_version` 字段，低于此版本的客户端强制要求升级后才能使用（用于安全漏洞修复场景）

---

## 管理后台

### 技术架构

管理后台与业务后端**合并在同一个 Spring Boot 项目**中，前端独立部署：

```
┌─────────────────────────────────────────────────────────┐
│                    Spring Boot 后端                      │
│                                                         │
│   /api/*         客户端公开接口（无需登录）               │
│   /admin/*       管理后台接口（JWT 认证，IP 白名单）      │
│   /api/wechat/*  微信回调（微信服务器 IP 白名单）         │
└────────────────────────┬────────────────────────────────┘
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
  admin.docmind.app              api.docmind.app
  （管理后台前端，Vue 3）          （供客户端调用）
```

**前端技术选型：Vue 3 + Element Plus**
- 轻量，管理后台场景下组件齐全（表格、表单、对话框）
- 无需与 Tauri 客户端保持一致，独立维护

**认证方式：JWT + IP 白名单双重保护**
- 登录后颁发 JWT，前端存 localStorage
- 同时在 Nginx 层限制只允许固定 IP 访问 `/admin/*`
- 管理员账号硬编码或存数据库（只有一个人，不需要 RBAC）

---

### 功能模块总览

```
管理后台
├── 数据概览（Dashboard）
├── 版本管理
│   ├── 版本列表
│   ├── 发布新版本
│   └── 设置强制升级
├── 定价管理
│   └── 编辑产品信息（价格/划线价/促销标签/上下架）
├── 订单管理
│   ├── 订单列表
│   ├── 订单详情
│   └── 标记退款
├── 激活码管理
│   ├── 生成激活码（含批次标签）
│   ├── 激活码列表（使用状态）
│   ├── 导出 CSV
│   └── 重置换机次数
└── License 管理
    ├── 按 MAC / 订单号查询激活状态
    ├── 重新签发 License
    └── 吊销 License
```

---

### 各模块详细设计

#### 1. 数据概览（Dashboard）

展示核心指标，管理员登录后首页：

| 指标卡片 | 数据来源 |
|----------|----------|
| 总收入（元） | `orders` where `status=paid` sum(amount) |
| 今日新增订单 | `orders` where `paid_at >= today` |
| 本月新增订单 | `orders` where `paid_at >= month_start` |
| 累计激活用户 | `orders` + `activate_codes` where `used=true` |
| 待处理换机申请 | 预留（目前换机自助完成）|
| 当前最新版本 | `app_versions` where `is_latest=true` |

```
GET /admin/dashboard/stats
```

---

#### 2. 版本管理

**版本列表页**

```
GET /admin/versions?page=1&size=20
```

响应包含：版本号、发布时间、是否最新、各平台包大小、下载量（可选）

**发布新版本**

```
POST /admin/versions/publish
```

请求体：
```json
{
  "version": "1.3.0",
  "release_notes": "### 更新内容\n- 修复若干问题",
  "pub_date": "2026-02-28T10:00:00Z",
  "min_version": null,
  "platforms": {
    "darwin-aarch64": {
      "url": "https://cdn.docmind.app/releases/v1.3.0/DocMind_aarch64.app.tar.gz",
      "signature": "dW50cnVzdGVkIG..."
    },
    "darwin-x86_64": { "..." },
    "windows-x86_64": { "..." }
  }
}
```

操作：写入 `app_versions`，旧版 `is_latest → FALSE`，新版 `is_latest → TRUE`。

**设置强制升级**

```
PATCH /admin/versions/{id}
Body: { "min_version": "1.2.0" }
```

低于 `min_version` 的客户端下次检测时，`/api/update/latest.json` 在响应中附加 `"force": true`，客户端收到后禁用主界面，强制用户升级。

---

#### 3. 定价管理

**编辑产品信息**

```
PUT /admin/products/{product_id}
```

请求体（仅需传要修改的字段）：
```json
{
  "price": 7800,
  "original_price": 9800,
  "price_display": "¥78",
  "original_price_display": "¥98",
  "discount_label": "新年特惠",
  "active": true
}
```

修改后客户端下次启动拉取 `/api/product/info` 时即生效，**无需发版**。

`active: false` 用于临时下架（如支付系统维护），客户端隐藏付费入口。

---

#### 4. 订单管理

**订单列表**

```
GET /admin/orders?page=1&size=20&status=paid&keyword=MAC地址或订单号
```

**订单详情**

```
GET /admin/orders/{order_id}
```

返回完整订单信息 + license_key + 换机历史。

**标记退款**

```
POST /admin/orders/{order_id}/refund
```

操作：
- `orders.status → refunded`
- `orders.license_key → null`（license 失效，但客户端离线缓存仍有效，无法强制即时失效）
- 如需让 license 在线失效，可将对应 license 加入黑名单表（见 License 管理）

---

#### 5. 激活码管理

**生成激活码**

```
POST /admin/codes/generate
Body: { "count": 100, "batch_tag": "2026双十一", "expires_at": "2026-12-31" }
```

响应：生成的激活码列表。

**激活码列表**

```
GET /admin/codes?batch_tag=2026双十一&used=false&page=1
```

**导出 CSV**

```
GET /admin/codes/export?batch_tag=2026双十一
```

---

#### 6. License 管理

**查询激活状态**

```
GET /admin/licenses/query?mac=aa:bb:cc:dd:ee:ff
GET /admin/licenses/query?order_id=DM20260228000001
```

返回：绑定 MAC、激活时间、当前 license 是否有效。

**吊销 License**

```
POST /admin/licenses/revoke
Body: { "order_id": "DM20260228000001" }
```

将 `order_id` 加入 `revoked_licenses` 表。客户端联网时（如调用问答、语义搜索等需要后端的功能）可附带验证，命中黑名单则降级为 Free。

> 注意：纯离线验证场景下，吊销无法即时生效。如需强制即时失效，须将相关功能改为在线验证（见防破解章节）。

---

### 管理后台数据库补充

**吊销黑名单表 `revoked_licenses`**

```sql
CREATE TABLE revoked_licenses (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id    VARCHAR(64) NOT NULL,
  reason      VARCHAR(255),
  revoked_at  DATETIME DEFAULT NOW(),
  revoked_by  VARCHAR(64)              -- 操作人备注
);
```

---

### 管理后台安全措施

| 措施 | 实现方式 |
|------|----------|
| 登录认证 | JWT，Token 有效期 8 小时，过期重新登录 |
| IP 白名单 | Nginx `allow` 指令，只允许开发者固定 IP |
| HTTPS | 所有请求走 HTTPS，禁止 HTTP 访问 |
| 操作日志 | 关键操作（吊销、退款、生成码）记录到 `admin_logs` 表 |
| 接口限流 | Spring Boot `RateLimiter`，防止暴力破解登录 |

---

## 防破解设计

### 威胁模型

| 攻击方式 | 风险等级 | 应对措施 |
|----------|----------|----------|
| 直接修改 TypeScript 代码绕过前端限制 | 高（如不防范） | **所有权限在 Rust 层判断，TS 层无授权逻辑** |
| 内存 Patch（修改运行时 plan 变量） | 中 | 多点检查 + 混淆函数名 |
| 替换公钥为自签公钥 | 低（需重新编译） | 公钥分段内嵌 + 完整性校验 |
| 伪造 license 文件 | 低 | RSA 签名无法伪造 |
| MAC 地址伪造 | 中 | 多网卡交叉验证 + 软硬件特征补充 |
| 直接 Patch 二进制跳过验证 | 中 | 多点验证 + 反调试 |
| 网络拦截 license 响应 | 低 | 全程 HTTPS，客户端验签不依赖服务器 |
| 旧 license 被多人共享 | 中 | 换机次数限制（3次）|

### 措施 1：权限判断全部在 Rust 层

```rust
// ✅ 正确：在 Rust 命令中检查
#[tauri::command]
pub fn ask_question_stream(state: State<AppState>, ...) {
    if state.plan.load() != Plan::Pro {
        return Err("需要 Pro 版".into());
    }
    // ...
}

// ❌ 错误：在 TypeScript 中判断
// if (plan === 'pro') { invoke('ask_question_stream', ...) }
// 这种写法攻击者改一行 JS 就能绕过
```

### 措施 2：公钥分段内嵌，避免整体提取

不要把 PEM 公钥作为一整个字符串常量，改为字节数组分段存储：

```rust
// ❌ 容易被识别和替换
const PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----\nMIIBIjAN...";

// ✅ 分段存储，增加替换难度
const PK_PART_A: &[u8] = &[0x30, 0x82, 0x01, 0x22, ...];
const PK_PART_B: &[u8] = &[0x02, 0x82, 0x01, 0x0f, ...];
const PK_PART_C: &[u8] = &[0x00, 0xb8, 0x40, 0x13, ...];

fn get_public_key() -> Vec<u8> {
    [PK_PART_A, PK_PART_B, PK_PART_C].concat()
}
```

### 措施 3：多点验证，不只在启动时检查

```rust
// 除启动时完整验证外，在以下场景再次验证：
// - 每次执行语义搜索时
// - 每次打开问答面板时
// - 每次索引付费格式文件时（检查内联，非调用 check_license）

// 验证逻辑分散在多处，攻击者需要 Patch 多个位置
```

### 措施 4：函数命名混淆

```rust
// ❌ 函数名暴露意图，攻击者直接定位
fn check_license() -> bool { ... }
fn is_pro_user() -> bool { ... }

// ✅ 语义不明，混入正常业务逻辑
fn validate_index_config(state: &AppState) -> bool { ... }
fn ensure_format_support(ext: &str, state: &AppState) -> bool { ... }
```

### 措施 5：MAC 地址多重采集

单一 MAC 容易被 VPN 或虚拟机欺骗，增加硬件特征辅助：

```rust
struct DeviceFingerprint {
    primary_mac: String,      // 主网卡 MAC
    hostname: String,         // 机器名（辅助）
}

// license 中的 mac 字段绑定 primary_mac
// 验证时：primary_mac 必须匹配，hostname 不匹配只记日志不拒绝
// 这样换机器必须重新激活，但重命名机器不影响使用
```

### 措施 6：时间防回滚

防止用户把系统时间调回过期前：

```rust
fn is_expired(payload: &LicensePayload) -> bool {
    if payload.expires_at == "lifetime" {
        return false;
    }
    let expire_date = NaiveDate::parse_from_str(&payload.expires_at, "%Y-%m-%d")?;
    let issued_date = NaiveDate::parse_from_str(&payload.issued_at, "%Y-%m-%d")?;
    let today = Local::now().date_naive();

    // 如果当前时间早于签发时间，说明系统时钟被篡改
    if today < issued_date {
        return true;  // 视为已过期
    }
    today > expire_date
}
```

### 措施 7：Tauri 前端资源保护

Tauri 默认会将前端资源打包进二进制（不是单独的文件夹），无需额外处理。但需注意：

- **不要在 TypeScript 层做任何付费功能的实际逻辑**，TS 只负责 UI 展示
- `invoke` 调用的命令在 Rust 层验权，TS 传什么参数都无效

### 措施 8：license 文件存储位置

优先使用操作系统级安全存储：

| 平台 | 存储方式 |
|------|----------|
| macOS | Keychain Services（`security add-generic-password`）|
| Windows | DPAPI（Data Protection API）|
| Linux | Secret Service API / fallback 到加密文件 |

macOS Keychain 存储的 license 不会随 App 卸载删除，重装后可自动恢复。

### 综合评估

上述措施组合后，破解难度：
- **脚本小子**（改 JS、改配置文件）：完全无效，权限在 Rust 层
- **中级逆向**（IDA/Ghidra 分析二进制）：需要找到多个验证点并全部 Patch，成本较高
- **高级逆向**（修改 Rust 源码重编译）：需要源码，基本不现实

**结论：对于个人桌面工具，此防护级别已足够。** 大多数破解传播是通过"改一行代码"完成的，Rust 层强制验权从根本上消除了这条路径。

---

## 售后流程

### 换机政策

**不支持换机，一机一码，换机需重新购买。**

客户端在激活时将 MAC 地址永久写入 license，新设备无法使用旧 license。付费页和激活页需明确告知用户此政策。

### 退款

- 微信支付支持原路退款（商户后台操作）
- 退款后在管理后台将对应订单标记 `refunded`，并将 `order_id` 加入 `revoked_licenses` 黑名单
- 客户端纯离线时无法实时感知 license 吊销（离线验证的固有局限）
- 若需强制即时失效，在后台吊销后，客户端下次调用需要联网的功能（语义搜索、问答）时附带在线验证，命中黑名单则降级为 Free

---

### 版本表 `app_versions`（支撑更新服务）

```sql
CREATE TABLE app_versions (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  version         VARCHAR(16) NOT NULL,            -- 1.3.0
  release_notes   TEXT,                            -- Markdown 格式更新说明
  pub_date        DATETIME NOT NULL,
  is_latest       BOOLEAN DEFAULT FALSE,           -- 只有一条为 TRUE
  min_version     VARCHAR(16),                     -- 低于此版本强制升级（NULL = 不强制）
  -- 各平台下载信息（JSON 存储，方便扩展新平台）
  platforms       JSON NOT NULL,
  created_at      DATETIME DEFAULT NOW()
);

-- platforms 字段示例：
-- {
--   "darwin-aarch64": {
--     "signature": "...",
--     "url": "https://cdn.docmind.app/releases/v1.3.0/DocMind_1.3.0_aarch64.app.tar.gz",
--     "size": 52428800
--   },
--   ...
-- }
```

后端接口 `GET /api/update/latest.json` 直接查询 `is_latest = TRUE` 的记录并组装返回，发布新版本只需插入一条记录并更新 `is_latest` 标志，**无需重启服务、无需改代码**。

---

## 附录：后续扩展预留

| 功能 | 说明 |
|------|------|
| Windows 支持 | MAC 地址获取改用 `ipconfig /all` 解析；Keychain 改用 Windows DPAPI |
| OCR 功能 | `license.features` 数组加入 `"ocr"` 即可，无需改验证逻辑 |
| 多设备授权 | 换机次数限制改为设备绑定列表，允许同时激活 N 台 |
