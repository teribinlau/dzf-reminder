-- DZF 提醒 · v0.8.9：库位整理（「仓库」→「整理」）
-- 在 Supabase Dashboard → SQL Editor 里整段执行（重复执行无害）。全是新对象，不改旧表 / 旧函数。
-- 用到 0011 里的 stocktake_at()、stocktake_signer()（盘点的迁移要先跑过）。
--
-- 整理 = 把占用很少的货架库位并到别的库位、把空托盘搬走，腾出托位。
--   - 在「3D 仓库」的「整理」里挑库位 → 加入整理清单（一条任务 = 一个来源库位整个搬到一个目标库位）。
--   - 现场用手机扫来源库位、再扫目标库位 → 已搬；搬不了点原因 → 有问题（这条停下）。
--   - 空托盘：现场看到库位里只有空托盘 → 报一条，叉车搬走后点「搬走了」。
--   - 管理员按系统生成 WMS「批次库存 › 批量移库位」文件（只有已搬的任务），导入后点「已导入」→ 完成。
--
-- 权限：
--   看：已激活的成员。
--   加任务（tidy_add）、现场操作（tidy_act：已搬 / 有问题 / 重新待搬 / 空托盘搬走了 / 换目标 / 取消自己加的）：已激活的成员。
--   标记「已出文件」、移库任务「已导入 → 完成」、取消别人加的：管理员。
--   表上没有 insert / update / delete 策略，只能走下面的函数。
--
-- 现场操作带客户端时间（p_at，限制在 24 小时内、不晚于服务器时间）：离线时点的，联网后补传；
-- 服务器上已经有更晚的操作就不覆盖（返回服务器上的那份）。

create table if not exists public.tidy_tasks (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('move', 'pallet')),     -- move = 并到别的库位；pallet = 搬走空托盘
  src              text not null,                                        -- 来源库位，统一写法 B2-14-34-01
  dst              text not null default '',                             -- 目标库位（pallet 为空）
  hall             text not null,                                        -- 来源在哪个厅
  sys              text not null default '',                             -- 货在哪个系统：B3 / DECGN / HP / DZF
  customer         text not null default '',
  fill             real,                                                 -- 加入时来源的占用（0–1，货物体积 ÷ 一个托位）
  dst_before       real,                                                 -- 目标并入前 / 并入后的占用
  dst_after        real,
  same_sku         boolean not null default false,                       -- 目标里已经有同一个 SKU
  lines            jsonb not null default '[]'::jsonb,                   -- 加入时系统里的货：[[SKU, 件数], …]
  status           text not null default 'todo' check (status in ('todo', 'moved', 'problem', 'done', 'cancelled')),
  problem          text not null default '' check (problem in ('', 'qty', 'missing', 'full', 'other')),
  note             text not null default '',
  moved_to         text not null default '',                             -- 实际放到的库位（现场换了目标时和 dst 不一样）
  created_by       uuid references public.profiles(id) on delete set null,
  created_by_name  text not null default '',
  created_at       timestamptz not null default now(),
  acted_by         uuid references public.profiles(id) on delete set null,   -- 最近一次现场操作是谁、什么时候
  acted_by_name    text not null default '',
  acted_at         timestamptz,
  exported_at      timestamptz,                                          -- 什么时候出过移库文件
  exported_by      uuid references public.profiles(id) on delete set null,
  closed_at        timestamptz                                           -- 完成 / 取消的时间
);
-- 一个来源库位同时只能有一条没结束的任务
create unique index if not exists tidy_tasks_open_src on public.tidy_tasks (src) where status in ('todo', 'moved', 'problem');
create index if not exists tidy_tasks_status_idx on public.tidy_tasks (status, closed_at);

alter table public.tidy_tasks enable row level security;

drop policy if exists tidy_tasks_select on public.tidy_tasks;
create policy tidy_tasks_select on public.tidy_tasks for select to authenticated using (public.is_active());
-- 没有 insert / update / delete 策略：只能走下面的函数

-- 货架库位号的统一写法
create or replace function public.tidy_is_slot(p text) returns boolean
language sql immutable as $$
  select p ~ '^B[1-9]-[0-9]{2}-[0-9]{2}-[0-9]{2}$';
$$;

