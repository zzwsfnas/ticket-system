const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
// 打包(pkg)运行时 __dirname 指向只读快照；数据与静态资源需放在 exe 同目录
const IS_PKG = typeof process.pkg !== 'undefined';
const BASE_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = path.join(BASE_DIR, 'data');
// 前端资源：开发模式用外部 public；打包模式统一用 exe 内置快照，
// 这样“只换 exe”即可完整升级前后端，数据(data)独立保存在 exe 同目录。
const PUBLIC_DIR = IS_PKG ? path.join(__dirname, 'public') : path.join(BASE_DIR, 'public');
const DB_PATH = path.join(DATA_DIR, 'tickets.db');

// --- Database Setup ---
fs.mkdirSync(DATA_DIR, { recursive: true });
const KNOWLEDGE_DIR = path.join(DATA_DIR, 'knowledge');
fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
const APK_DIR = path.join(DATA_DIR, 'apk');
fs.mkdirSync(APK_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS substations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    substation_id INTEGER NOT NULL,
    task_content TEXT NOT NULL,
    category TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (substation_id) REFERENCES substations(id)
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    item_content TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS items_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    old_content TEXT,
    new_content TEXT,
    changed_at TEXT DEFAULT (datetime('now','localtime')),
    operator TEXT DEFAULT 'admin',
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    rating INTEGER,
    suggestion TEXT DEFAULT '',
    ai_raw TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS ai_prompt_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ticket_type TEXT NOT NULL DEFAULT 'default',
    content TEXT NOT NULL,
    description TEXT DEFAULT '',
    is_default INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS ai_prompt_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (template_id) REFERENCES ai_prompt_templates(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS ai_knowledge_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime TEXT DEFAULT '',
    size INTEGER DEFAULT 0,
    ticket_type TEXT NOT NULL DEFAULT 'default',
    extracted_text TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    error_msg TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS item_edit_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    submitter TEXT DEFAULT '一般用户',
    proposed_items TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    submit_note TEXT DEFAULT '',
    reviewer TEXT DEFAULT '',
    review_note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    reviewed_at TEXT DEFAULT '',
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );
`);
  // 兼容旧库：补充"修改前快照"列（一般用户保存后即生效，记录原始内容供管理员恢复）
  try {
    db.prepare("ALTER TABLE item_edit_submissions ADD COLUMN before_items TEXT DEFAULT '[]'").run();
  } catch (e) { /* 列已存在则忽略 */ }
  // 本地校验问题反馈表（一般用户提交 → 管理员据此调整校验规范）
  db.exec(`
  CREATE TABLE IF NOT EXISTS validation_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    task_content TEXT DEFAULT '',
    submitter TEXT DEFAULT '',
    issues_json TEXT DEFAULT '[]',
    status TEXT DEFAULT 'open',
    review_note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    resolved_at TEXT DEFAULT ''
  );
  `);

// 校验规范标准（管理员在线维护，本地校验按此执行）
(() => {
  const v = db.prepare("SELECT value FROM settings WHERE key='validation_standards'").get();
  if (!v) {
    const def = JSON.stringify({
      number_format: 'arabic',                 // arabic=阿拉伯数字编号 / chinese=中文数字编号 / none=不校验
      forbidden_words: '和闸,闸刀,傍路,线络,接电线,合入,拉和,验电笔,合阐,拉阐,刀阐,确在和位',
      required_verbs: '拉开,合上,检查,确认,装设,拆除,投入,退出,切换,验明,推上,拉至,断开,悬挂,取下,装上,记录,汇报,测量,核对,调整,充电,送电,解除,恢复,解锁,闭锁',
      banned_punct: '',
      required_steps: '',
      paired_verbs: '合上|拉开,投入|退出,装设|拆除,悬挂|取下',                        // 不应出现的标点字符，逗号分隔
      notes: '默认规范：编号使用阿拉伯数字；禁用常见错别字；操作项目以规范动词开头。'
    });
    db.prepare("INSERT INTO settings (key, value) VALUES ('validation_standards', ?)").run(def);
  }
})();

// 初始化默认提示词模板（四重校验，可被管理员编辑/微调；按操作票类型适配）
(() => {
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM ai_prompt_templates').get().n;
  if (cnt === 0) {
    const defaultPrompt = `你是一名资深「电力操作票智能审核员」，服务于变电运维典型操作票审核场景。请基于下方【参考规范文档】（若有）与电力行业通用规范，对操作票执行四重校验：

① 逻辑校验：依据变电站"五防"规则与设备状态转移矩阵，检查操作步骤先后顺序是否合规，是否存在逻辑颠倒、跳步、遗漏关键步骤（如未验电即挂地线、未断开开关即拉刀闸等）。

② 五防校验：重点核对是否存在以下典型违章操作：误分/误合断路器；带负荷拉、合隔离开关（刀闸）；带电挂（合）接地线（接地刀闸）；带接地线（接地刀闸）合断路器（隔离开关）；误入带电间隔。

③ 术语校验：检查操作动词与设备对象是否正确匹配，操作术语是否符合电力行业规范标准，是否存在口语化、错字、歧义表述。

④ 结果输出：逐条标注校验结果，明确错误类型，对每条错误给出具体修改建议，并给出最终审核结论。

错误类型(error_type)取值：编号错误、逻辑颠倒、术语不规范、五防违规、错漏字、其他。严重程度(type)取值：error(必须修改)、warn(建议修改)、info(提示)。

