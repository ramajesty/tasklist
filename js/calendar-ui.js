// 会社カレンダーの設定画面
import { getCalendar, saveCalendar, isWorkday, workdaysInMonth, daysInMonth } from './recur.js';
import { jpHolidays, jpHolidayName } from './holidays-jp.js';
import { ymd, parseYmd, addDays, escapeHtml as esc } from './util.js';

const WD = '日月火水木金土';
const pad = (n) => String(n).padStart(2, '0');
const mk = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

export function openCalendarSettings({ openSheet, onBack, toast }) {
  const now = parseYmd(ymd());
  let y = now.getFullYear();
  let m = now.getMonth() + 1;

  const sheet = openSheet(`
    <header class="sheet-header">
      <button class="text-btn" data-act="back">戻る</button>
      <h2>会社カレンダー</h2>
      <span></span>
    </header>
    <div class="sheet-body cal-settings" id="cal-body"></div>`, onBack);
  const body = sheet.querySelector('#cal-body');

  const draw = () => {
    const c = getCalendar();
    const today = ymd();
    const hol = jpHolidays(y);
    const first = new Date(y, m - 1, 1).getDay();
    const cells = [];
    for (let i = 0; i < first; i++) cells.push('<div class="cal-day blank"></div>');
    for (let d = 1; d <= daysInMonth(y, m); d++) {
      const s = mk(y, m, d);
      const work = isWorkday(s);
      const name = hol.get(s);
      const custom = c.holidays.includes(s) || c.workdays.includes(s);
      const dow = new Date(y, m - 1, d).getDay();
      cells.push(`
        <button class="cal-day ${work ? 'work' : 'off'} ${custom ? 'custom' : ''} ${s === today ? 'today' : ''} dow${dow}"
          data-date="${s}" aria-label="${m}月${d}日 ${work ? '出勤' : '休み'}${name ? ' ' + name : ''}">
          <span class="d">${d}</span>${name ? `<span class="hn">${esc(name)}</span>` : ''}
        </button>`);
    }

    body.innerHTML = `
      <p class="hint">日付をタップすると「休み ⇔ 出勤」が切り替わります。変更はすぐ保存されます。</p>

      <div class="field">
        <label>毎週の休み</label>
        <div class="chips">${[1, 2, 3, 4, 5, 6, 0].map((i) =>
          `<button type="button" class="chip ${c.weeklyOff.includes(i) ? 'on' : ''}" data-wk="${i}">${WD[i]}</button>`).join('')}</div>
      </div>

      <div class="cal-nav">
        <button type="button" class="icon-btn" data-nav="-1" aria-label="前の月">‹</button>
        <div class="cal-title">${y}年${m}月<span class="sub">稼働日 ${workdaysInMonth(y, m).length}日</span></div>
        <button type="button" class="icon-btn" data-nav="1" aria-label="次の月">›</button>
      </div>
      <div class="cal-grid">
        ${[...WD].map((w, i) => `<div class="cal-h dow${i}">${w}</div>`).join('')}
        ${cells.join('')}
      </div>
      <div class="cal-legend">
        <span><i class="lg work"></i>出勤</span>
        <span><i class="lg off"></i>休み</span>
        <span><i class="lg custom"></i>個別に設定した日</span>
      </div>

      <h3>まとめて設定（${y}年）</h3>
      <button type="button" class="menu-item" data-bulk="holidays">🎌 ${y}年の祝日をすべて休みにする</button>
      <div class="menu-item range">
        <span>期間を休みに</span>
        <input type="date" id="r-from" value="${y}-12-29">
        <span>〜</span>
        <input type="date" id="r-to" value="${y + 1}-01-03">
        <button type="button" class="btn small" data-bulk="range">休みにする</button>
      </div>
      <button type="button" class="menu-item" data-bulk="copy">📋 ${y - 1}年の設定を${y}年にコピー</button>
      <button type="button" class="menu-item" data-bulk="clear">🧹 ${y}年の個別設定をクリア</button>
      <p class="hint">祝日は自動では休みになりません。「祝日をすべて休みにする」→ 出勤する祝日だけタップで戻す、が簡単です。<br>
      コピーは「休み」の設定が対象です。祝日は同じ名前の祝日へ、それ以外は同じ月日へ写します（土曜出勤などの出勤日はコピーされません）。<br>
      カレンダーを変えても、すでに設定済みの期限日は変わりません（次に完了したときの計算から反映）。</p>`;
  };

  const update = async (fn) => {
    const c = getCalendar();
    const msg = fn(c);
    if (msg === false) return;
    await saveCalendar(c);
    draw();
    if (msg) toast(msg);
  };

  const setOff = (c, s) => {
    c.workdays = c.workdays.filter((x) => x !== s);
    if (!c.holidays.includes(s)) c.holidays.push(s);
  };

  body.addEventListener('click', (e) => {
    const day = e.target.closest('[data-date]');
    if (day) {
      const s = day.dataset.date;
      update((c) => {
        if (isWorkday(s)) {
          // 出勤 → 休み
          if (c.workdays.includes(s)) c.workdays = c.workdays.filter((x) => x !== s);
          else c.holidays.push(s);
        } else {
          // 休み → 出勤
          c.holidays = c.holidays.filter((x) => x !== s);
          if (c.weeklyOff.includes(parseYmd(s).getDay())) c.workdays.push(s);
        }
      });
      return;
    }

    const wk = e.target.closest('[data-wk]');
    if (wk) {
      const i = Number(wk.dataset.wk);
      update((c) => { c.weeklyOff = c.weeklyOff.includes(i) ? c.weeklyOff.filter((x) => x !== i) : [...c.weeklyOff, i]; });
      return;
    }

    const nav = e.target.closest('[data-nav]');
    if (nav) {
      m += Number(nav.dataset.nav);
      if (m < 1) { m = 12; y--; }
      if (m > 12) { m = 1; y++; }
      draw();
      return;
    }

    const bulk = e.target.closest('[data-bulk]')?.dataset.bulk;
    if (bulk === 'holidays') {
      update((c) => {
        const days = [...jpHolidays(y).keys()];
        days.forEach((s) => setOff(c, s));
        return `${y}年の祝日 ${days.length}日を休みにしました`;
      });
    } else if (bulk === 'range') {
      const from = body.querySelector('#r-from').value;
      const to = body.querySelector('#r-to').value;
      if (!from || !to || from > to) { alert('期間を正しく入力してください'); return; }
      update((c) => {
        let n = 0;
        for (let s = from; s <= to && n < 400; s = addDays(s, 1), n++) setOff(c, s);
        return `${n}日を休みにしました`;
      });
    } else if (bulk === 'copy') {
      if (!confirm(`${y - 1}年の休みの設定を${y}年にコピーしますか？\n（${y}年の既存の設定は残ります）`)) return;
      update((c) => {
        const target = jpHolidays(y);
        const byName = new Map([...target].map(([s, n]) => [n, s]));
        const mapDate = (s) => {
          const name = jpHolidayName(s);
          if (name === '振替休日' || name === '国民の休日') return null; // 下でコピー先の年の分を反映
          if (name) return byName.get(name) || null;
          const md = s.slice(5);
          const t = `${y}-${md}`;
          return md === '02-29' && daysInMonth(y, 2) === 28 ? null : t;
        };
        const prefix = `${y - 1}-`;
        let n = 0;
        for (const s of c.holidays.filter((x) => x.startsWith(prefix))) {
          const t = mapDate(s);
          if (t) { setOff(c, t); n++; }
        }
        // 振替休日・国民の休日は、コピー先の年の分をそのまま反映
        if (c.holidays.some((x) => x.startsWith(prefix) && ['振替休日', '国民の休日'].includes(jpHolidayName(x)))) {
          for (const [s, name] of target) if (name === '振替休日' || name === '国民の休日') setOff(c, s);
        }
        // 土曜出勤などの個別の出勤日は、年が変わると曜日がずれるのでコピーしない
        if (!n) { alert(`${y - 1}年の個別設定がありません`); return false; }
        return `${n}日分をコピーしました`;
      });
    } else if (bulk === 'clear') {
      if (!confirm(`${y}年の個別設定（休み・出勤）をすべて消しますか？`)) return;
      update((c) => {
        const p = `${y}-`;
        c.holidays = c.holidays.filter((x) => !x.startsWith(p));
        c.workdays = c.workdays.filter((x) => !x.startsWith(p));
        return `${y}年の個別設定をクリアしました`;
      });
    }
  });

  sheet.querySelector('[data-act="back"]').addEventListener('click', onBack);
  draw();
}
