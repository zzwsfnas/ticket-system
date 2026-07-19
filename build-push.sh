#!/usr/bin/env bash
# ============================================================
# 变电运维五班操作票典型票系统 —— 构建并推送到私有镜像仓库
# 在【开发/构建机】上执行（不是 FNOS 上）。
# 前置：在 .env 中配置 IMAGE（以及 REGISTRY_USER/REGISTRY_PASS 若需登录）。
# 流程：docker build -> docker login(可选) -> docker push
#       若 .env 设了 VERSION，会额外推送 <IMAGE名>:<VERSION> 便于回滚。
# ============================================================
set -euo pipefail

# 定位到脚本所在目录（ticket-system/），构建上下文即当前目录
cd "$(dirname "$0")"

# 载入 .env（若存在）
if [ -f .env ]; then set -a; . ./.env; set +a; fi

IMAGE="${IMAGE:?请在 .env 中设置 IMAGE（如 registry.example.com/ticket-system:latest）}"
CTX="${BUILD_CONTEXT:-.}"

# 0) 前置检查
command -v docker >/dev/null 2>&1 || { echo "错误: 未找到 docker" >&2; exit 1; }

echo "=================================================="
echo " 操作票系统 · 构建并推送镜像"
echo " 镜像: $IMAGE"
echo " 构建上下文: $CTX"
echo "=================================================="

# 1) 构建镜像（含 better-sqlite3 原生模块，构建较慢请耐心等待）
echo "==> [1/3] 构建镜像 ..."
docker build -t "$IMAGE" "$CTX"

# 2) 登录私有仓库（若配置了凭据）
if [ -n "${REGISTRY_USER:-}" ]; then
  echo "==> [2/3] 登录私有仓库 ${REGISTRY:-${IMAGE%%/*}} ..."
  printf '%s' "$REGISTRY_PASS" | docker login "${REGISTRY:-${IMAGE%%/*}}" -u "$REGISTRY_USER" --password-stdin
fi

# 3) 推送
echo "==> [3/3] 推送 $IMAGE ..."
docker push "$IMAGE"

if [ -n "${VERSION:-}" ]; then
  VT="${IMAGE%:*}:${VERSION}"
  docker tag "$IMAGE" "$VT"
  docker push "$VT"
  echo "    已推送版本标签: $VT"
fi

echo ""
echo "✅ 构建并推送完成。在 FNOS 部署目录执行 ./update-compose.sh 即可拉取更新。"