请严格只输出一个 JSON 对象，不要输出任何额外解释文字，格式为：
{
  "issues": [
    {"line": 行号(整数；任务层面问题用 null),"category":"逻辑校验|五防校验|术语校验|其他","type":"error|warn|info","error_type":"编号错误|逻辑颠倒|术语不规范|五防违规|错漏字|其他","msg":"问题描述","suggestion":"具体修改建议"}
  ],
  "conclusion": "通过" | "不通过" | "通过（有提示）",
  "summary": "总体审核说明"
}
若未发现任何问题，issues 为空数组 []，conclusion 为 "通过"。`;
    const info = db.prepare("INSERT INTO ai_prompt_templates (name, ticket_type, content, description, is_default) VALUES (?, 'default', ?, '系统默认四重校验提示词，可复制后按操作票类型微调', 1)").run('默认四重校验', defaultPrompt);
    db.prepare('INSERT INTO ai_prompt_versions (template_id, version, content, note) VALUES (?, 1, ?, ?)')
      .run(info.lastInsertRowid, defaultPrompt, '初始版本');
  }
})();


// Seed default password: Wjjks000.
const pwRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('password_hash');
if (!pwRow) {
  const hash = bcrypt.hashSync('Wjjks000.', 10);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('password_hash', hash);
}

// --- Middleware ---
app.use(express.json({ limit: '200mb' }));

// PWA：manifest 与 Service Worker 需要正确的 Content-Type 才能被安装/注册
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').sendFile(path.join(PUBLIC_DIR, 'manifest.webmanifest'));
});
app.get('/sw.js', (req, res) => {
  res.type('application/javascript').set('Service-Worker-Allowed', '/').sendFile(path.join(PUBLIC_DIR, 'sw.js'));
});

app.use(express.static(PUBLIC_DIR));
app.use(session({
  secret: 'ticket-system-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// --- Auth Middleware ---
function requireEdit(req, res, next) {
  if (req.session.isEditor) return next();
  return res.status(403).json({ error: '需要修改权限，请先验证密码' });
}

function audit(action, summary) {
  db.prepare('INSERT INTO audit_log (action_type, summary) VALUES (?, ?)').run(action, summary);
}

// 统一替换某操作票的全部操作项目，并写历史。operator 用于区分修改来源（admin / 审核通过）。
function replaceItems(taskId, newItemsArr, operator = 'admin') {
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM items WHERE task_id = ? ORDER BY sort_order, id').all(taskId);
    let updated = 0, added = 0, removed = 0;
    const max = Math.max(old.length, newItemsArr.length);
    for (let i = 0; i < max; i++) {
      const o = old[i];
      const n = newItemsArr[i];
      if (o && n !== undefined) {
        if (o.item_content !== n) {
          db.prepare("UPDATE items SET item_content = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(n, o.id);
          db.prepare('INSERT INTO items_history (item_id, old_content, new_content, operator) VALUES (?, ?, ?, ?)').run(o.id, o.item_content, n, operator);
          updated++;
        }
      } else if (o && n === undefined) {
        db.prepare('DELETE FROM items WHERE id = ?').run(o.id);
        removed++;
      } else if (!o && n !== undefined) {
        db.prepare('INSERT INTO items (task_id, item_content, sort_order) VALUES (?, ?, ?)').run(taskId, n, i + 1);
        added++;
      }
    }
    const all = db.prepare('SELECT id FROM items WHERE task_id = ? ORDER BY sort_order, id').all(taskId);
    all.forEach((it, idx) => db.prepare('UPDATE items SET sort_order = ? WHERE id = ?').run(idx + 1, it.id));
    return { updated, added, removed };
  })();
}

// --- Auth Routes ---
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: '请输入密码' });
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('password_hash');
  if (bcrypt.compareSync(password, row.value)) {
    req.session.isEditor = true;
    audit('LOGIN', '管理员登录');
    return res.json({ success: true });
  }
  return res.status(401).json({ error: '密码错误' });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// 修改密码
app.post('/api/auth/change-password', requireEdit, (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) return res.status(400).json({ error: '缺少必填字段' });
  if (new_password.length < 6) return res.status(400).json({ error: '新密码长度至少6位' });
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('password_hash');
  if (!row) return res.status(500).json({ error: '密码未初始化' });
  if (!bcrypt.compareSync(old_password, row.value)) return res.status(401).json({ error: '原密码错误' });
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(hash, 'password_hash');
  audit('CHANGE_PASSWORD', '管理员修改密码');
  res.json({ success: true });
});

app.get('/api/auth/status', (req, res) => {
  res.json({ isEditor: !!req.session.isEditor });
});

// --- Substations ---
app.get('/api/substations', (req, res) => {
  const list = db.prepare('SELECT * FROM substations ORDER BY name').all();
  res.json(list);
});

// --- Tasks ---
app.get('/api/tasks', (req, res) => {
  const { substation_id } = req.query;
  let rows;
  if (substation_id) {
    rows = db.prepare('SELECT * FROM tasks WHERE substation_id = ? ORDER BY sort_order, id').all(substation_id);
  } else {
    rows = db.prepare('SELECT * FROM tasks ORDER BY substation_id, sort_order, id').all();
  }
  res.json(rows);
});

app.post('/api/tasks', requireEdit, (req, res) => {
  const { substation_id, task_content, category, items } = req.body;
  if (!substation_id || !task_content) return res.status(400).json({ error: '缺少必填字段' });
  const tx = db.transaction(() => {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) + 1 AS n FROM tasks WHERE substation_id = ?').get(substation_id);
    const result = db.prepare('INSERT INTO tasks (substation_id, task_content, category, sort_order) VALUES (?, ?, ?, ?)')
      .run(substation_id, task_content, category || '', maxOrder.n);
    const taskId = result.lastInsertRowid;
    let importedItems = 0;
    if (Array.isArray(items)) {
      let order = 0;
      const stmt = db.prepare('INSERT INTO items (task_id, item_content, sort_order) VALUES (?, ?, ?)');
      for (const content of items) {
        const c = (content || '').toString().trim();
        if (!c) continue;
        order++;
        stmt.run(taskId, c, order);
        importedItems++;
      }
    }
    audit('ADD_TASK', `新增操作票: ${task_content.substring(0, 50)}（含 ${importedItems} 项操作）`);
    return { id: result.lastInsertRowid, items: importedItems };
  });
  const r = tx();
  res.json({ id: r.id, success: true, items_imported: r.items });
});

// 批量导出操作票为 TXT（普通权限即可，无需修改密码）
// 格式：每张票「操作任务」单独一行，其后每行为「操作项目」，票与票之间空一行
app.get('/api/tasks/export', (req, res) => {
  const { ids } = req.query;
  if (!ids) return res.status(400).json({ error: '缺少 ids 参数' });
  const idList = ids.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
  if (idList.length === 0) return res.status(400).json({ error: '没有有效的操作票ID' });
  // 保持用户勾选的顺序
  const orderMap = new Map(idList.map((id, i) => [id, i]));
  const placeholders = idList.map(() => '?').join(',');
  const tasks = db.prepare(`SELECT * FROM tasks WHERE id IN (${placeholders})`).all(...idList);
  tasks.sort((a, b) => orderMap.get(a.id) - orderMap.get(b.id));
  let out = '';
  for (const t of tasks) {
    const items = db.prepare('SELECT item_content FROM items WHERE task_id = ? ORDER BY sort_order, id').all(t.id);
    const lines = [t.task_content, ...items.map(it => it.item_content)];
    out += lines.join('\n') + '\n\n';
  }
  out = out.replace(/\n+$/, '\n'); // 末尾仅保留一个换行
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const filename = `操作票典型票导出_${ts}.txt`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tickets_export_${ts}.txt"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(out);
});

// 删除单张操作票（及其下所有操作项目，依赖外键级联）
app.delete('/api/tasks/:id', requireEdit, (req, res) => {
  const { id } = req.params;
  const old = db.prepare('SELECT task_content FROM tasks WHERE id = ?').get(id);
  if (!old) return res.status(404).json({ error: '操作票不存在' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  audit('DELETE_TASK', `删除操作票: ${old.task_content.substring(0, 50)}`);
  res.json({ success: true });
});

// 批量删除操作票
app.post('/api/tasks/batch-delete', requireEdit, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '请选择要删除的操作票' });
  let count = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const old = db.prepare('SELECT task_content FROM tasks WHERE id = ?').get(id);
      if (old) {
        db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
        count++;
      }
    }
  });
  tx();
  audit('BATCH_DELETE_TASK', `批量删除 ${count} 张操作票`);
  res.json({ success: true, deleted: count });
});

// 从 TXT 批量导入操作票（客户端已解析为结构化数据 { substation_id, tickets:[{task, items}] }）
// 复制操作票（含其下所有操作项目），生成副本
app.post('/api/tasks/:id/duplicate', requireEdit, (req, res) => {
  const { id } = req.params;
  const src = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!src) return res.status(404).json({ error: '操作票不存在' });
  const newId = db.transaction(() => {
    const newOrder = src.sort_order + 1;
    db.prepare('UPDATE tasks SET sort_order = sort_order + 1 WHERE substation_id = ? AND sort_order >= ?').run(src.substation_id, newOrder);
    const r = db.prepare('INSERT INTO tasks (substation_id, task_content, category, sort_order) VALUES (?, ?, ?, ?)')
      .run(src.substation_id, src.task_content + '（副本）', src.category || '', newOrder);
    const tid = r.lastInsertRowid;
    const items = db.prepare('SELECT item_content, sort_order FROM items WHERE task_id = ? ORDER BY sort_order, id').all(id);
    const stmt = db.prepare('INSERT INTO items (task_id, item_content, sort_order) VALUES (?, ?, ?)');
    for (const it of items) stmt.run(tid, it.item_content, it.sort_order);
    return tid;
  })();
  audit('DUPLICATE_TASK', `复制操作票: ${src.task_content.substring(0, 50)} → #${newId}`);
  res.json({ success: true, id: newId });
});

app.post('/api/import-tickets', requireEdit, (req, res) => {
  const { substation_id, tickets, replace_existing } = req.body;
  if (!substation_id) return res.status(400).json({ error: '请选择目标变电站' });
  if (!Array.isArray(tickets) || tickets.length === 0) return res.status(400).json({ error: '没有可导入的操作票' });
  // 默认替换：若操作任务名称已存在，则用上传内容覆盖其操作项目
  const replace = replace_existing === undefined ? true : !!replace_existing;
  let addedTasks = 0, addedItems = 0, replacedTasks = 0, skippedTasks = 0;
  const tx = db.transaction(() => {
    const taskStmt = db.prepare('INSERT INTO tasks (substation_id, task_content, category, sort_order) VALUES (?, ?, ?, ?)');
    const itemStmt = db.prepare('INSERT INTO items (task_id, item_content, sort_order) VALUES (?, ?, ?)');
    let maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order),0) AS n FROM tasks WHERE substation_id = ?').get(substation_id)).n;
    for (const t of tickets) {
      const task_content = (t.task || '').toString().trim();
      if (!task_content) continue;
      const existing = db.prepare('SELECT id FROM tasks WHERE substation_id = ? AND task_content = ?').get(substation_id, task_content);
      if (existing) {
        if (!replace) { skippedTasks++; continue; }
        // 替换：记录原操作项目用于历史，删除后按新内容重建
        const oldItems = db.prepare('SELECT id, item_content FROM items WHERE task_id = ? ORDER BY sort_order, id').all(existing.id);
        db.prepare('DELETE FROM items WHERE task_id = ?').run(existing.id);
        let order = 0;
        const newContents = [];
        if (Array.isArray(t.items)) {
          for (const item of t.items) {
            const c = (item || '').toString().trim();
            if (!c) continue;
            order++;
            itemStmt.run(existing.id, c, order);
            addedItems++;
            newContents.push(c);
          }
        }
        // 在历史记录中注明替换操作
        const newRows = db.prepare('SELECT id, item_content FROM items WHERE task_id = ? ORDER BY sort_order, id').all(existing.id);
        newRows.forEach((nr, i) => {
          const oldContent = oldItems[i] ? oldItems[i].item_content : '';
          if (oldContent !== nr.item_content) {
            db.prepare('INSERT INTO items_history (item_id, old_content, new_content, operator) VALUES (?, ?, ?, ?)')
              .run(nr.id, oldContent, nr.item_content, '替换导入');
          }
        });
        replacedTasks++;
        audit('IMPORT_REPLACE', `替换操作票: ${task_content.substring(0, 50)}（${oldItems.length}→${newRows.length} 项）`);
        continue;
      }
      maxOrder++;
      const r = taskStmt.run(substation_id, task_content, (t.category || '').toString(), maxOrder);
      const taskId = r.lastInsertRowid;
      let order = 0;
      if (Array.isArray(t.items)) {
        for (const item of t.items) {
          const c = (item || '').toString().trim();
          if (!c) continue;
          order++;
          itemStmt.run(taskId, c, order);
          addedItems++;
        }
      }
      addedTasks++;
    }
  });
  tx();
  audit('IMPORT_TXT', `从TXT导入 ${addedTasks} 张（新增）/ 替换 ${replacedTasks} 张 / 跳过 ${skippedTasks} 张 / 共 ${addedItems} 项操作`);
  res.json({ success: true, tasks: addedTasks, replaced: replacedTasks, skipped: skippedTasks, items: addedItems });
});

