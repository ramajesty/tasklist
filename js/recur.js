// 会社カレンダー（稼働日）と繰り返しの日付計算
import * as db from './db.js';
import { parseYmd, addDays } from './util.js';

// ---------------------------------------------------------------------------
// 会社カレンダー
//   weeklyOff: 毎週休みの曜日（0=日〜6=土）
//   holidays : 休みにする日（祝日・会社休日など）
//   workdays : 休み曜日だけど出勤する日（土曜出勤など）
// ---------------------------------------------------------------------------
const DEFAULT_CAL = { weeklyOff: [0, 6], holidays: [], workdays: [] };
let rawCal = { ...DEFAULT_CAL };
let cal = compile(rawCal);

function compile(r) {
  return { weeklyOff: new Set(r.weeklyOff), holidays: new Set(r.holidays), workdays: new Set(r.workdays) };
}

export async function loadCalendar() {
  const saved = await db.getMeta('calendar');
  rawCal = { ...DEFAULT_CAL, ...(saved || {}) };
  cal = compile(rawCal);
}

export const getCalendar = () => JSON.parse(JSON.stringify(rawCal));

export async function saveCalendar(next) {
  next.weeklyOff = [...new Set(next.weeklyOff)].sort();
  next.holidays = [...new Set(next.holidays)].sort();
  next.workdays = [...new Set(next.workdays)].sort();
  rawCal = next;
  cal = compile(next);
  await db.setMeta('calendar', next);
  await db.setMeta('calendarUpdatedAt', new Date().toISOString());
  await db.setMeta('calendarDirty', true);
  window.dispatchEvent(new Event('tl:local-change'));
}

export function isWorkday(s) {
  if (cal.workdays.has(s)) return true;
  if (cal.holidays.has(s)) return false;
  return !cal.weeklyOff.has(parseYmd(s).getDay());
}

const pad = (n) => String(n).padStart(2, '0');
const mk = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export const daysInMonth = (y, m) => new Date(y, m, 0).getDate(); // m は 1〜12

export function workdaysInMonth(y, m) {
  const out = [];
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    const s = mk(y, m, d);
    if (isWorkday(s)) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 繰り返し
//   { type: 'days', n }                   毎日 / n日ごと
//   { type: 'weekly', days: [1,3] }       毎週 ◯曜
//   { type: 'monthly-day', day }          毎月 ◯日（day='last' で末日）
//   { type: 'monthly-weekday', n, dow }   毎月 第n ◯曜（n=-1 で最終）
//   { type: 'workday-nth', n }            毎月 第n稼働日
//   { type: 'workday-last', n }           毎月 最終稼働日のn稼働日前（n=0 で最終稼働日）
//   { type: 'yearly', month, day }        毎年 ◯月◯日
// ---------------------------------------------------------------------------
function occurrenceInMonth(rep, y, m) {
  switch (rep.type) {
    case 'monthly-day': {
      const day = rep.day === 'last' ? 31 : Number(rep.day);
      return mk(y, m, Math.min(day, daysInMonth(y, m)));
    }
    case 'monthly-weekday': {
      const n = Number(rep.n), dow = Number(rep.dow), last = daysInMonth(y, m);
      if (n === -1) {
        for (let d = last; d >= 1; d--) if (new Date(y, m - 1, d).getDay() === dow) return mk(y, m, d);
      } else {
        let c = 0;
        for (let d = 1; d <= last; d++) if (new Date(y, m - 1, d).getDay() === dow && ++c === n) return mk(y, m, d);
      }
      return null;
    }
    case 'workday-nth': {
      const w = workdaysInMonth(y, m);
      return w[Number(rep.n) - 1] || null;
    }
    case 'workday-last': {
      const w = workdaysInMonth(y, m);
      return w[w.length - 1 - Number(rep.n || 0)] || null;
    }
    case 'yearly':
      return Number(rep.month) === m ? mk(y, m, Math.min(Number(rep.day), daysInMonth(y, m))) : null;
    default:
      return null;
  }
}

// after より後の最初の日付
export function nextOccurrence(rep, after) {
  if (!rep) return null;
  if (rep.type === 'days') return addDays(after, Math.max(1, Number(rep.n) || 1));
  if (rep.type === 'weekly') {
    const days = (rep.days || []).map(Number);
    if (!days.length) return null;
    for (let i = 1; i <= 7; i++) {
      const s = addDays(after, i);
      if (days.includes(parseYmd(s).getDay())) return s;
    }
    return null;
  }
  const a = parseYmd(after);
  let y = a.getFullYear(), m = a.getMonth() + 1;
  for (let i = 0; i < 60; i++) {
    const s = occurrenceInMonth(rep, y, m);
    if (s && s > after) return s;
    if (++m > 12) { m = 1; y++; }
  }
  return null;
}

// from 当日を含めて最初の日付
export function firstOccurrenceFrom(rep, from) {
  if (!rep) return null;
  return rep.type === 'days' ? from : nextOccurrence(rep, addDays(from, -1));
}

// 完了したときの次の期限日
//   日・週単位: 溜まった過去分は飛ばして今日以降へ
//   月・年単位: 1回分ずつ進める（月次業務を飛ばさないため）
export function nextDueOnComplete(task, today) {
  const rep = task.repeat;
  let next = nextOccurrence(rep, task.due || today);
  if (rep.type === 'days' || rep.type === 'weekly') {
    let guard = 0;
    while (next && next < today && guard++ < 2000) next = nextOccurrence(rep, next);
  }
  return next;
}

const WD = '日月火水木金土';
export function describeRepeat(rep) {
  if (!rep) return '';
  switch (rep.type) {
    case 'days': return Number(rep.n) === 1 ? '毎日' : `${rep.n}日ごと`;
    case 'weekly': return '毎週 ' + [...rep.days].map(Number).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WD[d]).join('・');
    case 'monthly-day': return rep.day === 'last' ? '毎月 末日' : `毎月 ${rep.day}日`;
    case 'monthly-weekday': return `毎月 ${Number(rep.n) === -1 ? '最終' : '第' + rep.n}${WD[rep.dow]}曜`;
    case 'workday-nth': return `毎月 第${rep.n}稼働日`;
    case 'workday-last': return Number(rep.n) ? `毎月 最終稼働日の${rep.n}稼働日前` : '毎月 最終稼働日';
    case 'yearly': return `毎年 ${rep.month}/${rep.day}`;
    default: return '';
  }
}
