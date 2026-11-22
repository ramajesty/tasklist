// 端末内保存（IndexedDB）
// 将来クラウド同期（Supabase）を足すときも、このファイルの関数経由で読み書きする。
const DB_NAME = 'tasklist';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) {
        const s = db.createObjectStore('images', { keyPath: 'id' });
        s.createIndex('taskId', 'taskId');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// store に対して fn(store) を実行し、最後のリクエスト結果を返す
async function run(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---- tasks ----
export const getAllTasks = () => run('tasks', 'readonly', (s) => s.getAll());
export const getTask = (id) => run('tasks', 'readonly', (s) => s.get(id));
export const putTask = (task) => run('tasks', 'readwrite', (s) => s.put(task));

// ---- images ----
export const getAllImages = () => run('images', 'readonly', (s) => s.getAll());
export const getAllImageIds = () => run('images', 'readonly', (s) => s.getAllKeys());
export const getImage = (id) => run('images', 'readonly', (s) => s.get(id));
export const putImage = (img) => run('images', 'readwrite', (s) => s.put(img));

// 削除した画像のIDを記録しておき、同期時にクラウド側からも消す
async function addImageTombstones(ids) {
  if (!ids.length) return;
  const cur = (await getMeta('imageDeletes')) || [];
  await setMeta('imageDeletes', [...new Set([...cur, ...ids])]);
}

export async function deleteImage(id) {
  await run('images', 'readwrite', (s) => s.delete(id));
  await addImageTombstones([id]);
}

export async function deleteImagesByTask(taskId) {
  const db = await open();
  const ids = await new Promise((resolve, reject) => {
    const removed = [];
    const tx = db.transaction('images', 'readwrite');
    const idx = tx.objectStore('images').index('taskId');
    const req = idx.openCursor(IDBKeyRange.only(taskId));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { removed.push(cur.primaryKey); cur.delete(); cur.continue(); }
    };
    tx.oncomplete = () => resolve(removed);
    tx.onerror = () => reject(tx.error);
  });
  await addImageTombstones(ids);
}

// ---- meta（設定など） ----
export const getMeta = async (key) => (await run('meta', 'readonly', (s) => s.get(key)))?.value;
export const setMeta = (key, value) => run('meta', 'readwrite', (s) => s.put({ key, value }));