// --- Items ---
app.get('/api/items', (req, res) => {
  const { task_id } = req.query;
  if (!task_id) return res.status(400).json({ error: '缺少task_id' });
  const rows = db.prepare('SELECT * FROM items WHERE task_id = ? ORDER BY sort_order, id').all(task_id);
  res.json(rows);
});

app.post('/api/items', requireEdit, (req, res) => {
  const { task_id, item_content, after_item_id } = req.body;
  if (!task_id || !item_content) return res.status(400).json({ error: '缺少必填字段' });
  let sortOrder;
  if (after_item_id) {
    const after = db.prepare('SELECT sort_order FROM items WHERE id = ?').get(after_item_id);
    sortOrder = after ? after.sort_order + 1 : 1;
    db.prepare('UPDATE items SET sort_order = sort_order + 1 WHERE task_id = ? AND sort_order >= ?').run(task_id, sortOrder);
  } else {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) + 1 AS n FROM items WHERE task_id = ?').get(task_id);
    sortOrder = max.n;
  }
  const result = db.prepare('INSERT INTO items (task_id, item_content, sort_order) VALUES (?, ?, ?)').run(task_id, item_content, sortOrder);
  audit('ADD_ITEM', `新增操作项目: ${item_content.substring(0, 50)}`);
  res.json({ id: result.lastInsertRowid, success: true });
});

app.put('/api/items/:id', requireEdit, (req, res) => {
  const { id } = req.params;
  const { item_content } = req.body;
  if (!item_content) return res.status(400).json({ error: '缺少内容' });
  const old = db.prepare('SELECT item_content FROM items WHERE id = ?').get(id);
  if (!old) return res.status(404).json({ error: '项目不存在' });
  db.prepare('UPDATE items SET item_content = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(item_content, id);
  db.prepare('INSERT INTO items_history (item_id, old_content, new_content) VALUES (?, ?, ?)').run(id, old.item_content, item_content);
  audit('EDIT_ITEM', `修改操作项目 #${id}: ${old.item_content.substring(0,30)} → ${item_content.substring(0,30)}`);
  res.json({ success: true });
});

app.delete('/api/items/:id', requireEdit, (req, res) => {
  const { id } = req.params;
  const old = db.prepare('SELECT item_content FROM items WHERE id = ?').get(id);
  if (!old) return res.status(404).json({ error: '项目不存在' });
  db.prepare('DELETE FROM items WHERE id = ?').run(id);
  audit('DELETE_ITEM', `删除操作项目: ${old.item_content.substring(0, 50)}`);
  res.json({ success: true });
});

// --- 操作项目排序（上/下移动，管理权限）---
app.post('/api/items/:id/move', requireEdit, (req, res) => {
  const { id } = req.params;
  const { direction } = req.body || {};
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: '项目不存在' });
  const list = db.prepare('SELECT id, sort_order FROM items WHERE task_id = ? ORDER BY sort_order, id').all(item.task_id);
  const idx = list.findIndex(x => x.id === item.id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= list.length) return res.json({ success: true, moved: false });
  const a = list[idx], b = list[swapIdx];
  db.prepare('UPDATE items SET sort_order = ? WHERE id = ?').run(b.sort_order, a.id);
  db.prepare('UPDATE items SET sort_order = ? WHERE id = ?').run(a.sort_order, b.id);
  res.json({ success: true, moved: true });
});

// --- 在线批量编辑某操作任务下所有操作项目（TXT 文本）---
app.post('/api/tasks/:id/items-replace', requireEdit, (req, res) => {
  const { id } = req.params;
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: '缺少 items 列表' });
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: '操作票不存在' });
  const newItems = items.map(s => (s || '').toString().trim()).filter(s => s.length > 0);
  const r = replaceItems(id, newItems, 'admin');
  audit('EDIT_ITEMS_REPLACE', `在线编辑操作项目 #${id}: 改 ${r.updated} / 增 ${r.added} / 删 ${r.removed}`);
  res.json({ success: true, ...r });
});

// --- 在线编辑提交（一般用户：保存后直接生效，并记录修改前快照供管理员审核/恢复） ---
app.post('/api/tasks/:id/items-submit', (req, res) => {
  const { id } = req.params;
  const { items, submitter, note } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: '缺少 items 列表' });
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: '操作票不存在' });
  const proposed = items.map(s => (s || '').toString().trim());
  const before = db.prepare('SELECT item_content FROM items WHERE task_id = ? ORDER BY sort_order, id').all(id).map(i => i.item_content);
  const exists = db.prepare("SELECT id, before_items FROM item_edit_submissions WHERE task_id = ? AND status = 'pending'").get(id);
  // 直接生效（一般用户保存即替换当前操作项目内容）
  const r = replaceItems(id, proposed, '一般用户');
  const subName = (submitter || '一般用户').toString().trim().slice(0, 50) || '一般用户';
  let subId, status = 'pending';
  if (exists) {
    // 已有待审核提交：保留最初修改前快照（供管理员一键恢复），仅更新最新提案
    const origBefore = JSON.parse(exists.before_items || '[]');
    const origBeforeArr = Array.isArray(origBefore) ? origBefore : before;
    db.prepare(`UPDATE item_edit_submissions SET proposed_items = ?, submitter = ?, submit_note = ?, created_at = datetime('now','localtime') WHERE id = ?`)
      .run(JSON.stringify(proposed), subName, (note || '').toString().slice(0, 500), exists.id);
    subId = exists.id;
    audit('EDIT_SUBMIT', `一般用户在线编辑（更新待审提交）并生效 #${id}（提交人：${subName}）/ 改 ${r.updated} 增 ${r.added} 删 ${r.removed}`);
  } else {
    const info = db.prepare(`INSERT INTO item_edit_submissions (task_id, submitter, proposed_items, before_items, status, submit_note, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, datetime('now','localtime'))`)
      .run(id, subName, JSON.stringify(proposed), JSON.stringify(before), (note || '').toString().slice(0, 500));
    subId = info.lastInsertRowid;
    audit('EDIT_SUBMIT', `一般用户在线编辑保存并生效 #${id}（提交人：${subName}）/ 改 ${r.updated} 增 ${r.added} 删 ${r.removed}`);
  }
  res.json({ success: true, id: subId, status, updated: r.updated, added: r.added, removed: r.removed });
});

