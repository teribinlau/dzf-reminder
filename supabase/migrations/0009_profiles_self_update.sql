-- DZF 提醒 · v0.6.3：本人改自己的资料时，active / email 也不能改（2026-10-04 已在生产手动执行过，这里补进仓库）
-- 以前任何能收到登录邮件的人，登录后都能把自己改成「已激活」。重复执行无害。
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = (select p.role from public.profiles p where p.id = auth.uid())
    and team_id is not distinct from (select p.team_id from public.profiles p where p.id = auth.uid())
    and is_station = (select p.is_station from public.profiles p where p.id = auth.uid())
    and active = (select p.active from public.profiles p where p.id = auth.uid())
    and email = (select p.email from public.profiles p where p.id = auth.uid())
  );
