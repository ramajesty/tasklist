// クラウド同期（Supabase）
// 方針: 端末内（IndexedDB）が正本。変更は端末に保存してから、ネットにつながっていればクラウドへ送る。
//   - タスク: 端末で変更したものに _dirty 印を付けて送信。受信は前回以降にサーバーに届いた分だけ。
//   - 同じタスクを2台で編集したら、編集日時が新しい方を採用。
//   - 画像: Storage の images/<ユーザーID>/<画像ID> に保存。足りない画像は受信時にダウンロード。
//   - 会社カレンダー: settings テーブルに保存（新しい方を採用）。
import * as db from './db.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const BUCKET = 'images';
let sb = null;
let running = null;
let again = false;
let timer = null;
const listeners = new Set();

export const status = { state: 'off', lastSyncAt: null, message: '', email: null };

function setStatus(patch) {
  Object.assign(status, patch);
  for (const fn of listeners) fn(status);
}
export const onStatus = (fn) => { listeners.add(fn); fn(status); };

// 受信でデータが変わったときに呼ぶ（app.js が再読み込みする）
let onRemoteChange = () => {};
export const setOnRemoteChange = (fn) => { onRemoteChange = fn; };

export const isConfigured = () => !!(SUPABASE_URL && SUPABASE_KEY && window.supabase);

function client() {
  if (!sb && isConfigured()) {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'tl-auth' },
    });
  }
  return sb;
}

export async function getUser() {
  const c = client();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  return data.session?.user ?? null;
}

export async function signIn(email, password) {
  const c = client();
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message === 'Invalid login credentials' ? 'メールアドレスかパスワードが違います' : error.message);
  await refreshUserStatus();
  await sync();
}

export async function signOut() {
  const c = client();
  if (c) await c.auth.signOut();
  setStatus({ state: 'signed-out', email: null, message: '' });
}

async function refreshUserStatus() {
  if (!isConfigured()) { setStatus({ state: 'off' }); return null; }
  const user = await getUser();
  if (!user) setStatus({ state: 'signed-out', email: null });
  else setStatus({ email: user.email, state: status.state === 'off' || status.state === 'signed-out' ? 'idle' : status.state });
  return user;
}

// ---------------------------------------------------------------------------
// iPhone ショートカット用のキー（サーバーにはハッシュだけ保存）
// ---------------------------------------------------------------------------
export const shortcutEndpoint = () => `${SUPABASE_URL}/rest/v1/rpc/quick_add?apikey=${SUPABASE_KEY}`;

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 発行済みなら発行日時、未発行なら null
export async function getShortcutTokenInfo() {
  const c = client();
  const user = await getUser();
  if (!c || !user) return null;
  const { data, error } = await c.from('shortcut_tokens').select('created_at').eq('user_id', user.id).maybeSingle();
  if (error) throw new Error(error.code === 'PGRST205' ? 'サーバー側の準備（shortcut.sql の実行）がまだです' : error.message);
  return data?.created_at ?? null;
}

// 新しいキーを発行（古いキーは使えなくなる）。キー本体はこの1回だけ返す
export async function issueShortcutToken() {
  const c = client();
  const user = await getUser();
  if (!c || !user) throw new Error('ログインしてください');
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const { error } = await c.from('shortcut_tokens').upsert({
    user_id: user.id, token_hash: await sha256Hex(token), created_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.code === 'PGRST205' ? 'サーバー側の準備（shortcut.sql の実行）がまだです' : error.message);
  return token;
}

// ---------------------------------------------------------------------------
// 起動時の準備: 変更の監視・定期同期
// ---------------------------------------------------------------------------
export async function initSync() {
  if (!isConfigured()) { setStatus({ state: 'off' }); return; }
  setStatus({ lastSyncAt: await db.getMeta('lastSyncAt') });
  await refreshUserStatus();

  window.addEventListener('tl:local-change', () => requestSync());
  window.addEventListener('online', () => sync());
  window.addEventListener('offline', () => setStatus({ state: 'offline' }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
  setInterval(() => { if (!document.hidden) sync(); }, 60 * 1000);
  sync();
}

// 変更直後は少し待ってからまとめて送る
export function requestSync() {
  clearTimeout(timer);
  timer = setTimeout(() => sync(), 1500);
}

export function sync() {
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      await doSync();
    } catch (err) {
      console.error('sync error', err);
      setStatus({ state: navigator.onLine ? 'error' : 'offline', message: err?.message || String(err) });
    } finally {
      running = null;
      if (again) { again = false; sync(); }
    }
  })();
  return running;
}

const ts = (s) => (s ? Date.parse(s) : 0);
const stripLocal = (t) => { const { _dirty, ...rest } = t; return rest; };

