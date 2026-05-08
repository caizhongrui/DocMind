#!/usr/bin/env bash
#
# Build the DocMind backend Docker image and push to the private registry.
#
# Tag scheme:  registry.boyocloud.com/boyo/docmind-server:YYYYMMDD-N
#              registry.boyocloud.com/boyo/docmind-server:latest
#
# `N` 是当天的发布序号 — 脚本自动从 registry 查最近今天的 tag 并自增。
# 也可以传一个完整 tag 跳过自动检测:  bash scripts/build-and-push.sh 20260508-3

set -euo pipefail

REGISTRY=${REGISTRY:-registry.boyocloud.com/boyo}
IMAGE_NAME=${IMAGE_NAME:-docmind-server}
DATE_TAG=$(date +%Y%m%d)

# ── 决定具体 tag ───────────────────────────────────────────────────────────
if [ $# -ge 1 ]; then
    TAG="$1"
    echo "[build] using user-specified tag: $TAG"
else
    # 在本地 docker 镜像缓存里找今天最高序号(不依赖 registry 网络可达)。
    # 如果你只在 push 后才依赖 registry 中的 tag 可见性,改成查 registry 也行。
    HIGHEST=$(docker images "${REGISTRY}/${IMAGE_NAME}" --format '{{.Tag}}' \
        | grep -E "^${DATE_TAG}-[0-9]+$" \
        | sed -E "s/^${DATE_TAG}-//" \
        | sort -n \
        | tail -1 || true)
    if [ -z "$HIGHEST" ]; then
        SEQ=1
    else
        SEQ=$((HIGHEST + 1))
    fi
    TAG="${DATE_TAG}-${SEQ}"
    echo "[build] auto-bumped tag: $TAG"
fi

FULL_TAG="${REGISTRY}/${IMAGE_NAME}:${TAG}"
LATEST_TAG="${REGISTRY}/${IMAGE_NAME}:latest"

# ── 构建 ───────────────────────────────────────────────────────────────────
cd "$(dirname "$0")/.."

echo "[build] docker build -t ${FULL_TAG} ..."
docker build --pull -t "${FULL_TAG}" -t "${LATEST_TAG}" .

# ── 询问是否推送(可用 PUSH=1 跳过) ──────────────────────────────────────
PUSH=${PUSH:-}
if [ -z "$PUSH" ]; then
    read -rp "Push ${FULL_TAG} 到 ${REGISTRY} ? [y/N] " ans
    case "$ans" in
        y|Y|yes) PUSH=1 ;;
        *)       PUSH=0 ;;
    esac
fi

if [ "$PUSH" = "1" ]; then
    echo "[push] ${FULL_TAG}"
    docker push "${FULL_TAG}"
    echo "[push] ${LATEST_TAG}"
    docker push "${LATEST_TAG}"
fi

# ── 在服务器上的拉取命令(便于复制) ──────────────────────────────────────
echo
echo "═════════════════════════════════════════════════════════════════"
echo "  本次 tag: ${TAG}"
echo "  完整镜像: ${FULL_TAG}"
echo
echo "  在生产服务器上更新到这个版本:"
echo "    cd /opt/docmind"
echo "    IMAGE_TAG=${FULL_TAG} docker compose pull"
echo "    IMAGE_TAG=${FULL_TAG} docker compose up -d"
echo
echo "  或固定到 latest:"
echo "    docker compose pull && docker compose up -d"
echo "═════════════════════════════════════════════════════════════════"
