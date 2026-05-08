#!/usr/bin/env sh
# Container entry point.
# 后台跑 Axum (loopback :8081),前台跑 Caddy (:8080) 处理 Host 路由。
# SSL 终止 + 证书续期由宿主机宝塔 Nginx 完成。

set -e

if [ -z "$ADMIN_PASSWORD" ] || [ "$ADMIN_PASSWORD" = "change-me" ]; then
    echo "[entrypoint] ERROR: ADMIN_PASSWORD must be set (and not 'change-me')."
    exit 1
fi

mkdir -p "${DATA_DIR:-/data}/db" "${DATA_DIR:-/data}/keys" "${DATA_DIR:-/data}/releases"

echo "[entrypoint] starting docmind-server on ${LISTEN_ADDR:-127.0.0.1:8081}..."
docmind-server &
SERVER_PID=$!

trap "echo '[entrypoint] stopping...'; kill -TERM $SERVER_PID 2>/dev/null || true; exit 0" TERM INT

# 等 Axum 起来再起 Caddy(避免冷启动 502)
for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null --max-time 1 "http://${LISTEN_ADDR:-127.0.0.1:8081}/" 2>/dev/null; then
        break
    fi
    sleep 0.5
done

echo "[entrypoint] starting caddy on :8080 (DOMAIN=${DOMAIN}, PORTAL_DOMAIN=${PORTAL_DOMAIN})..."
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
