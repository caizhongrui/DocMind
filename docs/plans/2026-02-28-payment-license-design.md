# DocMind 订阅付费与授权体系设计文档

**版本：** v1.1
**日期：** 2026-02-28
**状态：** 设计阶段（已决策）

**已决策：**
- 付费模式：买断制（永久授权，`expires_at: "lifetime"`）
- 定价：后端动态配置，客户端启动时拉取
- 激活码：支持，用于促销/礼品码/批量授权

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
9. [防破解设计](#防破解设计)
10. [换机与售后流程](#换机与售后流程)

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

#### 4. 换机激活

```
POST /api/license/reissue
```

请求体：
```json
{
  "order_id": "DM20260228000001",
  "old_mac": "aa:bb:cc:dd:ee:ff",
  "new_mac": "11:22:33:44:55:66"
}
```

响应：
```json
{
  "license_key": "新license...",
  "reissue_count": 1,
  "reissue_limit": 3
}
```

说明：每个订单最多允许换机 3 次，防止 license 被多人共享。

#### 5. 激活码激活

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
  reissue_count INT DEFAULT 0,                 -- 已换机次数
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
  mac_address   VARCHAR(32),                   -- 激活时绑定
  license_key   TEXT,                          -- 激活后生成的 license
  reissue_count INT DEFAULT 0,                -- 换机次数
  expires_at    DATE,                          -- 激活码本身的有效期（NULL = 永久有效）
  used_at       DATETIME,
  created_at    DATETIME DEFAULT NOW()
);
```

说明：
- `batch_tag` 用于区分不同渠道/活动的激活码，方便统计
- `expires_at` 是激活码的使用截止日期，与 license 的 `expires_at` 不同（license 是 lifetime）
- 激活码一旦使用即绑定 MAC，与订单付费逻辑复用相同的 license 生成和换机流程

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

## 换机与售后流程

### 用户换机

1. 用户在新机器上打开 DocMind → 提示"未激活"
2. 用户点击"已购买，重新激活"→ 填入订单号
3. 客户端自动获取新 MAC → 调用 `/api/license/reissue`
4. 后端校验订单号有效且换机次数未超限 → 生成新 license 返回
5. 客户端保存新 license → 解锁 Pro 功能

### 换机次数限制

- 默认每个订单最多换机 **3 次**
- 超出后提示联系客服（邮件：qdzy_cai@163.com）
- 客服可在后台手动重置换机次数

### 退款

- 微信支付支持原路退款（商户后台操作）
- 退款后在数据库将对应 license 状态改为 `revoked`
- 客户端无法实时感知（离线 license 的固有局限）
- 如需立即失效，可将该 license 的 `issued_at` 日期设为未来的无效值并重新签发（需强制客户端在线验证一次）

---

## 附录：后续扩展预留

| 功能 | 说明 |
|------|------|
| Windows 支持 | MAC 地址获取改用 `ipconfig /all` 解析；Keychain 改用 Windows DPAPI |
| OCR 功能 | `license.features` 数组加入 `"ocr"` 即可，无需改验证逻辑 |
| 多设备授权 | 换机次数限制改为设备绑定列表，允许同时激活 N 台 |
