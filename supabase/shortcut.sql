-- iPhone ショートカットからタスクを追加するための設定（schema.sql の後に実行）
-- Supabase の「SQL Editor」に全文を貼り付けて「Run」を押す。何度実行しても大丈夫。
--
-- しくみ:
--   アプリのメニューで「ショートカット用のキー」を発行 → キーのハッシュだけをここに保存。
--   ショートカットは quick_add(token, content) を呼び、キーが合えば今日期限のタスクを1件追加する。
--   キーを作り直すと古いキーは使えなくなる。

create table if not exists public.shortcut_tokens (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now()
);

alter table public.shortcut_tokens enable row level security;

drop policy if exists "own token" on public.shortcut_tokens;
create policy "own token" on public.shortcut_tokens
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- content: 音声入力の文字や、共有されたURL（「タイトル URL」の形でもよい）
create or replace function public.quick_add(token text, content text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid;
  body text := left(btrim(coalesce(content, '')), 4000);
  link text;
  rest text;
  first_line text;
  more text;
  ttl text;
  memo text;
  needs boolean := false;
  new_id uuid := gen_random_uuid();
  now_iso text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  today text := to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD');
begin
  select t.user_id into uid
    from public.shortcut_tokens t
   where t.token_hash = encode(sha256(convert_to(coalesce(token, ''), 'UTF8')), 'hex');
  if uid is null then
    raise exception 'キーが正しくありません（アプリのメニューで発行したキーを入れてください）' using errcode = '28000';
  end if;
  if body = '' then
    raise exception '追加する内容が空です' using errcode = '22023';
  end if;

  -- 最初のURLはメモへ、残りの文字をタイトルに
  link := substring(body from 'https?://[^[:space:]<>"]+');
  rest := btrim(regexp_replace(body, 'https?://[^[:space:]<>"]+', '', 'g'));
  first_line := btrim(split_part(rest, E'\n', 1));
  more := btrim(substr(rest, length(split_part(rest, E'\n', 1)) + 1));

  if first_line <> '' then
    ttl := left(first_line, 200);
  elsif link is not null then
    ttl := link;
    needs := true; -- アプリ側で動画タイトルなどに置き換える
  else
    ttl := left(body, 200);
  end if;

  memo := concat_ws(E'\n', nullif(more, ''), link);

  insert into public.tasks (id, user_id, data, updated_at)
  values (
    new_id, uid,
    jsonb_build_object(
      'id', new_id, 'title', ttl, 'due', today, 'priority', false,
      'memo', coalesce(memo, ''), 'tags', '[]'::jsonb, 'images', '[]'::jsonb,
      'repeat', null, 'done', false, 'doneAt', null,
      'createdAt', now_iso, 'updatedAt', now_iso, 'deletedAt', null,
      'needsTitle', needs, 'source', 'shortcut'
    ),
    now()
  );

  return jsonb_build_object('ok', true, 'title', ttl);
end $$;

revoke all on function public.quick_add(text, text) from public;
grant execute on function public.quick_add(text, text) to anon, authenticated;
