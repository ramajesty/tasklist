-- タスクリスト用 Supabase セットアップ
-- Supabase の「SQL Editor」に全文を貼り付けて「Run」を押す。何度実行しても大丈夫。

-- ---------------------------------------------------------------------------
-- タスク（中身は JSON でまるごと保存）
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null,                     -- 端末側で編集した日時（新しい方を採用）
  server_updated_at timestamptz not null default now() -- サーバーに届いた日時（差分取得用）
);
create index if not exists tasks_user_server_updated on public.tasks (user_id, server_updated_at);

-- ---------------------------------------------------------------------------
-- 設定（会社カレンダーなど）
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  calendar jsonb,
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);

-- サーバー到着日時を自動で更新
create or replace function public.touch_server_updated_at()
returns trigger language plpgsql as $$
begin
  new.server_updated_at = now();
  return new;
end $$;

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before insert or update on public.tasks
  for each row execute function public.touch_server_updated_at();

drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before insert or update on public.settings
  for each row execute function public.touch_server_updated_at();

-- ---------------------------------------------------------------------------
-- 本人のデータだけ読み書きできるようにする（行単位セキュリティ）
-- ---------------------------------------------------------------------------
alter table public.tasks enable row level security;
alter table public.settings enable row level security;

drop policy if exists "own tasks" on public.tasks;
create policy "own tasks" on public.tasks
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own settings" on public.settings;
create policy "own settings" on public.settings
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- まとめて送信（同じタスクは編集日時が新しい方だけ反映）
-- ---------------------------------------------------------------------------
create or replace function public.push_tasks(rows jsonb)
returns void language sql security invoker as $$
  insert into public.tasks (id, user_id, data, updated_at)
  select (r ->> 'id')::uuid, auth.uid(), r -> 'data', (r ->> 'updated_at')::timestamptz
  from jsonb_array_elements(rows) as r
  on conflict (id) do update
    set data = excluded.data, updated_at = excluded.updated_at
    where public.tasks.updated_at < excluded.updated_at;
$$;

-- ---------------------------------------------------------------------------
-- 画像の保存場所（非公開。ユーザーIDのフォルダ内だけ読み書き可）
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('images', 'images', false)
on conflict (id) do nothing;

drop policy if exists "own images select" on storage.objects;
create policy "own images select" on storage.objects for select to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own images insert" on storage.objects;
create policy "own images insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own images update" on storage.objects;
create policy "own images update" on storage.objects for update to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own images delete" on storage.objects;
create policy "own images delete" on storage.objects for delete to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);
