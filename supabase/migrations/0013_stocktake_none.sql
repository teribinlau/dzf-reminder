-- 0013 盘点：库位状态加「无」（none）
--
-- 「无」= 这个库位号现在没有实际能用的位置。比如这一列有一层放了 2 个大托，该列每层第 2 个号就都标「无」；
-- 要挪开旁边的托盘才放得下的也标「无」，备注写「挪」（或 move）。
--
-- 只放宽 stocktake_rows.status 的取值，不改、不删任何已有的盘点记录。
-- stocktake_mark() 不检查状态值、「还能放」照旧只在「半」时保存，所以函数不用改；
-- stocktake_progress 视图按 status is not null 算已盘，「无」自然算已盘。
--
-- 在 Supabase → SQL Editor 里整段执行一次即可（重复执行也没关系）。

begin;

-- 0011 建表时写的是列上的 check（没起名字，Postgres 自动叫 stocktake_rows_status_check）：
-- 按定义找，名字不一样也能删掉
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'public.stocktake_rows'::regclass
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ~ '\mstatus\M'
  loop
    execute format('alter table public.stocktake_rows drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.stocktake_rows
  add constraint stocktake_rows_status_check
  check (status in ('empty', 'half', 'full', 'none', 'odd'));

commit;

-- 执行完可以这样看一眼（三条：actual、can_add，和包含 'none' 的 status）：
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--  where conrelid = 'public.stocktake_rows'::regclass and contype = 'c';
