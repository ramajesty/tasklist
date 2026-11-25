// 画面の描画と操作
import * as db from './db.js';
import {
  uuid, nowIso, ymd, addDays, endOfWeek, shortDate, dueLabel, compareTasks,
  escapeHtml, linkify, hasLink, parseQuickInput, matchesQuery, compressImage,
} from './util.js';
import { exportJSON, exportCSV, importJSON } from './export.js';
import { loadCalendar, firstOccurrenceFrom, nextDueOnComplete, describeRepeat } from './recur.js';
import { repeatFieldHtml, bindRepeatField } from './repeat-ui.js';
import { openCalendarSettings } from './calendar-ui.js';
import * as cloud from './sync.js';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = escapeHtml;

// 表示設定（画面の状態だけ。タスク本体は IndexedDB）
const pref = {
  get(k, d) { try { const v = localStorage.getItem('tl.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tl.' + k, JSON.stringify(v)); } catch { /* 無視 */ } },
};

const VIEWS = [
  { id: 'all', label: 'すべて' },
  { id: 'today', label: '今日' },
  { id: 'week', label: '今週' },
  { id: 'overdue', label: '期限切れ' },
];

const state = {
  tasks: [],
  view: pref.get('view', 'all'),
  tag: pref.get('tag', null),
  query: '',
  flashId: null,
  today: ymd(),
};

const ICON_CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

// ---------------------------------------------------------------------------
// データ操作
// ---------------------------------------------------------------------------
const live = () => state.tasks.filter((t) => !t.deletedAt);
const findTask = (id) => state.tasks.find((t) => t.id === id);

function newTask(fields = {}) {
  const now = nowIso();
  return {
    id: uuid(),
    title: '',
    due: ymd(),
    priority: false,
    memo: '',
    tags: [],
    images: [],
    repeat: null,
    done: false,
    doneAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...fields,
  };
}

async function saveTask(t) {
  t.updatedAt = nowIso();
  t._dirty = true; // クラウドへ未送信の印
  await db.putTask(t);
  const i = state.tasks.findIndex((x) => x.id === t.id);
  if (i < 0) state.tasks.push(t);
  else state.tasks[i] = t;
  window.dispatchEvent(new Event('tl:local-change'));
}

async function setDone(t, done) {
  t.done = done;
  t.doneAt = done ? nowIso() : null;
  await saveTask(t);
}

// 繰り返しタスクの完了: 完了記録（履歴）を別に残し、元のタスクは次の期限日へ進める。
// 画像やメモは元のタスクに残るので、毎回の手順メモなどがそのまま使える。
async function completeRepeating(t) {
  const next = nextDueOnComplete(t, ymd());
  if (!next) return null;
  const now = nowIso();
  const history = {
    ...JSON.parse(JSON.stringify(t)),
    id: uuid(),
    images: [],
    repeat: null,
    repeatOf: t.id,
    done: true,
    doneAt: now,
    createdAt: now,
  };
  await saveTask(history);
  const prevDue = t.due;
  t.due = next;
  await saveTask(t);
  return {
    next,
    undo: async () => {
      history.deletedAt = nowIso();
      await saveTask(history);
      t.due = prevDue;
      await saveTask(t);
      state.flashId = t.id;
    },
  };
}

function allTags() {
  const set = new Set();
  for (const t of live()) for (const tag of t.tags || []) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}

function inView(t, view, today) {
  switch (view) {
    case 'today': return !!t.due && t.due <= today;
    case 'week': return !!t.due && t.due <= endOfWeek(today);
    case 'overdue': return !!t.due && t.due < today;
    default: return true;
  }
}