-- 加任务：p_tasks = [{id?, kind, src, dst, sys, cust, fill, before, after, same, lines, note}, …]（3D 页「加入整理」/ 手机报空托盘）。
-- 跳过：来源已经有没结束的任务；来源正是别的任务的目标；目标正是别的任务的来源。返回真正加进去的那些。
create or replace function public.tidy_add(p_tasks jsonb, p_name text default null) returns setof public.tidy_tasks
language plpgsql security definer set search_path = public as $$
declare
  t       jsonb;
  v_row   public.tidy_tasks;
  v_kind  text;
  v_src   text;
  v_dst   text;
  v_id    uuid;
  v_name  text;
begin
  if not public.is_active() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_tasks is null or jsonb_typeof(p_tasks) <> 'array' then
    raise exception 'tasks must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_tasks) > 500 then
    raise exception 'too many tasks' using errcode = '22023';
  end if;
  v_name := public.stocktake_signer(p_name);
  for t in select * from jsonb_array_elements(p_tasks) loop
    if jsonb_typeof(t) <> 'object' then
      continue;
    end if;
    v_kind := t->>'kind';
    v_src := upper(trim(coalesce(t->>'src', '')));
    v_dst := upper(trim(coalesce(t->>'dst', '')));
    if v_kind is null or v_kind not in ('move', 'pallet') or not public.tidy_is_slot(v_src) then
      continue;
    end if;
    if v_kind = 'pallet' then
      v_dst := '';
    elsif not public.tidy_is_slot(v_dst) or v_dst = v_src then
      continue;
    end if;
    if exists (select 1 from public.tidy_tasks x where x.status in ('todo', 'moved', 'problem') and x.kind = 'move'
                 and (x.dst = v_src or x.moved_to = v_src or (v_dst <> '' and x.src = v_dst))) then
      continue;
    end if;
    v_id := case when coalesce(t->>'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (t->>'id')::uuid else gen_random_uuid() end;
    insert into public.tidy_tasks (id, kind, src, dst, hall, sys, customer, fill, dst_before, dst_after, same_sku, lines, note, created_by, created_by_name)
    values (
      v_id, v_kind, v_src, v_dst, substr(v_src, 2, 1),
      left(coalesce(t->>'sys', ''), 12),
      left(coalesce(t->>'cust', ''), 120),
      case when jsonb_typeof(t->'fill') = 'number' then (t->>'fill')::real end,
      case when jsonb_typeof(t->'before') = 'number' then (t->>'before')::real end,
      case when jsonb_typeof(t->'after') = 'number' then (t->>'after')::real end,
      coalesce(t->'same' = 'true'::jsonb, false),
      case when jsonb_typeof(t->'lines') = 'array' and length((t->'lines')::text) <= 20000 then t->'lines' else '[]'::jsonb end,
      left(trim(coalesce(t->>'note', '')), 500),
      auth.uid(), v_name
    )
    on conflict do nothing
    returning * into v_row;
    if found then
      return next v_row;
    end if;
  end loop;
end $$;

-- 现场操作。p_action：
--   moved    货搬过去了（p_dst 空 = 放到原定目标；现场换了目标就带实际放到的库位）
--   problem  搬不了：p_problem = qty 数量不对 / missing 货不在 / full 目标放不下 / other 别的，p_note 写说明
--   reopen   回到待搬（点错了、问题解决了；出过文件的不行）
--   done     空托盘：搬走了；移库任务：已导入系统（管理员）
--   cancel   不搬了（自己加的，或者管理员）
--   retarget 换目标（还没搬时）
-- 状态对不上的操作不报错、原样返回（离线补传时别人已经处理过了很正常）；没权限的报错。
create or replace function public.tidy_act(
  p_id      uuid,
  p_action  text,
  p_dst     text default null,
  p_problem text default null,
  p_note    text default null,
  p_name    text default null,
  p_at      timestamptz default null
) returns public.tidy_tasks
language plpgsql security definer set search_path = public as $$
declare
  v        public.tidy_tasks;
  v_at     timestamptz := public.stocktake_at(p_at);
  v_admin  boolean := public.is_admin();
  v_dst    text := upper(trim(coalesce(p_dst, '')));
  v_note   text := left(trim(coalesce(p_note, '')), 500);
  v_name   text;
  v_prob   text := case when p_problem in ('qty', 'missing', 'full', 'other') then p_problem else 'other' end;
begin
  if not public.is_active() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v from public.tidy_tasks where id = p_id for update;
  if not found then
    raise exception 'tidy task % not found', p_id using errcode = 'P0002';
  end if;
  -- 时间更早的补传：不盖掉后来的操作
  if v.acted_at is not null and v_at < v.acted_at then
    return v;
  end if;
  v_name := public.stocktake_signer(p_name);

  if p_action = 'moved' then
    if v.kind <> 'move' or v.status not in ('todo', 'problem') then
      return v;
    end if;
    if v_dst = '' then
      v_dst := v.dst;
    end if;
    if not public.tidy_is_slot(v_dst) or v_dst = v.src then
      raise exception 'bad target %', v_dst using errcode = '22023';
    end if;
    update public.tidy_tasks x set status = 'moved', moved_to = v_dst, problem = '',
           note = case when p_note is null then x.note else v_note end,
           acted_by = auth.uid(), acted_by_name = v_name, acted_at = v_at
     where x.id = p_id returning x.* into v;

  elsif p_action = 'problem' then
    if v.status not in ('todo', 'problem') then
      return v;
    end if;
    update public.tidy_tasks x set status = 'problem', problem = v_prob, note = v_note,
           acted_by = auth.uid(), acted_by_name = v_name, acted_at = v_at
     where x.id = p_id returning x.* into v;

  elsif p_action = 'reopen' then
    if v.status not in ('moved', 'problem') or v.exported_at is not null then
      return v;
    end if;
    update public.tidy_tasks x set status = 'todo', moved_to = '', problem = '',
           acted_by = auth.uid(), acted_by_name = v_name, acted_at = v_at
     where x.id = p_id returning x.* into v;

  elsif p_action = 'done' then
    if v.kind = 'pallet' and v.status in ('todo', 'problem') then
      null;
    elsif v.kind = 'move' and v.status = 'moved' then
      if not v_admin then
        raise exception 'not allowed' using errcode = '42501';
      end if;
    else
      return v;
    end if;
    update public.tidy_tasks x set status = 'done', problem = '', closed_at = v_at,
           note = case when p_note is null then x.note else v_note end,
           acted_by = auth.uid(), acted_by_name = v_name, acted_at = v_at
     where x.id = p_id returning x.* into v;

  elsif p_action = 'cancel' then
    if v.status not in ('todo', 'problem') then
      return v;
    end if;
    if v.created_by is distinct from auth.uid() and not v_admin then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    update public.tidy_tasks x set status = 'cancelled', closed_at = v_at,
           acted_by = auth.uid(), acted_by_name = v_name, acted_at = v_at
     where x.id = p_id returning x.* into v;

  elsif p_action = 'retarget' then
    if v.kind <> 'move' or v.status not in ('todo', 'problem') then
      return v;
    end if;
    if not public.tidy_is_slot(v_dst) or v_dst = v.src then
      raise exception 'bad target %', v_dst using errcode = '22023';
    end if;
    if exists (select 1 from public.tidy_tasks y where y.id <> p_id and y.status in ('todo', 'moved', 'problem') and y.src = v_dst) then
      raise exception 'target % is being cleared itself', v_dst using errcode = '23505';
    end if;
    update public.tidy_tasks x set dst = v_dst, same_sku = false, dst_before = null, dst_after = null,
           acted_by = auth.uid(), acted_by_name = v_name, acted_at = v_at
     where x.id = p_id returning x.* into v;

  else
    raise exception 'bad action %', p_action using errcode = '22023';
  end if;
  return v;
end $$;

-- 管理员：这些已搬的移库任务出过移库文件了（记个时间；再出一次也可以）
create or replace function public.tidy_exported(p_ids uuid[]) returns setof public.tidy_tasks
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    update public.tidy_tasks x set exported_at = now(), exported_by = auth.uid()
     where x.id = any (p_ids) and x.kind = 'move' and x.status = 'moved'
    returning x.*;
end $$;

revoke all on function public.tidy_add(jsonb, text) from public, anon;
revoke all on function public.tidy_act(uuid, text, text, text, text, text, timestamptz) from public, anon;
revoke all on function public.tidy_exported(uuid[]) from public, anon;
grant execute on function public.tidy_add(jsonb, text) to authenticated;
grant execute on function public.tidy_act(uuid, text, text, text, text, text, timestamptz) to authenticated;
grant execute on function public.tidy_exported(uuid[]) to authenticated;

-- 实时订阅（已加过就跳过）
do $$
begin
  alter publication supabase_realtime add table public.tidy_tasks;
exception when duplicate_object then null;
end $$;