// --- 审核列表（管理员） ---
app.get('/api/edit-submissions', requireEdit, (req, res) => {
  const status = req.query.status || 'pending';
  const order = (req.query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const rows = db.prepare(`
    SELECT s.*, t.task_content, t.category, sub.name AS substation_name
    FROM item_edit_submissions s
    JOIN tasks t ON t.id = s.task_id
    LEFT JOIN substations sub ON sub.id = t.substation_id
    WHERE s.status = ?
    ORDER BY s.created_at ${order}
  `).all(status);
  res.json(rows.map(r => ({ ...r, proposed_items: JSON.parse(r.proposed_items || '[]'), before_items: JSON.parse(r.before_items || '[]') })));
});

app.get('/api/edit-submissions/:id', requireEdit, (req, res) => {
  const s = db.prepare('SELECT * FROM item_edit_submissions WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '提交记录不存在' });
  const items = db.prepare('SELECT item_content FROM items WHERE task_id = ? ORDER BY sort_order, id').all(s.task_id).map(i => i.item_content);
  res.json({ ...s, proposed_items: JSON.parse(s.proposed_items || '[]'), before_items: JSON.parse(s.before_items || '[]'), current_items: items });
});

app.post('/api/edit-submissions/:id/approve', requireEdit, (req, res) => {
  const { id } = req.params;
  const s = db.prepare('SELECT * FROM item_edit_submissions WHERE id = ?').get(id);
  if (!s) return res.status(404).json({ error: '提交记录不存在' });
  if (s.status !== 'pending') return res.status(409).json({ error: '该提交已处理' });
  // 一般用户保存时已直接生效；管理员"确认"仅作审核留痕，不再改动库
  db.prepare("UPDATE item_edit_submissions SET status='confirmed', reviewer='管理员', reviewed_at=datetime('now','localtime') WHERE id = ?").run(id);
  audit('EDIT_CONFIRM', `确认一般用户在线编辑 #${s.task_id}（提交人${s.submitter}）`);
  res.json({ success: true });
});

// 恢复原始：将操作项目还原到一般用户保存前的快照，并写入历史（operator=审核恢复）
app.post('/api/edit-submissions/:id/restore', requireEdit, (req, res) => {
  const { id } = req.params;
  const { note } = req.body || {};
  const s = db.prepare('SELECT * FROM item_edit_submissions WHERE id = ?').get(id);
  if (!s) return res.status(404).json({ error: '提交记录不存在' });
  if (s.status !== 'pending') return res.status(409).json({ error: '该提交已处理' });
  const before = JSON.parse(s.before_items || '[]').map(x => (x || '').toString().trim());
  const r = replaceItems(s.task_id, before, '审核恢复');
  db.prepare("UPDATE item_edit_submissions SET status='restored', reviewer='管理员', review_note=?, reviewed_at=datetime('now','localtime') WHERE id = ?")
    .run((note || '').toString().slice(0, 500), id);
  audit('EDIT_RESTORE', `恢复操作票 #${s.task_id} 至一般用户保存前原始内容（提交人${s.submitter}）/ 改 ${r.updated} 增 ${r.added} 删 ${r.removed}`);
  res.json({ success: true, ...r });
});

app.post('/api/edit-submissions/:id/reject', requireEdit, (req, res) => {
  const { id } = req.params;
  const { note } = req.body || {};
  const s = db.prepare('SELECT * FROM item_edit_submissions WHERE id = ?').get(id);
  if (!s) return res.status(404).json({ error: '提交记录不存在' });
  if (s.status !== 'pending') return res.status(409).json({ error: '该提交已处理' });
  db.prepare("UPDATE item_edit_submissions SET status='rejected', reviewer='管理员', review_note=?, reviewed_at=datetime('now','localtime') WHERE id = ?")
    .run((note || '').toString().slice(0, 500), id);
  audit('EDIT_REJECT', `驳回在线编辑 #${s.task_id}: 提交人${s.submitter}`);
  res.json({ success: true });
});

// --- 本地校验规范标准（管理员维护，一般用户只读） ---
app.get('/api/validation-standards', (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key='validation_standards'").get();
  let cfg = {};
  try { cfg = JSON.parse(row ? row.value : '{}'); } catch (e) {}
  const defaults = { number_format: 'arabic', forbidden_words: '', required_verbs: '', banned_punct: '', required_steps: '', paired_verbs: '', notes: '' };
  res.json({ ...defaults, ...cfg });
});
app.put('/api/validation-standards', requireEdit, (req, res) => {
  const b = req.body || {};
  const cfg = {
    number_format: ['arabic', 'chinese', 'none'].includes(b.number_format) ? b.number_format : 'arabic',
    forbidden_words: (b.forbidden_words || '').toString().slice(0, 1000),
    required_verbs: (b.required_verbs || '').toString().slice(0, 1000),
    banned_punct: (b.banned_punct || '').toString().slice(0, 200),
    required_steps: (b.required_steps || '').toString().slice(0, 1000),
    paired_verbs: (b.paired_verbs || '').toString().slice(0, 1000),
    notes: (b.notes || '').toString().slice(0, 1000)
  };
  db.prepare("INSERT INTO settings (key, value) VALUES ('validation_standards', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(cfg));
  audit('VALIDATION_STANDARDS', '管理员更新本地校验规范标准');
  res.json({ success: true, cfg });
});

// --- 本地校验问题反馈（一般用户提交，管理员查看并据以调整规范） ---
app.post('/api/validation-feedback', (req, res) => {
  const { task_id, issues, submitter } = req.body || {};
  if (!task_id) return res.status(400).json({ error: '缺少 task_id' });
  const task = db.prepare('SELECT task_content FROM tasks WHERE id = ?').get(task_id);
  if (!task) return res.status(404).json({ error: '操作票不存在' });
  const iss = Array.isArray(issues) ? issues : [];
  const subName = (submitter || '一般用户').toString().trim().slice(0, 50) || '一般用户';
  const info = db.prepare(`INSERT INTO validation_feedback (task_id, task_content, submitter, issues_json, status, created_at)
    VALUES (?, ?, ?, ?, 'open', datetime('now','localtime'))`)
    .run(task_id, task.task_content || '', subName, JSON.stringify(iss));
  audit('VALIDATION_FEEDBACK', `一般用户提交本地校验问题反馈 #${task_id}（${iss.length} 条，提交人：${subName}）`);
  res.json({ success: true, id: info.lastInsertRowid });
});
app.get('/api/validation-feedback', requireEdit, (req, res) => {
  const status = req.query.status || 'open';
  const rows = db.prepare(`
    SELECT * FROM validation_feedback WHERE status = ?
    ORDER BY created_at DESC
  `).all(status);
  res.json(rows.map(r => ({ ...r, issues_json: JSON.parse(r.issues_json || '[]') })));
});
app.put('/api/validation-feedback/:id', requireEdit, (req, res) => {
  const { id } = req.params;
  const { note } = req.body || {};
  const r = db.prepare("UPDATE validation_feedback SET status='resolved', review_note=?, resolved_at=datetime('now','localtime') WHERE id = ?")
    .run((note || '').toString().slice(0, 500), id);
  if (r.changes === 0) return res.status(404).json({ error: '反馈记录不存在' });
  audit('VALIDATION_FEEDBACK_RESOLVE', `处理本地校验问题反馈 #${id}`);
  res.json({ success: true });
});

// --- Version History ---
app.get('/api/items/:id/history', (req, res) => {
  const { id } = req.params;
  const rows = db.prepare('SELECT * FROM items_history WHERE item_id = ? ORDER BY changed_at DESC').all(id);
  res.json(rows);
});

// --- Task Version History (all items history for a task) ---
app.get('/api/tasks/:id/history', (req, res) => {
  const { id } = req.params;
  const rows = db.prepare(`
    SELECT ih.*, i.item_content AS current_content
    FROM items_history ih
    JOIN items i ON i.id = ih.item_id
    WHERE i.task_id = ?
    ORDER BY ih.changed_at DESC
    LIMIT 100
  `).all(id);
  res.json(rows);
});

// --- Audit Log ---
app.get('/api/audit-log', requireEdit, (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all();
  res.json(rows);
});

// --- Data Integrity Check ---
app.get('/api/integrity-check', requireEdit, (req, res) => {
  const orphanItems = db.prepare(`
    SELECT COUNT(*) AS cnt FROM items WHERE task_id NOT IN (SELECT id FROM tasks)
  `).get().cnt;
  const orphanHistory = db.prepare(`
    SELECT COUNT(*) AS cnt FROM items_history WHERE item_id NOT IN (SELECT id FROM items)
  `).get().cnt;
  const tasksWithoutItems = db.prepare(`
    SELECT COUNT(*) AS cnt FROM tasks WHERE id NOT IN (SELECT DISTINCT task_id FROM items)
  `).get().cnt;
  const allOk = orphanItems === 0 && orphanHistory === 0;
  res.json({
    allOk,
    orphanItems,
    orphanHistory,
    tasksWithoutItems,
    substations: db.prepare('SELECT COUNT(*) AS cnt FROM substations').get().cnt,
    tasks: db.prepare('SELECT COUNT(*) AS cnt FROM tasks').get().cnt,
    items: db.prepare('SELECT COUNT(*) AS cnt FROM items').get().cnt,
    history: db.prepare('SELECT COUNT(*) AS cnt FROM items_history').get().cnt,
    auditEntries: db.prepare('SELECT COUNT(*) AS cnt FROM audit_log').get().cnt
  });
});

// ===== 双通道校验：本地校验 + AI 校验（操作票术语 / 错漏字 / 逻辑 / 五防 / 规范性）=====
const AI_PROVIDERS = {
  deepseek: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  custom: { base_url: '', model: '' }
};
function getAIConfig() {
  const keys = ['ai_enabled', 'ai_provider', 'ai_base_url', 'ai_model', 'ai_api_key'];
  const cfg = {};
  for (const k of keys) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    cfg[k] = row ? row.value : '';
  }
  cfg.ai_enabled = cfg.ai_enabled === '1';
  cfg.api_key_set = !!cfg.ai_api_key;
  cfg.ai_api_key = cfg.api_key_set ? '******' : '';
  return cfg;
}
// 本地规范性检查（无需联网）：错漏字 + 重复输入 + 编号/序号/字母 + 按规范标准综合判断
function localChecks(taskContent, items, std) {
  std = std || {};
  const issues = [];
  const typoMap = {
    '和闸': '合闸', '确在和位': '确在合位', '闸刀': '刀闸', '傍路': '旁路',
    '线络': '线路', '接电线': '接地线', '合入': '合上', '拉和': '拉合',
    '验电笔': '验电器', '合阐': '合闸', '拉阐': '拉开', '刀阐': '刀闸'
  };
  const verbs = (std.required_verbs && std.required_verbs.trim())
    ? std.required_verbs.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
    : ['拉开', '合上', '检查', '确认', '装设', '拆除', '投入', '退出', '切换',
       '验明', '推上', '拉至', '断开', '悬挂', '取下', '装上', '记录', '汇报', '测量',
       '核对', '调整', '充电', '送电', '将', '装设接地线', '拆除接地线', '解除', '恢复',
       '解锁', '闭锁'];
  const forbidden = (std.forbidden_words || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
  const bannedPunct = (std.banned_punct || '').split('').map(s => s.trim()).filter(Boolean);
  const cnNumRe = /^[一二三四五六七八九十百千万零两]+/;
  const stripNum = (s) => (s || '').replace(/^\d+[.、)）]\s*/, '');
  // 错漏字 / 禁用词
  items.forEach((it, idx) => {
    const i = idx + 1;
    const t = (it || '').trim();
    if (!t) { issues.push({ type: 'error', line: i, error_type: '其他', msg: '存在空白操作项目' }); return; }
    for (const [bad, good] of Object.entries(typoMap)) {
      if (t.includes(bad)) issues.push({ type: 'warn', line: i, error_type: '错漏字', msg: `疑似错别字：“${bad}”建议改为“${good}”` });
    }
    for (const w of forbidden) {
      if (w && t.includes(w)) issues.push({ type: 'warn', line: i, error_type: '错漏字', msg: `包含禁用词：“${w}”，请按规范表述修改` });
    }
  });
  // 重复输入文字：任意两项完全相同（含跨行），以及相邻重复
  const seen = {};
  items.forEach((it, idx) => {
    const t = (it || '').trim();
    if (!t) return;
    if (seen[t] !== undefined) issues.push({ type: 'warn', line: idx + 1, error_type: '其他', msg: `与第 ${seen[t]} 项内容重复（重复输入）` });
    else seen[t] = idx + 1;
  });
  // 术语 / 操作动词开头
  items.forEach((it, idx) => {
    const t = (it || '').trim();
    if (!t) return;
    const hasVerb = verbs.some(v => t.startsWith(v));
    if (!hasVerb) issues.push({ type: 'info', line: idx + 1, error_type: '术语不规范', msg: '开头未使用规范操作动词，请确认表述准确（如：拉开/合上/检查/确认）' });
  });
  // 编号 / 序号 / 字母 规范
  const numRe = /^(\d+)[.、)）]/;
  const nums = [];
  items.forEach((it, idx) => {
    const t = (it || '').trim();
    if (!t) return;
    const m = t.match(numRe);
    if (m) nums.push({ line: idx + 1, num: parseInt(m[1], 10) });
    // 编号数字格式规范
    if (std.number_format === 'arabic' && cnNumRe.test(t)) {
      issues.push({ type: 'warn', line: idx + 1, error_type: '编号错误', msg: '规范使用阿拉伯数字编号，当前以中文数字开头，请改为"1."形式' });
    } else if (std.number_format === 'chinese' && m) {
      issues.push({ type: 'warn', line: idx + 1, error_type: '编号错误', msg: '规范使用中文数字编号，当前以阿拉伯数字开头' });
    }
    // 字母错误：中文内容中混入半角英文字母单词（疑似误输入）
    const asciiWord = t.match(/[A-Za-z]{2,}/);
    if (asciiWord && !/kV|kV|#|MV|KV/.test(t)) {
      issues.push({ type: 'info', line: idx + 1, error_type: '其他', msg: `疑似非规范字母/英文：“${asciiWord[0]}”，请确认是否为误输入` });
    }
    // 禁用标点
    if (bannedPunct.length) {
      for (const p of bannedPunct) {
        if (t.includes(p)) issues.push({ type: 'warn', line: idx + 1, error_type: '其他', msg: `不应使用标点“${p}”` });
      }
    }
  });
  if (nums.length >= 2) {
    const seenN = {};
    for (const n of nums) {
      if (seenN[n.num]) issues.push({ type: 'warn', line: n.line, error_type: '编号错误', msg: `编号重复：第 ${n.line} 项与第 ${seenN[n.num]} 项同为第 ${n.num} 项` });
      else seenN[n.num] = n.line;
    }
    if (nums[0].num === 1) {
      const maxNum = nums[nums.length - 1].num;
      const set = new Set(nums.map(n => n.num));
      for (let x = 1; x <= maxNum; x++) {
        if (!set.has(x)) issues.push({ type: 'info', line: null, error_type: '编号错误', msg: `操作项目编号不连续，缺少第 ${x} 项` });
      }
    }
  }
  // 必含步骤关键词（可配置）
  const reqSteps = (std.required_steps && std.required_steps.trim())
    ? std.required_steps.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean) : [];
  if (reqSteps.length) {
    const big = items.map(it => (it || '').trim()).join(' ');
    for (const kw of reqSteps) {
      if (kw && !big.includes(kw)) issues.push({ type: 'warn', line: null, error_type: '其他', msg: `操作票缺少必备步骤关键词：“${kw}”，请确认是否已执行该步骤` });
    }
  }
  // 成对动词闭合（可配置：open|close，逗号分隔）
  const pairs = (std.paired_verbs && std.paired_verbs.trim())
    ? std.paired_verbs.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
      .map(p => { const kv = p.split(/[|｜:：]/); return kv.length === 2 ? { open: kv[0].trim(), close: kv[1].trim() } : null; })
      .filter(Boolean) : [];
  if (pairs.length) {
    const allText = items.map(it => stripNum((it || '').trim())).filter(Boolean);
    for (const pr of pairs) {
      const hasOpen = allText.some(t => t.startsWith(pr.open));
      const hasClose = allText.some(t => t.startsWith(pr.close));
      if (hasOpen && !hasClose) issues.push({ type: 'warn', line: null, error_type: '其他', msg: `存在“${pr.open}”操作但缺少对应的“${pr.close}”收尾步骤，请确认是否遗漏` });
    }
  }
  // 单条多动作拆分（内置逻辑）
  items.forEach((it, idx) => {
    const t = (it || '').trim();
    if (!t) return;
    const ts = stripNum(t);
    const parts = ts.split(/[、，,；;]/).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2 && parts.filter(p => verbs.some(v => p.startsWith(v))).length >= 2) {
      issues.push({ type: 'warn', line: idx + 1, error_type: '其他', msg: '该操作项目含多个以动词开头的子句（用“、”连接），建议拆分为多条独立操作' });
    }
    if (ts.includes('并') && verbs.some(v => ts.startsWith(v))) {
      issues.push({ type: 'warn', line: idx + 1, error_type: '其他', msg: '操作项目用“并”连接多个动作，建议拆分为多条独立操作' });
    }
  });
  return issues;
}
// 解析 AI 返回（兼容「纯数组」与「{issues,conclusion,summary}」两种结构）
function parseAIResult(content) {
  let obj = null;
  try { obj = JSON.parse(content); } catch (e) {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch (e2) {} }
  }
  if (obj && typeof obj === 'object') {
    let issues = [];
    if (Array.isArray(obj)) issues = obj;
    else if (Array.isArray(obj.issues)) issues = obj.issues;
    issues = issues.map(it => ({
      line: it.line != null ? it.line : null,
      category: it.category || '其他',
      type: it.type || 'info',
      error_type: it.error_type || '其他',
      msg: it.msg || '',
      suggestion: it.suggestion || ''
    }));
    return { issues, conclusion: obj.conclusion || '', summary: obj.summary || '' };
  }
  return { issues: [], conclusion: '', summary: '' };
}
// 调用大模型执行四重校验（OpenAI 兼容接口）
async function validateWithAI(taskContent, items, config) {
  if (!config.ai_enabled || !config.ai_api_key) return { used: false, issues: [], conclusion: '', summary: '', raw: '' };
  const numbered = items.map((x, i) => (i + 1) + '. ' + x).join('\n');
  const prompt = `你是一名资深「电力操作票智能审核员」，服务于变电运维典型操作票审核场景。请对下面这张操作票执行四重校验：

① 逻辑校验：依据变电站"五防"规则与设备状态转移矩阵，检查操作步骤的先后顺序是否合规，是否存在逻辑颠倒、跳步、遗漏关键步骤（如未验电即挂地线、未断开开关即拉刀闸等）。

② 五防校验：重点核对是否存在以下典型违章操作：误分/误合断路器；带负荷拉、合隔离开关（刀闸）；带电挂（合）接地线（接地刀闸）；带接地线（接地刀闸）合断路器（隔离开关）；误入带电间隔。

③ 术语校验：检查操作动词（拉开/合上/检查/确认/装设/拆除/验明/投入/退出等）与设备对象（断路器/隔离开关/接地刀闸/母线/主变等）是否正确匹配，操作术语是否符合电力行业规范标准，是否存在口语化、错字、歧义表述。

④ 结果输出：逐条标注校验结果，明确错误类型，对每条错误给出具体修改建议，并给出最终审核结论。

错误类型(error_type)取值：编号错误、逻辑颠倒、术语不规范、五防违规、错漏字、其他。严重程度(type)取值：error(必须修改)、warn(建议修改)、info(提示)。

请严格只输出一个 JSON 对象，不要输出任何额外解释文字，格式为：
{
  "issues": [
    {"line": 行号(整数；任务层面问题用 null),"category":"逻辑校验|五防校验|术语校验|其他","type":"error|warn|info","error_type":"编号错误|逻辑颠倒|术语不规范|五防违规|错漏字|其他","msg":"问题描述","suggestion":"具体修改建议"}
  ],
  "conclusion": "通过" | "不通过" | "通过（有提示）",
  "summary": "总体审核说明"
}
若未发现任何问题，issues 为空数组 []，conclusion 为 "通过"。

操作任务：${taskContent}
操作项目（每行一条，前为行号）：
${numbered}`;
  const base = (config.ai_base_url || '').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config.ai_api_key },
      body: JSON.stringify({ model: config.ai_model, messages: [{ role: 'user', content: prompt }], temperature: 0.1 }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) return { used: true, issues: [], conclusion: '', summary: '', raw: '模型接口返回错误：HTTP ' + resp.status };
    const data = await resp.json();
    const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    const parsed = parseAIResult(content);
    return { used: true, issues: parsed.issues, conclusion: parsed.conclusion, summary: parsed.summary, raw: content };
  } catch (e) {
    clearTimeout(timer);
    return { used: false, issues: [], conclusion: '', summary: '', raw: 'AI 调用失败：' + e.message };
  }
}
// 取操作票及其项目
function loadValidationStandards() {
  const row = db.prepare("SELECT value FROM settings WHERE key='validation_standards'").get();
  try { return row ? JSON.parse(row.value) : {}; } catch (e) { return {}; }
}
function getTaskItems(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return null;
  const rows = db.prepare('SELECT item_content FROM items WHERE task_id = ? ORDER BY sort_order, id').all(taskId);
  return { task, items: rows.map(r => r.item_content) };
}
// --- 本地校验（开放给所有用户，无需修改权限）---
app.post('/api/validate/local', (req, res) => {
  const { task_id } = req.body || {};
  if (!task_id) return res.status(400).json({ error: '缺少 task_id' });
  const data = getTaskItems(task_id);
  if (!data) return res.status(404).json({ error: '操作票不存在' });
  const std = loadValidationStandards();
  const localIssues = localChecks(data.task.task_content, data.items, std);
  res.json({ success: true, task_content: data.task.task_content, items: data.items, localIssues });
});
// --- AI 校验（开放给所有用户，使用管理员预设模型；未配置时返回 notConfigured）---
app.post('/api/validate/ai', async (req, res) => {
  const { task_id, template_id, doc_ids } = req.body || {};
  if (!task_id) return res.status(400).json({ error: '缺少 task_id' });
  const data = getTaskItems(task_id);
  if (!data) return res.status(404).json({ error: '操作票不存在' });
  const config = getAIConfig();
  if (!config.ai_enabled || !config.api_key_set) {
    return res.json({ success: true, task_content: data.task.task_content, items: data.items, aiIssues: [], aiUsed: false, notConfigured: true, conclusion: '', summary: '', aiRaw: '', prompt_name: null });
  }
  const keyRow = db.prepare("SELECT value FROM settings WHERE key = 'ai_api_key'").get();
  const apiKey = keyRow ? keyRow.value : '';
  const tpl = getActiveTemplate(data.task.category, template_id);
  let ai, promptName = null;
  if (tpl) {
    const docsText = buildDocContext(doc_ids, data.task.category);
    ai = await validateWithAIAdvanced(data.task.task_content, data.items, config, apiKey, tpl.content, docsText);
    promptName = tpl.name;
  } else {
    ai = await validateWithAI(data.task.task_content, data.items, { ...config, ai_api_key: apiKey });
  }
  res.json({ success: true, task_content: data.task.task_content, items: data.items, aiIssues: ai.issues, aiUsed: ai.used, notConfigured: false, conclusion: ai.conclusion, summary: ai.summary, aiRaw: ai.raw, prompt_name: promptName });
});
// 兼容旧接口（返回双通道合并结果，开放给所有用户）
app.post('/api/ai/validate', async (req, res) => {
  const { task_id, template_id, doc_ids } = req.body || {};
  if (!task_id) return res.status(400).json({ error: '缺少 task_id' });
  const data = getTaskItems(task_id);
  if (!data) return res.status(404).json({ error: '操作票不存在' });
  const localIssues = localChecks(data.task.task_content, data.items, loadValidationStandards());
  const config = getAIConfig();
  let ai = { used: false, issues: [], conclusion: '', summary: '', raw: '' }, promptName = null;
  if (config.ai_enabled && config.api_key_set) {
    const keyRow = db.prepare("SELECT value FROM settings WHERE key = 'ai_api_key'").get();
    const apiKey = keyRow ? keyRow.value : '';
    const tpl = getActiveTemplate(data.task.category, template_id);
    if (tpl) {
      const docsText = buildDocContext(doc_ids, data.task.category);
      ai = await validateWithAIAdvanced(data.task.task_content, data.items, config, apiKey, tpl.content, docsText);
      promptName = tpl.name;
    } else {
      ai = await validateWithAI(data.task.task_content, data.items, { ...config, ai_api_key: apiKey });
    }
  }
  res.json({ success: true, task_content: data.task.task_content, items: data.items, localIssues, aiIssues: ai.issues, aiUsed: ai.used, conclusion: ai.conclusion, summary: ai.summary, aiRaw: ai.raw, prompt_name: promptName });
});
// --- AI 配置（仅管理员）---
app.get('/api/ai/config', requireEdit, (req, res) => {
  res.json(getAIConfig());
});
app.post('/api/ai/config', requireEdit, (req, res) => {
  const { enabled, provider, base_url, model, api_key } = req.body || {};
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_enabled', ?)").run(enabled ? '1' : '0');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_provider', ?)").run(provider || 'deepseek');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_base_url', ?)").run(base_url || '');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_model', ?)").run(model || '');
  if (api_key && api_key !== '******') {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_api_key', ?)").run(api_key);
  }
  audit('AI_CONFIG', '更新 AI 校验模型配置');
  res.json({ success: true });
});
// --- AI 校验反馈（普通用户提交，开放）---
app.post('/api/ai/feedback', (req, res) => {
  const { task_id, rating, suggestion, ai_raw } = req.body || {};
  if (!rating && !suggestion) return res.status(400).json({ error: '请至少提供评分或建议' });
  const r = db.prepare("INSERT INTO ai_feedback (task_id, rating, suggestion, ai_raw, created_at) VALUES (?, ?, ?, ?, datetime('now','localtime'))")
    .run(task_id != null ? parseInt(task_id, 10) : null, rating != null ? parseInt(rating, 10) : null, (suggestion || '').toString().slice(0, 1000), (ai_raw || '').toString().slice(0, 4000));
  res.json({ success: true, id: r.lastInsertRowid });
});
// --- AI 校验反馈汇总（仅管理员）---
app.get('/api/ai/feedback', requireEdit, (req, res) => {
  const rows = db.prepare('SELECT * FROM ai_feedback ORDER BY id DESC LIMIT 200').all();
  const stats = db.prepare('SELECT COUNT(*) AS cnt, COALESCE(ROUND(AVG(rating),2),0) AS avg FROM ai_feedback WHERE rating IS NOT NULL').get();
  res.json({ success: true, feedback: rows, total: stats.cnt, avg_rating: stats.avg });
});
// --- 管理员与 AI 模型对话调优（仅管理员）---
app.post('/api/ai/chat', requireEdit, async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: '缺少对话内容' });
  const config = getAIConfig();
  if (!config.ai_enabled || !config.api_key_set) return res.status(400).json({ error: '管理员尚未配置可用的 AI 模型' });
  const keyRow = db.prepare("SELECT value FROM settings WHERE key = 'ai_api_key'").get();
  const apiKey = keyRow ? keyRow.value : '';
  const sysPrompt = '你是「电力操作票智能审核员」的模型调优助手。管理员会向你提供用户对 AI 校验结果的反馈、误报/漏报案例，以及期望的审核标准。请基于电力"五防"规则与行业规范，给出可落地的校验规则改进建议、提示词优化方向，或示范正确的审核结论。';
  const fullMessages = [{ role: 'system', content: sysPrompt }, ...messages.filter(m => m && m.content).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))];
  const base = (config.ai_base_url || '').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model: config.ai_model, messages: fullMessages, temperature: 0.3 }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) return res.status(502).json({ error: '模型接口返回错误：HTTP ' + resp.status });
    const data = await resp.json();
    const reply = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    res.json({ success: true, reply });
  } catch (e) {
    clearTimeout(timer);
    res.status(502).json({ error: 'AI 调用失败：' + e.message });
  }
});