// ---------------------------------------------------------------------------
// 一覧の描画
// ---------------------------------------------------------------------------
function render() {
  const today = (state.today = ymd());
  if (state.tag && !allTags().includes(state.tag)) state.tag = null;
  renderViews(today);
  renderTagFilter();

  const q = state.query.trim().toLowerCase();
  let items = live();
  if (state.tag) items = items.filter((t) => (t.tags || []).includes(state.tag));

  let groups;
  if (q) {
    items = items.filter((t) => matchesQuery(t, q));
    const open = items.filter((t) => !t.done).sort(compareTasks);
    const done = items.filter((t) => t.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
    groups = groupTasks(open, today);
    if (done.length) groups.push({ key: 'done', label: '完了済み', items: done });
  } else {
    items = items.filter((t) => !t.done && inView(t, state.view, today)).sort(compareTasks);
    groups = groupTasks(items, today);
  }

  const list = $('#list');
  list.innerHTML = groups.map((g) => `
    <section class="group ${g.key === 'overdue' ? 'is-overdue' : ''} ${g.key === 'done' ? 'is-done' : ''}">
      <h2 class="group-title">${esc(g.label)}<span class="count">${g.items.length}</span></h2>
      <ul>${g.items.map((t) => rowHtml(t, today, g.key)).join('')}</ul>
    </section>`).join('');

  const empty = $('#empty');
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  empty.hidden = total > 0;
  if (!total) {
    empty.textContent = q ? '見つかりませんでした'
      : state.view === 'overdue' ? '期限切れのタスクはありません'
      : 'タスクはありません。下の入力欄から追加できます';
  }

  if (state.flashId) {
    const el = list.querySelector(`[data-id="${state.flashId}"]`);
    if (el) {
      el.classList.add('flash');
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    state.flashId = null;
  }
}

function groupTasks(items, today) {
  const groups = [];
  let cur = null;
  for (const t of items) {
    const key = !t.due ? 'none' : t.due < today ? 'overdue' : t.due;
    if (!cur || cur.key !== key) {
      const label = key === 'overdue' ? '期限切れ' : key === 'none' ? '期限なし' : dueLabel(key, today);
      cur = { key, label, items: [] };
      groups.push(cur);
    }
    cur.items.push(t);
  }
  return groups;
}

function rowHtml(t, today, groupKey) {
  const meta = [];
  if ((groupKey === 'overdue' || groupKey === 'done') && t.due) {
    meta.push(`<span class="due ${!t.done && t.due < today ? 'overdue' : ''}">${esc(shortDate(t.due))}</span>`);
  }
  if (t.repeat) meta.push(`<span class="repeat">🔁 ${esc(describeRepeat(t.repeat))}</span>`);
  for (const tag of t.tags || []) meta.push(`<span class="tag">#${esc(tag)}</span>`);
  const icons = [];
  if ((t.memo || '').trim()) icons.push(hasLink(t.memo) ? '🔗' : '📝');
  if (t.images?.length) icons.push('🖼️');
  if (icons.length) meta.push(`<span class="icons">${icons.join('')}</span>`);

  return `
    <li class="task ${t.done ? 'done' : ''} ${t.priority ? 'prio' : ''}" data-id="${esc(t.id)}">
      <button class="check" data-act="toggle-done" aria-label="${t.done ? '未完了に戻す' : '完了にする'}">${ICON_CHECK}</button>
      <div class="body" data-act="edit" role="button" tabindex="0">
        <div class="title">${esc(t.title)}</div>
        ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
      </div>
      <button class="star ${t.priority ? 'on' : ''}" data-act="toggle-prio" aria-label="優先" aria-pressed="${!!t.priority}">${ICON_STAR}</button>
    </li>`;
}

function renderViews(today) {
  const base = live().filter((t) => !t.done && (!state.tag || (t.tags || []).includes(state.tag)));
  $('#views').innerHTML = VIEWS.map((v) => {
    const n = base.filter((t) => inView(t, v.id, today)).length;
    const active = state.view === v.id && !state.query;
    const warn = v.id === 'overdue' && n > 0;
    return `<button class="view-tab ${active ? 'active' : ''} ${warn ? 'warn' : ''}" data-view="${v.id}">${v.label}<span class="n">${n}</span></button>`;
  }).join('');
}

function renderTagFilter() {
  const tags = allTags();
  const el = $('#tag-filter');
  el.hidden = tags.length === 0;
  el.innerHTML = [
    `<button class="chip ${!state.tag ? 'active' : ''}" data-tag="">すべてのタグ</button>`,
    ...tags.map((t) => `<button class="chip ${state.tag === t ? 'active' : ''}" data-tag="${esc(t)}">#${esc(t)}</button>`),
  ].join('');
}

// ---------------------------------------------------------------------------
// トースト（元に戻す付き）
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg, actionLabel, onAction) {
  const el = $('#toast');
  el.innerHTML = `<span class="msg">${esc(msg)}</span>${actionLabel ? `<button class="toast-btn">${esc(actionLabel)}</button>` : ''}`;
  el.classList.add('show');
  const btn = el.querySelector('.toast-btn');
  if (btn) btn.onclick = () => { el.classList.remove('show'); onAction(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), actionLabel ? 5000 : 2500);
}

// ---------------------------------------------------------------------------
// シート（編集画面・メニュー）
// ---------------------------------------------------------------------------
let sheetOnClose = null;

function openSheet(html, onClose) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="sheet-backdrop"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  document.body.classList.add('sheet-open');
  sheetOnClose = onClose;
  const backdrop = root.firstElementChild;
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) sheetOnClose?.(); });
  return backdrop.querySelector('.sheet');
}

function closeSheet() {
  $('#sheet-root').innerHTML = '';
  document.body.classList.remove('sheet-open');
  sheetOnClose = null;
}

