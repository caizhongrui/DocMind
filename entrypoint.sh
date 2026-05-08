#!/usr/bin/env sh
# Container entry point. Starts the Axum server in the background, then
# foregrounds Caddy so signals reach it cleanly.

set -e

# Require the operator to have set an admin password — refuse to boot with
# the default. This catches "docker run without -e" before the container
# accepts any traffic.
if [ -z "$ADMIN_PASSWORD" ] || [ "$ADMIN_PASSWORD" = "change-me" ]; then
    echo "[entrypoint] ERROR: ADMIN_PASSWORD must be set (and not 'change-me')."
    echo "             Pass it via -e ADMIN_PASSWORD=... or docker-compose environment."
    exit 1
fi

# Make sure the data dir exists with sane perms.
mkdir -p "${DATA_DIR:-/data}/db" "${DATA_DIR:-/data}/keys" "${DATA_DIR:-/data}/releases"

# Start the Rust API server in the background.
echo "[entrypoint] starting docmind-server..."
docmind-server &
SERVER_PID=$!

# Trap signals so we can shut down cleanly.
trap "echo '[entrypoint] stopping...'; kill -TERM $SERVER_PID 2>/dev/null || true; exit 0" TERM INT

# Foreground Caddy.
echo "[entrypoint] starting caddy..."
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