// ===== AI 提示词模板 + 版本管理（管理员）=====
app.get('/api/ai/prompts', requireEdit, (req, res) => {
  const rows = db.prepare(`SELECT t.id, t.name, t.ticket_type, t.description, t.is_default, t.updated_at,
    (SELECT COUNT(*) FROM ai_prompt_versions v WHERE v.template_id=t.id) AS version_count
    FROM ai_prompt_templates t ORDER BY t.sort_order, t.id`).all();
  res.json({ success: true, templates: rows });
});
// 解析当前操作票应使用的提示词模板（开放，供审核界面展示）
app.get('/api/ai/prompts/resolve', (req, res) => {
  const tt = req.query.ticket_type || 'default';
  let row = db.prepare("SELECT id,name,content FROM ai_prompt_templates WHERE is_default=1 AND ticket_type=? LIMIT 1").get(tt);
  if (!row) row = db.prepare("SELECT id,name,content FROM ai_prompt_templates WHERE is_default=1 AND ticket_type='default' LIMIT 1").get();
  if (!row) row = db.prepare('SELECT id,name,content FROM ai_prompt_templates ORDER BY is_default DESC, id ASC LIMIT 1').get();
  res.json({ success: true, template: row || null });
});
app.get('/api/ai/prompts/:id', requireEdit, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = db.prepare('SELECT * FROM ai_prompt_templates WHERE id=?').get(id);
  if (!t) return res.status(404).json({ error: '模板不存在' });
  const versions = db.prepare('SELECT id, version, note, created_at FROM ai_prompt_versions WHERE template_id=? ORDER BY version DESC').all(id);
  res.json({ success: true, template: t, versions });
});
app.post('/api/ai/prompts', requireEdit, (req, res) => {
  const { name, ticket_type, content, description } = req.body || {};
  if (!name || !content) return res.status(400).json({ error: '模板名称与提示词内容必填' });
  const info = db.prepare("INSERT INTO ai_prompt_templates (name, ticket_type, content, description, is_default) VALUES (?, ?, ?, ?, 0)")
    .run(name.trim(), (ticket_type || 'default').trim(), content, (description || '').toString());
  db.prepare('INSERT INTO ai_prompt_versions (template_id, version, content, note) VALUES (?, 1, ?, ?)')
    .run(info.lastInsertRowid, content, '初始版本');
  audit('AI_PROMPT', '新建提示词模板：' + name);
  res.json({ success: true, id: info.lastInsertRowid });
});
app.put('/api/ai/prompts/:id', requireEdit, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = db.prepare('SELECT * FROM ai_prompt_templates WHERE id=?').get(id);
  if (!t) return res.status(404).json({ error: '模板不存在' });
  const { name, ticket_type, content, description, note } = req.body || {};
  if (!content) return res.status(400).json({ error: '提示词内容必填' });
  const ver = db.prepare('SELECT COALESCE(MAX(version),0) AS m FROM ai_prompt_versions WHERE template_id=?').get(id).m + 1;
  db.prepare("UPDATE ai_prompt_templates SET name=?, ticket_type=?, content=?, description=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run((name || t.name).trim(), (ticket_type || t.ticket_type).trim(), content, (description != null ? description : t.description), id);
  db.prepare('INSERT INTO ai_prompt_versions (template_id, version, content, note) VALUES (?, ?, ?, ?)')
    .run(id, ver, content, (note || ('修改至 v' + ver)));
  audit('AI_PROMPT', '更新提示词模板：' + (name || t.name));
  res.json({ success: true, version: ver });
});
app.delete('/api/ai/prompts/:id', requireEdit, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = db.prepare('SELECT * FROM ai_prompt_templates WHERE id=?').get(id);
  if (!t) return res.status(404).json({ error: '模板不存在' });
  if (t.is_default) return res.status(400).json({ error: '默认模板不可删除（可编辑其内容）' });
  db.prepare('DELETE FROM ai_prompt_templates WHERE id=?').run(id);
  audit('AI_PROMPT', '删除提示词模板：' + t.name);
  res.json({ success: true });
});
app.post('/api/ai/prompts/:id/rollback', requireEdit, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { version_id } = req.body || {};
  const v = db.prepare('SELECT * FROM ai_prompt_versions WHERE id=? AND template_id=?').get(parseInt(version_id, 10), id);
  if (!v) return res.status(404).json({ error: '版本不存在' });
  const ver = db.prepare('SELECT COALESCE(MAX(version),0) AS m FROM ai_prompt_versions WHERE template_id=?').get(id).m + 1;
  db.prepare('UPDATE ai_prompt_templates SET content=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(v.content, id);
  db.prepare('INSERT INTO ai_prompt_versions (template_id, version, content, note) VALUES (?, ?, ?, ?)')
    .run(id, ver, v.content, '回滚自 v' + v.version);
  audit('AI_PROMPT', '回滚提示词模板至 v' + v.version);
  res.json({ success: true, version: ver });
});

