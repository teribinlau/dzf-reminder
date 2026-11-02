-- DZF 提醒 · v0.8.0：库位空位盘点（「仓库」→「盘点」）
-- 在 Supabase Dashboard → SQL Editor 里整段执行（重复执行无害）。全是新对象，不改旧表 / 旧函数。
--
-- 流程：Claude 开盘前从三个 WMS（盘古 / DECGN / DZF）导出一个厅的库位和库存，做成
-- 《X厅_库位空位盘点表.xlsx》；管理员在应用里导入 → 生成一次盘点（stocktakes）和它的行（stocktake_rows，
-- 一行 = 库位 + 系统 + SKU，空库位一行）。现场用手机扫库位码，点 空 / 半 / 满 / 异，必要时填还能放、实数、备注、拍照。
--
-- 权限：
--   看：已激活的成员。
--   记录（状态 / 还能放 / 实数 / 备注）：已激活的成员，只能通过 stocktake_mark()，而且盘点没结束；
--     只改记录那几列，库位、SKU、应有数这些导入的内容动不了。
--   现场加「表上没有的货」：stocktake_add_found()；删掉自己加的：stocktake_delete_found()（管理员可删任何人的）。
--   导入 / 结束 / 重新打开 / 删除整次盘点：管理员。
--   照片：已激活的成员在没结束的盘点里能传；上传人 / 管理员能删。私有桶 stocktakes，路径第一段是盘点 id。
--
-- 记录带客户端时间（p_at，限制在 24 小时内、不晚于服务器时间）：离线时点的，网络恢复后补传，
-- 盘点时间还是现场点的那一刻；两个人先后改同一行，以时间晚的为准（早的补传不会盖掉新的）。

create table if not exists public.stocktakes (
  id           uuid primary key default gen_random_uuid(),
  hall         text not null,                                   -- '2' / '3' / '4'
  title        text not null,
  exported_at  timestamptz,                                     -- WMS 导出时间
  status       text not null default 'open' check (status in ('open', 'closed')),
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  closed_at    timestamptz
);

create table if not exists public.stocktake_rows (
  id              bigint generated always as identity primary key,
  stocktake_id    uuid not null references public.stocktakes(id) on delete cascade,
  seq             integer not null,                             -- 走行顺序；现场加的行跟在本库位最后一行后面
  serial          text not null,                                -- 盘点表序号 4-001；现场加的 = 本库位首行序号 + '+1'
  aisle           text not null,                                -- 通道：'01'、'02-03'……
  pos             integer,                                      -- 位号
  loc             text not null,                                -- 统一库位号 B4-13-44-03
  codes           text[] not null default '{}',                 -- 扫码认得的库位码（统一码 + 各系统原码）
  is_first        boolean not null default false,               -- 本库位第一行：状态 / 还能放只记在这一行
  sku             text not null default '',
  wms             text not null default '',                     -- 盘古 / DECGN / DZF
  customer        text not null default '',
  lo              integer not null default 0,                   -- 应有下限 = 在库 − 待出
  hi              integer not null default 0,                   -- 应有上限 = 在库
  tag             text not null default '',                     -- SKU 后面的小标签，如「含不良 2」
  extra           boolean not null default false,               -- 库容表外的库位号
  info            jsonb not null default '{}'::jsonb,           -- 原库位号、仓库代码、批次、库存类型……
  added           boolean not null default false,               -- 现场加的（表上没有的货）
  added_by        uuid references public.profiles(id) on delete set null,
  -- 现场记录
  status          text check (status in ('empty', 'half', 'full', 'odd')),
  can_add         integer check (can_add >= 0),
  actual          integer check (actual >= 0),
  note            text not null default '',
  counted_by      uuid references public.profiles(id) on delete set null,
  counted_by_name text not null default '',
  counted_at      timestamptz,
  unique (stocktake_id, serial)
);
create index if not exists stocktake_rows_take_idx on public.stocktake_rows (stocktake_id, seq, id);
create index if not exists stocktake_rows_loc_idx on public.stocktake_rows (stocktake_id, loc);

create table if not exists public.stocktake_photos (
  id                uuid primary key default gen_random_uuid(),
  stocktake_id      uuid not null references public.stocktakes(id) on delete cascade,
  loc               text not null,
  file_path         text not null,                              -- <stocktake_id>/<随机名>.<ext>
  file_name         text not null,
  size              bigint not null default 0,
  mime              text not null default '',
  uploaded_by       uuid not null references public.profiles(id) on delete cascade,
  uploaded_by_name  text not null default '',
  created_at        timestamptz not null default now()
);
create index if not exists stocktake_photos_take_idx on public.stocktake_photos (stocktake_id, loc, created_at);

-- 列表上显示进度用：每次盘点有多少个库位、盘了多少个（按调用者的权限算，没激活的人看到的是空）
create or replace view public.stocktake_progress with (security_invoker = true) as
  select stocktake_id,
         count(*) filter (where is_first and not added)                         as locations,
         count(*) filter (where is_first and not added and status is not null) as counted
    from public.stocktake_rows
   group by stocktake_id;
