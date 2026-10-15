-- DZF 提醒 · v0.6.5：Notion 同步过来的提醒按每个人的语言显示
-- 在 Supabase Dashboard → SQL Editor 里整段执行（重复执行无害）。
--
-- reminders 多两列：title_de / notes_de = 德语版的标题和备注，可以为空。
-- 只有 Notion 同步函数（v3 起）会填：固定的词（到柜、入库单号、货柜、卸柜方、货物、备注、明天到柜 N 柜）翻成德语，
-- 表里同事手写的内容原样保留；发货方名字按对照表换（盘古 → teknihall）。
-- 应用在德语界面下有 title_de 就显示它，没有就还是显示中文；手动建的提醒这两列是空的，什么都不变。
-- 权限不用改：还是同一行 reminders，谁能看这条提醒就能看到它的德语版。

alter table public.reminders
  add column if not exists title_de text,
  add column if not exists notes_de text;
