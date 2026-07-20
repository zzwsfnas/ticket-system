// ===== 变电运维五班操作票典型票系统 - 前端逻辑 =====
let state = {
  isEditor: false,
  substations: [],
  tasks: [],
  currentSubstationId: null,
  filterCategory: '',
  searchQuery: '',
  expandedTasks: new Set(),
  categories: ['主变', '断路器', '隔离开关·保险', '接地线', '保护·定值', '线路', '电压互感器', '其他']
};

// 临时存放 TXT 解析结果
let txtTicketsBuffer = [];

const API = {
  async get(url) {
    // 加时间戳防止 CDN/代理缓存旧响应；cache:'no-store' 防浏览器缓存
    const sep = url.includes('?') ? '&' : '?';
    const r = await fetch(url + sep + '_t=' + Date.now(), { cache: 'no-store' });
    // 容错：若服务端返回 HTML（旧代码/路由被拦截），给出明确提示而非 JSON 解析崩溃
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      const text = await r.text();
      if (text.trim().startsWith('<') || text.trim().startsWith('<!')) {
        throw new Error('服务端返回了网页而非数据（可能镜像未重建或路由未生效），请访问 /api/version 确认服务端版本');
      }
      throw new Error('服务端返回非 JSON 数据（' + ct.slice(0, 30) + '）');
    }
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || '请求失败'); }
    return r.json();
  },
  async put(url, body) {
    const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || '请求失败'); }
    return r.json();
  },
  async del(url) {
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || '请求失败'); }
    return r.json();
  }
};

// --- Auth ---
async function checkAuth() {
  const s = await API.get('/api/auth/status');
  state.isEditor = s.isEditor;
  renderAuthUI();
}
async function login() {
  const pw = document.getElementById('passwordInput').value;
  try {
    await API.post('/api/auth/login', { password: pw });
    state.isEditor = true;
    closeModal();
    renderAuthUI();
    renderTaskList();
    toast('已切换至修改模式', 'success');
  } catch (e) {
    toast('密码错误，已保持查看模式', 'error');
    closeModal();
    renderAuthUI();
  }
}
async function logout() {
  await API.post('/api/auth/logout');
  state.isEditor = false;
  renderAuthUI();
  renderTaskList();
  toast('已退出修改模式', 'info');
}

// --- Toast ---
function toast(msg, type = 'info') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// --- Modal ---
function openModal(html) {
  const overlay = document.getElementById('modalOverlay');
  document.getElementById('modalContent').innerHTML = html;
  overlay.classList.add('open');
}
function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
}

// --- Load Data ---
async function loadSubstations() {
  state.substations = await API.get('/api/substations');
  renderStationSelect();
}
async function loadTasks(substationId) {
  const q = substationId ? `?substation_id=${substationId}` : '';
  state.tasks = await API.get('/api/tasks' + q);
  renderTaskList();
}

// --- Render ---
function renderAuthUI() {
  const badge = document.getElementById('authBadge');
  const btn = document.getElementById('authBtn');
  const editorUI = document.getElementById('editorUI');
  if (state.isEditor) {
    badge.className = 'auth-badge editor';
    badge.innerHTML = '🔒 修改模式';
    btn.textContent = '退出修改';
    btn.onclick = logout;
    editorUI.style.display = 'flex';
    document.body.classList.add('editing');
  } else {
    badge.className = 'auth-badge viewer';
    badge.innerHTML = '👁 查看模式';
    btn.textContent = '验证密码';
    btn.onclick = showLoginModal;
    editorUI.style.display = 'none';
    document.body.classList.remove('editing');
  }
}
function showLoginModal() {
  openModal(`
    <div class="modal-header"><h3>验证管理员密码</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <label>输入修改权限密码</label>
      <input type="password" id="passwordInput" onkeydown="if(event.key==='Enter')login()" placeholder="请输入密码" autofocus>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="login()">验证</button>
    </div>
  `);
  setTimeout(() => document.getElementById('passwordInput')?.focus(), 100);
}
function showChangePasswordModal() {
  openModal(`
    <div class="modal-header"><h3>修改密码</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <label>原密码</label>
      <input type="password" id="oldPasswordInput" placeholder="输入原密码">
      <label>新密码</label>
      <input type="password" id="newPasswordInput" placeholder="输入新密码（至少6位）">
      <label>确认新密码</label>
      <input type="password" id="confirmPasswordInput" placeholder="再次输入新密码">
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="changePassword()">确认修改</button>
    </div>
  `);
}
async function changePassword() {
  const old = document.getElementById('oldPasswordInput').value;
  const p1 = document.getElementById('newPasswordInput').value;
  const p2 = document.getElementById('confirmPasswordInput').value;
  if (!old || !p1) { toast('请填写完整', 'error'); return; }
  if (p1 !== p2) { toast('两次密码不一致', 'error'); return; }
  if (p1.length < 6) { toast('新密码至少6位', 'error'); return; }
  try {
    await API.post('/api/auth/change-password', { old_password: old, new_password: p1 });
    closeModal();
    toast('密码修改成功', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

function renderStationSelect() {
  const sel = document.getElementById('stationSelect');
  let html = '<option value="">-- 选择变电站 --</option>';
  for (const s of state.substations) {
    html += `<option value="${s.id}" ${s.id == state.currentSubstationId ? 'selected' : ''}>${s.name}</option>`;
  }
  sel.innerHTML = html;
}

function renderTaskList() {
  const container = document.getElementById('taskContainer');
  const countBar = document.getElementById('countBar');

  let filtered = [...state.tasks];
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    filtered = filtered.filter(t => t.task_content.toLowerCase().includes(q));
  }
  if (state.filterCategory) {
    filtered = filtered.filter(t => {
      const cats = t.category ? t.category.split(',') : [];
      return cats.includes(state.filterCategory);
    });
  }

  countBar.textContent = `${filtered.length} 条典型操作任务`;

  if (filtered.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary)">暂无匹配的操作任务</div>';
    return;
  }

  let html = '';
  for (const task of filtered) {
    const isOpen = state.expandedTasks.has(task.id);
    const cats = task.category ? task.category.split(',').map(c => `<span class="chip" style="font-size:10px;padding:2px 8px;cursor:default">${c.trim()}</span>`).join('') : '';
    const delBtn = state.isEditor
      ? `<span class="task-del-btn" onclick="event.stopPropagation();deleteTask(${task.id})" title="删除该操作票">🗑</span>`
      : '';
    const dupBtn = state.isEditor
      ? `<span class="copy-task-btn" onclick="event.stopPropagation();duplicateTask(${task.id})" title="复制此操作票为副本">📑</span>`
      : '';
    html += `
      <div class="task-card" data-task-id="${task.id}">
        <div class="task-header" onclick="toggleTask(${task.id})">
          <input type="checkbox" class="task-select" value="${task.id}" data-task-id="${task.id}" onclick="event.stopPropagation()">
          <span class="arrow ${isOpen ? 'open' : ''}">▶</span>
          <span class="task-text">${highlight(task.task_content)}</span>
          <span class="task-meta">${cats} ${task.updated_at ? '更新 ' + task.updated_at.substring(0,10) : ''} ${pendingSubmissions.has(task.id) ? '<span class="chip pending">待审核</span>' : ''}</span>
          ${delBtn}
          <span class="copy-btn-wrap" onclick="event.stopPropagation();copyTaskItems(${task.id})" title="复制操作项目">📋</span>
          <span class="copy-btn-wrap" onclick="event.stopPropagation();copyTaskFull(${task.id})" title="复制操作任务名称（纯文本）">📄</span>
          ${dupBtn}
        </div>
        <div class="task-body ${isOpen ? 'open' : ''}">
          <div class="item-list" id="items-${task.id}">
            <div style="text-align:center;padding:12px;color:var(--text-secondary)">加载中...</div>
          </div>
        </div>
      </div>
    `;
  }
  container.innerHTML = html;

  for (const task of filtered) {
    if (state.expandedTasks.has(task.id)) {
      loadItems(task.id);
    }
  }
}

async function toggleTask(taskId) {
  if (state.expandedTasks.has(taskId)) {
    state.expandedTasks.delete(taskId);
  } else {
    state.expandedTasks.add(taskId);
    await loadItems(taskId);
  }
  renderTaskList();
}

async function loadItems(taskId) {
  const container = document.getElementById(`items-${taskId}`);
  if (!container) return;
  try {
    const items = await API.get(`/api/items?task_id=${taskId}`);
    taskItemsCache[taskId] = items;
    paintItems(taskId);
  } catch (e) {
    container.innerHTML = '<div style="color:var(--danger);padding:8px">加载失败</div>';
  }
}
// 根据草稿/缓存渲染某任务的操作项目列表（不重新请求接口）
function paintItems(taskId) {
  const container = document.getElementById(`items-${taskId}`);
  if (!container) return;
  const draft = itemDrafts[taskId];
  const mode = draft ? 'draft' : 'normal';
  const items = draft ? draft.items : (taskItemsCache[taskId] || []);
  if (!draft && (!items || items.length === 0)) {
    container.innerHTML = '<div style="text-align:center;padding:8px;color:var(--text-secondary);font-size:13px">暂无操作项目</div>';
    return;
  }
  let html = '';
  html += `<div class="items-toolbar" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:6px">`;
  html += `<span style="font-size:13px;color:var(--text-secondary)">共 ${items.length} 项${draft ? '（含未提交修改）' : ''}</span>`;
  html += `<span style="display:flex;gap:6px">`;
  html += `<button class="btn btn-sm btn-outline" onclick="copyTaskItems(${taskId})" style="font-size:12px">📋 复制操作项目</button>`;
  html += `<button class="btn btn-sm btn-outline" onclick="copyTaskFull(${taskId})" style="font-size:12px">📄 复制任务</button>`;
  html += `<button class="btn btn-sm btn-outline" onclick="runLocalValidate(${taskId},event)" style="font-size:12px">🔍 本地校验</button>`;
  html += `<button class="btn btn-sm btn-outline" onclick="openAISettings(${taskId})" style="font-size:12px">🤖 AI校验</button>`;
  html += `<button class="btn btn-sm btn-outline" onclick="showOnlineEditModal(${taskId})" style="font-size:12px">✏ 在线编辑</button>`;
  if (!draft && pendingSubmissions.has(taskId)) {
    html += `<span class="chip pending" style="font-size:11px;padding:2px 8px;align-self:center">待审核</span>`;
  }
  html += `</span>`;
  html += `</div>`;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const content = draft ? item.content : item.item_content;
    const itemId = item.id;
    html += `
      <div class="item-row" data-item-id="${itemId}">
        <span class="item-num">${i + 1}</span>
        <span class="item-text">${highlight(content)}</span>
        <span class="item-actions">
    `;
    if (draft) {
      html += `<button class="btn btn-sm btn-outline" title="上移" onclick="moveItemDraft(${itemId},'up',${taskId},event)">↑</button><button class="btn btn-sm btn-outline" title="下移" onclick="moveItemDraft(${itemId},'down',${taskId},event)">↓</button>`;
      html += `<button class="btn btn-sm btn-outline" onclick="editItemDraft(${itemId}, ${taskId})">编辑</button>`;
      html += `<button class="btn btn-sm btn-danger" onclick="deleteItemDraft(${itemId}, ${taskId})">删除</button>`;
    } else if (state.isEditor) {
      html += `<button class="btn btn-sm btn-outline" title="上移" onclick="moveItem(${itemId},'up',${taskId},event)">↑</button><button class="btn btn-sm btn-outline" title="下移" onclick="moveItem(${itemId},'down',${taskId},event)">↓</button>`;
      html += `<button class="btn btn-sm btn-primary" onclick="showAddItemModal(${taskId}, ${itemId})">＋插入</button>`;
      html += `<button class="btn btn-sm btn-outline" onclick="editItem(${itemId}, ${taskId})">编辑</button>`;
      html += `<button class="btn btn-sm btn-danger" onclick="deleteItem(${itemId})">删除</button>`;
    } else {
      // 一般用户：上移/下移/编辑/删除均可触发，进入草稿模式（提交后需管理员审核）
      html += `<button class="btn btn-sm btn-outline" title="上移（进入草稿）" onclick="moveItemDraft(${itemId},'up',${taskId},event)">↑</button><button class="btn btn-sm btn-outline" title="下移（进入草稿）" onclick="moveItemDraft(${itemId},'down',${taskId},event)">↓</button>`;
      html += `<button class="btn btn-sm btn-primary" onclick="editItemDraft(${itemId}, ${taskId})">编辑</button>`;
      html += `<button class="btn btn-sm btn-danger" onclick="deleteItemDraft(${itemId}, ${taskId})">删除</button>`;
    }
    html += `<button class="btn btn-sm btn-outline" onclick="viewItemHistory(${itemId})">历史</button>`;
    html += `
        </span>
      </div>
    `;
  }
  if (draft) {
    html += `<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-sm btn-primary" onclick="submitItemDraft(${taskId})">💾 保存并提交审核</button>
      <button class="btn btn-sm btn-outline" onclick="cancelItemDraft(${taskId})">取消</button>
      <span style="font-size:12px;color:var(--warning, #d48806)">● 有未提交的修改（保存后立即生效并通知管理员审核，管理员可一键恢复原始）</span>
    </div>`;
  } else if (state.isEditor) {
    html += `<div style="margin-top:8px"><button class="btn btn-sm btn-primary" onclick="showAddItemModal(${taskId})">＋ 新增操作项目</button></div>`;
  }
  container.innerHTML = html;
}