// ===== AI 知识文档（上传学习 / 规范库）=====
async function extractDocText(buffer, mime, filename) {
  const lower = (filename || '').toLowerCase();
  try {
    if (lower.endsWith('.txt') || mime === 'text/plain') return buffer.toString('utf-8');
    if (lower.endsWith('.pdf') || mime === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const out = await pdfParse(buffer);
      return out.text || '';
    }
    if (lower.endsWith('.docx') || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const mammoth = require('mammoth');
      const out = await mammoth.extractRawText({ buffer });
      return out.value || '';
    }
  } catch (e) { return { __error: e.message }; }
  return buffer.toString('utf-8');
}
app.post('/api/ai/docs', requireEdit, async (req, res) => {
  const { filename, mime, ticket_type, data } = req.body || {};
  if (!filename || !data) return res.status(400).json({ error: '缺少文件内容' });
  let buf;
  try { buf = Buffer.from(data, 'base64'); } catch (e) { return res.status(400).json({ error: '文件数据无效' }); }
  if (buf.length === 0) return res.status(400).json({ error: '空文件' });
  const ext = (filename.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const stored = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  const info = db.prepare("INSERT INTO ai_knowledge_docs (original_name, stored_name, mime, size, ticket_type, status) VALUES (?, ?, ?, ?, ?, 'parsing')")
    .run(filename, stored, mime || '', buf.length, (ticket_type || 'default').trim());
  const docId = info.lastInsertRowid;
  try {
    fs.writeFileSync(path.join(KNOWLEDGE_DIR, stored), buf);
    const text = await extractDocText(buf, mime, filename);
    if (text && text.__error) {
      db.prepare("UPDATE ai_knowledge_docs SET status='error', error_msg=? WHERE id=?").run(text.__error, docId);
      return res.status(200).json({ success: true, id: docId, status: 'error', error_msg: text.__error });
    }
    const capped = (text || '').slice(0, 200000);
    db.prepare("UPDATE ai_knowledge_docs SET extracted_text=?, status='ready' WHERE id=?").run(capped, docId);
    audit('AI_DOC', '上传知识文档：' + filename);
    res.json({ success: true, id: docId, status: 'ready', text_len: capped.length });
  } catch (e) {
    db.prepare("UPDATE ai_knowledge_docs SET status='error', error_msg=? WHERE id=?").run(e.message, docId);
    res.status(500).json({ error: '解析失败：' + e.message });
  }
});
app.get('/api/ai/docs', (req, res) => {
  const tt = req.query.ticket_type;
  const rows = tt
    ? db.prepare("SELECT id, original_name, ticket_type, status, size, error_msg, created_at FROM ai_knowledge_docs WHERE ticket_type=? ORDER BY id DESC").all(tt)
    : db.prepare('SELECT id, original_name, ticket_type, status, size, error_msg, created_at FROM ai_knowledge_docs ORDER BY id DESC').all();
  res.json({ success: true, docs: rows });
});
app.delete('/api/ai/docs/:id', requireEdit, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const d = db.prepare('SELECT * FROM ai_knowledge_docs WHERE id=?').get(id);
  if (!d) return res.status(404).json({ error: '文档不存在' });
  try { fs.unlinkSync(path.join(KNOWLEDGE_DIR, d.stored_name)); } catch (_) {}
  db.prepare('DELETE FROM ai_knowledge_docs WHERE id=?').run(id);
  audit('AI_DOC', '删除知识文档：' + d.original_name);
  res.json({ success: true });
});