// ---- 編集画面 ----
async function openEditor(task) {
  const isNew = !task;
  const draft = isNew
    ? newTask({ tags: state.tag ? [state.tag] : [] })
    : JSON.parse(JSON.stringify(task));
  draft.tags = [...(draft.tags || [])];
  draft.images = [...(draft.images || [])];
  const addedImages = [];
  const removedImages = [];
  const urls = new Map();
  const snapshot = () => JSON.stringify([draft.title, draft.due, draft.priority, draft.memo, draft.tags, draft.images, draft.repeat]);

  const memoStartsInView = !isNew && (draft.memo || '').trim() !== '';

  const sheet = openSheet(`
    <header class="sheet-header">
      <button class="text-btn" data-act="cancel">キャンセル</button>
      <h2>${isNew ? '新しいタスク' : 'タスクの編集'}</h2>
      <button class="btn primary" data-act="save">保存</button>
    </header>
    <div class="sheet-body">
      <textarea id="f-title" class="title-input" rows="1" placeholder="タスク名" enterkeyhint="done">${esc(draft.title)}</textarea>

      <div class="field">
        <label for="f-due">期限日</label>
        <div class="due-row">
          <input type="date" id="f-due" value="${esc(draft.due || '')}">
          <div class="quick-due">
            <button type="button" class="chip" data-due="0">今日</button>
            <button type="button" class="chip" data-due="1">明日</button>
            <button type="button" class="chip" data-due="7">1週間後</button>
            <button type="button" class="chip" data-due="none">なし</button>
          </div>
        </div>
      </div>

      ${repeatFieldHtml(draft.repeat)}

      <div class="field inline">
        <label for="f-prio">優先</label>
        <label class="switch"><input type="checkbox" id="f-prio" ${draft.priority ? 'checked' : ''}><span class="slider"></span></label>
      </div>

      <div class="field">
        <label for="f-tag-input">タグ</label>
        <div class="tag-editor">
          <span id="f-tags" class="chips"></span>
          <input id="f-tag-input" placeholder="タグを入力して Enter" enterkeyhint="done" autocomplete="off">
        </div>
        <div id="f-tag-suggest" class="chips suggest"></div>
      </div>

      <div class="field">
        <div class="label-row">
          <label for="f-memo">メモ</label>
          <button type="button" class="text-btn small" id="memo-toggle" ${memoStartsInView ? '' : 'hidden'}>編集</button>
        </div>
        <div id="memo-view" class="memo-view" ${memoStartsInView ? '' : 'hidden'}></div>
        <textarea id="f-memo" class="memo-input" rows="6" ${memoStartsInView ? 'hidden' : ''}
          placeholder="メモ・URL（OneNote / SharePoint / YouTube など）">${esc(draft.memo || '')}</textarea>
        <p class="hint">URLは自動でリンクになります。<code>[表示名](URL)</code> と書くと名前付きリンクになります。</p>
      </div>

      <div class="field">
        <label>画像</label>
        <div id="f-images" class="images"></div>
        <label class="btn file-btn">画像を追加<input type="file" id="f-file" accept="image/*" multiple hidden></label>
        <p class="hint">PCではコピーした画像を Ctrl+V で貼り付け、またはドラッグ＆ドロップでも追加できます。</p>
      </div>

      ${isNew ? '' : `
      <div class="field danger-zone">
        <button type="button" class="btn danger" data-act="delete">このタスクを削除</button>
        <p class="hint">作成: ${esc(new Date(draft.createdAt).toLocaleString('ja-JP'))}${draft.doneAt ? ` ／ 完了: ${esc(new Date(draft.doneAt).toLocaleString('ja-JP'))}` : ''}</p>
      </div>`}
    </div>`, () => cancel());

  const titleEl = $('#f-title', sheet);
  const dueEl = $('#f-due', sheet);
  const prioEl = $('#f-prio', sheet);
  const memoEl = $('#f-memo', sheet);
  const memoView = $('#memo-view', sheet);
  const memoToggle = $('#memo-toggle', sheet);
  const tagInput = $('#f-tag-input', sheet);

  const original = snapshot();

  // ---- タイトル（Enterで改行させない・高さ自動） ----
  const autoGrow = (el) => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; };
  titleEl.addEventListener('input', () => { autoGrow(titleEl); titleEl.classList.remove('invalid'); });
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); titleEl.blur(); }
  });
  requestAnimationFrame(() => autoGrow(titleEl));
  if (isNew) setTimeout(() => titleEl.focus(), 50);

  // ---- 期限日 ----
  sheet.querySelectorAll('[data-due]').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.due;
    dueEl.value = v === 'none' ? '' : addDays(ymd(), Number(v));
  }));

  // ---- 繰り返し（設定を変えたら期限日を直近の該当日に合わせる） ----
  const repeatCtl = bindRepeatField(sheet, draft.repeat, () => dueEl.value || ymd(), (rep) => {
    if (rep) dueEl.value = firstOccurrenceFrom(rep, ymd()) || dueEl.value;
  });

  // ---- タグ ----
  const renderTags = () => {
    $('#f-tags', sheet).innerHTML = draft.tags.map((t) =>
      `<span class="chip on">#${esc(t)}<button type="button" class="chip-x" data-rmtag="${esc(t)}" aria-label="${esc(t)} を外す">×</button></span>`).join('');
    const sug = allTags().filter((t) => !draft.tags.includes(t));
    $('#f-tag-suggest', sheet).innerHTML = sug.map((t) =>
      `<button type="button" class="chip ghost" data-addtag="${esc(t)}">+ #${esc(t)}</button>`).join('');
  };
  const commitTagInput = () => {
    const parts = tagInput.value.split(/[\s,、]+/).map((s) => s.replace(/^[#＃]/, '').trim()).filter(Boolean);
    for (const p of parts) if (!draft.tags.includes(p)) draft.tags.push(p);
    tagInput.value = '';
    renderTags();
  };
  tagInput.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',') && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      commitTagInput();
    }
  });
  sheet.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rmtag]');
    if (rm) { draft.tags = draft.tags.filter((t) => t !== rm.dataset.rmtag); renderTags(); return; }
    const add = e.target.closest('[data-addtag]');
    if (add) { if (!draft.tags.includes(add.dataset.addtag)) draft.tags.push(add.dataset.addtag); renderTags(); }
  });
  renderTags();

  // ---- メモ（表示モード⇔編集モード） ----
  const showMemoView = () => {
    memoView.innerHTML = linkify(memoEl.value) || '<span class="placeholder">（メモなし）</span>';
    memoView.hidden = false;
    memoEl.hidden = true;
    memoToggle.hidden = false;
    memoToggle.textContent = '編集';
  };
  const showMemoEdit = () => {
    memoView.hidden = true;
    memoEl.hidden = false;
    memoToggle.hidden = false;
    memoToggle.textContent = 'プレビュー';
    memoEl.focus();
  };
  memoToggle.addEventListener('click', () => (memoEl.hidden ? showMemoEdit() : showMemoView()));
  memoView.addEventListener('click', (e) => { if (!e.target.closest('a')) showMemoEdit(); });
  if (memoStartsInView) showMemoView();

  // ---- 画像 ----
  const imagesEl = $('#f-images', sheet);
  const renderImages = async () => {
    for (const id of draft.images) {
      if (urls.has(id)) continue;
      const rec = await db.getImage(id);
      if (rec) urls.set(id, URL.createObjectURL(rec.blob));
    }
    imagesEl.innerHTML = draft.images.filter((id) => urls.has(id)).map((id) => `
      <div class="thumb">
        <img src="${urls.get(id)}" alt="添付画像" data-view="${esc(id)}">
        <button type="button" class="thumb-del" data-delimg="${esc(id)}" aria-label="画像を削除">×</button>
      </div>`).join('');
  };
  const addImages = async (files) => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      const blob = await compressImage(f);
      const id = uuid();
      await db.putImage({ id, taskId: draft.id, blob, createdAt: nowIso() });
      draft.images.push(id);
      addedImages.push(id);
      urls.set(id, URL.createObjectURL(blob));
    }
    renderImages();
  };
  imagesEl.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-delimg]');
    if (del) {
      const id = del.dataset.delimg;
      draft.images = draft.images.filter((x) => x !== id);
      const ai = addedImages.indexOf(id);
      if (ai >= 0) { addedImages.splice(ai, 1); await db.deleteImage(id); }
      else removedImages.push(id);
      URL.revokeObjectURL(urls.get(id));
      urls.delete(id);
      renderImages();
      return;
    }
    const img = e.target.closest('[data-view]');
    if (img) openImageViewer(img.src);
  });
  $('#f-file', sheet).addEventListener('change', (e) => { addImages([...e.target.files]); e.target.value = ''; });
  sheet.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addImages(files); }
  });
  sheet.addEventListener('dragover', (e) => { e.preventDefault(); sheet.classList.add('dragging'); });
  sheet.addEventListener('dragleave', (e) => { if (e.target === sheet) sheet.classList.remove('dragging'); });
  sheet.addEventListener('drop', (e) => {
    e.preventDefault();
    sheet.classList.remove('dragging');
    addImages([...(e.dataTransfer?.files || [])]);
  });
  renderImages();

  // ---- 保存・キャンセル・削除 ----
  const collect = () => {
    draft.title = titleEl.value.replace(/\s+/g, ' ').trim();
    draft.due = dueEl.value || null;
    draft.priority = prioEl.checked;
    draft.memo = memoEl.value;
    draft.repeat = repeatCtl.get();
  };
  const releaseUrls = () => { for (const u of urls.values()) URL.revokeObjectURL(u); };

  async function save() {
    commitTagInput();
    collect();
    if (!draft.title) {
      titleEl.classList.add('invalid');
      titleEl.focus();
      return;
    }
    for (const id of removedImages) await db.deleteImage(id);
    await saveTask(draft);
    releaseUrls();
    closeSheet();
    state.flashId = draft.id;
    render();
    toast(isNew ? '追加しました' : '保存しました');
  }

  async function cancel() {
    collect();
    if ((snapshot() !== original || tagInput.value.trim()) && !confirm('変更を保存せずに閉じますか？')) return;
    for (const id of addedImages) await db.deleteImage(id);
    releaseUrls();
    closeSheet();
  }

  async function remove() {
    if (!confirm(`「${task.title}」を削除しますか？\n（画像も削除され、元に戻せません）`)) return;
    for (const id of addedImages) await db.deleteImage(id);
    await db.deleteImagesByTask(task.id);
    task.deletedAt = nowIso();
    task.images = [];
    await saveTask(task);
    releaseUrls();
    closeSheet();
    render();
    toast('削除しました');
  }

  sheet.querySelector('[data-act="save"]').addEventListener('click', save);
  sheet.querySelector('[data-act="cancel"]').addEventListener('click', cancel);
  sheet.querySelector('[data-act="delete"]')?.addEventListener('click', remove);
}