async function doSync() {
  const c = client();
  if (!c) return;
  const user = await getUser();
  if (!user) { setStatus({ state: 'signed-out' }); return; }
  if (!navigator.onLine) { setStatus({ state: 'offline' }); return; }
  setStatus({ state: 'syncing', email: user.email, message: '' });

  // 初めてこのアカウントで同期する端末: 手元のデータを全部送る
  if ((await db.getMeta('syncUser')) !== user.id) {
    for (const t of await db.getAllTasks()) { t._dirty = true; await db.putTask(t); }
    for (const img of await db.getAllImages()) { if (img.uploaded) { img.uploaded = false; await db.putImage(img); } }
    await db.setMeta('lastPull', null);
    await db.setMeta('calendarDirty', !!(await db.getMeta('calendar')));
    await db.setMeta('syncUser', user.id);
  }

  let changed = false;
  await pushImages(c, user);
  await pushTasks(c);
  await pushImageDeletes(c, user);
  changed = (await pullTasks(c)) || changed;
  changed = (await pullImages(c, user)) || changed;
  changed = (await syncCalendar(c, user)) || changed;

  const now = new Date().toISOString();
  await db.setMeta('lastSyncAt', now);
  setStatus({ state: 'idle', lastSyncAt: now, message: '' });
  if (changed) onRemoteChange();
}

// ---- タスク送信 ----
async function pushTasks(c) {
  const dirty = (await db.getAllTasks()).filter((t) => t._dirty);
  for (let i = 0; i < dirty.length; i += 200) {
    const chunk = dirty.slice(i, i + 200);
    const rows = chunk.map((t) => ({ id: t.id, data: stripLocal(t), updated_at: t.updatedAt }));
    const { error } = await c.rpc('push_tasks', { rows });
    if (error) throw error;
    // 送信中に再編集されていなければ印を外す
    for (const t of chunk) {
      const cur = await db.getTask(t.id);
      if (cur && cur.updatedAt === t.updatedAt && cur._dirty) {
        delete cur._dirty;
        await db.putTask(cur);
      }
    }
  }
}

// ---- タスク受信（前回以降にサーバーへ届いた分） ----
async function pullTasks(c) {
  const since = await db.getMeta('lastPull');
  // 取りこぼし防止に1分重ねて取る（同じデータは上書きしても問題ない）
  const from = since ? new Date(ts(since) - 60 * 1000).toISOString() : null;
  let changed = false;
  let latest = since;
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    let q = c.from('tasks').select('id,data,updated_at,server_updated_at')
      .order('server_updated_at', { ascending: true }).range(offset, offset + PAGE - 1);
    if (from) q = q.gt('server_updated_at', from);
    const { data, error } = await q;
    if (error) throw error;
    for (const row of data) {
      const local = await db.getTask(row.id);
      const remoteNewer = !local || ts(row.updated_at) > ts(local.updatedAt);
      if (remoteNewer) {
        await db.putTask({ ...row.data, id: row.id });
        changed = true;
      }
      if (!latest || ts(row.server_updated_at) > ts(latest)) latest = row.server_updated_at;
    }
    if (data.length < PAGE) break;
  }
  if (latest) await db.setMeta('lastPull', latest);
  return changed;
}

// ---- 画像 ----
const imagePath = (user, id) => `${user.id}/${id}`;

async function pushImages(c, user) {
  for (const img of await db.getAllImages()) {
    if (img.uploaded) continue;
    const { error } = await c.storage.from(BUCKET).upload(imagePath(user, img.id), img.blob, {
      upsert: true, contentType: img.blob.type || 'image/jpeg',
    });
    if (error) throw error;
    const cur = await db.getImage(img.id);
    if (cur) { cur.uploaded = true; await db.putImage(cur); }
  }
}

async function pushImageDeletes(c, user) {
  const ids = (await db.getMeta('imageDeletes')) || [];
  if (!ids.length) return;
  const { error } = await c.storage.from(BUCKET).remove(ids.map((id) => imagePath(user, id)));
  if (error) throw error;
  const rest = ((await db.getMeta('imageDeletes')) || []).filter((id) => !ids.includes(id));
  await db.setMeta('imageDeletes', rest);
}

// タスクが参照しているのに手元にない画像をダウンロード
async function pullImages(c, user) {
  const have = new Set(await db.getAllImageIds());
  const deleted = new Set((await db.getMeta('imageDeletes')) || []);
  let changed = false;
  for (const t of await db.getAllTasks()) {
    if (t.deletedAt) continue;
    for (const id of t.images || []) {
      if (have.has(id) || deleted.has(id)) continue;
      const { data, error } = await c.storage.from(BUCKET).download(imagePath(user, id));
      if (error || !data) continue; // まだ届いていない → 次回また試す
      await db.putImage({ id, taskId: t.id, blob: data, createdAt: new Date().toISOString(), uploaded: true });
      have.add(id);
      changed = true;
    }
  }
  return changed;
}

// ---- 会社カレンダー ----
async function syncCalendar(c, user) {
  const { data, error } = await c.from('settings').select('calendar,updated_at').eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  const localCal = await db.getMeta('calendar');
  const localAt = await db.getMeta('calendarUpdatedAt');
  const dirty = await db.getMeta('calendarDirty');

  if (data && data.calendar && (!localCal || ts(data.updated_at) > ts(localAt))) {
    await db.setMeta('calendar', data.calendar);
    await db.setMeta('calendarUpdatedAt', data.updated_at);
    await db.setMeta('calendarDirty', false);
    return true;
  }
  if (localCal && (dirty || !data)) {
    const updated_at = localAt || new Date().toISOString();
    const { error: e2 } = await c.from('settings').upsert({ user_id: user.id, calendar: localCal, updated_at });
    if (e2) throw e2;
    await db.setMeta('calendarDirty', false);
  }
  return false;
}
