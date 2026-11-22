// 日本の祝日を計算で求める（現行の祝日法ベース。2020年以降を想定）
// 会社カレンダーの「祝日を一括で休みにする」候補と、カレンダー上の祝日名表示に使う。
const pad = (n) => String(n).padStart(2, '0');
const mk = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// m月の第n月曜日の日付
function nthMonday(y, m, n) {
  const first = new Date(y, m - 1, 1).getDay();
  return 1 + ((8 - first) % 7) + (n - 1) * 7;
}

const cache = new Map();

export function jpHolidays(y) {
  if (cache.has(y)) return cache.get(y);
  const k = y - 1980;
  const spring = Math.floor(20.8431 + 0.242194 * k - Math.floor(k / 4));
  const autumn = Math.floor(23.2488 + 0.242194 * k - Math.floor(k / 4));

  const map = new Map([
    [mk(y, 1, 1), '元日'],
    [mk(y, 1, nthMonday(y, 1, 2)), '成人の日'],
    [mk(y, 2, 11), '建国記念の日'],
    [mk(y, 2, 23), '天皇誕生日'],
    [mk(y, 3, spring), '春分の日'],
    [mk(y, 4, 29), '昭和の日'],
    [mk(y, 5, 3), '憲法記念日'],
    [mk(y, 5, 4), 'みどりの日'],
    [mk(y, 5, 5), 'こどもの日'],
    [mk(y, 7, nthMonday(y, 7, 3)), '海の日'],
    [mk(y, 8, 11), '山の日'],
    [mk(y, 9, nthMonday(y, 9, 3)), '敬老の日'],
    [mk(y, 9, autumn), '秋分の日'],
    [mk(y, 10, nthMonday(y, 10, 2)), 'スポーツの日'],
    [mk(y, 11, 3), '文化の日'],
    [mk(y, 11, 23), '勤労感謝の日'],
  ]);

  // 振替休日: 祝日が日曜なら、その後の最初の「祝日でない日」
  for (const [s] of [...map]) {
    const d = new Date(y, Number(s.slice(5, 7)) - 1, Number(s.slice(8)));
    if (d.getDay() !== 0) continue;
    do { d.setDate(d.getDate() + 1); } while (map.has(mk(d.getFullYear(), d.getMonth() + 1, d.getDate())));
    map.set(mk(d.getFullYear(), d.getMonth() + 1, d.getDate()), '振替休日');
  }

  // 国民の休日: 祝日に挟まれた平日
  for (let m = 1; m <= 12; m++) {
    const days = new Date(y, m, 0).getDate();
    for (let d = 2; d < days; d++) {
      const s = mk(y, m, d);
      if (map.has(s) || new Date(y, m - 1, d).getDay() === 0) continue;
      if (map.has(mk(y, m, d - 1)) && map.has(mk(y, m, d + 1))) map.set(s, '国民の休日');
    }
  }

  const sorted = new Map([...map].sort((a, b) => a[0].localeCompare(b[0])));
  cache.set(y, sorted);
  return sorted;
}

export const jpHolidayName = (s) => jpHolidays(Number(s.slice(0, 4))).get(s) || null;
