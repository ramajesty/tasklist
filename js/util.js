// 日付・文字列などの共通処理

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] % 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export const nowIso = () => new Date().toISOString();

// ---- 日付（YYYY-MM-DD 文字列で扱う。端末のローカル日付） ----
export function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
// 今週の日曜日（週は月曜始まり）
export function endOfWeek(s) {
  const d = parseYmd(s);
  const dow = d.getDay();
  d.setDate(d.getDate() + (dow === 0 ? 0 : 7 - dow));
  return ymd(d);
}

const WD = '日月火水木金土';
export function shortDate(s) {
  const d = parseYmd(s);
  const thisYear = new Date().getFullYear();
  const base = `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  return d.getFullYear() === thisYear ? base : `${d.getFullYear()}/${base}`;
}

// 期限日の見出しラベル
export function dueLabel(s, today) {
  if (!s) return '期限なし';
  if (s === today) return '今日';
  if (s === addDays(today, 1)) return '明日';
  return shortDate(s);
}

// ---- 並び順: 期限日昇順 → 優先ON → 作成順（期限なしは最後） ----
export function compareTasks(a, b) {
  const da = a.due || '9999-12-31';
  const dbb = b.due || '9999-12-31';
  if (da !== dbb) return da < dbb ? -1 : 1;
  if (!!a.priority !== !!b.priority) return a.priority ? -1 : 1;
  return (a.createdAt || '').localeCompare(b.createdAt || '');
}

// ---- 文字列 ----
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// メモ内のURLをリンク化。[表示名](URL) 形式にも対応。onenote: スキームも許可。
const LINK_RE = /\[([^\]\n]+)\]\(((?:https?:\/\/|onenote:)[^\s)]+)\)|((?:https?:\/\/|onenote:)[^\s<>"'）」]+)/g;

export function linkify(text) {
  text = text || '';
  let out = '';
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    out += escapeHtml(text.slice(last, m.index));
    let label, url, tail = '';
    if (m[1]) {
      label = m[1];
      url = m[2];
    } else {
      url = m[3];
      const tm = url.match(/[.,;:!?、。]+$/);
      if (tm) { tail = tm[0]; url = url.slice(0, -tail.length); }
      label = prettyUrl(url);
    }
    out += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="link ${linkKind(url)}">${escapeHtml(label)}</a>${escapeHtml(tail)}`;
    last = m.index + m[0].length;
  }
  out += escapeHtml(text.slice(last));
  return out.replace(/\n/g, '<br>');
}

export function linkKind(u) {
  if (/^onenote:/i.test(u) || /onenote/i.test(u)) return 'k-onenote';
  if (/sharepoint\.com/i.test(u)) return 'k-sharepoint';
  if (/(youtube\.com|youtu\.be)/i.test(u)) return 'k-youtube';
  return '';
}

function prettyUrl(u) {
  try {
    const x = new URL(u);
    let s = x.hostname.replace(/^www\./, '') + decodeURIComponent(x.pathname);
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s.length > 48 ? s.slice(0, 45) + '…' : s;
  } catch {
    return u;
  }
}

export const hasLink = (text) => /(https?:\/\/|onenote:)/i.test(text || '');

// クイック追加: 「#タグ」を取り出す
export function parseQuickInput(text) {
  const tags = [];
  const title = text.replace(/(^|\s)[#＃](\S+)/g, (_, sp, tag) => {
    if (!tags.includes(tag)) tags.push(tag);
    return sp;
  }).replace(/\s+/g, ' ').trim();
  return { title, tags };
}

export function matchesQuery(t, q) {
  const hay = `${t.title}\n${t.memo || ''}\n${(t.tags || []).join(' ')}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

// 画像を縮小（長辺1600px・JPEG）。失敗したら元のファイルのまま。
export async function compressImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const max = 1600;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}
