// Supabase の接続情報
// Supabase の「Project Settings → API Keys / Data API」で確認できる値を入れる。
// どちらも公開してよい値（データは「本人だけ読み書き可」の設定で守られる）。
// 空のままなら同期なし（この端末だけで使う）で動く。
export const SUPABASE_URL = '';
export const SUPABASE_KEY = ''; // anon キー、または sb_publishable_ で始まるキー
