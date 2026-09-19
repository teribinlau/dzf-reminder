-- DZF 提醒 · 定时任务：每 15 分钟从 Notion「到柜登记表」同步一次
-- 在 Supabase Dashboard → SQL Editor 里执行。执行前把下面两处 <…> 换掉：
--   <PROJECT_REF>  项目 ref（如 qgcyatlomdeocfyblynh）
--   <SYNC_SECRET>  和 Edge Function Secrets 里 SYNC_SECRET 相同的口令

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 已存在同名任务先删掉（重复执行本文件也没关系）
do $$
begin
  perform cron.unschedule('sync-notion-containers');
exception when others then null;
end $$;

select cron.schedule(
  'sync-notion-containers',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-notion-containers',
    headers := '{"Content-Type": "application/json", "x-sync-secret": "<SYNC_SECRET>"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- 看最近几次运行结果：
-- select * from public.sync_runs order by id desc limit 10;
-- select * from cron.job_run_details order by start_time desc limit 10;
