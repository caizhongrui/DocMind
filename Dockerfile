# syntax=docker/dockerfile:1.6
#
# DocMind self-hosted backend — Axum API only.
#
# 宝塔面板部署模式:
#   - 容器只跑 Rust API,监听 :8080,不处理 SSL
#   - 宝塔 Nginx 在宿主机终止 SSL,反向代理 doc-api.boyobang.com → 127.0.0.1:8080
#   - 门户站(portal/)是纯静态站,build 后上传到宝塔某个网站根目录,由宝塔 Nginx
#     直接 file_server,不进入这个容器

# ────────────────────────────────────────────────────────────────────────────
# Stage 1: Rust build
# ────────────────────────────────────────────────────────────────────────────
FROM rust:1.83-slim AS server-build
WORKDIR /server

# Build deps for rusqlite (bundled feature builds sqlite from source)
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config build-essential \
    && rm -rf /var/lib/apt/lists/*

# Cache deps
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src

# Real source
COPY server/src ./src
RUN touch src/main.rs && cargo build --release

# ────────────────────────────────────────────────────────────────────────────
# Stage 2: Runtime — Debian slim + ca-certificates only
# ────────────────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=server-build /server/target/release/docmind-server /usr/local/bin/docmind-server
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/docmind-server

# Bind to 0.0.0.0 inside the container so the host's BT Nginx can reach
# us via the published port. The docker-compose `ports:` mapping limits
# external access to 127.0.0.1 on the host.
ENV DATA_DIR=/data \
    LISTEN_ADDR=0.0.0.0:8080 \
    DOMAIN=doc-api.boyobang.com \
    PORTAL_DOMAIN=doc-web.boyobang.com

EXPOSE 8080

VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
