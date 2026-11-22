// エクスポート（JSON/CSV）とバックアップからの復元
import * as db from './db.js';
import { ymd } from './util.js';

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function stamp() {
  return ymd().replace(/-/g, '');
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function saveFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  // iPhone のホーム画面アプリではダウンロードが不安定なので共有シート経由（「ファイルに保存」を選ぶ）
  if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// 全データ（画像込み）を JSON で書き出す
export async function exportJSON() {
  const tasks = await db.getAllTasks();
  const images = await db.getAllImages();
  const imgs = await Promise.all(images.map(async (i) => ({
    id: i.id,
    taskId: i.taskId,
    createdAt: i.createdAt,
    data: await blobToDataURL(i.blob),
  })));
  const calendar = await db.getMeta('calendar');
  const data = { app: 'tasklist', version: 1, exportedAt: new Date().toISOString(), tasks, images: imgs, calendar: calendar ?? null };
  await saveFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), `tasklist-backup-${stamp()}.json`);
}

// 一覧を CSV で書き出す（Excel で開けるよう BOM 付き）
export async function exportCSV() {
  const tasks = (await db.getAllTasks()).filter((t) => !t.deletedAt);
  const head = ['完了', 'タスク名', '期限日', '優先', 'タグ', 'メモ', '作成日時', '完了日時'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = tasks.map((t) => [
    t.done ? '済' : '',
    t.title,
    t.due || '',
    t.priority ? '★' : '',
    (t.tags || []).join(' '),
    t.memo || '',
    t.createdAt ? new Date(t.createdAt).toLocaleString('ja-JP') : '',
    t.doneAt ? new Date(t.doneAt).toLocaleString('ja-JP') : '',
  ].map(q).join(','));
  const csv = '﻿' + [head.map(q).join(','), ...rows].join('\r\n');
  await saveFile(new Blob([csv], { type: 'text/csv' }), `tasklist-${stamp()}.csv`);
}

// バックアップ JSON から復元（上書きではなくマージ。同じタスクは更新日時が新しい方を採用）
export async function importJSON(file) {
  const data = JSON.parse(await file.text());
  if (data?.app !== 'tasklist' || !Array.isArray(data.tasks)) {
    throw new Error('このアプリのバックアップファイルではありません');
  }
  let added = 0, updated = 0;
  for (const t of data.tasks) {
    if (!t?.id) continue;
    const cur = await db.getTask(t.id);
    if (!cur) { await db.putTask({ ...t, _dirty: true }); added++; }
    else if ((t.updatedAt || '') > (cur.updatedAt || '')) { await db.putTask({ ...t, _dirty: true }); updated++; }
  }
  for (const i of data.images || []) {
    if (!i?.id || (await db.getImage(i.id))) continue;
    const blob = await (await fetch(i.data)).blob();
    await db.putImage({ id: i.id, taskId: i.taskId, createdAt: i.createdAt, blob });
  }
  if (data.calendar && !(await db.getMeta('calendar'))) {
    await db.setMeta('calendar', data.calendar);
    await db.setMeta('calendarUpdatedAt', new Date().toISOString());
    await db.setMeta('calendarDirty', true);
  }
  window.dispatchEvent(new Event('tl:local-change'));
  return { added, updated };
}
