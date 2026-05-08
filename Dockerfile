# syntax=docker/dockerfile:1.6
#
# Multi-stage build for the DocMind self-hosted backend + marketing portal.
#
# Stage layout:
#   1. portal-build  — Astro static site (pure HTML/CSS/JS)
#   2. server-build  — Rust Axum server binary
#   3. runtime       — Debian slim + Caddy + the two artifacts
#
# Final image is one container that:
#   - serves api.docmind.app via Axum on :8080 behind Caddy reverse-proxy
#   - serves docmind.app as static files from /app/portal
#   - persists state under /data (mount this as a volume)

# ────────────────────────────────────────────────────────────────────────────
# 1. Portal (Astro)
# ────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS portal-build
WORKDIR /portal

# Cache deps — copy package manifest first
COPY portal/package.json ./

# Astro doesn't ship a lockfile in this repo, so generate fresh.
RUN npm install --no-audit --no-fund

# Copy the rest of the portal source and build
COPY portal/ ./
RUN npm run build

# ────────────────────────────────────────────────────────────────────────────
# 2. Server (Rust + Axum)
# ────────────────────────────────────────────────────────────────────────────
FROM rust:1.83-slim AS server-build
WORKDIR /server

# Build deps for rusqlite (bundled feature builds sqlite from source)
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy manifest first for caching
COPY server/Cargo.toml server/Cargo.lock ./

# Pre-fetch + warm up dependency build
RUN mkdir -p src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src

# Copy real source
COPY server/src ./src
RUN touch src/main.rs && cargo build --release

# ────────────────────────────────────────────────────────────────────────────
# 3. Runtime
# ────────────────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

# Caddy + ca-certificates (for outbound HTTPS to PayJS) + tini
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        tini \
        curl \
        debian-keyring debian-archive-keyring apt-transport-https gnupg \
    && curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    && curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list \
    && apt-get update && apt-get install -y --no-install-recommends caddy \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy artifacts
COPY --from=portal-build  /portal/dist                       /app/portal
COPY --from=server-build  /server/target/release/docmind-server  /usr/local/bin/docmind-server
COPY Caddyfile                                                /etc/caddy/Caddyfile
COPY entrypoint.sh                                            /entrypoint.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/docmind-server

# Default config — override at runtime
ENV DATA_DIR=/data \
    LISTEN_ADDR=127.0.0.1:8080 \
    DOMAIN=api.docmind.app \
    PORTAL_DOMAIN=docmind.app

EXPOSE 80 443

VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
