#!/usr/bin/env bash
# ============================================================
# 变电运维五班操作票典型票系统 —— 从私有镜像仓库一键更新
# 在【FNOS / 任意部署机】上执行（前提是已在 .env 配置 IMAGE）。
# 用法:
#   ./update-compose.sh            # 登录(如需) -> 拉取 -> 重建容器
#   ./update-compose.sh --no-pull  # 跳过拉取，用本地已有镜像重建（离线/调试）
#   ./update-compose.sh --no-prune # 不清理悬空镜像
#   ./update-compose.sh -h         # 帮助
# 作用:
#   1. 登录私有仓库（配置了 REGISTRY_USER 时）
#   2. 给当前旧镜像打 ticket-system:backup 标签（回滚点）
#   3. docker compose pull 拉取新镜像
#   4. docker compose up -d --remove-orphans 重建并重启容器
#   5. 等待健康检查通过并汇报状态
# 数据库 (./data 卷) 完全不受影响。回滚见脚本末尾提示。
# ============================================================
set -euo pipefail

# 定位到脚本所在目录（无论从哪调用都能正确工作）
cd "$(dirname "$0")"

# 载入 .env（若存在）
if [ -f .env ]; then set -a; . ./.env; set +a; fi

# --- 解析参数 ---
PULL=1
PRUNE=1
for arg in "$@"; do
  case "$arg" in
    --no-pull)  PULL=0 ;;
    --no-prune) PRUNE=0 ;;
    -h|--help)  sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg（用 -h 查看帮助）" >&2; exit 1 ;;
  esac
done

SERVICE="ticket-system"
IMAGE="${IMAGE:-ticket-system}"
BACKUP_REF="${SERVICE}:backup"

echo "=================================================="
echo " 操作票系统 · 私有仓库一键更新"
echo " 镜像: $IMAGE"
echo " 目录: $(pwd)"
echo "=================================================="

# 0) 前置检查
if ! command -v docker >/dev/null 2>&1; then
  echo "错误: 未找到 docker，请先安装/启用 Docker。" >&2
  exit 1
fi
if [ ! -f docker-compose.yml ] && [ ! -f compose.yml ]; then
  echo "错误: 当前目录未发现 docker-compose.yml。" >&2
  exit 1
fi

# 1) 登录私有仓库（若配置了凭据）
if [ -n "${REGISTRY_USER:-}" ]; then
  echo "==> [1/5] 登录私有仓库 ${REGISTRY:-${IMAGE%%/*}} ..."
  printf '%s' "$REGISTRY_PASS" | docker login "${REGISTRY:-${IMAGE%%/*}}" -u "$REGISTRY_USER" --password-stdin
fi

# 2) 给当前旧镜像打 backup 标签（回滚用）
echo "==> [2/5] 为旧镜像打 backup 标签 ..."
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker tag "$IMAGE" "$BACKUP_REF"
  echo "    已标记 $BACKUP_REF（回滚点已就绪）"
else
  echo "    无旧镜像，跳过（首次部署）"
fi

# 3) 拉取新镜像
if [ "$PULL" -eq 1 ]; then
  echo "==> [3/5] 拉取新镜像 ..."
  docker compose pull "$SERVICE"
else
  echo "==> [3/5] 跳过拉取 (--no-pull)"
fi

# 4) 以新镜像重建并启动容器（旧容器自动替换，data 卷保留）
echo "==> [4/5] 重建并重启容器 ..."
docker compose up -d --remove-orphans

# 5) 健康检查
echo "==> [5/5] 等待服务就绪 ..."
HEALTHY=0
for i in $(seq 1 20); do
  sleep 2
  STATUS=$(docker inspect -f '{{.State.Health.Status}}' "$SERVICE" 2>/dev/null || echo "unknown")
  if [ "$STATUS" = "healthy" ]; then HEALTHY=1; break; fi
  # 兜底：直接探测端口
  if curl -fsS -o /dev/null "http://localhost:3000/api/auth/status" 2>/dev/null; then HEALTHY=1; break; fi
done

echo ""
if [ "$HEALTHY" -eq 1 ]; then
  echo "✅ 更新完成，服务已就绪: http://<NAS_IP>:3000"
else
  echo "⚠️  容器已启动但健康检查未通过，请查看日志:"
  echo "    docker compose logs --tail=50 $SERVICE"
fi

# 6) 可选清理悬空镜像（旧镜像已被 backup 标签保留，未被清理）
if [ "$PRUNE" -eq 1 ]; then
  echo "==> 清理悬空镜像 ..."
  docker image prune -f >/dev/null 2>&1 || true
fi

echo "==> 当前容器状态:"
docker compose ps "$SERVICE" 2>/dev/null || docker ps --filter "name=$SERVICE" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

cat <<EOF

回滚方法（若更新后异常）：
  docker compose down
  docker tag ${BACKUP_REF} ${IMAGE}
  docker compose up -d
EOF
