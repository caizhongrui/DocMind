#!/usr/bin/env sh
# Container entry point. Just runs the Axum server.
# SSL termination + static portal hosting are done by the host's BT Nginx.

set -e

if [ -z "$ADMIN_PASSWORD" ] || [ "$ADMIN_PASSWORD" = "change-me" ]; then
    echo "[entrypoint] ERROR: ADMIN_PASSWORD must be set (and not 'change-me')."
    echo "             Pass it via -e ADMIN_PASSWORD=... or docker-compose environment."
    exit 1
fi

mkdir -p "${DATA_DIR:-/data}/db" "${DATA_DIR:-/data}/keys" "${DATA_DIR:-/data}/releases"

echo "[entrypoint] starting docmind-server on ${LISTEN_ADDR:-0.0.0.0:8080}..."
exec docmind-server
