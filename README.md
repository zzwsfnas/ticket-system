# 变电运维五班操作票典型票系统

## 快速启动

```bash
# 1. 安装依赖
cd ticket-system
npm install

# 2. 导入现有数据
npm run migrate

# 3. 启动服务
npm start
# 访问 http://localhost:3000
```

## 系统功能

### 1. 操作任务与项目管理
- **按变电站浏览** — 顶部下拉切换变电站，显示该站所有典型操作任务
- **新增操作任务** — 修改模式下可为变电站新增任务（含分类标签）
- **新增操作项目** — 展开任务后，修改模式下可新增步骤
- **编辑操作项目** — 修改操作项内容，自动记录修改时间与版本历史
- **版本对比查看** — 每项操作可查看修改历史（修改前/修改后对比）
- **数据自动同步** — 所有修改实时写入数据库，多端数据一致

### 2. 权限控制
- **查看模式（默认）** — 无需密码，可浏览全部票库内容
- **修改模式** — 输入密码 `Wjjks000.` 后解锁编辑功能
- 密码使用 bcrypt 加盐哈希存储
- 修改操作记录到操作日志

### 3. 管理功能
- 操作日志：记录所有修改操作的时间与内容摘要
- 数据完整性检查：自动校验孤立数据
- 导入现有典型票 JSON 数据

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/auth/status | 查看当前权限状态 |
| POST | /api/auth/login | 密码验证登录 |
| GET | /api/substations | 获取所有变电站列表 |
| GET | /api/tasks?substation_id=X | 获取指定站的操作任务 |
| POST | /api/tasks | 新增操作任务（需修改权限） |
| GET | /api/items?task_id=X | 获取指定任务的操作项目 |
| POST | /api/items | 新增操作项目（需修改权限） |
| PUT | /api/items/:id | 修改操作项目（需修改权限，自动记录版本） |
| DELETE | /api/items/:id | 删除操作项目（需修改权限） |
| GET | /api/items/:id/history | 查看单项修改历史 |
| GET | /api/tasks/:id/history | 查看整任务的修改历史 |
| GET | /api/audit-log | 操作日志（需修改权限） |
| GET | /api/integrity-check | 数据完整性检查（需修改权限） |
| POST | /api/import | 从 JSON 导入现有数据 |

## 部署到 Cloudflare

```bash
# 1. 构建前端
cp -r public/ deploy_dist/

# 2. 部署到 Pages（前端的静态文件）
npx wrangler pages deploy deploy_dist --project-name=ticket-system

# 3. 部署 Workers API（需要 D1 数据库）
# 见 cloudflare-worker.js
```
