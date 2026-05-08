# DocMind self-hosted backend(API + 门户站,单容器,Node 20)
#
# 部署模式:
#   - 容器内 Node :8080 监听 plain HTTP,按 Host 头分流:
#       Host = doc-web.* → 静态门户(/app/portal,Astro 构建产物)
#       Host = doc-api.* → API + admin + activate
#   - 宿主机宝塔 Nginx 终止 SSL,反代两个子域到 127.0.0.1:8080。
#
# better-sqlite3 通过 prebuild-install 拉取 Alpine x64 / arm64 预编译二进制,
# 找不到才回落到源码编译(server-build 阶段已带 python3 + g++)。

# ────────────────────────────────────────────────────────────────────────────
# Stage 1: Portal (Astro static)
# ────────────────────────────────────────────────────────────────────────────
FROM docker.m.daocloud.io/library/node:20-alpine AS portal-build
WORKDIR /portal
COPY portal/package.json portal/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY portal/ ./
RUN npm run build

# ────────────────────────────────────────────────────────────────────────────
# Stage 2: Server (Node + TypeScript)
# ────────────────────────────────────────────────────────────────────────────
FROM docker.m.daocloud.io/library/node:20-alpine AS server-build
WORKDIR /server

# Native build deps for better-sqlite3 (used only as a fallback when
# prebuild-install can't fetch the prebuilt .node binary).
RUN apk add --no-cache python3 make g++ libc-dev linux-headers

COPY server-node/package.json server-node/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY server-node/tsconfig.json ./
COPY server-node/src ./src
RUN npm run build && \
    npm prune --omit=dev

# ────────────────────────────────────────────────────────────────────────────
# Stage 3: Runtime
# ────────────────────────────────────────────────────────────────────────────
FROM docker.m.daocloud.io/library/node:20-alpine AS runtime

RUN apk add --no-cache tini

WORKDIR /app

# Server artifacts: dist/ + node_modules/ (production-only after `npm prune`)
COPY --from=server-build /server/dist          /app/dist
COPY --from=server-build /server/node_modules  /app/node_modules
COPY --from=server-build /server/package.json  /app/package.json

# Portal static
COPY --from=portal-build /portal/dist          /app/portal

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8080 \
    PORTAL_ROOT=/app/portal \
    DOMAIN=doc-api.boyobang.com \
    PORTAL_DOMAIN=doc-web.boyobang.com

EXPOSE 8080
VOLUME ["/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
