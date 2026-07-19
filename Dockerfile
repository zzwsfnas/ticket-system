# 变电运维五班操作票典型票系统 - Docker 镜像
FROM node:22-slim AS builder

# 编译原生模块需要 Python 与构建工具：
# connect-sqlite3 会拉入 sqlite3（node-sqlite3），它在 arm64 / Node 22 下无预编译包，
# 必须本地用 node-gyp 编译，否则报 “Could not find any Python installation”。
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:22-slim

WORKDIR /app

# 安装运行时依赖和时区数据
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# 从构建阶段复制编译好的 native 模块和依赖
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# 创建数据目录
RUN mkdir -p /app/data

EXPOSE 3000

VOLUME ["/app/data"]

CMD ["node", "server.js"]