function openImageViewer(src) {
  const v = document.createElement('div');
  v.className = 'viewer';
  v.innerHTML = `<img src="${src}" alt="画像"><button class="viewer-close" aria-label="閉じる">×</button>`;
  v.addEventListener('click', () => v.remove());
  document.body.appendChild(v);
}

// ---- メニュー ----
async function openMenu() {
  const doneCount = live().filter((t) => t.done).length;
  const sheet = openSheet(`
    <header class="sheet-header">
      <span></span>
      <h2>メニュー</h2>
      <button class="text-btn" data-act="close">閉じる</button>
    </header>
    <div class="sheet-body menu">
      <button class="menu-item" data-act="done-list">✅ 完了済みのタスク<span class="n">${doneCount}</span></button>
      <button class="menu-item" data-act="calendar">📅 会社カレンダー（稼働日の設定）</button>
      <h3>同期（クラウド保存）</h3>
      <div id="sync-box"></div>
      <h3>iPhoneショートカット（共有・音声で追加）</h3>
      <div id="shortcut-box" class="token-box"></div>
      <h3>カレンダー購読（Google・Outlook）</h3>
      <div id="feed-box" class="token-box"></div>
      <h3>バックアップ</h3>
      <button class="menu-item" data-act="export-json">💾 バックアップを保存（画像込み）</button>
      <button class="menu-item" data-act="export-csv">📄 CSVで書き出す（Excel用）</button>
      <label class="menu-item">📥 バックアップから復元<input type="file" id="import-file" accept="application/json,.json" hidden></label>
      <h3>このアプリについて</h3>
      <p class="hint">データはまずこの端末内に保存され、ログイン中はクラウドにも自動で同期されます（オフライン中の変更は、つながったときに送信）。念のため、ときどき「バックアップを保存」してください。</p>
      <p class="hint" id="storage-info"></p>
      <p class="hint">ショートカット: <kbd>N</kbd> 追加欄へ ／ <kbd>/</kbd> 検索</p>
    </div>`, closeSheet);

  renderSyncBox(sheet);
  renderTokenBoxes(sheet);

  sheet.addEventListener('click', async (e) => {
    const actEl = e.target.closest('[data-act]');
    const act = actEl?.dataset.act;
    try {
      if (act === 'sync-now') { await cloud.sync(); renderSyncBox(sheet); }
      else if (act === 'issue-token') {
        const kind = actEl.dataset.kind;
        if (actEl.dataset.has && !confirm(TOKEN_UI[kind].confirm)) return;
        const token = await cloud.issueToken(kind);
        renderTokenBox(sheet, kind, token);
      }
      else if (act === 'copy') {
        const v = $('#' + actEl.dataset.target, sheet).value;
        await navigator.clipboard.writeText(v);
        toast('コピーしました');
      }
      else if (act === 'logout') {
        if (!confirm('ログアウトしますか？\n（この端末のデータは残ります）')) return;
        await cloud.signOut();
        renderSyncBox(sheet);
        renderTokenBoxes(sheet);
      }
      else if (act === 'close') closeSheet();
      else if (act === 'done-list') openDoneList();
      else if (act === 'calendar') openCalendarSettings({ openSheet, onBack: openMenu, toast });
      else if (act === 'export-json') { await exportJSON(); toast('バックアップを書き出しました'); }
      else if (act === 'export-csv') { await exportCSV(); toast('CSVを書き出しました'); }
    } catch (err) {
      alert('エラー: ' + err.message);
    }
  });
  $('#import-file', sheet).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const r = await importJSON(f);
      state.tasks = await db.getAllTasks();
      await loadCalendar();
      closeSheet();
      render();
      toast(`復元しました（追加 ${r.added}件・更新 ${r.updated}件）`);
    } catch (err) {
      alert('復元できませんでした: ' + err.message);
    }
  });

  if (navigator.storage?.estimate) {
    const { usage } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const info = $('#storage-info', sheet);
    if (info) info.textContent = `使用容量: 約 ${(usage / 1024 / 1024).toFixed(1)} MB ／ 自動削除の保護: ${persisted ? 'あり' : 'なし'}`;
  }
}

