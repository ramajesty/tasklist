-- カレンダー購読（Google カレンダー・Outlook に期限日を表示）用の設定（schema.sql の後に実行）
-- Supabase の「SQL Editor」に全文を貼り付けて「Run」を押す。何度実行しても大丈夫。
--
-- しくみ:
--   アプリのメニューで「購読URL」を発行 → URLに含まれるキーのハッシュだけをここに保存。
--   カレンダーアプリがそのURLを定期的に読みに来ると、未完了タスクの期限日を終日の予定として返す。
--   URLを作り直すと古いURLは使えなくなる。

create table if not exists public.feed_tokens (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now()
);

alter table public.feed_tokens enable row level security;

drop policy if exists "own feed token" on public.feed_tokens;
create policy "own feed token" on public.feed_tokens
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 返す形式（text/calendar）を表す型
do $$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public' and t.typname = 'text/calendar'
  ) then
    create domain public."text/calendar" as text;
  end if;
end $$;

-- iCalendar 用の文字のエスケープ
create or replace function public.ics_escape(s text)
returns text language sql immutable set search_path = '' as $$
  select replace(replace(replace(replace(replace(coalesce(s, ''),
    E'\\', E'\\\\'), ';', E'\\;'), ',', E'\\,'), E'\r', ''), E'\n', E'\\n');
$$;

-- 1行75バイトごとに折り返す（iCalendar の決まり）
create or replace function public.ics_fold(line text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  result text := '';
  cur text := '';
  ch text;
  lim int := 75;
begin
  for i in 1..char_length(line) loop
    ch := substr(line, i, 1);
    if octet_length(cur) + octet_length(ch) > lim then
      result := result || cur || E'\r\n ';
      cur := '';
      lim := 74; -- 続きの行は先頭の空白1文字ぶん短く
    end if;
    cur := cur || ch;
  end loop;
  return result || cur;
end $$;

-- 購読フィード本体: GET /rest/v1/rpc/tasks_ics?token=...
create or replace function public.tasks_ics(token text)
returns public."text/calendar"
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid;
  events text;
begin
  select f.user_id into uid
    from public.feed_tokens f
   where f.token_hash = encode(sha256(convert_to(coalesce(token, ''), 'UTF8')), 'hex');
  if uid is null then
    raise exception '購読URLが正しくありません（アプリのメニューで発行し直してください）' using errcode = '28000';
  end if;

  select string_agg(concat(
      'BEGIN:VEVENT', E'\r\n',
      'UID:', e.id, '@tasklist', E'\r\n',
      'DTSTAMP:', to_char(e.updated_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'), E'\r\n',
      'DTSTART;VALUE=DATE:', to_char(e.d, 'YYYYMMDD'), E'\r\n',
      'DTEND;VALUE=DATE:', to_char(e.d + 1, 'YYYYMMDD'), E'\r\n',
      public.ics_fold('SUMMARY:' || public.ics_escape(
        case when e.prio then '★ ' else '' end || e.title
        || coalesce(' ' || nullif(e.tags, ''), ''))), E'\r\n',
      case when e.memo <> '' then public.ics_fold('DESCRIPTION:' || public.ics_escape(left(e.memo, 1000))) || E'\r\n' end,
      'TRANSP:TRANSPARENT', E'\r\n',
      'END:VEVENT', E'\r\n'), '' order by e.d, e.prio desc)
    into events
    from (
      select t.id, t.updated_at,
             (t.data ->> 'due')::date as d,
             coalesce((t.data ->> 'priority')::boolean, false) as prio,
             coalesce(t.data ->> 'title', '') as title,
             coalesce(t.data ->> 'memo', '') as memo,
             (select string_agg('#' || x, ' ') from jsonb_array_elements_text(
                case when jsonb_typeof(t.data -> 'tags') = 'array' then t.data -> 'tags' else '[]'::jsonb end) x) as tags
        from public.tasks t
       where t.user_id = uid
         and t.data ->> 'deletedAt' is null
         and coalesce((t.data ->> 'done')::boolean, false) = false
         and t.data ->> 'due' ~ '^\d{4}-\d{2}-\d{2}$'
    ) e;

  return concat(
    'BEGIN:VCALENDAR', E'\r\n',
    'VERSION:2.0', E'\r\n',
    'PRODID:-//tasklist//JA', E'\r\n',
    'CALSCALE:GREGORIAN', E'\r\n',
    'METHOD:PUBLISH', E'\r\n',
    'X-WR-CALNAME:タスク', E'\r\n',
    'X-WR-TIMEZONE:Asia/Tokyo', E'\r\n',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', E'\r\n',
    'X-PUBLISHED-TTL:PT1H', E'\r\n',
    events,
    'END:VCALENDAR', E'\r\n');
end $$;

revoke all on function public.tasks_ics(text) from public;
grant execute on function public.tasks_ics(text) to anon, authenticated;
