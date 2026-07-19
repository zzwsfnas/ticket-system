# 变电运维五班操作票典型票系统 · Docker 部署（FnOS / 群晖 / 任意 Docker 主机）

本文覆盖三种更新方式，推荐用**私有镜像仓库**（免传源码）。数据库始终保存在宿主机 `./data`，与镜像/容器分离，更新不会丢数据。

---

## 一、首次部署（构建自源码）

适合没有私有仓库、直接把代码放到 NAS 的场景：

1. 将本项目目录上传到 NAS（FnOS 等），例如 `/volume1/docker/ticket-system`。
2. 进入该目录，构建并启动容器：

   ```bash
   cd /volume1/docker/ticket-system
   docker compose up -d --build
   ```

3. 浏览器访问 `http://<NAS_IP>:3000` 即可使用。
   - 默认查看模式可直接浏览、搜索、批量导出、复制操作票。
   - 点击右上角「验证密码」输入管理密码（`Wjjks000.`）进入修改模式，可进行新增/删除/导入/AI 校验等。

---

## 二、增量更新（无需重建整个容器）

新版本发布时，**无需重新构建镜像、也无需重建容器**，只需把新代码同步进正在运行的容器并重启即可：

```bash
cd /volume1/docker/ticket-system
chmod +x update.sh
./update.sh            # 默认读取 ./app 作为新代码目录
# 或指定目录: ./update.sh /path/to/new_release/app
```

脚本会执行：
1. `docker cp` 将 `server.js` / `package.json` / `public/` 同步进运行中的容器；
2. 如 `package.json` 变化则重装依赖；
3. `docker compose restart` 仅重启容器使新代码生效。

> 整个过程数据库（`./data` 卷）完全不受影响。回滚：用旧版本代码目录再执行一次 `./update.sh <旧版本目录>`。

---

## 三、Docker Compose 一键更新（构建自源码）

若希望在 NAS 上直接用最新源码重建镜像 + 重建容器（最干净、可回滚），用 `update-compose.sh`：

```bash
cd /volume1/docker/ticket-system
chmod +x update-compose.sh
./update-compose.sh                 # 用当前目录源码重建并重启
./update-compose.sh --no-pull       # 跳过基础镜像更新（离线/加速）
./update-compose.sh --prune         # 更新后再清理悬空镜像
```

脚本自动：打 backup 标签 → `docker compose build --no-cache` → `docker compose up -d --remove-orphans` → 健康检查。
回滚：`docker compose down && docker tag ticket-system:backup ticket-system:latest && docker compose up -d`。

---

## 四、私有镜像仓库部署（推荐：免传源码）

把镜像构建一次并推送到私有仓库（阿里云 ACR / 腾讯 TCR / Harbor / 自建 registry 均可），之后 **FNOS 上只需拉镜像，不再传源码**。

### 1) 配置仓库地址（一次）
复制 `ticket-system/.env.example` 为 `.env` 并填写：

```bash
cd /volume1/docker/ticket-system
cp .env.example .env
vi .env        # 填入 IMAGE / REGISTRY_USER / REGISTRY_PASS
```

```ini
IMAGE=registry.cn-hangzhou.aliyuncs.com/your_ns/ticket-system:latest
REGISTRY=registry.cn-hangzhou.aliyuncs.com
REGISTRY_USER=your_user
REGISTRY_PASS=your_pass
# VERSION=1.2.0   # 可选：构建时同时打版本标签
```

> `docker-compose.yml` 已改为 `image: ${IMAGE}`，不再本地构建。

### 2) 在开发/构建机：构建并推送（每次发版执行一次）
```bash
cd <本地项目>/ticket-system
chmod +x build-push.sh
./build-push.sh
```
脚本自动 `docker build` → `docker login`（若配了凭据）→ `docker push`（及可选 `VERSION` 标签）。

### 3) 在 FNOS：拉取并更新（每次更新执行）
```bash
cd /volume1/docker/ticket-system
chmod +x update-compose.sh
./update-compose.sh            # 登录(如需) → 拉取 → 重建容器
./update-compose.sh --no-pull  # 用本地已有镜像重建（离线/调试）
./update-compose.sh --no-prune # 不清理悬空镜像
```
脚本自动：登录 → 旧镜像打 `ticket-system:backup` → `docker compose pull` → `docker compose up -d --remove-orphans` → 健康检查。

### 4) FnOS Docker 图形界面等效操作
1. 「镜像」→「拉取」，填入 `IMAGE` 地址并登录私有仓库；
2. 「Compose」里该项目的 YAML 确认 `image` 已指向仓库地址，点「更新/构建」或先停止容器再「重新创建」。

### 5) 回滚
```bash
docker compose down
docker tag ticket-system:backup <IMAGE>
docker compose up -d
```
（`<IMAGE>` 即 `.env` 里的完整镜像地址；若推送过 `VERSION` 标签，也可直接把 `.env` 的 `IMAGE` 改成版本标签后重新 `./update-compose.sh`。）

---

## 五、目录说明

```
ticket-system/
├── Dockerfile            # 镜像构建（含 better-sqlite3 原生模块）
├── docker-compose.yml    # 服务定义，image 取自 .env 的 IMAGE，数据挂载 ./data，含健康检查
├── .env.example          # 私有仓库配置样例（复制为 .env 填写）
├── .dockerignore         # 构建时排除 node_modules / data 等
├── build-push.sh         # 【构建机】构建并推送到私有仓库
├── update-compose.sh     # 【FNOS】从私有仓库拉取并一键更新（可回滚）
├── update.sh             # 增量更新（docker cp 进运行容器 + restart）
├── server.js             # 后端服务
├── public/               # 前端
└── data/                 # （运行时生成）SQLite 数据库，已持久化
```

`docker-compose.yml` 关键字段：
```yaml
services:
  ticket-system:
    image: ${IMAGE:?请在 .env 中设置 IMAGE}
    container_name: ticket-system
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: ["./data:/app/data"]
    environment: [TZ=Asia/Shanghai, PORT=3000]
```

---

## 六、数据备份

定期备份 `./data/tickets.db` 文件即可。建议结合 FnOS 的存储快照或定时任务复制该文件。

> 注意：`.dockerignore` 已排除 `data/`，镜像内不会包含票库；票库永远只来自宿主机挂载卷。

---

## 七、EXE 桌面版（内网单机）

若内网为纯 Windows 单机、不便运行 Docker，可使用 Release 中的 `变电运维五班操作票典型票系统.exe`：
双击运行即自动打开浏览器，数据保存在 exe 同目录 `data/`。升级时**仅替换 exe** 即可（前端已内置，数据独立）。
