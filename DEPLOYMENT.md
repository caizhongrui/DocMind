# DocMind 自建后端部署指南(宝塔面板版)

DocMind 自建后端由两部分组成:

1. **API 容器**(Rust + Axum,跑在 Docker 里):license / 支付 / 更新 / admin 后台
2. **门户站**(Astro 静态站):产品介绍 / 定价 / 文档 / 下载入口

部署模式:
- **宝塔面板** 统一处理 SSL 证书 + Nginx 反代
- API 容器只在宿主机 `127.0.0.1:8080` 监听明文 HTTP
- 门户站作为普通静态网站托管在宝塔

---

## 准备

- 已备案的域名(本文示例 `boyobang.com`),配两个子域:
  - `doc-web.boyobang.com` → 门户站
  - `doc-api.boyobang.com` → API
- 一台 Linux 服务器(2C2G+,30GB 起),固定公网 IP
- DNS A 记录都指向这台服务器
- **宝塔面板**(7.x+)已安装
- Docker 20.10+ + Docker Compose v2

---

## 一、装 Docker

如果服务器还没装,在宝塔的"软件商店"搜索 Docker 安装,或用脚本:
```bash
curl -fsSL https://get.docker.com | bash
systemctl enable --now docker
```

---

## 二、起 API 容器

```bash
sudo mkdir -p /opt/docmind && sudo chown $USER /opt/docmind
cd /opt/docmind

# 把仓库拉下来
git clone https://github.com/caizhongrui/DocMind.git .

# 配置环境变量
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
- **打印一段 64 字符 hex 公钥**,**保存它**
- 在 `data/db/docmind.sqlite` 建表
- 监听 `127.0.0.1:8080`(只对宿主机 loopback 开放)

验证容器跑起来了:
```bash
curl -i http://127.0.0.1:8080/        # 应返回 HTML
curl -i http://127.0.0.1:8080/admin   # 应返回 303 跳 /admin/login
```

---

## 三、宝塔配置 doc-api 站点(API 反代)

1. 宝塔面板 → 网站 → **添加站点**
   - 域名:`doc-api.boyobang.com`
   - 创建数据库、PHP 版本都不勾(选纯静态)
2. 点新建站点的 "**SSL**" 标签 → Let's Encrypt → 申请证书 → 强制 HTTPS
3. 点 "**配置文件**" 标签 → 用 `deploy/nginx/doc-api.conf` 替换 `server { ... }` 块(保留 SSL 部分):
   - 关键设置 `client_max_body_size 200M`(管理员上传二进制要 ~100MB)
   - `proxy_pass http://127.0.0.1:8080`
   - 所有请求转发,Host/X-Real-IP 透传
4. 保存配置,在宝塔点 "**重载**"

测试:
```bash
curl https://doc-api.boyobang.com/      # 应返回 HTML
curl https://doc-api.boyobang.com/admin # 应返回 303 跳 /admin/login
```

---

## 四、构建并部署门户站

门户是纯静态站,在你的开发机或服务器上构建一次,把 `dist/` 上传到宝塔。

**在开发机或服务器**:
```bash
cd /opt/docmind/portal       # 或者你 git clone 的位置
npm install
npm run build
# 产物在 dist/ 目录
```

**上传到宝塔**:
- 宝塔 → 文件 → 创建目录 `/www/wwwroot/docmind-portal/`
- 把 `portal/dist/` 下的所有文件传到 `/www/wwwroot/docmind-portal/`

**宝塔配置 doc-web 站点**:
1. 网站 → **添加站点**
   - 域名:`doc-web.boyobang.com`
   - 根目录:`/www/wwwroot/docmind-portal`
2. SSL 标签 → 申请 Let's Encrypt 证书 → 强制 HTTPS
3. 配置文件标签 → 把 `deploy/nginx/doc-web.conf` 的 `location` 块粘贴进去
4. 重载