grant select on public.stocktake_progress to authenticated;

alter table public.stocktakes       enable row level security;
alter table public.stocktake_rows   enable row level security;
alter table public.stocktake_photos enable row level security;

-- ---------------------------------------------------------------------------
-- 表的权限
-- ---------------------------------------------------------------------------
drop policy if exists stocktakes_select on public.stocktakes;
create policy stocktakes_select on public.stocktakes for select to authenticated using (public.is_active());

drop policy if exists stocktakes_insert on public.stocktakes;
create policy stocktakes_insert on public.stocktakes for insert to authenticated
  with check (public.is_admin() and created_by = auth.uid());

drop policy if exists stocktakes_update on public.stocktakes;
create policy stocktakes_update on public.stocktakes for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists stocktakes_delete on public.stocktakes;
create policy stocktakes_delete on public.stocktakes for delete to authenticated using (public.is_admin());

drop policy if exists stocktake_rows_select on public.stocktake_rows;
create policy stocktake_rows_select on public.stocktake_rows for select to authenticated using (public.is_active());

-- 导入：只有管理员，只能往没结束的盘点里加，而且导入的行不能自带记录
drop policy if exists stocktake_rows_insert on public.stocktake_rows;
create policy stocktake_rows_insert on public.stocktake_rows for insert to authenticated
  with check (
    public.is_admin()
    and not added
    and status is null and actual is null and counted_at is null
    and exists (select 1 from public.stocktakes t where t.id = stocktake_id and t.status = 'open')
  );

drop policy if exists stocktake_rows_delete on public.stocktake_rows;
create policy stocktake_rows_delete on public.stocktake_rows for delete to authenticated using (public.is_admin());
-- 没有 update 策略：记录只能走 stocktake_mark()

drop policy if exists stocktake_photos_select on public.stocktake_photos;
create policy stocktake_photos_select on public.stocktake_photos for select to authenticated using (public.is_active());

drop policy if exists stocktake_photos_insert on public.stocktake_photos;
create policy stocktake_photos_insert on public.stocktake_photos for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and public.is_active()
    and exists (select 1 from public.stocktakes t where t.id = stocktake_id and t.status = 'open')
  );

