#!/usr/bin/env bash
#
# DocMind self-hosted backend — bootstrap installer.
#
# Run on a fresh server (备案后) with Docker installed:
#
#   curl -fsSL https://raw.githubusercontent.com/caizhongrui/DocMind/main/install.sh | bash
#
# It will clone the repo, copy .env.example, prompt for the few required
# secrets, and bring the stack up.

set -euo pipefail

INSTALL_DIR=${INSTALL_DIR:-/opt/docmind}
REPO_URL=${REPO_URL:-https://github.com/caizhongrui/DocMind.git}
BRANCH=${BRANCH:-main}

if ! command -v docker >/dev/null; then
    echo "[install] Docker is required. Install via 'curl -fsSL https://get.docker.com | bash' first."
    exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
    echo "[install] Docker Compose v2 is required (Docker 20.10+ usually ships it as a plugin)."
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
    echo "[install] Wrote .env. Filling in required values..."

    read -rp "domain for API server [api.docmind.app]: " api_dom
    read -rp "domain for portal site [docmind.app]: " portal_dom
    read -rp "ACME email (Let's Encrypt notifications): " acme
    read -rsp "admin password for /admin: " admin_pw; echo
    read -rp "PayJS merchant ID (leave blank to set later): " payjs_mid
    read -rsp "PayJS merchant key (leave blank to set later): " payjs_key; echo

    sed -i "s|^DOMAIN=.*|DOMAIN=${api_dom:-api.docmind.app}|" .env
    sed -i "s|^PORTAL_DOMAIN=.*|PORTAL_DOMAIN=${portal_dom:-docmind.app}|" .env
    sed -i "s|^ACME_EMAIL=.*|ACME_EMAIL=${acme}|" .env
    sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${admin_pw}|" .env
    sed -i "s|^PAYJS_MERCHANT_ID=.*|PAYJS_MERCHANT_ID=${payjs_mid}|" .env
    sed -i "s|^PAYJS_KEY=.*|PAYJS_KEY=${payjs_key}|" .env
    sed -i "s|^PAYJS_NOTIFY_URL=.*|PAYJS_NOTIFY_URL=https://${api_dom:-api.docmind.app}/api/v1/payment/payjs/webhook|" .env
fi

echo "[install] Building & starting docmind-server..."
docker compose up -d --build

echo "[install] Waiting for the public key to be generated..."
for _ in $(seq 1 30); do
    if [ -f data/keys/ed25519.pub ]; then break; fi
    sleep 1
done

if [ -f data/keys/ed25519.pub ]; then
    pubkey=$(cat data/keys/ed25519.pub)
    echo
    echo "─────────────────────────────────────────────────────────────────"
    echo "  Stack is up."
    echo "  Public key (bake into desktop client SERVER_PUBLIC_KEY_HEX):"
    echo "  $pubkey"
    echo "─────────────────────────────────────────────────────────────────"
fi

echo
echo "[install] Done. Visit:"
echo "  https://$(grep ^PORTAL_DOMAIN .env | cut -d= -f2)"
echo "  https://$(grep ^DOMAIN .env | cut -d= -f2)/admin/login"
