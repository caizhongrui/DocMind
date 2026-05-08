# DocMind 自建后端部署指南(宝塔面板版)

DocMind 单 Docker 容器内集成:
1. **Caddy**(:8080,plain HTTP)按 Host 头路由
2. **Axum API**(:8081,loopback)
3. **门户站静态产物**(/app/portal,Astro 构建结果)

外层架构:
- **宝塔面板** 终止 SSL + 反代两个子域到容器
- 两个子域都指向同一台服务器同一个端口 `127.0.0.1:8080`,Caddy 按 Host 分发

```
公网 :443
   ↓ 宝塔 Nginx(终止 SSL + 证书自动续期)
   ├── doc-web.boyobang.com → 127.0.0.1:8080(Host=doc-web.…)
   └── doc-api.boyobang.com → 127.0.0.1:8080(Host=doc-api.…)
                                       ↓
                               Docker 容器 :8080 (Caddy)
                                  ├─ Host=doc-web → /app/portal/*(静态)
                                  └─ Host=doc-api → 127.0.0.1:8081(Axum)
```

---

## 准备

- 已备案的域名,配两个子域:
  - `doc-web.boyobang.com` → 门户站
  - `doc-api.boyobang.com` → API
- 一台 Linux 服务器,2C2G+,30GB 起,固定公网 IP
- DNS A 记录都指向这台服务器
- **宝塔面板**(7.x+)
- Docker 20.10+ + Docker Compose v2

---

## 一、装 Docker

宝塔软件商店搜 Docker 安装,或:
```bash
curl -fsSL https://get.docker.com | bash
systemctl enable --now docker
```

---

## 二、起容器

```bash
sudo mkdir -p /opt/docmind && sudo chown $USER /opt/docmind
cd /opt/docmind
git clone https://github.com/caizhongrui/DocMind.git .

cp .env.example .env
vi .env
```

`.env` 必填:
```env
DOMAIN=doc-api.boyobang.com
PORTAL_DOMAIN=doc-web.boyobang.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<改成强密码>
PAYJS_MERCHANT_ID=<PayJS 商户号>
PAYJS_KEY=<PayJS 商户密钥>
PAYJS_NOTIFY_URL=https://doc-api.boyobang.com/api/v1/payment/payjs/webhook
```

启动:
```bash
docker compose up -d --build
docker compose logs -f docmind-server
```

首次启动会:
- 在 `data/keys/ed25519.priv` 生成 Ed25519 私钥
- **打印一段 64 字符 hex 公钥**,**保存它**(后面要烧到客户端)
- 在 `data/db/docmind.sqlite` 建表
- 容器内 Caddy 监听 `127.0.0.1:8080`(对宿主机 loopback 开放)

验证:
```bash
# 模拟 doc-web 流量
curl -H "Host: doc-web.boyobang.com" http://127.0.0.1:8080/         # 门户首页 HTML
curl -H "Host: doc-web.boyobang.com" http://127.0.0.1:8080/pricing  # 定价页

# 模拟 doc-api 流量
curl -H "Host: doc-api.boyobang.com" http://127.0.0.1:8080/         # API 落地页
curl -H "Host: doc-api.boyobang.com" -i http://127.0.0.1:8080/admin # 303 跳 /admin/login
```

---

## 三、宝塔配 doc-api.boyobang.com 站点

1. **网站 → 添加站点**
   - 域名:`doc-api.boyobang.com`
   - 不创建 PHP / 数据库
2. **SSL 标签** → Let's Encrypt → 申请 → 强制 HTTPS
3. **配置文件** → 把 [`deploy/nginx/doc-api.conf`](deploy/nginx/doc-api.conf) 的 `server` 块粘进去(保留宝塔已生成的 SSL 部分)
   - `proxy_pass http://127.0.0.1:8080`
   - `proxy_set_header Host $host`(关键,Caddy 靠这个分流)
   - `client_max_body_size 200M`(管理员上传安装包用)
4. 点 "重载"

---

## 四、宝塔配 doc-web.boyobang.com 站点

跟 doc-api **一模一样的反代配置**,只是域名换成 doc-web:
1. 网站 → 添加站点 `doc-web.boyobang.com`
2. SSL → 申证书 → 强制 HTTPS
3. 配置文件 → 粘 [`deploy/nginx/doc-web.conf`](deploy/nginx/doc-web.conf)
   - 同样 `proxy_pass http://127.0.0.1:8080`
   - 同样 `proxy_set_header Host $host`
