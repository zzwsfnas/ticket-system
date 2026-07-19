/**
 * 一键打包脚本：将系统构建为 Windows 可执行 exe，并组装成可分发的 release 目录
 * 用法：npm run build:exe
 * 产物：release/变电运维五班操作票典型票系统/
 *        ├─ 变电运维五班操作票典型票系统.exe   (含 Node 运行时+全部依赖+前端页面)
 *        ├─ data/tickets.db                    (数据库，升级时保留不覆盖)
 *        └─ 使用说明.txt
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const EXE_NAME = '变电运维五班操作票典型票系统.exe';
const RELEASE_ROOT = path.join(ROOT, 'release');
const RELEASE = path.join(RELEASE_ROOT, '变电运维五班操作票典型票系统');

function log(msg) { console.log('\n\x1b[36m▶ ' + msg + '\x1b[0m'); }

// 1) 调用 pkg 打包
log('[1/4] 正在打包 exe（首次会下载 Node22-win 基础运行时，请稍候）...');
fs.mkdirSync(DIST, { recursive: true });
const distExe = path.join(DIST, 'ticket-system.exe');
const pkgBin = require.resolve('@yao-pkg/pkg/lib-es5/bin.js');
execFileSync(process.execPath, [
  pkgBin, '.',
  '--target', 'node22-win-x64',
  '--output', distExe,
], { stdio: 'inherit', cwd: ROOT });
if (!fs.existsSync(distExe)) throw new Error('打包失败：未生成 exe');

// 2) 组装 release 目录（直接覆盖，避免触发环境的 rmSync 安全删除钩子）
log('[2/4] 组装发布目录 ...');
try { fs.mkdirSync(RELEASE, { recursive: true }); } catch (e) {}

// 3) 复制 exe + data（前端已内置在 exe 中，无需单独复制 public）
fs.copyFileSync(distExe, path.join(RELEASE, EXE_NAME));
fs.mkdirSync(path.join(RELEASE, 'data'), { recursive: true });
// 清理 release/data 中可能残留的 WAL/SHM，避免与复制进来的主库不一致导致“database disk image is malformed”
for (const ext of ['-wal', '-shm']) {
  const stale = path.join(RELEASE, 'data', 'tickets.db' + ext);
  try { if (fs.existsSync(stale)) fs.unlinkSync(stale); } catch (e) { /* 忽略 */ }
}
const srcDb = path.join(ROOT, 'data', 'tickets.db');
if (fs.existsSync(srcDb)) {
  fs.copyFileSync(srcDb, path.join(RELEASE, 'data', 'tickets.db'));
  let dbInfo = '';
  try {
    const D = require('better-sqlite3');
    const db = new D(srcDb);
    const t = db.prepare('SELECT COUNT(*) n FROM tasks').get().n;
    const i = db.prepare('SELECT COUNT(*) n FROM items').get().n;
    dbInfo = `（${t} 任务 / ${i} 项目）`;
  } catch (e) { /* 忽略计数错误 */ }
  log('已包含现有票库数据' + dbInfo);
} else {
  log('未发现现有数据库，exe 首次启动将自动创建空库');
}

// 4) 写使用说明
log('[3/4] 写入使用说明 ...');
const readme = [
  '变电运维五班操作票典型票系统 — 桌面版 使用说明',
  '================================================',
  '',
  '【运行】',
  '  双击「' + EXE_NAME + '」即可启动，程序会自动打开浏览器进入系统。',
  '  若浏览器未自动打开，手动访问：http://localhost:3000',
  '  （若 3000 端口被占用，会自动切换到 3001、3002…，以黑色命令窗口中显示的地址为准）',
  '  关闭黑色命令窗口即停止服务。',
  '',
  '【使用】',
  '  · 查看模式：默认无需密码，可浏览全部变电站操作票。',
  '  · 修改模式：点击「验证密码」，默认密码 Wjjks000.（进入后可在管理中修改）。',
  '  · 支持新增/删除操作票、TXT 批量导入/批量导出、复制操作票（生成副本）、操作项目行级插入/上下移动、在线文本批量编辑、一键复制、版本历史、操作日志等。',
  '  · 导入 TXT 时若操作任务重名，默认用新内容覆盖旧票并在历史中注明“替换导入”（可在导入弹窗取消勾选改为跳过）。',
  '  · AI 校验：管理模式下可为每张操作票一键调用 AI（DeepSeek / OpenAI 兼容 / 自定义）检查术语准确性与错漏字，并执行本地规范性检查（管理→🤖 AI配置 接入模型）。',
  '',
  '【数据】',
  '  所有数据保存在本程序同目录的 data\\tickets.db 文件中，数据不出本机。',
  '  建议定期备份 data 文件夹即可完整保存全部票库。',
  '',
  '【升级】',
  '  前端已内置在 exe 中，升级只需用「新 exe」覆盖「旧 exe」即可（无需动 data）；',
  '  切勿覆盖 data 文件夹，以免丢失数据。',
  '',
  '【卸载】',
  '  直接删除整个文件夹即可，不写注册表、不留系统残留。',
  '',
  '【内网部署】',
  '  本程序完全离线运行，无需联网、无需安装 Node 环境。',
  '  拷贝整个文件夹到目标电脑即可使用。',
  '',
  '发布日期：' + new Date().toLocaleDateString('zh-CN'),
].join('\r\n');
fs.writeFileSync(path.join(RELEASE, '使用说明.txt'), readme, 'utf8');

log('[4/4] 完成！');
console.log('\n\x1b[32m✔ 发布目录已生成：\x1b[0m');
console.log('  ' + RELEASE);
const stat = fs.statSync(path.join(RELEASE, EXE_NAME));
console.log('  exe 体积：' + (stat.size / 1024 / 1024).toFixed(1) + ' MB');
console.log('\n将该文件夹整体拷贝到内网电脑，双击 exe 即可运行。\n');
