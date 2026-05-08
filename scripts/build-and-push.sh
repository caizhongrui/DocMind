#!/usr/bin/env bash
#
# Build the DocMind backend Docker image (multi-arch) and push to the registry.
#
# 默认推到阿里云青岛(国内服务器拉得快):
#   registry.cn-qingdao.aliyuncs.com/boyocloud/docmind-server:YYYYMMDD-N
#   registry.cn-qingdao.aliyuncs.com/boyocloud/docmind-server:latest
#
# 用 docker buildx 构建 linux/amd64 + linux/arm64,适配国内 x86 服务器
# 与 Apple Silicon / ARM 服务器。
#
# 用法:
#   bash scripts/build-and-push.sh                  # 自动今天日期 + 序号 +1
#   bash scripts/build-and-push.sh 20260508-3       # 手动指定 tag
#   REGISTRY=... bash scripts/build-and-push.sh     # 换 registry

set -euo pipefail

REGISTRY=${REGISTRY:-registry.cn-qingdao.aliyuncs.com/boyocloud}
IMAGE_NAME=${IMAGE_NAME:-docmind-server}
PLATFORMS=${PLATFORMS:-linux/amd64,linux/arm64}
DATE_TAG=$(date +%Y%m%d)

# ── 决定具体 tag ───────────────────────────────────────────────────────────
if [ $# -ge 1 ]; then
    TAG="$1"
    echo "[build] using user-specified tag: $TAG"
else
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

cd "$(dirname "$0")/.."

# ── 确保 buildx builder 存在 ──────────────────────────────────────────────
if ! docker buildx inspect multi-builder >/dev/null 2>&1; then
    echo "[build] creating buildx builder 'multi-builder'..."
    docker buildx create --name multi-builder --use --bootstrap
else
    docker buildx use multi-builder
fi

# ── 构建并推送 ────────────────────────────────────────────────────────────
echo "[build] platforms: ${PLATFORMS}"
echo "[build] tags: ${FULL_TAG}, ${LATEST_TAG}"
echo "[build] (multi-arch builds 直接推送,不会落到本地 docker images)"

docker buildx build \
    --platform "${PLATFORMS}" \
    --tag "${FULL_TAG}" \
    --tag "${LATEST_TAG}" \
    --push \
    .

echo
echo "═════════════════════════════════════════════════════════════════"
echo "  ✅ 已推送(多架构)"
echo "  本次 tag: ${TAG}"
echo "  完整镜像: ${FULL_TAG}"
echo
echo "  在生产服务器上更新到这个版本:"
echo "    cd /opt/docmind"
echo "    docker compose pull && docker compose up -d"
echo
echo "  固定到具体 tag(回滚用):"
echo "    IMAGE_TAG=${FULL_TAG} docker compose up -d"
echo "═════════════════════════════════════════════════════════════════"
