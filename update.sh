#!/usr/bin/env bash
# ============================================================
# 变电运维五班操作票典型票系统 —— Docker 增量更新脚本
# 用法:
#   ./update.sh                 # 默认使用 ./app 作为新代码目录
#   ./update.sh /path/to/new    # 指定新版本代码目录
# 作用:
#   将新版本的应用代码（server.js / public / package.json）同步进
#   【正在运行】的容器，然后仅重启该容器。不重建镜像、不重建容器，
#   数据库（./data 卷）完全不受影响，实现真正的“增量更新”。
# ============================================================
set -euo pipefail

SRC="${1:-./app}"
if [ ! -d "$SRC" ] && [ -d "./release/app" ]; then
  SRC="./release/app"
fi

for f in "$SRC/server.js" "$SRC/package.json" "$SRC/public"; do
  if [ ! -e "$f" ]; then
    echo "错误: 新代码目录缺少必要文件: $f"
    echo "请确认 SRC 目录包含 server.js、package.json 与 public/"
    exit 1
  fi
done

echo "==> 增量更新: 将 $SRC 同步进运行中的容器 ticket-system"
echo "    （仅重启容器，不重建镜像/容器，数据库 ./data 不受影响）"

# 1) 将新代码拷贝进容器可写层（restart 不会清除该层）
docker cp "$SRC/server.js" ticket-system:/app/server.js
docker cp "$SRC/package.json" ticket-system:/app/package.json
docker cp "$SRC/public/." ticket-system:/app/public/

# 2) 若依赖清单变化则重装（镜像已含 better-sqlite3 原生模块，通常无需）
if docker exec ticket-system sh -c 'command -v npm >/dev/null && [ -f package.json ]' 2>/dev/null; then
  echo "==> 校验依赖（如有变化会自动安装）..."
  docker exec -T ticket-system npm install --omit=dev 2>&1 | tail -3 || echo "（依赖安装跳过）"
fi

# 3) 仅重启容器使新代码生效
echo "==> 重启容器..."
docker compose restart ticket-system

echo "==> 等待健康检查..."
sleep 4
docker compose ps ticket-system 2>/dev/null || docker ps --filter name=ticket-system

echo ""
echo "✅ 增量更新完成。请访问 http://<NAS_IP>:3000 验证。"
echo "   如需回滚：将上一版代码目录再次执行 ./update.sh <旧版本目录> 即可。"