// ===== 审核上下文组装（自定义提示词 + 知识文档）=====
function getActiveTemplate(taskCategory, templateId) {
  if (templateId) {
    const t = db.prepare('SELECT id,name,content FROM ai_prompt_templates WHERE id=?').get(parseInt(templateId, 10));
    if (t) return t;
  }
  let row = db.prepare("SELECT id,name,content FROM ai_prompt_templates WHERE is_default=1 AND ticket_type=? LIMIT 1").get(taskCategory || '');
  if (!row) row = db.prepare("SELECT id,name,content FROM ai_prompt_templates WHERE is_default=1 AND ticket_type='default' LIMIT 1").get();
  if (!row) row = db.prepare('SELECT id,name,content FROM ai_prompt_templates ORDER BY is_default DESC, id ASC LIMIT 1').get();
  return row || null;
}
function buildDocContext(docIds, taskCategory) {
  const MAX_PER_DOC = 8000, MAX_TOTAL = 24000;
  let docs = [];
  if (Array.isArray(docIds) && docIds.length) {
    const ids = docIds.map(x => parseInt(x, 10)).filter(n => !isNaN(n));
    if (ids.length) docs = db.prepare('SELECT original_name, extracted_text FROM ai_knowledge_docs WHERE id IN (' + ids.map(() => '?').join(',') + ") AND status='ready'").all(ids);
  } else if (taskCategory) {
    docs = db.prepare("SELECT original_name, extracted_text FROM ai_knowledge_docs WHERE status='ready' AND (ticket_type=? OR ticket_type='default')").all(taskCategory);
  }
  let total = 0, parts = [];
  for (const d of docs) {
    if (total >= MAX_TOTAL) break;
    const t = (d.extracted_text || '').slice(0, MAX_PER_DOC);
    if (!t.trim()) continue;
    parts.push('### 文档：' + (d.original_name || '未命名') + '\n' + t);
    total += t.length;
  }
  return parts.join('\n\n');
}
async function validateWithAIAdvanced(taskContent, items, config, apiKey, promptContent, docsText) {
  if (!config.ai_enabled || !apiKey) return { used: false, issues: [], conclusion: '', summary: '', raw: '' };
  const numbered = items.map((x, i) => (i + 1) + '. ' + x).join('\n');
  let userContent = promptContent || '';
  if (docsText) userContent += '\n\n【参考规范文档】（来自已学习的知识库，请据此判断填写规范与审核要点）\n' + docsText;
  userContent += '\n\n待审核操作票：\n操作任务：' + taskContent + '\n操作项目（每行一条，前为行号）：\n' + numbered;
  const base = (config.ai_base_url || '').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model: config.ai_model, messages: [{ role: 'user', content: userContent }], temperature: 0.1 }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) return { used: true, issues: [], conclusion: '', summary: '', raw: '模型接口返回错误：HTTP ' + resp.status };
    const data = await resp.json();
    const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    const parsed = parseAIResult(content);
    return { used: true, issues: parsed.issues, conclusion: parsed.conclusion, summary: parsed.summary, raw: content };
  } catch (e) {
    clearTimeout(timer);
    return { used: false, issues: [], conclusion: '', summary: '', raw: 'AI 调用失败：' + e.message };
  }
}

