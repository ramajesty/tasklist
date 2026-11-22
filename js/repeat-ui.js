// 編集画面の「繰り返し」欄
import { firstOccurrenceFrom, nextOccurrence } from './recur.js';
import { ymd, parseYmd, shortDate, escapeHtml as esc } from './util.js';

const WD = '日月火水木金土';
const TYPES = [
  ['', 'なし'],
  ['days', '毎日 / ◯日ごと'],
  ['weekly', '毎週（曜日を選ぶ）'],
  ['monthly-day', '毎月 ◯日'],
  ['monthly-weekday', '毎月 第◯ ◯曜日'],
  ['workday-nth', '毎月 第◯稼働日'],
  ['workday-last', '毎月 最終稼働日（からN稼働日前）'],
  ['yearly', '毎年 ◯月◯日'],
];

export function repeatFieldHtml(rep) {
  return `
    <div class="field">
      <label for="r-type">繰り返し</label>
      <select id="r-type" class="select">
        ${TYPES.map(([v, l]) => `<option value="${v}" ${(rep?.type || '') === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <div id="r-opts" class="repeat-opts"></div>
      <p class="hint" id="r-preview"></p>
    </div>`;
}

// 期限日を基に、種類を選んだときの初期値を作る
function defaults(type, due) {
  const d = parseYmd(due || ymd());
  switch (type) {
    case 'days': return { type, n: 1 };
    case 'weekly': return { type, days: [d.getDay()] };
    case 'monthly-day': return { type, day: d.getDate() };
    case 'monthly-weekday': return { type, n: Math.min(4, Math.ceil(d.getDate() / 7)), dow: d.getDay() };
    case 'workday-nth': return { type, n: 1 };
    case 'workday-last': return { type, n: 0 };
    case 'yearly': return { type, month: d.getMonth() + 1, day: d.getDate() };
    default: return null;
  }
}

const options = (from, to, sel, label = (v) => v) => {
  let s = '';
  for (let v = from; v <= to; v++) s += `<option value="${v}" ${Number(sel) === v ? 'selected' : ''}>${label(v)}</option>`;
  return s;
};

function optsHtml(rep) {
  if (!rep) return '';
  switch (rep.type) {
    case 'days':
      return `<input type="number" id="r-n" min="1" max="365" value="${rep.n}" class="num"> 日ごと`;
    case 'weekly':
      return `<div class="chips">${[1, 2, 3, 4, 5, 6, 0].map((i) =>
        `<button type="button" class="chip ${rep.days.includes(i) ? 'on' : ''}" data-rdow="${i}">${WD[i]}</button>`).join('')}</div>`;
    case 'monthly-day':
      return `毎月 <select id="r-day" class="select">${options(1, 31, rep.day, (v) => `${v}日`)}
        <option value="last" ${rep.day === 'last' ? 'selected' : ''}>末日</option></select>
        <span class="hint-inline">（その日がない月は末日）</span>`;
    case 'monthly-weekday':
      return `毎月 <select id="r-n" class="select">${options(1, 4, rep.n, (v) => `第${v}`)}
        <option value="-1" ${Number(rep.n) === -1 ? 'selected' : ''}>最終</option></select>
        <select id="r-dow" class="select">${[...WD].map((w, i) => `<option value="${i}" ${Number(rep.dow) === i ? 'selected' : ''}>${w}曜日</option>`).join('')}</select>`;
    case 'workday-nth':
      return `毎月 第 <input type="number" id="r-n" min="1" max="23" value="${rep.n}" class="num"> 稼働日`;
    case 'workday-last':
      return `毎月 最終稼働日の <input type="number" id="r-n" min="0" max="20" value="${rep.n}" class="num"> 稼働日前
        <span class="hint-inline">（0 = 最終稼働日）</span>`;
    case 'yearly':
      return `毎年 <select id="r-month" class="select">${options(1, 12, rep.month, (v) => `${v}月`)}</select>
        <select id="r-day" class="select">${options(1, 31, rep.day, (v) => `${v}日`)}</select>`;
    default:
      return '';
  }
}

// root: 編集シート / getDue: 現在の期限日 / onChange(rep): 設定が変わったとき
export function bindRepeatField(root, initial, getDue, onChange) {
  let rep = initial ? JSON.parse(JSON.stringify(initial)) : null;
  const typeEl = root.querySelector('#r-type');
  const optsEl = root.querySelector('#r-opts');
  const previewEl = root.querySelector('#r-preview');

  const preview = () => {
    if (!rep) { previewEl.textContent = ''; return; }
    const dates = [];
    let s = firstOccurrenceFrom(rep, ymd());
    for (let i = 0; i < 4 && s; i++) { dates.push(shortDate(s)); s = nextOccurrence(rep, s); }
    const wd = rep.type.startsWith('workday') ? '（会社カレンダー基準）' : '';
    previewEl.innerHTML = dates.length
      ? `今後の日付${wd}: ${esc(dates.join('、'))}<br>完了すると、次の日付で自動的に復活します。`
      : '該当する日がありません。設定を確認してください。';
  };

  const drawOpts = () => { optsEl.innerHTML = optsHtml(rep); preview(); };

  const changed = () => { preview(); onChange(rep); };

  typeEl.addEventListener('change', () => {
    rep = defaults(typeEl.value, getDue());
    drawOpts();
    onChange(rep);
  });

  optsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rdow]');
    if (!b) return;
    const i = Number(b.dataset.rdow);
    const days = rep.days.includes(i) ? rep.days.filter((x) => x !== i) : [...rep.days, i];
    if (!days.length) return; // 最低1つは残す
    rep.days = days;
    drawOpts();
    onChange(rep);
  });

  const readInputs = () => {
    const v = (id) => optsEl.querySelector(id)?.value;
    switch (rep.type) {
      case 'days': rep.n = Math.max(1, Number(v('#r-n')) || 1); break;
      case 'monthly-day': rep.day = v('#r-day') === 'last' ? 'last' : Number(v('#r-day')); break;
      case 'monthly-weekday': rep.n = Number(v('#r-n')); rep.dow = Number(v('#r-dow')); break;
      case 'workday-nth': rep.n = Math.min(23, Math.max(1, Number(v('#r-n')) || 1)); break;
      case 'workday-last': rep.n = Math.min(20, Math.max(0, Number(v('#r-n')) || 0)); break;
      case 'yearly': rep.month = Number(v('#r-month')); rep.day = Number(v('#r-day')); break;
    }
    changed();
  };
  optsEl.addEventListener('change', readInputs);
  optsEl.addEventListener('input', (e) => { if (e.target.matches('input[type="number"]') && e.target.value !== '') readInputs(); });

  drawOpts();
  return { get: () => (rep ? JSON.parse(JSON.stringify(rep)) : null) };
}