// ---- 同期の状態・ログイン ----
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

function renderSyncBox(sheet) {
  const box = $('#sync-box', sheet);
  if (!box) return;
  const s = cloud.status;
  if (s.state === 'off') {
    box.innerHTML = '<p class="hint">未設定です（セットアップ手順に沿って接続情報を設定すると使えます）。</p>';
    return;
  }
  if (s.state === 'signed-out') {
    box.innerHTML = `
      <form id="login-form" class="login-form">
        <input type="email" id="login-email" placeholder="メールアドレス" autocomplete="username" required>
        <input type="password" id="login-pass" placeholder="パスワード" autocomplete="current-password" required>
        <button class="btn primary" type="submit">ログインして同期</button>
        <p class="hint" id="login-msg"></p>
      </form>`;
    $('#login-form', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#login-msg', box);
      msg.textContent = 'ログイン中…';
      try {
        await cloud.signIn($('#login-email', box).value.trim(), $('#login-pass', box).value);
        renderSyncBox(sheet);
        renderTokenBoxes(sheet);
        toast('ログインしました');
      } catch (err) {
        msg.textContent = err.message;
      }
    });
    return;
  }
  const label = { idle: '同期済み', syncing: '同期中…', offline: 'オフライン（つながったら送信）', error: '同期エラー' }[s.state] || s.state;
  box.innerHTML = `
    <div class="sync-info">
      <div>ログイン中: <b>${esc(s.email || '')}</b></div>
      <div>状態: ${esc(label)} ／ 最終同期: ${esc(fmtTime(s.lastSyncAt))}</div>
      ${s.state === 'error' && s.message ? `<div class="err">${esc(s.message)}</div>` : ''}
    </div>
    <div class="sync-actions">
      <button class="btn small" data-act="sync-now">今すぐ同期</button>
      <button class="btn small" data-act="logout">ログアウト</button>
    </div>`;
}