4. 重载

✅ **门户的静态文件不需要单独上传 — 已经在容器里**。容器内 Caddy 看到 Host=doc-web.* 就直接 file_server 出去。

---

## 五、烧入公钥到客户端

容器首次启动打印的公钥(也存在 `/opt/docmind/data/keys/ed25519.pub`)写进客户端代码:

```rust
// src-tauri/src/license/token.rs
pub const SERVER_PUBLIC_KEY_HEX: &str =
    "<把 64 字符 hex 公钥粘到这里>";
```

修改后重新构建客户端,通过 admin 后台 `/admin/releases` 上传发布。

⚠️ **私钥永远只在 `/opt/docmind/data/keys/ed25519.priv`**,不要 commit、不要复制。
泄漏后需要轮换密钥并重发所有 license。

---

## 六、PayJS 配置

1. 注册 https://payjs.cn 完成商户审核
2. 拿到 `商户号` 和 `密钥`,填入 `.env`,重启 `docker compose up -d`
3. PayJS 控制台填异步通知地址:`https://doc-api.boyobang.com/api/v1/payment/payjs/webhook`
4. 测一笔 ¥0.01 订单,在 `https://doc-api.boyobang.com/admin/orders` 应能看到记录

---

## 七、上传第一个客户端版本

1. 本地 `npm run tauri build` 构建 macOS / Windows 安装包
2. 拿到二进制 + Tauri 生成的 `.sig` 签名
3. 浏览器开 `https://doc-api.boyobang.com/admin/releases`
4. 上传:版本号 / 平台 / edition=free / 二进制 / .sig
5. 客户端通过 `/api/v1/updates/{platform}/{cur_ver}` 收到更新

---

## 八、版本与镜像 tag

镜像推送到私有 registry:
```
registry.boyocloud.com/boyo/docmind-server:YYYYMMDD-N
registry.boyocloud.com/boyo/docmind-server:latest
```

构建并推送:
```bash
bash scripts/build-and-push.sh        # 自动用今天日期 + 序号 +1
bash scripts/build-and-push.sh 20260508-3  # 也可手动指定
```

服务器上拉新版本:
```bash
cd /opt/docmind
docker compose pull
docker compose up -d
```

---

## 九、备份

`/opt/docmind/data/` 是所有状态。建议宝塔计划任务:
```bash
0 3 * * * tar czf /www/backup/docmind/$(date +\%F).tar.gz /opt/docmind/data
```
或用宝塔自带的"备份"。

---

## 十、升级

API 升级(改了 server/portal 源码):
```bash
cd /opt/docmind && git pull
bash scripts/build-and-push.sh        # 推到私库
docker compose pull && docker compose up -d
```

或如果改动不需要发版,只是测试:
```bash
docker compose build --pull && docker compose up -d
```

---

## 故障排查

| 现象 | 检查 |
|---|---|
| `curl https://doc-api.boyobang.com/` 502 | 容器没起来。`docker compose ps` 看状态,`docker compose logs --tail=50` 看错误 |
| 上传二进制 413 Request Too Large | 宝塔 Nginx 没设 `client_max_body_size 200M` |
| 容器跑起来但访问 404 / 走错域 | Nginx 反代没透传 Host 头(`proxy_set_header Host $host`),Caddy 无法分流 |
| 客户端激活报 INVALID_TOKEN | 客户端 `SERVER_PUBLIC_KEY_HEX` 与服务器不匹配 |
| 门户子页面 404 | Caddy 已配 `try_files {path} {path}/index.html /index.html`,如果失败检查容器内 `/app/portal/` 是否完整 |
| PayJS webhook 没回调 | PayJS 后台填的 notify_url 必须 https + 公网可达 |

实时日志:
```bash
docker compose logs -f --tail=200 docmind-server
```

宝塔 Nginx 日志:
- 网站设置 → 日志

---

## 完全卸载

```bash
cd /opt/docmind
docker compose down -v       # -v 删数据卷,慎用
sudo rm -rf /opt/docmind
# 宝塔面板里删除两个站点
```
