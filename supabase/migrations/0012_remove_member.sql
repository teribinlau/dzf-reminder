-- DZF 提醒 · v0.8.1：管理员可以「移出成员」，记录保留
-- 在 Supabase Dashboard → SQL Editor 里整段执行（重复执行无害）。
--
-- 不能真的删账号：提醒、完成记录、讨论、留言、上传的文件都挂在这个人的 profile 上（on delete cascade），
-- 删账号会把 TA 建的提醒从所有人的日历里一起删掉。所以「移出」= 打个标记：
--   - profiles.deleted_at = 移出的时间（空 = 正常成员）；同时 active = false、role = member
--     → is_active() 为假，登录后什么都看不到（和「待激活」一样），也不再算管理员
--   - 从兼任班组、提醒的指派、讨论的范围里拿掉（不然头像还挂在卡片上、未交名单里还有 TA）
--   - 以前建的提醒、完成记录、讨论和留言都不动，名字照常显示
-- 恢复 = 清掉标记，人回到名单里、状态是「待激活」，管理员再点「激活」；以前的指派和兼任班组不会自动加回来。
-- 只能通过下面两个函数改（里面检查是不是管理员）；本人改资料时 deleted_at 也不能动（见 profiles_update_self）。

alter table public.profiles
  add column if not exists deleted_at timestamptz;

-- 本人改自己的资料：在 0009 的基础上再加 deleted_at 不能改（不然被移出的人能把自己放回名单）
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
    and deleted_at is not distinct from (select p.deleted_at from public.profiles p where p.id = auth.uid())
  );

create or replace function public.admin_remove_member(target uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'only admins can remove members' using errcode = '42501';
  end if;
  if target = auth.uid() then
    raise exception 'you cannot remove yourself' using errcode = '22023';
  end if;
  -- 管理员也照样能移出（另一个管理员动手，所以至少还剩一个；profiles_keep_admin 触发器兜底）
  update public.profiles
     set active = false, role = 'member', deleted_at = now()
   where id = target and deleted_at is null;
  if not found then
    raise exception 'member not found or already removed' using errcode = 'P0002';
  end if;
  delete from public.profile_teams where profile_id = target;
  delete from public.reminder_assignees where user_id = target;
  delete from public.discussion_members where user_id = target;
end $$;

create or replace function public.admin_restore_member(target uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'only admins can restore members' using errcode = '42501';
  end if;
  update public.profiles set deleted_at = null where id = target and deleted_at is not null;
  if not found then
    raise exception 'member not found or not removed' using errcode = 'P0002';
  end if;
end $$;

revoke all on function public.admin_remove_member(uuid) from public, anon;
revoke all on function public.admin_restore_member(uuid) from public, anon;
grant execute on function public.admin_remove_member(uuid) to authenticated;
grant execute on function public.admin_restore_member(uuid) to authenticated;
