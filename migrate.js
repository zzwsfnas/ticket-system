// migrate.js - Import existing typical ticket data into the new system
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'tickets.db');
const JSON_PATH = path.join(__dirname, '..', 'all_typical.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
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
`);

// Seed password
const pwRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('password_hash');
if (!pwRow) {
  const hash = bcrypt.hashSync('Wjjks000.', 10);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('password_hash', hash);
  console.log('✅ 默认密码已设置 (Wjjks000.)');
}

// Import data
if (fs.existsSync(JSON_PATH)) {
  const raw = fs.readFileSync(JSON_PATH, 'utf-8');
  const data = JSON.parse(raw);
  let imported = 0;

  if (data.stations) {
    const tx = db.transaction(() => {
      for (const station of data.stations) {
        let sub = db.prepare('SELECT id FROM substations WHERE name = ?').get(station.name);
        if (!sub) {
          const r = db.prepare('INSERT INTO substations (name) VALUES (?)').run(station.name);
          sub = { id: r.lastInsertRowid };
          console.log(`  新建变电站: ${station.name}`);
        }
        for (const ticket of station.tickets) {
          let task = db.prepare('SELECT id FROM tasks WHERE substation_id = ? AND task_content = ?').get(sub.id, ticket.task);
          if (!task) {
            const r = db.prepare('INSERT INTO tasks (substation_id, task_content, category) VALUES (?, ?, ?)').run(sub.id, ticket.task, ticket.category || '');
            task = { id: r.lastInsertRowid };
          }
          let order = 0;
          for (const item of ticket.items) {
            order++;
            const existing = db.prepare('SELECT id FROM items WHERE task_id = ? AND item_content = ?').get(task.id, item);
            if (!existing) {
              db.prepare('INSERT INTO items (task_id, item_content, sort_order) VALUES (?, ?, ?)').run(task.id, item, order);
              imported++;
            }
          }
        }
      }
    });
    tx();
    console.log(`✅ 导入完成: ${data.stations.length} 个变电站, ${imported} 条操作项目`);
  }

  db.prepare('INSERT INTO audit_log (action_type, summary) VALUES (?, ?)').run('MIGRATE', `从 JSON 导入 ${imported} 条操作项目`);
} else {
  console.log('⚠ 未找到 all_typical.json，跳过数据导入');
}

// Count
const substations = db.prepare('SELECT COUNT(*) AS cnt FROM substations').get().cnt;
const tasks = db.prepare('SELECT COUNT(*) AS cnt FROM tasks').get().cnt;
const items = db.prepare('SELECT COUNT(*) AS cnt FROM items').get().cnt;
console.log(`\n📊 数据库统计: ${substations} 变电站 / ${tasks} 操作任务 / ${items} 操作项目`);
db.close();