// ===== 一般用户逐项操作草稿（上移/下移/删除/编辑，提交后直接生效 + 管理员审核/恢复）=====
function ensureDraft(taskId) {
  if (!itemDrafts[taskId]) {
    const base = (taskItemsCache[taskId] || []).map(i => ({ id: i.id, content: i.item_content }));
    itemDrafts[taskId] = { items: base, dirty: false };
  }
  return itemDrafts[taskId];
}
function moveItemDraft(itemId, direction, taskId, ev) {
  if (ev) ev.stopPropagation();
  const d = ensureDraft(taskId);
  const idx = d.items.findIndex(x => x.id === itemId);
  if (idx < 0) return;
  const swap = direction === 'up' ? idx - 1 : idx + 1;
  if (swap < 0 || swap >= d.items.length) return;
  const t = d.items[idx]; d.items[idx] = d.items[swap]; d.items[swap] = t;
  d.dirty = true;
  paintItems(taskId);
}
function deleteItemDraft(itemId, taskId) {
  const d = ensureDraft(taskId);
  d.items = d.items.filter(x => x.id !== itemId);
  d.dirty = true;
  paintItems(taskId);
}
function editItemDraft(itemId, taskId) {
  const d = ensureDraft(taskId);
  const it = d.items.find(x => x.id === itemId);
  if (!it) return;
  const val = window.prompt('编辑操作项目：', it.content);
  if (val === null) return;
  const v = (val || '').trim();
  if (!v) { toast('内容不能为空，已取消', 'info'); return; }
  it.content = v;
  d.dirty = true;
  paintItems(taskId);
}
async function submitItemDraft(taskId) {
  const d = itemDrafts[taskId];
  if (!d) return;
  const items = d.items.map(x => (x.content || '').toString().trim()).filter(x => x.length > 0);
  if (items.length === 0) { toast('没有可保存的操作项目', 'info'); return; }
  try {
    const r = await API.post(`/api/tasks/${taskId}/items-submit`, { items });
    delete itemDrafts[taskId];
    pendingSubmissions.add(taskId);
    renderTaskList();
    toast(`已保存并生效：改 ${r.updated} / 增 ${r.added} / 删 ${r.removed}，已通知管理员审核`, 'success');
    await loadItems(taskId);
  } catch (e) { toast('提交失败：' + e.message, 'error'); }
}
function cancelItemDraft(taskId) {
  delete itemDrafts[taskId];
  paintItems(taskId);
  toast('已取消未提交的修改', 'info');
}

function highlight(text) {
  if (!state.searchQuery) return escapeHtml(text);
  const q = state.searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escapeHtml(text).replace(new RegExp(q, 'gi'), m => `<span class="search-highlight">${m}</span>`);
}
function escapeHtml(t) {
  const d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

// ===== 版本信息（语义化版本 SemVer） =====
// 更新规则：
//   - 小幅更新（Bug 修复、样式微调等）→ 末位 +1，如 V1.0.1
//   - 较大功能更新 → 中位 +1、末位置 0，如 V1.1.0
//   - 重大版本升级 → 首位 +1、其余置 0，如 V2.0.0
// 每次发版：修改 APP_VERSION，并在 APP_VERSION_HISTORY 顶部新增一条记录（最新在前）。
const APP_VERSION = 'V1.1.1';
const APP_VERSION_HISTORY = [
  {
    version: 'V1.1.1',
    date: '2026-07-20',
    level: 'patch',
    changes: [
      'Service Worker 改为「网络优先」策略并部署后自动刷新：彻底解决旧缓存导致批量导出/APK 功能「看起来没修好」的问题',
      '修复服务端 SPA 回退拦截 /api/apk/info、/api/apk/download 接口（APK 管理面板「加载失败」、主页无下载链接的根因）',
      '主页「📱 下载安卓App」链接改为 JS 触发下载，避免 Service Worker 致 Chrome 不下载'
    ]
  },
  {
    version: 'V1.1.0',
    date: '2026-07-20',
    level: 'minor',
    changes: [
      '修复 Chrome 浏览器批量导出 TXT 无法下载的问题（改用 fetch+blob 触发下载，兼容 Service Worker）',
      '「全选」按钮改为点击切换：未全选时全选，已全选时取消全选',
      '移除「导入已有库」功能',
      '安卓安装包（APK）下载文件名改为「运维五班操作票系统_版本号.apk」，上传默认带入当前版本号'
    ]
  },
  {
    version: 'V1.0.0',
    date: '2026-07-19',
    level: 'initial',
    changes: [
      '网页标题统一为「变电运维五班操作票系统」',
      '新增页面版本号显示（页眉徽标 + 页脚）',
      '新增「版本记录」弹窗，维护语义化版本（SemVer）变更历史'
    ]
  }
];

function renderVersion() {
  const v = APP_VERSION || 'V1.0.0';
  const badge = document.getElementById('appVersionBadge');
  if (badge) badge.textContent = v;
  const footer = document.getElementById('footerVersion');
  if (footer) footer.textContent = v;
}

function showVersionModal() {
  const levelLabel = { initial: '初始版本', patch: '小幅更新', minor: '功能更新', major: '重大升级' };
  const rows = (APP_VERSION_HISTORY || []).map(e => `
    <div class="ver-entry">
      <div class="ver-head">
        <span class="ver-tag ${e.level || 'patch'}">${escapeHtml(e.version)}</span>
        <span class="ver-date">${escapeHtml(e.date || '')}</span>
        <span class="ver-level">${escapeHtml(levelLabel[e.level] || e.level || '')}</span>
      </div>
      <ul class="ver-changes">${(e.changes || []).map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
    </div>`).join('');
  openModal(`
    <div class="modal-header"><h3>版本记录</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="ver-list">${rows || '<div class="ai-note">暂无版本记录</div>'}</div>
      <p class="ai-hint">版本号遵循语义化版本规范（SemVer）：小幅更新递增末位（如 V1.0.1），较大功能更新递增中位（如 V1.1.0），重大升级递增首位（如 V2.0.0）。</p>
      <p class="ver-copyright">©2026 变电运维五班操作票系统 · 变电运维五班 · 完全实况 · 保留所有权利 · 仅供变电运维五班内部使用</p>
    </div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">关闭</button></div>
  `);
}

// --- 一键复制 ---
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fallthrough to legacy */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch (e2) {
    return false;
  }
}

async function copyTaskItems(taskId) {
  try {
    const container = document.getElementById(`items-${taskId}`);
    let items;
    if (container && container.querySelector('.item-row')) {
      const rows = container.querySelectorAll('.item-row .item-text');
      items = Array.from(rows).map(r => r.textContent.trim());
    } else {
      const data = await API.get(`/api/items?task_id=${taskId}`);
      items = data.map(i => i.item_content);
    }
    if (items.length === 0) {
      toast('该任务暂无操作项目', 'info');
      return;
    }
    const ok = await copyText(items.join('\n'));
    toast(ok ? `已复制 ${items.length} 项操作步骤` : '复制失败，请手动选择复制', ok ? 'success' : 'error');
  } catch (e) {
    toast('复制失败，请手动选择复制', 'error');
  }
}

// --- 复制单条操作任务内容（仅任务本身，不含操作项目）---
async function copyTaskFull(taskId) {
  try {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) { toast('未找到该操作任务', 'error'); return; }
    const text = (task.task_content || '').trim();
    const ok = await copyText(text);
    toast(ok ? '已复制操作任务名称' : '复制失败，请手动选择复制', ok ? 'success' : 'error');
  } catch (e) {
    toast('复制失败', 'error');
  }
}

// --- 新增操作票（含操作项目） ---
function showAddTaskModal() {
  if (!state.isEditor) { toast('需要修改权限', 'error'); return; }
  openModal(`
    <div class="modal-header"><h3>新增操作票</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <label>所属变电站</label>
      <select id="addTaskStation">${state.substations.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select>
      <label>操作任务内容</label>
      <textarea id="addTaskContent" placeholder="请输入操作任务描述" rows="3"></textarea>
      <label>分类标签（可选）</label>
      <select id="addTaskCategory">
        <option value="">-- 选择分类 --</option>
        ${state.categories.map(c => `<option value="${c}">${c}</option>`).join('')}
      </select>
      <label>操作项目（每行一项，可留空）</label>
      <textarea id="addTaskItems" rows="8" placeholder="例如：&#10;合上35kV某某变电站#1主变3011刀闸&#10;检查该刀闸确在合位&#10;合上35kV某某变电站#1主变301开关"></textarea>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="addTask()">确认新增</button>
    </div>
  `);
  const sel = document.getElementById('addTaskStation');
  sel.value = state.currentSubstationId || (state.substations[0] && state.substations[0].id) || '';
}
async function addTask() {
  const substation_id = document.getElementById('addTaskStation').value;
  const task_content = document.getElementById('addTaskContent').value.trim();
  const category = document.getElementById('addTaskCategory').value;
  const itemsText = document.getElementById('addTaskItems').value;
  const items = itemsText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (!task_content) { toast('请输入操作任务', 'error'); return; }
  try {
    const r = await API.post('/api/tasks', { substation_id: parseInt(substation_id), task_content, category, items });
    closeModal();
    toast(`操作票已新增（含 ${r.items_imported} 项操作）`, 'success');
    await loadTasks(state.currentSubstationId);
  } catch (e) { toast(e.message, 'error'); }
}

