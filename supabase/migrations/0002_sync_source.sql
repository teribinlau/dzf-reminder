-- DZF 提醒 · v0.2：外部来源同步（Notion 到柜登记表）
-- 在 0001_init.sql 之后执行。

-- 提醒可以来自外部系统：source = 'notion'，source_key 是该来源里的唯一键（页面 id + 类型）
alter table public.reminders
  add column if not exists source     text,
  add column if not exists source_key text;

create unique index if not exists reminders_source_key_idx
  on public.reminders (source, source_key)
  where source_key is not null;

-- 同步运行日志（管理员在设置里看最近一次同步是否成功）
create table if not exists public.sync_runs (
  id          bigserial primary key,
  source      text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  created     int not null default 0,
  updated     int not null default 0,
  archived    int not null default 0,
  completed   int not null default 0,
  message     text not null default ''
);
alter table public.sync_runs enable row level security;
drop policy if exists sync_runs_select on public.sync_runs;
create policy sync_runs_select on public.sync_runs for select to authenticated using (public.is_admin());

-- 只保留最近 200 条日志
create or replace function public.trim_sync_runs() returns trigger
language plpgsql as $$
begin
  delete from public.sync_runs where id < (select coalesce(max(id), 0) - 200 from public.sync_runs);
  return null;
end $$;
drop trigger if exists sync_runs_trim on public.sync_runs;
create trigger sync_runs_trim after insert on public.sync_runs
  for each statement execute function public.trim_sync_runs();