drop policy if exists stocktake_photos_delete on public.stocktake_photos;
create policy stocktake_photos_delete on public.stocktake_photos for delete to authenticated
  using (uploaded_by = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- 现场记录
-- ---------------------------------------------------------------------------
create or replace function public.stocktake_at(p_at timestamptz) returns timestamptz
language sql stable as $$
  select least(now(), greatest(coalesce(p_at, now()), now() - interval '1 day'));
$$;

create or replace function public.stocktake_signer(p_name text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(left(trim(coalesce(p_name, '')), 60), ''), (select name from public.profiles where id = auth.uid()), '');
$$;

-- 记一行：状态（只在本库位第一行）、还能放（只在勾「半」时）、实数、备注。全部为空 = 撤销这一行的记录。
-- 返回这一行现在的样子（时间更早的补传被忽略时，返回的是服务器上更新的那份）。
create or replace function public.stocktake_mark(
  p_row     bigint,
  p_status  text,
  p_can_add integer,
  p_actual  integer,
  p_note    text,
  p_name    text default null,
  p_at      timestamptz default null
) returns public.stocktake_rows
language plpgsql security definer set search_path = public as $$
declare
  v_row    public.stocktake_rows;
  v_state  text;
  v_at     timestamptz := public.stocktake_at(p_at);
  v_note   text := left(trim(coalesce(p_note, '')), 500);
  v_status text;
  v_clear  boolean;
begin
  if not public.is_active() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_row from public.stocktake_rows where id = p_row for update;
  if not found then
    raise exception 'stocktake row % not found', p_row using errcode = 'P0002';
  end if;
  select status into v_state from public.stocktakes where id = v_row.stocktake_id;
  if v_state is distinct from 'open' then
    raise exception 'stocktake is closed' using errcode = '42501';
  end if;
  -- 时间更早的补传：不盖掉别人 / 自己后来点的
  if v_row.counted_at is not null and v_at < v_row.counted_at then
    return v_row;
  end if;
  v_status := case when v_row.is_first then p_status else null end;
  v_clear := v_status is null and p_actual is null and v_note = '';
  update public.stocktake_rows x set
    status          = v_status,
    can_add         = case when v_status = 'half' then p_can_add else null end,
    actual          = p_actual,
    note            = v_note,
    counted_by      = case when v_clear then null else auth.uid() end,
    counted_by_name = case when v_clear then '' else public.stocktake_signer(p_name) end,
    counted_at      = case when v_clear then null else v_at end
  where x.id = p_row
  returning x.* into v_row;
  return v_row;
end $$;

-- 现场发现表上没有的货：加在这个库位下面（SKU 可以是箱唛上抄的）
create or replace function public.stocktake_add_found(
  p_take  uuid,
  p_loc   text,
  p_sku   text,
  p_qty   integer,
  p_note  text,
  p_name  text default null,
  p_at    timestamptz default null
) returns public.stocktake_rows
language plpgsql security definer set search_path = public as $$
declare
  v_base  public.stocktake_rows;
  v_row   public.stocktake_rows;
  v_state text;
  v_n     integer;
  v_seq   integer;
  v_sku   text := upper(left(trim(coalesce(p_sku, '')), 80));
  v_note  text := left(trim(coalesce(p_note, '')), 500);
begin
  if not public.is_active() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select status into v_state from public.stocktakes where id = p_take;
  if v_state is null then
    raise exception 'stocktake % not found', p_take using errcode = 'P0002';
  end if;
  if v_state <> 'open' then
    raise exception 'stocktake is closed' using errcode = '42501';
  end if;
  if v_sku = '' and v_note = '' then
    raise exception 'sku or note is required' using errcode = '22023';
  end if;
  if p_qty is not null and p_qty < 0 then
    raise exception 'qty must be >= 0' using errcode = '22023';
  end if;
  -- 锁住本库位第一行：两个人同时加也不会撞序号
  select * into v_base from public.stocktake_rows
   where stocktake_id = p_take and loc = p_loc and is_first and not added
   order by seq limit 1
   for update;
  if not found then
    raise exception 'location % is not in this stocktake', p_loc using errcode = 'P0002';
  end if;
  select count(*) filter (where added) + 1, max(seq) into v_n, v_seq
    from public.stocktake_rows where stocktake_id = p_take and loc = p_loc;
  while exists (select 1 from public.stocktake_rows where stocktake_id = p_take and serial = v_base.serial || '+' || v_n) loop
    v_n := v_n + 1;
  end loop;
  insert into public.stocktake_rows (
    stocktake_id, seq, serial, aisle, pos, loc, codes, is_first, sku, extra, added, added_by,
    actual, note, counted_by, counted_by_name, counted_at
  ) values (
    p_take, v_seq, v_base.serial || '+' || v_n, v_base.aisle, v_base.pos, v_base.loc, v_base.codes, false, v_sku,
    v_base.extra, true, auth.uid(), p_qty, v_note, auth.uid(), public.stocktake_signer(p_name), public.stocktake_at(p_at)
  ) returning * into v_row;
  return v_row;
end $$;

-- 删掉现场加的一行：加的人自己，或者管理员；盘点结束后不能删
create or replace function public.stocktake_delete_found(p_row bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row   public.stocktake_rows;
  v_state text;
begin
  select * into v_row from public.stocktake_rows where id = p_row;
  if not found then
    return;
  end if;
  if not v_row.added then
    raise exception 'only rows added on site can be deleted' using errcode = '42501';
  end if;
  if not public.is_active() or (v_row.added_by is distinct from auth.uid() and not public.is_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select status into v_state from public.stocktakes where id = v_row.stocktake_id;
  if v_state is distinct from 'open' then
    raise exception 'stocktake is closed' using errcode = '42501';
  end if;
  delete from public.stocktake_rows where id = p_row;
end $$;

revoke all on function public.stocktake_mark(bigint, text, integer, integer, text, text, timestamptz) from public, anon;
revoke all on function public.stocktake_add_found(uuid, text, text, integer, text, text, timestamptz) from public, anon;
revoke all on function public.stocktake_delete_found(bigint) from public, anon;
grant execute on function public.stocktake_mark(bigint, text, integer, integer, text, text, timestamptz) to authenticated;
grant execute on function public.stocktake_add_found(uuid, text, text, integer, text, text, timestamptz) to authenticated;
grant execute on function public.stocktake_delete_found(bigint) to authenticated;

-- 实时订阅（已加过就跳过）
do $$
begin
  alter publication supabase_realtime add table public.stocktakes;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.stocktake_rows;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.stocktake_photos;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Storage：私有桶 stocktakes（现场照片，客户端先压到长边 2560px），单文件最大 20 MB
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('stocktakes', 'stocktakes', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = 20971520;

drop policy if exists stocktakes_storage_select on storage.objects;
create policy stocktakes_storage_select on storage.objects for select to authenticated
  using (bucket_id = 'stocktakes' and public.is_active());

drop policy if exists stocktakes_storage_insert on storage.objects;
create policy stocktakes_storage_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'stocktakes'
    and public.is_active()
    and exists (
      select 1 from public.stocktakes t
      where t.id::text = (storage.foldername(name))[1] and t.status = 'open'
    )
  );

-- 删文件：照片登记行的上传人 / 管理员（先删文件、再删登记行）
drop policy if exists stocktakes_storage_delete on storage.objects;
create policy stocktakes_storage_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'stocktakes'
    and (
      public.is_admin()
      or exists (select 1 from public.stocktake_photos p where p.file_path = name and p.uploaded_by = auth.uid())
    )
  );