// --- 删除整张操作票 ---
async function deleteTask(taskId) {
  if (!state.isEditor) { toast('需要修改权限', 'error'); return; }
  const task = state.tasks.find(t => t.id === taskId);
  const name = task ? task.task_content : '该操作票';
  if (!confirm(`确定删除操作票「${name.substring(0, 40)}」吗？\n该操作将同时删除其下所有操作项目，且不可恢复！`)) return;
  try {
    await API.del(`/api/tasks/${taskId}`);
    toast('操作票已删除', 'success');
    state.expandedTasks.delete(taskId);
    await loadTasks(state.currentSubstationId);
  } catch (e) { toast(e.message, 'error'); }
}

// --- 复制操作票 / 批量导出 ---
async function duplicateTask(taskId) {
  if (!state.isEditor) { toast('需要修改权限', 'error'); return; }
  if (!confirm('确定复制此操作票（含其下所有操作项目）吗？复制后将生成一份副本，可在此基础上修改。')) return;
  try {
    const r = await API.post(`/api/tasks/${taskId}/duplicate`, {});
    toast('操作票副本已创建', 'success');
    await loadTasks(state.currentSubstationId);
    if (r.id) state.expandedTasks.add(r.id);
  } catch (e) { toast(e.message, 'error'); }
}

function formatTs() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function selectAllVisible(checked) {
  document.querySelectorAll('#taskContainer .task-select').forEach(c => { c.checked = checked; });
  const n = document.querySelectorAll('#taskContainer .task-select:checked').length;
  toast(checked ? `已全选 ${n} 张操作票` : '已清空选择', 'info');
}

// 全选按钮：点击切换。未全选时全选，已全选时取消全选
function toggleSelectAll() {
  const all = Array.from(document.querySelectorAll('#taskContainer .task-select'));
  if (all.length === 0) { toast('当前没有可勾选的操作票', 'info'); return; }
  const allChecked = all.every(c => c.checked);
  const next = !allChecked;
  all.forEach(c => { c.checked = next; });
  const n = all.filter(c => c.checked).length;
  toast(next ? `已全选 ${n} 张操作票` : '已取消全选', 'info');
}