// ---- 外部連携用のキー（iPhone ショートカット・カレンダー購読） ----
const DOCS = 'https://github.com/ramajesty/tasklist/blob/main/docs/';
const copyRow = (id, label, value) => `
  <label class="copy-row"><span>${label}</span>
    <span class="copy-line"><input id="${id}" readonly value="${esc(value)}"><button class="btn small" type="button" data-act="copy" data-target="${id}">コピー</button></span>
  </label>`;
const TOKEN_UI = {
  shortcut: {
    box: '#shortcut-box',
    about: '共有メニューや音声からタスクを追加するショートカットで使います。',
    none: 'まだキーがありません。', has: 'キー発行済み',
    issue: 'キーを発行する', reissue: 'キーを作り直す',
    confirm: 'キーを作り直しますか？\n古いキーを入れたショートカットは使えなくなります（新しいキーに入れ替えが必要）。',
    shown: (token) => `
      <p class="hint"><b>キーを発行しました。</b>このキーは今だけ表示されます。ショートカットの設定が終わるまでこの画面を閉じないでください（閉じたら作り直せば大丈夫です）。</p>
      ${copyRow('sc-url', '送信先URL', cloud.shortcutEndpoint())}
      ${copyRow('sc-token', 'キー（token）', token)}
      <p class="hint">設定のしかたは <a href="${DOCS}${encodeURIComponent('iPhoneショートカット設定.md')}" target="_blank" rel="noopener">ショートカット設定ガイド</a> を見てください。</p>`,
  },
  feed: {
    box: '#feed-box',
    about: '未完了タスクの期限日を、Googleカレンダーや Outlook に終日の予定として表示します（表示のみ）。',
    none: 'まだ購読URLがありません。', has: '購読URL発行済み',
    issue: '購読URLを発行する', reissue: '購読URLを作り直す',
    confirm: '購読URLを作り直しますか？\n古いURLで購読しているカレンダーには表示されなくなります（新しいURLで購読し直しが必要）。',
    shown: (token) => `
      <p class="hint"><b>購読URLを発行しました。</b>このURLは今だけ表示されます。カレンダーに登録し終わるまでこの画面を閉じないでください（閉じたら作り直せば大丈夫です）。</p>
      ${copyRow('feed-url', '購読URL', cloud.feedUrl(token))}
      <p class="hint">登録のしかたは <a href="${DOCS}${encodeURIComponent('カレンダー購読設定.md')}" target="_blank" rel="noopener">カレンダー購読ガイド</a> を見てください。このURLを知っている人は誰でもタスクを見られるので、人に教えないでください。</p>`,
  },
};

