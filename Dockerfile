# DocMind self-hosted backend(API + 门户站,单容器)
#
# 部署模式:
#   - 容器内:Caddy(:8080,plain HTTP)按 Host 分流到
#       doc-web.* → /app/portal 静态文件
#       doc-api.* → Axum :8081(loopback)
#   - 宿主机:宝塔 Nginx 终止 SSL,反代两个子域到 127.0.0.1:8080
#
# Stages:
#   1. portal-build  Astro 静态产物
#   2. server-build  Rust Axum 二进制
#   3. runtime       Debian slim + Caddy + 两个产物

# ────────────────────────────────────────────────────────────────────────────
# Stage 1: Portal (Astro)
# ────────────────────────────────────────────────────────────────────────────
FROM docker.m.daocloud.io/library/node:20-alpine AS portal-build
WORKDIR /portal
COPY portal/package.json portal/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY portal/ ./
RUN npm run build
# 产物:/portal/dist

# ────────────────────────────────────────────────────────────────────────────
# Stage 2: Server (Rust + Axum)
# ────────────────────────────────────────────────────────────────────────────
FROM docker.m.daocloud.io/library/rust:1.86-slim AS server-build
WORKDIR /server

RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src

COPY server/src ./src
RUN touch src/main.rs && cargo build --release

# ────────────────────────────────────────────────────────────────────────────
# Stage 3: Runtime
# ────────────────────────────────────────────────────────────────────────────
FROM docker.m.daocloud.io/library/debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        tini \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Copy the official Caddy binary directly — Go static binary, works on any
# glibc system. Avoids adding the cloudsmith apt repo (which breaks against
# the daocloud-mirrored debian image due to keyring deps).
COPY --from=docker.m.daocloud.io/library/caddy:2.10-alpine /usr/bin/caddy /usr/local/bin/caddy

WORKDIR /app

COPY --from=portal-build /portal/dist                            /app/portal
COPY --from=server-build /server/target/release/docmind-server   /usr/local/bin/docmind-server
COPY Caddyfile                                                   /etc/caddy/Caddyfile
COPY entrypoint.sh                                               /entrypoint.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/docmind-server /usr/local/bin/caddy

# Axum 监听 8081(loopback),Caddy 监听 8080(对外)
ENV DATA_DIR=/data \
    LISTEN_ADDR=127.0.0.1:8081 \
    DOMAIN=doc-api.boyobang.com \
    PORTAL_DOMAIN=doc-web.boyobang.com \
    PORTAL_ROOT=/app/portal

EXPOSE 8080

VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