async function exportSelectedTasks() {
  const checks = Array.from(document.querySelectorAll('#taskContainer .task-select:checked'));
  if (checks.length === 0) { toast('请先勾选要导出的操作票', 'error'); return; }
  const ids = checks.map(c => parseInt(c.value || c.dataset.taskId, 10)).filter(n => !isNaN(n) && n > 0);
  if (ids.length === 0) { toast('未获取到有效的操作票ID（checkbox缺少value属性）', 'error'); return; }
  const ts = formatTs();
  const name = `操作票典型票导出_${ts}.txt`;
  try {
    toast(`正在导出 ${ids.length} 张操作票（TXT）...`, 'info');
    // 关键修复：Chrome 下通过 Service Worker 返回的 attachment 响应 + <a download> 组合不会触发下载。
    // 改用 fetch 取 blob，再用 blob: objectURL 触发下载（objectURL 不经过 SW），各浏览器均可靠。
    const resp = await fetch(`/api/tasks/export?ids=${ids.join(',')}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + resp.status));
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`已导出 ${ids.length} 张操作票`, 'success');
  } catch (e) {
    toast('导出失败：' + e.message, 'error');
  }
}

// --- 编辑操作项目 ---
async function editItem(itemId, taskId) {
  if (!state.isEditor) { toast('需要修改权限', 'error'); return; }
  let currentText = '';
  try {
    const items = await API.get(`/api/items?task_id=${taskId}`);
    const found = items.find(i => i.id === itemId);
    if (found) currentText = found.item_content;
  } catch (e) { /* 忽略 */ }
  openModal(`
    <div class="modal-header"><h3>编辑操作项目</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <label>操作项目内容</label>
      <textarea id="editItemContent" rows="4">${escapeHtml(currentText)}</textarea>
      <label><input type="checkbox" id="showHistory" onchange="toggleItemHistory(${itemId})"> 查看修改历史</label>
      <div id="itemHistoryContainer"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="saveItemEdit(${itemId})">保存修改</button>
    </div>
  `);
}
async function toggleItemHistory(itemId) {
  const cb = document.getElementById('showHistory');
  const container = document.getElementById('itemHistoryContainer');
  if (!cb.checked) { container.innerHTML = ''; return; }
  try {
    const hist = await API.get(`/api/items/${itemId}/history`);
    if (hist.length === 0) {
      container.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;margin-top:8px">暂无修改历史</p>';
    } else {
      container.innerHTML = hist.map(h => `
        <div class="diff-entry">
          <div class="diff-time">${h.changed_at} ${h.operator ? '- ' + h.operator : ''}</div>
          <div class="diff-old">${escapeHtml(h.old_content || '')}</div>
          <div class="diff-new">${escapeHtml(h.new_content || '')}</div>
        </div>
      `).join('');
    }
  } catch (e) {
    container.innerHTML = '<p style="color:var(--danger);font-size:13px">加载历史失败</p>';
  }
}
async function saveItemEdit(itemId) {
  const content = document.getElementById('editItemContent').value.trim();
  if (!content) { toast('内容不能为空', 'error'); return; }
  try {
    await API.put(`/api/items/${itemId}`, { item_content: content });
    closeModal();
    toast('操作项目已更新', 'success');
    for (const tid of state.expandedTasks) loadItems(tid);
  } catch (e) { toast(e.message, 'error'); }
}

// --- 删除操作项目 ---
async function deleteItem(itemId) {
  if (!state.isEditor) { toast('需要修改权限', 'error'); return; }
  if (!confirm('确定删除该操作项目吗？')) return;
  try {
    await API.del(`/api/items/${itemId}`);
    toast('已删除', 'success');
    for (const tid of state.expandedTasks) loadItems(tid);
  } catch (e) { toast(e.message, 'error'); }
}

function showAddItemModal(taskId, afterItemId) {
  if (!state.isEditor) { toast('需要修改权限', 'error'); return; }
  const isInsert = !!afterItemId;
  openModal(`
    <div class="modal-header"><h3>${isInsert ? '在此后新增操作项目' : '新增操作项目'}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <label>操作项目内容</label>
      <textarea id="addItemContent" rows="4" placeholder="请输入操作步骤"></textarea>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="addItem(${taskId}, ${afterItemId || 'null'})">确认新增</button>
    </div>
  `);
}
async function addItem(taskId, afterItemId) {
  const content = document.getElementById('addItemContent').value.trim();
  if (!content) { toast('请输入内容', 'error'); return; }
  try {
    const body = { task_id: taskId, item_content: content };
    if (afterItemId) body.after_item_id = afterItemId;
    await API.post('/api/items', body);
    closeModal();
    toast('操作项目已新增', 'success');
    await loadItems(taskId);
  } catch (e) { toast(e.message, 'error'); }
}

// --- 修改历史 ---
async function viewItemHistory(itemId) {
  try {
    const hist = await API.get(`/api/items/${itemId}/history`);
    let html = `<div class="modal-header"><h3>修改历史</h3><button class="modal-close" onclick="closeModal()">×</button></div>`;
    html += `<div class="modal-body">`;
    if (hist.length === 0) {
      html += `<p style="color:var(--text-secondary)">暂无修改历史</p>`;
    } else {
      for (const h of hist) {
        html += `<div class="diff-entry">
          <div class="diff-time">${h.changed_at} ${h.operator ? '- ' + h.operator : ''}</div>
          <div class="diff-old">${escapeHtml(h.old_content || '')}</div>
          <div class="diff-new">${escapeHtml(h.new_content || '')}</div>
        </div>`;
      }
    }
    html += `</div><div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">关闭</button></div>`;
    openModal(html);
  } catch (e) { toast('加载历史失败', 'error'); }
}

// ===== 在线编辑操作项目（TXT 文本批量修改）=====
let onlineEditOriginal = [];
let onlineEditNewLines = [];
let pendingSubmissions = new Set();   // 一般用户提交后，本地跟踪待审核的任务 ID（用于显示徽标）
// 一般用户逐项操作（上移/下移/删除/编辑）的本地草稿：taskId -> { items:[{id,content}], dirty }
let itemDrafts = {};
let taskItemsCache = {};   // taskId -> 最近一次从接口加载的操作项目
function showOnlineEditModal(taskId) {
  onlineEditNewLines = [];
  API.get(`/api/items?task_id=${taskId}`).then(items => {
    onlineEditOriginal = items.map(i => i.item_content);
    const text = onlineEditOriginal.join('\n');
    // 管理员：保存直接生效；一般用户：保存即生效并通知管理员审核（可在审核箱恢复原始）
    const footer = state.isEditor
      ? `<button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="previewOnlineEdit(${taskId})">保存</button>`
      : `<button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="previewOnlineEdit(${taskId})">保存</button>`;
    openModal(`
      <div class="modal-header"><h3>✏ 在线编辑操作项目</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <label>每行一项操作项目，可直接修改 / 增删行：</label>
        <textarea id="onlineEditText" rows="14" style="font-family:monospace;font-size:13px;line-height:1.6">${escapeHtml(text)}</textarea>
        ${state.isEditor ? '' : '<p style="font-size:12px;color:var(--text-secondary);margin-top:8px">保存后立即生效，系统会通知管理员审核；若管理员判定有误，可一键恢复为保存前的原始内容。</p>'}
      </div>
      <div class="modal-footer">${footer}</div>
    `);
  }).catch(e => toast('加载失败', 'error'));
}
function computeLineDiff(oldLines, newLines) {
  const diffs = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const o = i < oldLines.length ? oldLines[i] : null;
    const n = i < newLines.length ? newLines[i] : null;
    if (o !== null && n !== null) {
      if (o !== n) diffs.push({ type: 'change', line: i + 1, old: o, new: n });
    } else if (o !== null && n === null) {
      diffs.push({ type: 'remove', line: i + 1, old: o });
    } else if (o === null && n !== null) {
      diffs.push({ type: 'add', line: i + 1, new: n });
    }
  }
  return diffs;
}
function previewOnlineEdit(taskId) {
  const ta = document.getElementById('onlineEditText');
  if (!ta) return;
  const newLines = ta.value.split('\n').map(l => l.replace(/\r$/, ''));
  const diffs = computeLineDiff(onlineEditOriginal, newLines);
  if (diffs.length === 0) { toast('内容未发生变化', 'info'); return; }
  // 保存编辑结果，供 submitOnlineEdit 使用（预览弹窗会替换 modal 内容，原 textarea 已被销毁）
  onlineEditNewLines = newLines;
  const listHtml = diffs.map(d => {
    if (d.type === 'change') return `<div class="diff-entry"><div class="diff-time">第 ${d.line} 行 · 修改</div><div class="diff-old">${escapeHtml(d.old)}</div><div class="diff-new">${escapeHtml(d.new)}</div></div>`;
    if (d.type === 'add') return `<div class="diff-entry"><div class="diff-time">第 ${d.line} 行 · 新增</div><div class="diff-new">${escapeHtml(d.new)}</div></div>`;
    return `<div class="diff-entry"><div class="diff-time">第 ${d.line} 行 · 删除</div><div class="diff-old">${escapeHtml(d.old)}</div></div>`;
  }).join('');
  openModal(`
    <div class="modal-header"><h3>确认保存更改</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:8px">检测到以下 ${diffs.length} 处更改，确认后保存到数据库：</p>
      <div class="diff-view">${listHtml}</div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="onlineEditConfirm(${taskId})">确认保存</button>
    </div>
  `);
}
async function submitOnlineEdit(taskId) {
  // 预览弹窗已替换 modal 内容，textarea 可能已不存在；优先使用预览时保存的编辑结果
  let newLines = onlineEditNewLines;
  const ta = document.getElementById('onlineEditText');
  if ((!newLines || newLines.length === 0) && ta) {
    newLines = ta.value.split('\n').map(l => l.replace(/\r$/, ''));
  }
  if (!newLines) return;
  const items = newLines.map(l => l.trim()).filter(l => l.length > 0);
  if (items.length === 0) { toast('没有可保存的操作项目', 'info'); return; }
  try {
    const r = await API.post(`/api/tasks/${taskId}/items-replace`, { items });
    closeModal();
    toast(`已保存：改 ${r.updated} / 增 ${r.added} / 删 ${r.removed}`, 'success');
    await loadItems(taskId);
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
}

// 保存确认：按角色分流（管理员直接生效；一般用户保存即生效并留痕供审核）
async function onlineEditConfirm(taskId) {
  if (state.isEditor) return submitOnlineEdit(taskId);
  return submitOnlineEditGeneral(taskId);
}
// --- 一般用户：保存即生效，并记录修改前快照供管理员审核/恢复 ---
async function submitOnlineEditGeneral(taskId) {
  let newLines = onlineEditNewLines;
  const ta = document.getElementById('onlineEditText');
  if ((!newLines || newLines.length === 0) && ta) {
    newLines = ta.value.split('\n').map(l => l.replace(/\r$/, ''));
  }
  if (!newLines) return;
  const items = newLines.map(l => l.trim()).filter(l => l.length > 0);
  if (items.length === 0) { toast('没有可保存的操作项目', 'info'); return; }
  try {
    const r = await API.post(`/api/tasks/${taskId}/items-submit`, { items });
    closeModal();
    delete itemDrafts[taskId];
    pendingSubmissions.add(taskId);
    renderTaskList();
    toast(`已保存并生效：改 ${r.updated} / 增 ${r.added} / 删 ${r.removed}，已通知管理员审核`, 'success');
    await loadItems(taskId);
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

// --- 管理员：在线编辑审核箱（前后对照 + 排序 + 确认/恢复）---
let reviewSortOrder = 'desc';
// 左右对照渲染：修改前（左，改动标红） / 修改后（右）
function renderSideBySide(before, after) {
  const b = before || [], a = after || [];
  const max = Math.max(b.length, a.length);
  let left = '<div class="diff-side"><div class="diff-side-head">修改前（原始）</div>';
  let right = '<div class="diff-side"><div class="diff-side-head">修改后（当前）</div>';
  for (let i = 0; i < max; i++) {
    const bl = i < b.length ? b[i] : null;
    const ar = i < a.length ? a[i] : null;
    const changed = bl !== ar;
    left += `<div class="diff-line ${changed ? (bl === null ? 'diff-empty-row' : 'diff-old-row') : ''}">${bl === null ? '<span class="diff-empty">（无）</span>' : escapeHtml(bl)}</div>`;
    right += `<div class="diff-line ${changed ? (ar === null ? 'diff-empty-row' : 'diff-new-row') : ''}">${ar === null ? '<span class="diff-empty">（无）</span>' : escapeHtml(ar)}</div>`;
  }
  return `<div class="diff-side-wrap">${left}</div>${right}</div>`;
}
async function openReviewInbox() {
  if (!state.isEditor) { toast('需要管理权限', 'error'); return; }
  try {
    const list = await API.get(`/api/edit-submissions?status=pending&order=${reviewSortOrder}`);
    if (!list || list.length === 0) {
      openModal(`
        <div class="modal-header"><h3>📝 在线编辑审核</h3><button class="modal-close" onclick="closeModal()">×</button></div>
        <div class="modal-body" style="text-align:center;color:var(--text-secondary);padding:20px">暂无待审核的在线编辑提交</div>
      `);
      return;
    }
    const cards = list.map(s => {
      const before = s.before_items || [], after = s.proposed_items || [];
      const diffs = computeLineDiff(before, after);
      const summary = diffs.length ? `改动 ${diffs.length} 处` : '（无变化）';
      return `
        <div class="review-card" data-sub-id="${s.id}">
          <div class="review-head"><b>${escapeHtml(s.task_content)}</b> ${s.substation_name ? `<span class="chip">${escapeHtml(s.substation_name)}</span>` : ''}</div>
          <div class="review-meta">提交人：${escapeHtml(s.submitter || '一般用户')} · ${s.created_at} · ${summary}</div>
          <div class="review-actions">
            <button class="btn btn-sm btn-primary" onclick="confirmSubmission(${s.id}, ${s.task_id})">确认无误</button>
            <button class="btn btn-sm btn-danger" onclick="restoreSubmission(${s.id}, ${s.task_id})">恢复原始</button>
            <button class="btn btn-sm btn-outline" onclick="viewSubmissionDetail(${s.id})">查看对比</button>
          </div>
        </div>`;
    }).join('');
    const orderLabel = reviewSortOrder === 'asc' ? '时间正序' : '时间逆序';
    openModal(`
      <div class="modal-header"><h3>📝 在线编辑审核（${list.length} 条待审）</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="review-toolbar">
          <span class="ai-note" style="margin:0">一般用户保存后已直接生效；管理员可"确认无误"或"恢复原始"。</span>
          <button class="btn btn-sm btn-outline" onclick="toggleReviewOrder()">⇅ ${orderLabel}</button>
        </div>
        <div class="review-list">${cards}</div>
      </div>
    `);
  } catch (e) { toast('加载失败：' + e.message, 'error'); }
}
function toggleReviewOrder() {
  reviewSortOrder = reviewSortOrder === 'asc' ? 'desc' : 'asc';
  openReviewInbox();
}
async function confirmSubmission(subId, taskId) {
  if (!confirm('确认该修改无误？确认后审核记录标记为已确认（内容已生效）。')) return;
  try {
    await API.post(`/api/edit-submissions/${subId}/approve`, {});
    toast('已确认，内容维持生效', 'success');
    pendingSubmissions.delete(taskId);
    renderTaskList();
    await openReviewInbox();
  } catch (e) { toast('操作失败：' + e.message, 'error'); }
}
async function restoreSubmission(subId, taskId) {
  if (!confirm('确定恢复为一般用户保存前的原始内容？当前修改将被撤销。')) return;
  try {
    const r = await API.post(`/api/edit-submissions/${subId}/restore`, {});
    toast(`已恢复原始：改 ${r.updated} / 增 ${r.added} / 删 ${r.removed}`, 'success');
    pendingSubmissions.delete(taskId);
    await loadItems(taskId);
    renderTaskList();
    await openReviewInbox();
  } catch (e) { toast('操作失败：' + e.message, 'error'); }
}
async function viewSubmissionDetail(subId) {
  try {
    const s = await API.get(`/api/edit-submissions/${subId}`);
    const before = s.before_items || [], after = s.proposed_items || [];
    openModal(`
      <div class="modal-header"><h3>前后对比 #${s.id}</h3><button class="modal-close" onclick="openReviewInbox()">×</button></div>
      <div class="modal-body">
        <div class="review-meta" style="margin-bottom:8px">提交人：${escapeHtml(s.submitter || '一般用户')} · ${s.created_at} · 状态：${s.status}</div>
        ${renderSideBySide(before, after)}
      </div>
    `);
  } catch (e) { toast('加载失败：' + e.message, 'error'); }
}

// ===== 操作项目排序（上/下移动，管理权限）=====
async function moveItem(itemId, direction, taskId, ev) {
  if (!state.isEditor) { toast('需要修改权限', 'error'); return; }
  try {
    const r = await API.post(`/api/items/${itemId}/move`, { direction });
    if (r.moved) await loadItems(taskId);
  } catch (e) { toast('移动失败：' + e.message, 'error'); }
}

// ===== 双通道校验：本地校验 + AI 校验（操作票）=====
const AI_PROVIDERS = {
  deepseek: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  custom: { base_url: '', model: '' }
};

// 校验结果缓存：taskId -> { task_content, items, local, ai }
let valCache = {};
let fbRating = 0;

async function runLocalValidate(taskId, ev) {
  const btn = ev && ev.target;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 校验中...'; }
  try {
    const r = await API.post('/api/validate/local', { task_id: taskId });
    valCache[taskId] = valCache[taskId] || { task_content: r.task_content, items: r.items };
    valCache[taskId].local = r.localIssues;
    renderValidationModal(taskId);
  } catch (e) { toast('本地校验失败：' + e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '🔍 本地校验'; } }
}

async function runAIValidate(taskId, opts) {
  opts = opts || {};
  try {
    const r = await API.post('/api/validate/ai', { task_id: taskId, template_id: opts.template_id != null ? opts.template_id : null, doc_ids: opts.doc_ids || [] });
    valCache[taskId] = valCache[taskId] || { task_content: r.task_content, items: r.items };
    valCache[taskId].ai = { issues: r.aiIssues, used: r.aiUsed, notConfigured: r.notConfigured, conclusion: r.conclusion, summary: r.summary, raw: r.aiRaw, prompt_name: r.prompt_name || null };
    renderValidationModal(taskId);
  } catch (e) { toast('AI 校验失败：' + e.message, 'error'); }
}

const CAT_CLASS = { '逻辑校验': 'cat-logic', '五防校验': 'cat-five', '术语校验': 'cat-term', '其他': 'cat-other' };

function renderLocalIssues(issues) {
  if (!issues || issues.length === 0) return '<div class="ai-ok">✅ 本地规范性检查（错漏字/编号）未发现明显问题</div>';
  return issues.map(i => {
    const et = i.error_type ? `<span class="err-badge">${escapeHtml(i.error_type)}</span>` : '';
    return `<div class="ai-issue ai-${i.type || 'info'}">${et}<b>${i.line != null ? ('第' + i.line + '项') : '全文'}</b> · ${escapeHtml(i.msg || '')}</div>`;
  }).join('');
}
function renderAIIssues(ai) {
  if (!ai) return '';
  if (ai.notConfigured) return '<div class="ai-note">ℹ️ 管理员尚未配置 AI 模型，暂无法执行 AI 校验。请由管理员在「🤖 AI配置」中接入 DeepSeek 等模型后使用。</div>';
  if (!ai.used) return '<div class="ai-note">ℹ️ AI 模型调用未成功（可能网络异常或接口错误），仅显示本地校验结果。</div>';
  if (!ai.issues || ai.issues.length === 0) return '<div class="ai-ok">✅ AI 校验未发现问题</div>';
  return ai.issues.map(i => {
    const cat = CAT_CLASS[i.category] ? `<span class="cat-badge ${CAT_CLASS[i.category]}">${escapeHtml(i.category || '其他')}</span>` : '';
    const et = i.error_type ? `<span class="err-badge">${escapeHtml(i.error_type)}</span>` : '';
    const sugg = i.suggestion ? `<div class="ai-sugg">💡 建议：${escapeHtml(i.suggestion)}</div>` : '';
    return `<div class="ai-issue ai-${i.type || 'info'}">${cat}${et}<b>${i.line != null ? ('第' + i.line + '项') : '任务'}</b> · ${escapeHtml(i.msg || '')}${sugg}</div>`;
  }).join('');
}
function renderConclusion(ai) {
  if (!ai || ai.notConfigured || !ai.used) return '';
  const txt = ai.conclusion || '';
  let cls = 'pass';
  if (txt.includes('不通过')) cls = 'fail';
  else if (txt.includes('提示') || (ai.issues && ai.issues.length)) cls = 'warn';
  return `<div class="ai-conclusion ${cls}"><b>最终审核结论：</b>${escapeHtml(txt)}${ai.summary ? (' — ' + escapeHtml(ai.summary)) : ''}</div>`;
}

// 双通道对比弹窗（本地校验 | AI 校验 两栏）
function renderValidationModal(taskId) {
  const c = valCache[taskId];
  if (!c) return;
  const hasLocal = c.local !== undefined && c.local !== null;
  const hasAI = c.ai !== undefined && c.ai !== null;
  const title = (hasLocal && hasAI) ? '🔍🤖 双通道校验结果对比' : (hasAI ? '🤖 AI 校验结果' : '🔍 本地校验结果');
  const localCol = `<div class="val-col"><div class="ai-section-title">本地校验（错漏字 / 重复 / 编号 / 规范）</div>${hasLocal ? renderLocalIssues(c.local) : '<div class="ai-note">点击「🔍 本地校验」运行</div>'}</div>`;
  const aiPromptName = (hasAI && c.ai && c.ai.prompt_name) ? `<div class="ai-prompt-name">📄 使用提示词模板：<b>${escapeHtml(c.ai.prompt_name)}</b></div>` : '';
  const aiCol = `<div class="val-col"><div class="ai-section-title">AI 校验（逻辑 / 五防 / 术语）</div>${aiPromptName}${hasAI ? renderAIIssues(c.ai) : '<div class="ai-note">点击「🤖 AI校验」运行（需管理员已配置模型）</div>'}${hasAI ? renderConclusion(c.ai) : ''}</div>`;
  const localFbBlock = (hasLocal && c.local && c.local.length) ? `
    <div class="ai-feedback">
      <div class="ai-feedback-title">将本次本地校验发现的问题提交给管理员</div>
      <textarea id="localFbNote" rows="2" placeholder="补充说明（选填）..."></textarea>
      <button class="btn btn-primary btn-sm" onclick="submitLocalFeedback(${taskId})">提交问题给管理员</button>
    </div>` : '';
  const feedbackBlock = (hasAI && c.ai && c.ai.used && !c.ai.notConfigured) ? `
    <div class="ai-feedback">
      <div class="ai-feedback-title">对本次 AI 校验结果的评价</div>
      <div class="star-row" id="fbStars">
        ${[1, 2, 3, 4, 5].map(v => `<span data-v="${v}" onclick="setFbRating(${v})">★</span>`).join('')}
      </div>
      <textarea id="fbSuggestion" rows="3" placeholder="请描述 AI 校验是否准确、有无误报/漏报，或您的改进建议..."></textarea>
      <button class="btn btn-primary btn-sm" onclick="submitFeedback(${taskId})">提交反馈</button>
    </div>` : '';
  openModal(`
    <div class="modal-header"><h3>${title}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="val-compare">${localCol}${aiCol}</div>
      ${localFbBlock}
      ${feedbackBlock}
    </div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">关闭</button></div>
  `);
  updateFbStars();
}
function setFbRating(v) { fbRating = v; updateFbStars(); }
function updateFbStars() {
  const row = document.getElementById('fbStars');
  if (!row) return;
  row.querySelectorAll('span').forEach(s => {
    s.classList.toggle('on', parseInt(s.dataset.v, 10) <= fbRating);
  });
}
async function submitFeedback(taskId) {
  const c = valCache[taskId];
  const aiRaw = c && c.ai ? c.ai.raw : '';
  const sugg = document.getElementById('fbSuggestion');
  try {
    await API.post('/api/ai/feedback', { task_id: taskId, rating: fbRating || null, suggestion: sugg ? sugg.value.trim() : '', ai_raw: aiRaw });
    fbRating = 0;
    closeModal();
    toast('反馈已提交，感谢您的评价！', 'success');
  } catch (e) { toast('提交失败：' + e.message, 'error'); }
}

// 一般用户：将本地校验发现的问题提交给管理员
async function submitLocalFeedback(taskId) {
  const c = valCache[taskId];
  const issues = (c && c.local) ? c.local : [];
  const note = document.getElementById('localFbNote');
  const submitter = (prompt('提交人（选填）：') || '').trim() || '一般用户';
  try {
    await API.post('/api/validation-feedback', { task_id: taskId, issues, submitter });
    closeModal();
    toast('问题已提交给管理员，感谢反馈！', 'success');
  } catch (e) { toast('提交失败：' + e.message, 'error'); }
}

// ===== 校验规范标准（管理员在线维护）=====
async function loadStandardsTab() {
  const box = document.getElementById('manageStandards');
  if (!box) return;
  box.innerHTML = '<div class="ai-note">加载中...</div>';
  try {
    const cfg = await API.get('/api/validation-standards');
    box.innerHTML = `
      <p class="ai-note">本地校验将按以下规范标准执行；管理员可据一般用户的"校验反馈"持续调整，提升校验准确性。</p>
      <div class="std-form">
        <label>编号数字格式</label>
        <select id="stdNumberFormat">
          <option value="arabic" ${cfg.number_format === 'arabic' ? 'selected' : ''}>阿拉伯数字（如 1. 2.）</option>
          <option value="chinese" ${cfg.number_format === 'chinese' ? 'selected' : ''}>中文数字（如 一、二、）</option>
          <option value="none" ${cfg.number_format === 'none' ? 'selected' : ''}>不校验编号格式</option>
        </select>
        <label>禁用词（逗号分隔，命中即提示错别字）</label>
        <textarea id="stdForbidden" rows="3" placeholder="如：和闸,闸刀,傍路">${escapeHtml(cfg.forbidden_words || '')}</textarea>
        <label>规范操作动词（逗号分隔，操作项目开头应以此类动词起始）</label>
        <textarea id="stdVerbs" rows="3" placeholder="如：拉开,合上,检查,确认">${escapeHtml(cfg.required_verbs || '')}</textarea>
        <label>禁用标点（逐字填写，命中即提示）</label>
        <input id="stdPunct" value="${escapeHtml(cfg.banned_punct || '')}" placeholder="如：，。、" />
        <label>必含步骤关键词（逗号分隔，操作票必须包含；不填则不检查）</label>
        <textarea id="stdSteps" rows="2" placeholder="如：验电,装设接地线,悬挂标识牌">${escapeHtml(cfg.required_steps || '')}</textarea>
        <label>成对动词闭合（open|close 成对，逗号分隔；存在 open 缺少 close 收尾则提示）</label>
        <textarea id="stdPaired" rows="2" placeholder="如：合上|拉开,投入|退出,装设|拆除,悬挂|取下">${escapeHtml(cfg.paired_verbs || '')}</textarea>
        <label>规范说明（展示用）</label>
        <textarea id="stdNotes" rows="2">${escapeHtml(cfg.notes || '')}</textarea>
        <button class="btn btn-primary btn-sm" onclick="saveStandards()">保存规范</button>
      </div>`;
  } catch (e) {
    box.innerHTML = '<div class="ai-note">加载失败：' + escapeHtml(e.message) + '</div>';
  }
}
async function saveStandards() {
  const cfg = {
    number_format: document.getElementById('stdNumberFormat').value,
    forbidden_words: document.getElementById('stdForbidden').value,
    required_verbs: document.getElementById('stdVerbs').value,
    banned_punct: document.getElementById('stdPunct').value,
    required_steps: document.getElementById('stdSteps').value,
    paired_verbs: document.getElementById('stdPaired').value,
    notes: document.getElementById('stdNotes').value
  };
  try {
    await API.put('/api/validation-standards', cfg);
    toast('校验规范已保存', 'success');
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
}

// ===== 校验反馈（管理员查看一般用户提交的问题）=====
async function loadVFeedbackTab() {
  const box = document.getElementById('manageVFeedback');
  if (!box) return;
  box.innerHTML = '<div class="ai-note">加载中...</div>';
  try {
    const list = await API.get('/api/validation-feedback?status=open');
    if (!list || list.length === 0) {
      box.innerHTML = '<div class="ai-note">暂无待处理的校验问题反馈。</div>';
      return;
    }
    box.innerHTML = `<p class="ai-note">共 ${list.length} 条待处理反馈。管理员可据此在「校验规范」中调整标准。</p>` + list.map(f => {
      const issues = (f.issues_json || []).map(i => `· ${i.line != null ? ('第' + i.line + '项 ') : ''}${i.msg || ''}`).join('\n');
      return `
        <div class="review-card">
          <div class="review-head"><b>${escapeHtml(f.task_content || '(操作票)')}</b></div>
          <div class="review-meta">提交人：${escapeHtml(f.submitter || '一般用户')} · ${f.created_at} · ${f.issues_json.length} 条问题</div>
          <pre class="feedback-issues">${escapeHtml(issues || '（未附带明细）')}</pre>
          <div class="review-actions">
            <button class="btn btn-sm btn-outline" onclick="resolveFeedback(${f.id})">标记已处理</button>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = '<div class="ai-note">加载失败：' + escapeHtml(e.message) + '</div>';
  }
}
async function resolveFeedback(id) {
  const note = (prompt('处理备注（选填）：') || '').trim();
  try {
    await API.put(`/api/validation-feedback/${id}`, { note });
    toast('已标记为已处理', 'success');
    await loadVFeedbackTab();
  } catch (e) { toast('操作失败：' + e.message, 'error'); }
}

// ===== AI 提示词模板 + 知识库（管理员维护，审核时选用）=====
async function loadAIPromptTab() {
  const box = document.getElementById('manageAIPrompt');
  if (!box) return;
  box.innerHTML = '<div class="ai-note">加载中...</div>';
  try {
    const [tp, docs] = await Promise.all([API.get('/api/ai/prompts'), API.get('/api/ai/docs')]);
    const tpls = (tp.templates || []);
    const docList = (docs.docs || []);
    box.innerHTML = `
      <div class="ai-kb-toolbar">
        <div class="ai-kb-col">
          <div class="ai-kb-head"><span>📝 审核提示词模板</span><button class="btn btn-sm btn-primary" onclick="showPromptEditor()">+ 新建模板</button></div>
          <div id="promptTplList" class="ai-kb-list">${tpls.length ? tpls.map(renderTplItem).join('') : '<div class="ai-note">暂无模板，可点击右上角新建</div>'}</div>
        </div>
        <div class="ai-kb-col">
          <div class="ai-kb-head"><span>📚 知识库文档（上传学习）</span></div>
          <div class="ai-kb-upload">
            <select id="docType" class="input-sm">
              <option value="default">通用</option>
              <option value="倒闸操作">倒闸操作</option>
              <option value="工作票">工作票</option>
              <option value="事故处理">事故处理</option>
            </select>
            <input type="file" id="docFile" accept=".pdf,.txt,.docx" class="input-sm">
            <button class="btn btn-sm btn-primary" onclick="uploadDoc(this)">上传并解析</button>
          </div>
          <div id="docList" class="ai-kb-list">${docList.length ? docList.map(renderDocItem).join('') : '<div class="ai-note">暂无文档，支持 PDF / TXT / DOCX</div>'}</div>
        </div>
      </div>`;
  } catch (e) {
    box.innerHTML = '<div class="ai-note">加载失败：' + escapeHtml(e.message) + '</div>';
  }
}
function renderTplItem(t) {
  const def = t.is_default ? '<span class="tag-default">默认</span>' : '';
  return `<div class="ai-kb-item">
    <div class="ai-kb-item-main"><b>${escapeHtml(t.name)}</b> ${def}
      <span class="ai-kb-type">${escapeHtml(t.ticket_type)}</span>
      <span class="ai-kb-meta">v${t.version_count} · ${escapeHtml((t.updated_at || '').slice(0, 16))}</span>
    </div>
    <div class="ai-kb-item-actions">
      <button class="btn btn-xs btn-outline" onclick="showPromptEditor(${t.id})">编辑</button>
      <button class="btn btn-xs btn-outline" onclick="showPromptVersions(${t.id})">版本</button>
      ${t.is_default ? '' : `<button class="btn btn-xs btn-danger" onclick="deletePrompt(${t.id})">删除</button>`}
    </div>
  </div>`;
}
function renderDocItem(d) {
  const st = d.status === 'ready' ? '<span class="tag-ok">已解析</span>' : (d.status === 'error' ? '<span class="tag-err">解析失败</span>' : '<span class="tag-warn">解析中</span>');
  const err = d.error_msg ? ` <span class="ai-kb-err">${escapeHtml(d.error_msg)}</span>` : '';
  return `<div class="ai-kb-item">
    <div class="ai-kb-item-main"><b>${escapeHtml(d.original_name)}</b> ${st}
      <span class="ai-kb-type">${escapeHtml(d.ticket_type)}</span>${err}
    </div>
    <div class="ai-kb-item-actions"><button class="btn btn-xs btn-danger" onclick="deleteDoc(${d.id})">删除</button></div>
  </div>`;
}
async function showPromptEditor(id) {
  let t = null;
  if (id) { const r = await API.get('/api/ai/prompts/' + id); t = r.template; }
  openModal(`
    <div class="modal-header"><h3>${id ? '编辑提示词模板' : '新建提示词模板'}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <label>模板名称</label>
      <input type="text" id="ptName" value="${t ? escapeHtml(t.name) : ''}" placeholder="如：倒闸操作专用校验">
      <label>适用操作票类型</label>
      <input type="text" id="ptType" value="${t ? escapeHtml(t.ticket_type) : 'default'}" placeholder="default / 倒闸操作 / 工作票 ...">
      <label>说明（可选）</label>
      <input type="text" id="ptDesc" value="${t ? escapeHtml(t.description || '') : ''}" placeholder="该模板的适用场景">
      <label>提示词内容（四重校验指令，模型将据此审核）</label>
      <textarea id="ptContent" rows="14" style="font-family:monospace;white-space:pre-wrap">${t ? escapeHtml(t.content) : ''}</textarea>
      <p class="ai-hint">提示：在内容中说明审核维度、错误类型与输出格式；系统会自动在末尾拼接「参考规范文档」与待审核操作票。</p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="savePrompt(${id || 'null'})">保存（自动存为新版本）</button>
    </div>
  `);
}
async function savePrompt(id) {
  const body = {
    name: document.getElementById('ptName').value.trim(),
    ticket_type: document.getElementById('ptType').value.trim() || 'default',
    description: document.getElementById('ptDesc').value.trim(),
    content: document.getElementById('ptContent').value
  };
  if (!body.name || !body.content) { toast('名称与内容必填', 'error'); return; }
  try {
    if (id) await API.put('/api/ai/prompts/' + id, body);
    else await API.post('/api/ai/prompts', body);
    closeModal();
    toast('已保存' + (id ? '并更新版本' : ''), 'success');
    loadAIPromptTab();
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
}
async function showPromptVersions(id) {
  const r = await API.get('/api/ai/prompts/' + id);
  const vs = (r.versions || []).map(v => `<div class="ai-kb-item">
    <div class="ai-kb-item-main"><b>v${v.version}</b> <span class="ai-kb-meta">${escapeHtml(v.note || '')} · ${escapeHtml((v.created_at || '').slice(0, 16))}</span></div>
    <div class="ai-kb-item-actions"><button class="btn btn-xs btn-outline" onclick="rollbackPrompt(${id}, ${v.id})">回滚到此版本</button></div>
  </div>`).join('');
  openModal(`
    <div class="modal-header"><h3>版本历史 · ${escapeHtml(r.template.name)}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="ai-kb-list">${vs || '<div class="ai-note">暂无版本</div>'}</div>
    <p class="ai-hint">回滚会把该版本内容复制为「最新版本」并立即生效，原历史保留可追溯。</p></div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">关闭</button></div>
  `);
}
async function rollbackPrompt(id, versionId) {
  if (!confirm('确认回滚到该版本？将生成一条新版本记录并立即生效。')) return;
  try {
    await API.post('/api/ai/prompts/' + id + '/rollback', { version_id: versionId });
    closeModal();
    toast('已回滚至所选版本', 'success');
    loadAIPromptTab();
  } catch (e) { toast('回滚失败：' + e.message, 'error'); }
}
async function deletePrompt(id) {
  if (!confirm('确认删除该模板？')) return;
  try { await API.del('/api/ai/prompts/' + id); toast('已删除', 'success'); loadAIPromptTab(); }
  catch (e) { toast('删除失败：' + e.message, 'error'); }
}
async function uploadDoc(btn) {
  const fileInput = document.getElementById('docFile');
  const file = fileInput && fileInput.files && fileInput.files[0];
  if (!file) { toast('请选择文件', 'error'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '解析中...'; }
  try {
    const b64 = await fileToBase64(file);
    await API.post('/api/ai/docs', { filename: file.name, mime: file.type, ticket_type: document.getElementById('docType').value, data: b64 });
    toast('上传并解析完成', 'success');
    loadAIPromptTab();
  } catch (e) { toast('上传失败：' + e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '上传并解析'; } }
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
async function deleteDoc(id) {
  if (!confirm('确认删除该文档？')) return;
  try { await API.del('/api/ai/docs/' + id); toast('已删除', 'success'); loadAIPromptTab(); }
  catch (e) { toast('删除失败：' + e.message, 'error'); }
}
// 审核设置：选择模板（管理员）+ 勾选知识文档（所有人），开始审核
async function openAISettings(taskId) {
  const task = (state.tasks || []).find(t => t.id === taskId);
  const cat = (task && task.category) || 'default';
  openModal(`
    <div class="modal-header"><h3>🤖 AI 审核设置</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body" id="aiSetBody">加载中...</div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="aiStartBtn" onclick="startAIWithSettings(${taskId})">开始审核</button>
    </div>
  `);
  try {
    const [docs, resolved] = await Promise.all([
      API.get('/api/ai/docs'),
      API.get('/api/ai/prompts/resolve?ticket_type=' + encodeURIComponent(cat))
    ]);
    const docList = (docs.docs || []).filter(d => d.status === 'ready');
    let tplSel = '';
    if (state.isEditor) {
      const tp = await API.get('/api/ai/prompts');
      const tpls = tp.templates || [];
      const cur = resolved.template ? resolved.template.id : '';
      tplSel = `<label>审核提示词模板（管理员可切换）</label>
        <select id="aiTpl" class="input-sm">
          ${tpls.map(t => `<option value="${t.id}" ${String(t.id) === String(cur) ? 'selected' : ''}>${escapeHtml(t.name)}（${escapeHtml(t.ticket_type)}）</option>`).join('')}
        </select>`;
    } else {
      tplSel = `<p class="ai-hint">当前使用默认提示词模板：${resolved.template ? escapeHtml(resolved.template.name) : '系统内置'}（管理员可在「提示词与知识库」中自定义）。</p>`;
    }
    const docChecks = docList.length ? docList.map(d => {
      const checked = (d.ticket_type === cat || d.ticket_type === 'default') ? 'checked' : '';
      return `<label class="doc-check"><input type="checkbox" class="aiDocCb" value="${d.id}" ${checked}> ${escapeHtml(d.original_name)} <span class="ai-kb-type">${escapeHtml(d.ticket_type)}</span></label>`;
    }).join('') : '<div class="ai-note">知识库暂无可用文档。管理员可在「提示词与知识库」中上传 PDF/TXT/DOCX 规范文档。</div>';
    document.getElementById('aiSetBody').innerHTML = `
      ${tplSel}
      <label>参考资料文档（勾选后作为审核依据，按类型自动预选）</label>
      <div class="doc-check-list">${docChecks}</div>`;
  } catch (e) {
    document.getElementById('aiSetBody').innerHTML = '<div class="ai-note">加载失败：' + escapeHtml(e.message) + '</div>';
  }
}
async function startAIWithSettings(taskId) {
  const tplSel = document.getElementById('aiTpl');
  const template_id = tplSel ? parseInt(tplSel.value, 10) : null;
  const doc_ids = Array.from(document.querySelectorAll('.aiDocCb:checked')).map(c => parseInt(c.value, 10));
  closeModal();
  await runAIValidate(taskId, { template_id, doc_ids });
}

// ===== AI 模型配置（仅管理员）=====
function showAIConfigModal() {
  if (!state.isEditor) { toast('需要修改权限', 'error'); return; }
  API.get('/api/ai/config').then(cfg => {
    const provider = cfg.ai_provider || 'deepseek';
    const baseUrl = cfg.ai_base_url || (AI_PROVIDERS[provider] ? AI_PROVIDERS[provider].base_url : '');
    const model = cfg.ai_model || (AI_PROVIDERS[provider] ? AI_PROVIDERS[provider].model : '');
    openModal(`
      <div class="modal-header"><h3>🤖 AI 模型配置</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <label><input type="checkbox" id="aiEnabled" ${cfg.ai_enabled ? 'checked' : ''}> 启用 AI 校验（需管理权限）</label>
        <label>模型供应商</label>
        <select id="aiProvider" onchange="onAIProviderChange()">
          <option value="deepseek" ${provider === 'deepseek' ? 'selected' : ''}>DeepSeek</option>
          <option value="openai" ${provider === 'openai' ? 'selected' : ''}>OpenAI 兼容</option>
          <option value="custom" ${provider === 'custom' ? 'selected' : ''}>自定义</option>
        </select>
        <label>API 地址（Base URL）</label>
        <input type="text" id="aiBaseUrl" value="${escapeHtml(baseUrl)}" placeholder="例如 https://api.deepseek.com/v1">
        <label>模型名称</label>
        <input type="text" id="aiModel" value="${escapeHtml(model)}" placeholder="例如 deepseek-chat">
        <label>API Key</label>
        <input type="password" id="aiApiKey" placeholder="${cfg.api_key_set ? '已保存，留空表示不修改' : '请输入 API Key'}">
        <p style="font-size:12px;color:var(--text-secondary)">API Key 仅保存在本机数据库（内网部署），不会上传第三方。配置保存后，普通用户（非管理员）在校验界面可直接调用该模型进行 AI 校验，无需自行配置。</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="saveAIConfig()">保存配置</button>
      </div>
    `);
  }).catch(e => toast('加载配置失败', 'error'));
}
function onAIProviderChange() {
  const p = document.getElementById('aiProvider').value;
  if (AI_PROVIDERS[p]) {
    document.getElementById('aiBaseUrl').value = AI_PROVIDERS[p].base_url;
    document.getElementById('aiModel').value = AI_PROVIDERS[p].model;
  }
}
async function saveAIConfig() {
  const body = {
    enabled: document.getElementById('aiEnabled').checked,
    provider: document.getElementById('aiProvider').value,
    base_url: document.getElementById('aiBaseUrl').value.trim(),
    model: document.getElementById('aiModel').value.trim(),
    api_key: document.getElementById('aiApiKey').value
  };
  try {
    await API.post('/api/ai/config', body);
    closeModal();
    toast('AI 配置已保存', 'success');
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
}

// ===== 管理面板（批量操作票删除 + 完整性 + 日志）=====
async function showManageModal() {
  if (!state.isEditor) { toast('需要修改权限', 'error'); return; }
  openModal(`
    <div class="modal-header"><h3>⚙ 管理面板</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="manage-tabs">
        <button class="manage-tab active" onclick="switchManageTab('tickets')">批量操作票</button>
        <button class="manage-tab" onclick="switchManageTab('integrity')">完整性检查</button>
        <button class="manage-tab" onclick="switchManageTab('log')">操作日志</button>
        <button class="manage-tab" onclick="switchManageTab('ai')">AI反馈与调优</button>
        <button class="manage-tab" onclick="switchManageTab('aiprompt')">提示词与知识库</button>
        <button class="manage-tab" onclick="switchManageTab('standards')">校验规范</button>
        <button class="manage-tab" onclick="switchManageTab('vfeedback')">校验反馈</button>
        <button class="manage-tab" onclick="switchManageTab('apk')">APK管理</button>
      </div>
      <div id="manageTickets" class="manage-tab-content">
        <div class="manage-toolbar">
          <label style="display:inline;margin:0">变电站：</label>
          <select id="manageStation" onchange="loadManageTickets(parseInt(this.value))"></select>
          <button class="btn btn-sm btn-outline" onclick="selectAllManage(true)">全选</button>
          <button class="btn btn-sm btn-outline" onclick="selectAllManage(false)">清空</button>
          <span id="manageCount" class="manage-count"></span>
        </div>
        <div id="manageTicketList" class="manage-ticket-list"></div>
        <div class="manage-batch-bar">
          <button class="btn btn-sm btn-danger" onclick="batchDeleteTasks()">🗑 批量删除选中</button>
        </div>
      </div>
      <div id="manageIntegrity" class="manage-tab-content" style="display:none">
        <div id="manageIntegrityResult" class="integrity-result">检查中...</div>
        <button class="btn btn-sm btn-outline" onclick="manageIntegrity()" style="margin-top:8px">重新检查</button>
      </div>
      <div id="manageLog" class="manage-tab-content" style="display:none">
        <div id="manageLogList"></div>
      </div>
      <div id="manageAI" class="manage-tab-content" style="display:none">
        <div class="ai-fb-stats" id="aiFbStats"></div>
        <div id="aiFeedbackList" class="ai-fb-list"></div>
        <button class="btn btn-sm btn-outline" onclick="showAIChatModal()" style="margin-top:12px">💬 与 AI 对话调优</button>
      </div>
      <div id="manageAIPrompt" class="manage-tab-content" style="display:none"></div>
      <div id="manageStandards" class="manage-tab-content" style="display:none"></div>
      <div id="manageVFeedback" class="manage-tab-content" style="display:none"></div>
      <div id="manageApk" class="manage-tab-content" style="display:none"></div>
    </div>
  `);
  const sel = document.getElementById('manageStation');
  sel.innerHTML = state.substations.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  sel.value = state.currentSubstationId || (state.substations[0] && state.substations[0].id) || '';
  await loadManageTickets(parseInt(sel.value));
  manageIntegrity();
  loadManageLog();
}
function switchManageTab(tab) {
  document.querySelectorAll('.manage-tab').forEach(b => {
    const label = b.textContent.trim();
    b.classList.toggle('active', (tab === 'tickets' && label.includes('批量')) || (tab === 'integrity' && label.includes('完整性')) || (tab === 'log' && label.includes('日志')) || (tab === 'ai' && label.includes('AI')) || (tab === 'aiprompt' && label.includes('提示词')) || (tab === 'standards' && label.includes('校验规范')) || (tab === 'vfeedback' && label.includes('校验反馈')) || (tab === 'apk' && label.includes('APK')));
  });
  document.getElementById('manageTickets').style.display = tab === 'tickets' ? 'block' : 'none';
  document.getElementById('manageIntegrity').style.display = tab === 'integrity' ? 'block' : 'none';
  document.getElementById('manageLog').style.display = tab === 'log' ? 'block' : 'none';
  document.getElementById('manageAI').style.display = tab === 'ai' ? 'block' : 'none';
  document.getElementById('manageAIPrompt').style.display = tab === 'aiprompt' ? 'block' : 'none';
  document.getElementById('manageStandards').style.display = tab === 'standards' ? 'block' : 'none';
  document.getElementById('manageVFeedback').style.display = tab === 'vfeedback' ? 'block' : 'none';
  document.getElementById('manageApk').style.display = tab === 'apk' ? 'block' : 'none';
  if (tab === 'ai') loadAIFeedback();
  if (tab === 'aiprompt') loadAIPromptTab();
  if (tab === 'standards') loadStandardsTab();
  if (tab === 'vfeedback') loadVFeedbackTab();
  if (tab === 'apk') loadApkTab();
}
// ===== APK 管理（仅管理员）=====
async function loadApkTab() {
  const box = document.getElementById('manageApk');
  if (!box) return;
  try {
    const info = await API.get('/api/apk/info');
    const cur = info.available
      ? '<div class="ai-note" style="margin-bottom:10px">当前安装包：<b>' + escapeHtml(info.filename) + '</b><br>版本：' + (info.version || '未填写') + ' ｜ 大小：' + (info.size ? (info.size / 1048576).toFixed(1) + ' MB' : '-') + ' ｜ 上传：' + (info.uploadedAt ? info.uploadedAt.replace('T', ' ').slice(0, 19) : '-') + (info.note ? '<br>备注：' + escapeHtml(info.note) : '') + '</div>'
      : '<div class="ai-note">尚未上传安装包。请在下方上传 APK 文件。</div>';
    box.innerHTML = `
      <div class="apk-upload-box">
        ${cur}
        <div class="apk-form">
          <label>APK 文件：<input type="file" id="apkFile" accept=".apk" style="margin:6px 0"></label>
          <div style="display:flex;gap:8px;margin-top:6px">
            <input type="text" id="apkVersion" value="${APP_VERSION}" placeholder="版本号（自动填入当前版本，可修改）" style="flex:1">
            <input type="text" id="apkNote" placeholder="备注（可选）" style="flex:1">
          </div>
          <div style="margin-top:10px;display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" onclick="uploadApk()">⬆ 上传安装包</button>
            ${info.available ? '<button class="btn btn-danger btn-sm" onclick="deleteApk()">🗑 删除当前</button>' : ''}
          </div>
          <p class="ai-hint" style="margin-top:10px">APK 为 WebView 壳，加载本系统主域名。更新系统后打开 App 即自动最新，无需重新打包。管理员上传后，所有用户可在页面底部「📱 下载安卓App」下载安装。</p>
        </div>
      </div>`;
  } catch (e) {
    box.innerHTML = '<div class="ai-note" style="color:#d94a4a">加载失败：' + escapeHtml(e.message) + '</div>'
      + '<div class="ai-hint" style="margin-top:8px">请在浏览器地址栏直接访问 <b>/api/version</b> 查看返回内容：'
      '<br>• 若返回 JSON → 服务端正常，请按 Ctrl+Shift+R 硬刷新此页面'
      '<br>• 若返回网页(HTML) → 服务端仍是旧代码，需在 FNOS 执行 <code>docker compose up -d --build</code> 重建镜像</div>';
  }
}
function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
async function uploadApk() {
  const f = document.getElementById('apkFile').files[0];
  if (!f) { toast('请先选择 APK 文件', 'error'); return; }
  if (!f.name.toLowerCase().endsWith('.apk')) { toast('请选择 .apk 文件', 'error'); return; }
  toast('上传中...', 'info');
  try {
    const buf = await f.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);
    await API.post('/api/apk/upload', { filename: f.name, data: b64, version: (document.getElementById('apkVersion') || {}).value || '', note: (document.getElementById('apkNote') || {}).value || '' });
    toast('上传成功', 'success');
    loadApkTab();
  } catch (e) { toast('上传失败：' + e.message, 'error'); }
}
async function deleteApk() {
  if (!confirm('确认删除当前安装包？')) return;
  try { await API.del('/api/apk'); toast('已删除', 'success'); loadApkTab(); }
  catch (e) { toast('删除失败：' + e.message, 'error'); }
}
async function refreshApkDownload() {
  try {
    const info = await API.get('/api/apk/info');
    const el = document.getElementById('apkDownload');
    if (el) el.style.display = info.available ? 'inline' : 'none';
  } catch (_) {}
}

// 主页「📱 下载安卓App」：用 fetch+blob 触发下载（避免 SW 致 Chrome 不下载），文件名含版本号
async function downloadApk() {
  try {
    const info = await API.get('/api/apk/info');
    if (!info.available) { toast('暂无可下载的安装包', 'error'); return; }
    toast('正在下载安装包...', 'info');
    const resp = await fetch('/api/apk/download', { cache: 'no-store', credentials: 'same-origin' });
    if (!resp.ok) throw new Error('下载失败（' + resp.status + '）');
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = info.filename || ('运维五班操作票系统' + (APP_VERSION ? '_' + APP_VERSION : '') + '.apk');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) { toast('下载失败：' + e.message, 'error'); }
}

async function loadManageTickets(subId) {
  const list = document.getElementById('manageTicketList');
  if (!list) return;
  try {
    const rows = await API.get(`/api/tasks?substation_id=${subId}`);
    if (rows.length === 0) { list.innerHTML = '<div class="manage-empty">该变电站暂无操作票</div>'; updateManageCount(); return; }
    list.innerHTML = rows.map(t => `
      <label class="manage-ticket-item">
        <input type="checkbox" class="manage-check" value="${t.id}">
        <span class="manage-task-text">${escapeHtml(t.task_content)}</span>
        ${t.category ? `<span class="manage-cat">${escapeHtml(t.category)}</span>` : ''}
        <span class="manage-del" onclick="event.preventDefault();deleteTask(${t.id})" title="删除此票">🗑</span>
      </label>
    `).join('');
    updateManageCount();
  } catch (e) { list.innerHTML = '<div class="manage-empty">加载失败</div>'; }
}
function selectAllManage(checked) {
  document.querySelectorAll('#manageTicketList .manage-check').forEach(c => c.checked = checked);
  updateManageCount();
}
function updateManageCount() {
  const total = document.querySelectorAll('#manageTicketList .manage-check').length;
  const sel = document.querySelectorAll('#manageTicketList .manage-check:checked').length;
  const el = document.getElementById('manageCount');
  if (el) el.textContent = `已选 ${sel} / 共 ${total}`;
}
async function batchDeleteTasks() {
  const checks = Array.from(document.querySelectorAll('#manageTicketList .manage-check:checked'));
  if (checks.length === 0) { toast('请先勾选要删除的操作票', 'error'); return; }
  const ids = checks.map(c => parseInt(c.value));
  if (!confirm(`确定删除选中的 ${ids.length} 张操作票吗？\n该操作将同时删除其下所有操作项目，且不可恢复！`)) return;
  try {
    const r = await API.post('/api/tasks/batch-delete', { ids });
    toast(`已删除 ${r.deleted} 张操作票`, 'success');
    await loadManageTickets(parseInt(document.getElementById('manageStation').value));
    await loadTasks(state.currentSubstationId);
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
}
async function manageIntegrity() {
  const c = document.getElementById('manageIntegrityResult');
  if (!c) return;
  try {
    const r = await API.get('/api/integrity-check');
    c.innerHTML = r.allOk
      ? `<span class="ok">✅ 数据完整性检查通过</span><br><small>${r.substations} 变电站 / ${r.tasks} 任务 / ${r.items} 项目 / ${r.history} 条历史 / ${r.auditEntries} 条日志</small>`
      : `<span class="fail">❌ 存在 ${r.orphanItems} 个孤立项目，${r.orphanHistory} 条孤立历史记录</span>`;
  } catch (e) { c.innerHTML = '<span class="fail">检查失败</span>'; }
}
async function loadManageLog() {
  const c = document.getElementById('manageLogList');
  if (!c) return;
  try {
    const logs = await API.get('/api/audit-log');
    c.innerHTML = logs.length === 0 ? '<div class="manage-empty">暂无日志</div>'
      : logs.map(l => `<div class="audit-entry"><span class="time">${l.created_at}</span><span>${escapeHtml(l.action_type)}: ${escapeHtml(l.summary)}</span></div>`).join('');
  } catch (e) { c.innerHTML = '<div class="manage-empty">加载失败</div>'; }
}

// ===== AI 校验反馈汇总（仅管理员）=====
async function loadAIFeedback() {
  const c = document.getElementById('aiFeedbackList');
  const stats = document.getElementById('aiFbStats');
  if (!c) return;
  try {
    const r = await API.get('/api/ai/feedback');
    if (stats) stats.textContent = `共 ${r.total} 条反馈 · 平均评分 ${r.avg_rating || '-'}`;
    if (r.feedback.length === 0) { c.innerHTML = '<div class="manage-empty">暂无用户反馈</div>'; return; }
    c.innerHTML = r.feedback.map(f => `
      <div class="ai-fb-item">
        <div class="ai-fb-meta">#${f.id} · ${f.created_at}${f.rating ? ' · 评分 ' + '★'.repeat(f.rating) + '☆'.repeat(5 - f.rating) : ''}${f.task_id ? ' · 操作票#' + f.task_id : ''}</div>
        <div class="ai-fb-sugg">${escapeHtml(f.suggestion || '(无文字建议)')}</div>
      </div>`).join('');
  } catch (e) { c.innerHTML = '<div class="manage-empty">加载失败</div>'; }
}

// ===== 管理员与 AI 对话调优 =====
let aiChatHistory = [];
function showAIChatModal() {
  if (!state.isEditor) { toast('需要修改权限', 'error'); return; }
  aiChatHistory = [];
  openModal(`
    <div class="modal-header"><h3>💬 与 AI 对话调优</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">基于用户反馈优化校验规则。可直接粘贴反馈内容或描述期望的审核标准，AI 将给出改进建议与提示词优化方向（Ctrl/⌘+Enter 发送）。</p>
      <div id="aiChatBox" class="ai-chat-box"></div>
      <textarea id="aiChatInput" rows="3" placeholder="输入您想与 AI 探讨的调优内容..." onkeydown="if(event.key==='Enter'&&(event.ctrlKey||event.metaKey))sendAIChat()"></textarea>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">关闭</button>
      <button class="btn btn-primary" onclick="sendAIChat()">发送</button>
    </div>
  `);
}
async function sendAIChat() {
  const input = document.getElementById('aiChatInput');
  const box = document.getElementById('aiChatBox');
  if (!input || !input.value.trim()) return;
  const text = input.value.trim();
  input.value = '';
  aiChatHistory.push({ role: 'user', content: text });
  box.innerHTML += `<div class="chat-bubble user">${escapeHtml(text)}</div>`;
  const loading = document.createElement('div');
  loading.className = 'chat-bubble ai';
  loading.textContent = '思考中...';
  box.appendChild(loading);
  box.scrollTop = box.scrollHeight;
  try {
    const r = await API.post('/api/ai/chat', { messages: aiChatHistory });
    loading.remove();
    aiChatHistory.push({ role: 'assistant', content: r.reply });
    box.innerHTML += `<div class="chat-bubble ai">${escapeHtml(r.reply)}</div>`;
    box.scrollTop = box.scrollHeight;
  } catch (e) {
    loading.remove();
    box.innerHTML += `<div class="chat-bubble ai err">调用失败：${escapeHtml(e.message)}</div>`;
  }
}

// ===== TXT 批量导入操作票 =====
function showImportTxtModal() {
  if (!state.isEditor) { toast('需要修改权限', 'error'); return; }
  txtTicketsBuffer = [];
  openModal(`
    <div class="modal-header"><h3>📥 从 TXT 批量导入操作票</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <label>选择目标变电站</label>
      <select id="txtStation">${state.substations.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select>
      <label>选择 TXT 文件</label>
      <input type="file" id="txtFileInput" accept=".txt" onchange="parseTxtFile(event)">
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:12px"><input type="checkbox" id="txtReplace" checked> 重名时替换已有操作票（默认开启；取消则跳过重名项）</label>
      <div class="txt-format-tip">
        <b>文件格式说明：</b><br>
        ① 每张操作票：<b>第一行为「操作任务」</b>，其后的每行为「操作项目」；<br>
        ② 一张票结束后<b>空一行</b>，再写下一张票的操作任务与项目；<br>
        ③ 一个 TXT 文件可包含多张操作票。<br>
        示例：<br>
        <span class="txt-example">将35kV文星变电站#1主变由运行转检修<br>拉开35kV文星变电站#1主变301开关<br>检查301开关确在分位<br><br>将35kV文星变电站#1主变由检修转运行<br>合上35kV文星变电站#1主变301开关</span>
      </div>
      <div id="txtPreview"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="txtImportBtn" onclick="submitTxtImport()" disabled>确认导入</button>
    </div>
  `);
  const sel = document.getElementById('txtStation');
  sel.value = state.currentSubstationId || (state.substations[0] && state.substations[0].id) || '';
}
function parseTxtFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    try {
      const result = parseTxtTickets(text);
      if (!result.ok) {
        document.getElementById('txtPreview').innerHTML = `<div class="txt-err">❌ ${escapeHtml(result.error)}</div>`;
        document.getElementById('txtImportBtn').disabled = true;
        txtTicketsBuffer = [];
        return;
      }
      txtTicketsBuffer = result.tickets;
      const preview = result.tickets.slice(0, 5).map((t, i) => `
        <div class="txt-preview-item">
          <div class="txt-preview-task">${i + 1}. ${escapeHtml(t.task)} <span class="txt-preview-count">（${t.items.length} 项）</span></div>
          ${t.items.slice(0, 3).map(it => `<div class="txt-preview-line">· ${escapeHtml(it)}</div>`).join('')}
          ${t.items.length > 3 ? `<div class="txt-preview-more">… 等 ${t.items.length} 项</div>` : ''}
        </div>
      `).join('');
      const warn = result.warnings.length ? `<div class="txt-warn">⚠️ ${escapeHtml(result.warnings.join('；'))}</div>` : '';
      document.getElementById('txtPreview').innerHTML =
        `${warn}<div class="txt-summary">✅ 解析成功：共 ${result.tickets.length} 张操作票，${result.totalItems} 项操作</div>${preview}`;
      document.getElementById('txtImportBtn').disabled = false;
    } catch (err) {
      document.getElementById('txtPreview').innerHTML = `<div class="txt-err">❌ 解析失败：${escapeHtml(err.message)}</div>`;
      document.getElementById('txtImportBtn').disabled = true;
      txtTicketsBuffer = [];
    }
  };
  reader.readAsText(file, 'UTF-8');
}
function parseTxtTickets(text) {
  if (!text || !text.trim()) return { ok: false, error: '文件内容为空，请检查所选文件。' };
  const lines = text.split(/\r?\n/);
  const tickets = [];
  const warnings = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      if (current) {
        tickets.push(current);
        current = null;
      }
      continue;
    }
    if (!current) {
      current = { task: line, items: [] };
    } else {
      current.items.push(line);
    }
  }
  if (current) tickets.push(current);

  if (tickets.length === 0) {
    return { ok: false, error: '未解析到任何操作票。请确认格式：每张票第一行为操作任务，其后为操作项目，票与票之间用空行分隔。' };
  }
  let totalItems = 0, noItems = 0;
  for (const t of tickets) {
    totalItems += t.items.length;
    if (t.items.length === 0) noItems++;
  }
  if (noItems > 0) warnings.push(`${noItems} 张操作票缺少操作项目，将仅导入任务标题`);
  return { ok: true, tickets, warnings, totalItems };
}
async function submitTxtImport() {
  const substation_id = document.getElementById('txtStation').value;
  if (!substation_id) { toast('请选择目标变电站', 'error'); return; }
  if (!txtTicketsBuffer || txtTicketsBuffer.length === 0) { toast('没有可导入的数据', 'error'); return; }
  const replaceExisting = document.getElementById('txtReplace') ? document.getElementById('txtReplace').checked : true;
  if (!confirm(`确认将 ${txtTicketsBuffer.length} 张操作票导入所选变电站吗？${replaceExisting ? '（重名操作票将被覆盖）' : '（重名操作票将跳过）'}`)) return;
  try {
    const r = await API.post('/api/import-tickets', { substation_id: parseInt(substation_id), tickets: txtTicketsBuffer, replace_existing: replaceExisting });
    closeModal();
    let msg = `导入完成：新增 ${r.tasks} 张 / 替换 ${r.replaced} 张 / 跳过 ${r.skipped} 张 / 共 ${r.items} 项`;
    toast(msg, 'success');
    await loadTasks(state.currentSubstationId);
  } catch (e) { toast('导入失败：' + e.message, 'error'); }
}

// --- Event Handlers ---
document.addEventListener('DOMContentLoaded', async () => {
  await checkAuth();
  await loadSubstations();
  renderVersion();
  refreshApkDownload();

  document.getElementById('stationSelect').addEventListener('change', async (e) => {
    state.currentSubstationId = e.target.value ? parseInt(e.target.value) : null;
    await loadTasks(state.currentSubstationId);
    document.getElementById('editorUI').style.display = state.currentSubstationId && state.isEditor ? 'flex' : 'none';
  });

  document.getElementById('searchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderTaskList();
  });

  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
});

// === 主备域名故障自动切换（零成本方案：前端探测 + SW 缓存壳）===
// 主域名穿透链路中断时，已缓存的页面壳仍能加载并自动跳转备用域名；
// 在备用域名下持续探测主域名，恢复后自动切回。无需付费负载均衡。
(function () {
  const PRIMARY = 'https://czp.119222.xyz';
  const BACKUP = 'https://cz.lzz.de5.net';
  const cur = location.origin;
  // 仅在主/备域名下启用；本地开发或其他环境不触发切换
  if (cur !== PRIMARY && cur !== BACKUP) return;

  const KEEP = location.pathname + location.search + location.hash;

  function probe() {
    return new Promise((resolve) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      fetch(PRIMARY + '/api/auth/status', { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
        .then(() => { clearTimeout(timer); resolve(true); })
        .catch(() => { clearTimeout(timer); resolve(false); });
    });
  }

  if (cur === PRIMARY) {
    let fails = 0;
    setInterval(async () => {
      const ok = await probe();
      if (ok) { fails = 0; }
      else if (++fails >= 2) { location.replace(BACKUP + KEEP); }
    }, 15000);
  } else if (cur === BACKUP) {
    setInterval(async () => {
      const ok = await probe();
      if (ok) { location.replace(PRIMARY + KEEP); }
    }, 30000);
  }
})();