function renderTokenBoxes(sheet) {
  for (const kind of Object.keys(TOKEN_UI)) renderTokenBox(sheet, kind);
}

async function renderTokenBox(sheet, kind, newToken = null) {
  const ui = TOKEN_UI[kind];
  const box = $(ui.box, sheet);
  if (!box) return;
  const s = cloud.status;
  if (s.state === 'off' || s.state === 'signed-out') {
    box.innerHTML = '<p class="hint">同期にログインすると使えます。</p>';
    return;
  }
  if (newToken) { box.innerHTML = ui.shown(newToken); return; }
  box.innerHTML = '<p class="hint">確認中…</p>';
  try {
    const at = await cloud.getTokenInfo(kind);
    box.innerHTML = `
      <p class="hint">${at ? `${ui.has}（${esc(fmtTime(at))}）。` : ui.none}${ui.about}</p>
      <button class="btn small" data-act="issue-token" data-kind="${kind}" ${at ? 'data-has="1"' : ''}>${at ? ui.reissue : ui.issue}</button>`;
  } catch (err) {
    box.innerHTML = `<p class="hint err">${esc(err.message)}</p>`;
  }
}

// ショートカットで追加された「URLだけ」のタスクに、動画タイトルを入れる
let fillingTitles = false;
async function fillTitles() {
  if (fillingTitles || !navigator.onLine) return;
  fillingTitles = true;
  try {
    let changed = false;
    for (const t of live().filter((x) => x.needsTitle)) {
      const url = (t.memo || '').match(/https?:\/\/\S+/)?.[0];
      let title = null;
      if (url && /(youtube\.com|youtu\.be)/i.test(url)) {
        try {
          const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url));
          if (r.ok) title = (await r.json()).title || null;
          else if (r.status >= 500) continue; // 一時的なエラー → 次回また試す
        } catch { continue; } // 通信エラー → 次回また試す
      }
      const cur = findTask(t.id);
      if (!cur || !cur.needsTitle) continue;
      if (title && cur.title === url) cur.title = title;
      delete cur.needsTitle;
      await saveTask(cur);
      changed = true;
    }
    if (changed) render();
  } finally {
    fillingTitles = false;
  }
}

function renderSyncPill(s) {
  const pill = $('#sync-status');
  const map = {
    syncing: ['同期中…', 'syncing'],
    offline: ['オフライン', 'offline'],
    error: ['同期エラー', 'error'],
    'signed-out': ['未ログイン', 'offline'],
    idle: ['同期済み', 'ok'],
  };
  const v = map[s.state];
  pill.hidden = !v;
  if (v) {
    pill.textContent = v[0];
    pill.className = `sync-pill ${v[1]}`;
    pill.title = s.lastSyncAt ? `最終同期: ${fmtTime(s.lastSyncAt)}` : '';
  }
  const box = $('#sync-box');
  if (box && !box.querySelector('#login-form')) renderSyncBox(document);
}

// ---- 完了済み一覧 ----
function openDoneList() {
  const sheet = openSheet(`
    <header class="sheet-header">
      <button class="text-btn" data-act="back">戻る</button>
      <h2>完了済み</h2>
      <span></span>
    </header>
    <div class="sheet-body"><ul class="done-list" id="done-list"></ul></div>`, closeSheet);

  const draw = () => {
    const done = live().filter((t) => t.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
    $('#done-list', sheet).innerHTML = done.length ? done.map((t) => `
      <li data-id="${esc(t.id)}">
        <div class="done-body">
          <div class="title">${esc(t.title)}</div>
          <div class="meta">完了: ${esc(new Date(t.doneAt).toLocaleDateString('ja-JP'))}${t.due ? ` ／ 期限: ${esc(shortDate(t.due))}` : ''}</div>
        </div>
        <button class="btn small" data-act="restore">戻す</button>
        <button class="btn small danger" data-act="delete">削除</button>
      </li>`).join('') : '<li class="empty">完了済みのタスクはありません</li>';
  };
  sheet.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'back') { openMenu(); return; }
    const id = e.target.closest('li[data-id]')?.dataset.id;
    const t = id && findTask(id);
    if (!t) return;
    if (act === 'restore') {
      await setDone(t, false);
      draw();
      render();
      toast(`「${t.title}」を未完了に戻しました`);
    } else if (act === 'delete') {
      if (!confirm(`「${t.title}」を削除しますか？（元に戻せません）`)) return;
      await db.deleteImagesByTask(t.id);
      t.deletedAt = nowIso();
      t.images = [];
      await saveTask(t);
      draw();
      render();
    }
  });
  draw();
}

