#!/usr/bin/env bash
#
# DocMind self-hosted backend — bootstrap installer.
#
# 在已装好 Docker + 宝塔面板的服务器上运行。本脚本只负责起 API 容器,
# 站点 / 证书 / 反代 都在宝塔面板里手动配置,详见 DEPLOYMENT.md。
#
#   bash install.sh

set -euo pipefail

INSTALL_DIR=${INSTALL_DIR:-/opt/docmind}
REPO_URL=${REPO_URL:-https://github.com/caizhongrui/DocMind.git}
BRANCH=${BRANCH:-main}

if ! command -v docker >/dev/null; then
    echo "[install] Docker is required. 在宝塔软件商店安装 Docker,或运行:"
    echo "          curl -fsSL https://get.docker.com | bash"
    exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
    echo "[install] Docker Compose v2 is required."
    exit 1
fi

echo "[install] Cloning DocMind into $INSTALL_DIR..."
sudo mkdir -p "$INSTALL_DIR"
sudo chown "$USER" "$INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" pull --ff-only
else
    git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

if [ ! -f .env ]; then
    cp .env.example .env
    echo "[install] Wrote .env. 填几个关键值..."

    read -rp "API 域名 [doc-api.boyobang.com]: " api_dom
    read -rp "门户域名 [doc-web.boyobang.com]: " portal_dom
    read -rsp "管理员密码 (用于 /admin 后台登录): " admin_pw; echo
    read -rp "PayJS 商户号 (无可留空): " payjs_mid
    read -rsp "PayJS 商户密钥 (无可留空): " payjs_key; echo

    sed -i "s|^DOMAIN=.*|DOMAIN=${api_dom:-doc-api.boyobang.com}|" .env
    sed -i "s|^PORTAL_DOMAIN=.*|PORTAL_DOMAIN=${portal_dom:-doc-web.boyobang.com}|" .env
    sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${admin_pw}|" .env
    sed -i "s|^PAYJS_MERCHANT_ID=.*|PAYJS_MERCHANT_ID=${payjs_mid}|" .env
    sed -i "s|^PAYJS_KEY=.*|PAYJS_KEY=${payjs_key}|" .env
    sed -i "s|^PAYJS_NOTIFY_URL=.*|PAYJS_NOTIFY_URL=https://${api_dom:-doc-api.boyobang.com}/api/v1/payment/payjs/webhook|" .env
fi

echo "[install] Building & starting docmind-server..."
docker compose up -d --build

echo "[install] 等待容器初始化(生成 Ed25519 keypair)..."
for _ in $(seq 1 30); do
    if [ -f data/keys/ed25519.pub ]; then break; fi
    sleep 1
done

echo
echo "═════════════════════════════════════════════════════════════════"
if [ -f data/keys/ed25519.pub ]; then
    pubkey=$(cat data/keys/ed25519.pub)
    echo "  ✅ API 容器已启动"
    echo
    echo "  Ed25519 服务端公钥(粘贴到客户端 SERVER_PUBLIC_KEY_HEX):"
    echo "  $pubkey"
else
    echo "  ⚠️  未发现公钥文件,检查日志: docker compose logs -f"
fi
echo "═════════════════════════════════════════════════════════════════"
echo
echo "下一步在宝塔面板里完成:"
echo "  1) 添加站点 doc-api.boyobang.com → 反向代理到 127.0.0.1:8080"
echo "     (用 deploy/nginx/doc-api.conf 作为 Nginx 配置参考)"
echo "  2) 构建门户站(npm install && npm run build,在 portal/ 目录),"
echo "     把 portal/dist/ 上传到 /www/wwwroot/docmind-portal/"
echo "  3) 添加站点 doc-web.boyobang.com → 静态站,根目录上面那个路径"
echo "     (用 deploy/nginx/doc-web.conf 作为 Nginx 配置参考)"
echo "  4) 两个站点都申 Let's Encrypt 证书,启用强制 HTTPS"
echo
echo "完整说明见 DEPLOYMENT.md"