测试:
```bash
curl https://doc-web.boyobang.com/         # 首页 HTML
curl https://doc-web.boyobang.com/pricing  # 定价页
curl https://doc-web.boyobang.com/sitemap.xml
```

---

## 五、烧入公钥到客户端

API 容器首次启动时打印的公钥(也保存在 `/opt/docmind/data/keys/ed25519.pub`)需要写进客户端代码:

```rust
// src-tauri/src/license/token.rs
pub const SERVER_PUBLIC_KEY_HEX: &str =
    "<把日志里打印的 64 字符 hex 公钥粘到这里>";
```

修改后重新构建客户端安装包,通过 admin 后台 `/admin/releases` 上传。

⚠️ **私钥永远保留在 `/opt/docmind/data/keys/ed25519.priv`,不要 commit、不要复制。**
如果私钥泄漏,需要轮换密钥并重新发放所有 license,代价巨大。

---

## 六、PayJS 配置

1. 注册 https://payjs.cn 完成商户审核(个人/个体户即可)
2. 拿到 `商户号(MCHID)` 和 `密钥(KEY)`,填入 `.env`
3. 重启容器:`docker compose up -d`
4. PayJS 控制台填写"异步通知地址":
   `https://doc-api.boyobang.com/api/v1/payment/payjs/webhook`
5. 测一笔小额订单,在 `https://doc-api.boyobang.com/admin/orders` 应能看到记录

---

## 七、上传第一个客户端版本

1. 在你的 Mac/PC 用 `npm run tauri build` 构建安装包
2. 拿到 `.dmg` / `.msi` 文件 + Tauri 生成的 `.sig` 签名
3. 浏览器打开 `https://doc-api.boyobang.com/admin/releases`
4. 表单填:版本号 / 平台 / edition=free,选择二进制和 .sig,提交
5. 客户端通过 `/api/v1/updates/{platform}/{cur_ver}` 自动收到更新提示

---

## 八、备份

`/opt/docmind/data/` 目录是所有状态。建议宝塔 → 计划任务里加一条:

```bash
0 3 * * * tar czf /www/backup/docmind/$(date +\%F).tar.gz /opt/docmind/data
```

或用宝塔自带的"备份"功能直接备份这个目录到云存储。

---

## 九、升级

API 升级:
```bash
cd /opt/docmind
git pull
docker compose build --pull
docker compose up -d
```

门户升级:
```bash
cd portal
git pull
npm run build
# 上传 dist/ 覆盖 /www/wwwroot/docmind-portal/(用宝塔文件管理或 rsync)
```

---

## 十、故障排查

| 现象 | 检查 |
|---|---|
| `curl https://doc-api.boyobang.com/` 502 | 容器没起来或 Nginx 反代地址错了。`docker compose ps` 看状态,`docker compose logs` 看错误 |
| 上传二进制 413 Request Too Large | 宝塔 Nginx 没设 `client_max_body_size 200M` |
| Caddy 重复出现在日志 | 容器没换成新 Dockerfile,执行 `docker compose build --no-cache` |
| 客户端激活报 `INVALID_TOKEN` | 客户端的 `SERVER_PUBLIC_KEY_HEX` 与服务器不匹配 |
| 客户端 fetch 报 CORS | 当前不是问题,客户端是 Tauri 本机发起请求,无 CORS;如果在浏览器手动调试,需要单独加 CORS 头 |
| 门户站 404(子页面)| Nginx 没配 `try_files $uri $uri/ $uri/index.html`(`deploy/nginx/doc-web.conf` 已包含)|
| PayJS webhook 没回调 | PayJS 后台填的 notify_url 必须是 https,域名要能从 PayJS 服务器外网访问 |

查看实时日志:
```bash
docker compose logs -f --tail=200 docmind-server
```

查 Nginx 错误日志(宝塔):
- 网站 → 设置 → 日志

---

## 完全卸载

```bash
cd /opt/docmind
docker compose down -v       # -v 会删除 data 卷,慎用
sudo rm -rf /opt/docmind
# 宝塔面板里删除两个站点
```