// ---------------------------------------------------------------------------
// イベント
// ---------------------------------------------------------------------------
function bindEvents() {
  // 一覧の操作
  $('#list').addEventListener('click', async (e) => {
    const li = e.target.closest('.task');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!li || !act || li.classList.contains('completing')) return;
    const t = findTask(li.dataset.id);
    if (!t) return;

    if (act === 'toggle-done') {
      if (t.done) {
        await setDone(t, false);
        render();
        return;
      }
      li.classList.add('completing');
      await new Promise((r) => setTimeout(r, 350));
      const rep = t.repeat ? await completeRepeating(t) : null;
      if (rep) {
        render();
        toast(`「${t.title}」完了 → 次回 ${shortDate(rep.next)}`, '元に戻す', async () => {
          await rep.undo();
          render();
        });
        return;
      }
      await setDone(t, true);
      render();
      toast(`「${t.title}」を完了`, '元に戻す', async () => {
        await setDone(t, false);
        state.flashId = t.id;
        render();
      });
    } else if (act === 'toggle-prio') {
      t.priority = !t.priority;
      await saveTask(t);
      render();
    } else if (act === 'edit') {
      openEditor(t);
    }
  });
  $('#list').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.body')) e.target.click();
  });

  // 表示切替
  $('#views').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    state.view = b.dataset.view;
    pref.set('view', state.view);
    if (state.query) closeSearch();
    render();
  });

  // タグ絞り込み
  $('#tag-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    state.tag = b.dataset.tag || null;
    pref.set('tag', state.tag);
    render();
  });

  // クイック追加（今日期限）
  $('#quick-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#quick-input');
    const { title, tags } = parseQuickInput(input.value);
    if (!title) return;
    if (state.tag && !tags.includes(state.tag)) tags.push(state.tag);
    const t = newTask({ title, tags, due: ymd() });
    await saveTask(t);
    input.value = '';
    state.flashId = t.id;
    render();
    toast('追加しました（今日期限）');
  });
  $('#btn-detail-add').addEventListener('click', () => openEditor(null));

  // 検索
  $('#btn-search').addEventListener('click', () => ($('#search-bar').hidden ? openSearch() : closeSearch()));
  $('#search-close').addEventListener('click', closeSearch);
  $('#search-input').addEventListener('input', (e) => { state.query = e.target.value; render(); });

  // メニュー
  $('#btn-menu').addEventListener('click', openMenu);
  $('#sync-status').addEventListener('click', openMenu);

  // キーボード（PC用）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('.viewer')) { $('.viewer').remove(); return; }
      if (sheetOnClose) { sheetOnClose(); return; }
      if (!$('#search-bar').hidden) closeSearch();
      return;
    }
    if (sheetOnClose || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); $('#quick-input').focus(); }
    else if (e.key === '/') { e.preventDefault(); openSearch(); }
  });

  // 日付が変わったら再描画（開きっぱなし対策）
  const refreshIfNewDay = () => { if (ymd() !== state.today) render(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfNewDay(); });
  setInterval(refreshIfNewDay, 60 * 1000);
}

function openSearch() {
  $('#search-bar').hidden = false;
  $('#search-input').focus();
}
function closeSearch() {
  $('#search-bar').hidden = true;
  $('#search-input').value = '';
  state.query = '';
  render();
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
async function init() {
  state.tasks = await db.getAllTasks();
  await loadCalendar();
  bindEvents();
  render();

  // クラウド同期（未設定なら何もしない）
  cloud.setOnRemoteChange(async () => {
    state.tasks = await db.getAllTasks();
    await loadCalendar();
    render();
    fillTitles();
  });
  cloud.onStatus(renderSyncPill);
  fillTitles();
  cloud.initSync().catch((err) => console.error(err));

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  // ブラウザにデータを勝手に消されないよう保護を依頼（iPhoneはホーム画面に追加すると有効）
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin', `<div class="fatal">起動できませんでした: ${esc(err.message)}</div>`);
});
