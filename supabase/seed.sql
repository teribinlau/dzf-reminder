-- 初始班组（在 0001_init.sql 之后执行一次）
insert into public.teams (id, name_zh, name_de, color, sort) values
  ('11111111-1111-4111-8111-111111111111', '入库组', 'Wareneingang', '#3B7A2A', 1),
  ('22222222-2222-4222-8222-222222222222', '出库组', 'Versand',      '#0E7C6B', 2),
  ('33333333-3333-4333-8333-333333333333', '盘点组', 'Inventur',     '#6B4FBB', 3),
  ('44444444-4444-4444-8444-444444444444', '管理',   'Verwaltung',   '#A8560A', 4)
on conflict (id) do nothing;

-- 第一个通过邮箱登录的用户会自动成为管理员（见 handle_new_user）。
-- 如需手动指定：
-- update public.profiles set role = 'admin', team_id = '44444444-4444-4444-8444-444444444444' where email = 'hi@example.com';
