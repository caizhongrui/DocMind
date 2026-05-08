# DocMind 自建后端部署指南

DocMind 的 license 服务、PayJS 支付回调、Tauri 自动更新、营销门户站全部打包在一个 Docker 容器里。本文档说明如何在你已备案的国内服务器上部署。

## 准备

- 已备案的域名,比如 `doc-web.boyobang.com` + `doc-api.boyobang.com`(子域)
- 一台 Linux 服务器(2C2G 起,30GB 磁盘),固定 IP
- DNS A 记录把这两个域名都指向这台服务器
- 防火墙开放 80 / 443 端口
- Docker 20.10+ 和 Docker Compose v2

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/caizhongrui/DocMind/main/install.sh | bash
```

脚本会:
1. 把仓库 clone 到 `/opt/docmind`
2. 提示你输入域名 / Let's Encrypt 邮箱 / 管理员密码 / PayJS 商户号
3. 写入 `.env`
4. `docker compose up -d --build` 起服务
5. 打印 Ed25519 公钥 — 把这一串值粘贴到客户端 `src-tauri/src/license/token.rs::SERVER_PUBLIC_KEY_HEX` 后再发布客户端

## 手动部署

```bash
git clone https://github.com/caizhongrui/DocMind.git /opt/docmind
cd /opt/docmind
cp .env.example .env
vi .env                  # 填入你的域名 / 密码 / PayJS 信息
docker compose up -d --build
docker compose logs -f docmind-server
```

首次启动会:
- 生成 Ed25519 keypair 到 `data/keys/`
- 在日志中打印一段公钥,**保存这段公钥**
- migrate SQLite 到 `data/db/docmind.sqlite`
- Caddy 自动申请 Let's Encrypt 证书(需要 80 端口可达 + DNS 已生效)

## 烧入公钥到客户端

```rust
// src-tauri/src/license/token.rs
pub const SERVER_PUBLIC_KEY_HEX: &str =
    "<把日志里打印的 64 字符 hex 公钥粘到这里>";
```

修改后重新构建 client 安装包,上传到 `/admin/releases`。

⚠️ **私钥永远保留在 server 端 `data/keys/ed25519.priv`,不要 commit 到 Git,不要复制到任何其他位置。** 如果私钥泄漏,你需要轮换密钥并重新发放所有 license。

## PayJS 配置

1. 注册 https://payjs.cn 完成商户审核(个体户即可)
2. 拿到 `商户号(MCHID)` 和 `密钥(KEY)`,填入 `.env`
3. 在 PayJS 控制台填写"异步通知地址":`https://doc-api.boyobang.com/api/v1/payment/payjs/webhook`
4. 测试一笔 ¥0.01 订单,在 `/admin/orders` 应能看到记录

## 上传第一个版本

1. 用 GitHub Actions / 本地 `npm run tauri build` 构建 macOS / Windows 安装包
2. 拿到二进制和 `.sig` 文件(Tauri updater 用)
3. 浏览器访问 `https://doc-api.boyobang.com/admin/releases`
4. 在"上传新版本"表单填好版本号 / 平台 / edition,选择二进制和 .sig,提交
5. 完成后客户端通过 `/api/v1/updates/{platform}/{cur_ver}` 自动检测到新版本

## 备份

`data/` 目录是所有状态。建议每天 cron 打包到另一台机器:

```bash
0 3 * * * tar czf /backup/docmind-$(date +\%F).tar.gz /opt/docmind/data && \
          rsync -e "ssh -p 22" /backup/docmind-$(date +\%F).tar.gz user@backup-host:/backups/
```

## 升级

```bash
cd /opt/docmind
git pull
docker compose build --pull
docker compose up -d
```

数据卷不动,平滑升级。

## 监控

- `docker compose ps` 看容器状态
- `docker compose logs -f docmind-server` 看应用日志
- `/admin` 看业务统计(订单、license、下载)
- 服务器层建议挂个 uptime 监控(UptimeRobot / Better Stack)

## 故障排查

| 现象 | 检查 |
|---|---|
| Caddy 拿不到证书 | 80 端口外网可达?DNS 已生效?日志里看 ACME 错误 |
| PayJS webhook 没回调 | PayJS 后台填的 notify_url 必须是 https,域名要能从 PayJS 服务器访问 |
| 客户端激活报 `INVALID_TOKEN` | 客户端的 `SERVER_PUBLIC_KEY_HEX` 没烧成最新公钥 |
| 下载页 404 | `/admin/releases` 还没上传任何二进制 |
| 容器重启后状态丢失 | 检查 `docker compose.yml` 的 volumes 是否正确挂了 `./data:/data` |

## 完全卸载

```bash
cd /opt/docmind
docker compose down -v       # -v 会同时删除卷(慎用)
sudo rm -rf /opt/docmind     # 永久删除所有数据
```