// ===== APK 分发（管理员上传，所有人可下载）=====
// ⚠️ 必须注册在 SPA 回退 app.get('*') 之前，否则 GET 路由被通配符抢先拦截返回 HTML
// 注意：此处版本号需与前端 app.js 中的 APP_VERSION 保持一致（当前 V1.1.1）
const APP_VERSION = 'V1.1.1';
const APK_FILE = path.join(APK_DIR, 'ticket-system.apk');
const APK_META = path.join(APK_DIR, 'meta.json');
function apkMeta() {
  try { return JSON.parse(fs.readFileSync(APK_META, 'utf8')); } catch (_) { return null; }
}
// 对外展示/下载文件名：运维五班操作票系统_版本号.apk
function apkDisplayName(version) {
  return '运维五班操作票系统_' + (version || APP_VERSION) + '.apk';
}

app.get('/api/apk/info', (req, res) => {
  const m = apkMeta();
  if (!m) return res.json({ available: false });
  res.json({ available: true, filename: m.filename, version: m.version || '', size: m.size || null, uploadedAt: m.uploadedAt, note: m.note || '' });
});

app.get('/api/apk/download', (req, res) => {
  if (!fs.existsSync(APK_FILE)) return res.status(404).json({ error: '暂无安装包' });
  const m = apkMeta();
  const version = (m && m.version) || APP_VERSION;
  const dispName = apkDisplayName(version);
  res.type('application/vnd.android.package-archive');
  // filename*=UTF-8'' 保证中文文件名在各浏览器（含 Chrome）正确显示
  res.set('Content-Disposition', `attachment; filename="ticket-system.apk"; filename*=UTF-8''${encodeURIComponent(dispName)}`);
  res.sendFile(APK_FILE);
});

app.post('/api/apk/upload', requireEdit, async (req, res) => {
  try {
    const { filename, data, version, note } = req.body || {};
    if (!data) return res.status(400).json({ error: '缺少文件数据' });
    let buf;
    try { buf = Buffer.from(data, 'base64'); } catch (e) { return res.status(400).json({ error: '文件数据无效' }); }
    if (buf.length > 200 * 1024 * 1024) return res.status(400).json({ error: '文件过大（上限 200MB）' });
    const ver = version || APP_VERSION; // 未填版本号时默认使用当前系统版本
    fs.writeFileSync(APK_FILE, buf);
    const meta = { filename: apkDisplayName(ver), version: ver, note: note || '', size: buf.length, uploadedAt: new Date().toISOString() };
    fs.writeFileSync(APK_META, JSON.stringify(meta, null, 2));
    audit('APK_UPLOAD', '管理员上传了安卓安装包（' + apkDisplayName(ver) + '）');
    res.json({ ok: true, meta });
  } catch (e) { res.status(500).json({ error: '上传失败：' + e.message }); }
});

app.delete('/api/apk', requireEdit, (req, res) => {
  try {
    if (fs.existsSync(APK_FILE)) fs.unlinkSync(APK_FILE);
    if (fs.existsSync(APK_META)) fs.unlinkSync(APK_META);
    audit('APK_DELETE', '管理员删除了安卓安装包');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: '删除失败：' + e.message }); }
});

// ===== 部署诊断接口（务必注册在 SPA 回退之前）=====
// 用途：部署后用浏览器直接访问  https://你的域名/api/version
//   - 返回 JSON（含 version 字段）= 服务端已是新代码，问题在前端缓存，清缓存刷新即可
//   - 返回 HTML（<！DOCTYPE html>）= 服务端仍是旧代码，说明镜像未重建，需 docker compose up -d --build
app.get('/api/version', (req, res) => {
  res.json({
    version: APP_VERSION,
    apkRoutesBeforeSpa: true,
    swStrategy: 'network-first',
    note: '若本接口返回 HTML 而非 JSON，说明服务端在跑旧代码，请重建镜像(docker compose up -d --build)'
  });
});

// --- Serve frontend（SPA 回退：除 /api/ 以外的 GET 请求返回 index.html）---
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// --- Start (端口占用自动递增，最多尝试10个端口) ---
function openBrowser(url) {
  if (process.platform !== 'win32') return;
  try {
    const { spawn } = require('child_process');
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) { /* 忽略：手动访问即可 */ }
}

function startServer(port, attempt = 0) {
  const server = app.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log('==============================================');
    console.log('  变电运维五班操作票典型票系统 已启动');
    console.log(`  访问地址: ${url}`);
    console.log('  关闭此窗口即停止服务');
    console.log('==============================================');
    if (IS_PKG) openBrowser(url);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      console.log(`端口 ${port} 被占用，尝试 ${port + 1} ...`);
      startServer(port + 1, attempt + 1);
    } else {
      console.error('启动失败:', err.message);
      process.exit(1);
    }
  });
}

startServer(PORT);
