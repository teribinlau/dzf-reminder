# DZF 提醒 · DZF Erinnerungen

仓库团队共享提醒：装在每台员工电脑上的桌面应用（Windows / macOS，Tauri 2）+ 手机网页版（PWA），
数据放在 Supabase（法兰克福），所有人实时共享；可指派给个人或班组；中文 / 德语界面。

```
src/            React + TypeScript 前端（桌面和网页共用一份代码）
  lib/          数据层（Supabase / 演示模式）、重复规则展开、本地通知调度、离线缓存
  components/   界面组件（议程日历、看板、详情、新建提醒 …）
  views/        登录、设置、置顶小窗
  i18n/         zh-CN / de-DE 语言包
src-tauri/      桌面壳（托盘、关闭到托盘、置顶提醒小窗、开机自启、自动更新）
supabase/       数据库迁移（表 + 行级权限 + 实时）、初始班组、Notion 同步云函数 + 定时任务
.github/        CI 与发版流水线
```

---

## 1. 第一次部署（约 30 分钟）

### 1.1 Supabase（数据库 + 登录）

1. https://supabase.com → New project，**Region 选 Frankfurt (eu-central-1)**。
2. 左侧 SQL Editor → 新建查询，把 `supabase/migrations/` 里的 `0001_init.sql`、`0002_sync_source.sql`、`0003_submissions.sql` 按顺序整段粘贴运行；再运行 `supabase/seed.sql`（建 4 个班组）。
3. Authentication → Providers → Email：保持开启。
   Authentication → URL Configuration：Site URL 填 Vercel 域名（如 `https://dzf-reminder.vercel.app`），Redirect URLs 加同一个地址。
   Authentication → Email Templates → Magic Link：在正文里加上验证码 `{{ .Token }}`，例如
   `<p>点击链接登录：<a href="{{ .ConfirmationURL }}">登录</a></p><p>或在桌面应用里输入验证码：<b>{{ .Token }}</b></p>`
   （网页版点链接登录，桌面版输入 6 位验证码登录，不需要跳转浏览器。）
4. Settings → API：记下 **Project URL** 和 **anon public key**。

> 第一个用邮箱登录的人自动成为管理员并激活；之后登录的人默认「待激活」，管理员在应用的「设置 → 账户与班组」里激活并分班组。任何邮箱都能收到登录链接，但激活前什么都看不到。

### 1.2 Vercel（手机网页版 + 下载页）

1. 把本仓库推到 GitHub，在 Vercel 里 Import 这个仓库（Framework 自动识别 Vite）。
2. Environment Variables 加 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`。
3. Deploy。打开域名 → 手机浏览器「添加到主屏幕」即可当 App 用。

两个变量都不填时，网站以**演示模式**运行（内置示例数据，不连服务器），适合先看界面。

### 1.3 桌面安装包（GitHub Actions 自动构建）

1. 生成更新签名密钥（只做一次，私钥妥善保存）：
   ```bash
   npx tauri signer generate -w ~/.tauri/dzf.key
   ```
   把输出的**公钥**填到 `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`，
   `endpoints` 已指向 github.com/teribinlau/dzf-reminder 的 Releases（仓库需为公开，否则已装电脑无法下载更新）。
2. 仓库 Settings → Secrets and variables → Actions，添加：
   `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`、`TAURI_SIGNING_PRIVATE_KEY`（`~/.tauri/dzf.key` 文件内容）、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
3. 打 tag 发版：
   ```bash
   git tag v0.1.0 && git push --tags
   ```
   几分钟后 Releases 页面出现 `-setup.exe` 和 `.msi`（Windows 64 位 `x64` / 32 位 `x86` 各一份）、`.dmg`（macOS），
   最后一个 `manifest` 任务会把三个平台合成一份 `latest.json`（并行的打包任务各写一份会互相覆盖，所以单独做一步）。

### 1.4 装到员工电脑

- **Windows**：64 位系统下载 `_x64-setup.exe`，32 位系统下载 `_x86-setup.exe`（设置 → 系统 → 关于 → 系统类型 可查），双击安装。
  装在当前用户目录下，不需要管理员密码，以后自动更新也不会弹 UAC —— **推荐发这个**。
  要按台统一部署（装到 Program Files）可以改用同名的 `.msi`，但之后每次自动更新都会要管理员密码；批量装：`msiexec /i DZF.Reminder_0.1.2_x64_zh-CN.msi /qn`。
  需要 Windows 10 及以上（Win7 / 8.1 没有 WebView2，不能用）。
  没买代码签名证书时首次会出 SmartScreen 提示：点「更多信息 → 仍要运行」。
- **macOS**：打开 `.dmg` 拖到「应用程序」。没有 Apple 签名 + 公证时首次右键 → 打开。
- 首次启动：用公司邮箱收登录链接 → 选语言 → 允许通知。之后开机自启、常驻托盘，关闭窗口不会退出（托盘菜单里「退出」才退出）。
- 共用的打包工位：管理员在「账户与班组」里把该账号的「工位」开关打开，点完成时会先选名字。

### 1.5 以后怎么发新版本（不用再发安装包）

改完代码 → 把 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 里的版本号一起加一位 → 推 main → 打 tag：

```bash
git tag v0.1.3
git push origin v0.1.3
```

已经装了的电脑：应用启动 20 秒后查一次、之后每 6 小时查一次，发现新版本就**在后台下好**，
顶部出现一条绿色提示「新版本 x.y.z 已下载好 · 重启更新」，员工点一下（或下次自己重启应用）就更新完了。
也可以在 设置 → 关于 里手动点「检查更新」。更新包是用 `TAURI_SIGNING_PRIVATE_KEY` 签名的，签名对不上不会安装。

只有这几种情况才需要重新发安装包：新同事的新电脑、装的时候选错了位数、或者有人把应用卸载了。

---

## 2. 本地开发

```bash
cp .env.example .env        # 填 Supabase 地址；留空 = 演示模式
npm install
npm run dev                 # 网页版 http://localhost:1420
npm run tauri dev           # 桌面版（需要 Rust 工具链：https://tauri.app/start/prerequisites/）
npm run tauri build         # 本机打安装包
```

---

## 3. 数据与权限一览

| 表 | 用途 | 谁能改 |
| --- | --- | --- |
| `teams` | 班组（中 / 德名、颜色） | 管理员 |
| `profiles` | 成员：班组、角色（admin / member）、语言、是否工位、是否激活 | 本人改名字 / 语言；管理员改其余 |
| `reminders` | 提醒：时间（UTC）、重复规则（RRULE）、提前量、逾期重复、优先级、可见范围、完成方式 | 创建人、管理员 |
| `reminder_assignees` | 指派给人或班组 | 创建人、管理员 |
| `completions` | 每次到期的完成记录（工位模式记录选的名字） | 本人写，管理员可删 |
| `snoozes` | 稍后提醒，只影响自己的设备 | 本人 |
| `submissions` | 回传文件记录（谁、什么时候、哪个文件）；文件本体在 Storage 私有桶 `submissions`，单文件 ≤ 20 MB | 本人上传；上传人 / 创建人 / 管理员可删 |

可见范围由数据库行级权限强制：仅自己 / 本班组 / 全公司；管理员看全部。

## 4. 提醒是怎么弹的

- 每台电脑自己按「到期时间 − 提前量」定时弹（系统通知 + 提示音 + 高优先级置顶小窗），**不依赖服务器在线**。
- 到点没人完成 → 每 30 分钟（可设）再弹，直到有人点完成；任一人完成，其他人的提醒随实时同步消失。
- 免打扰时段（默认 18:30–07:00 和周末）不弹；上班后补发 12 小时内错过的。
- 重复提醒按 Europe/Berlin 本地时间展开，夏令时切换不受影响；黑森州法定假日自动跳过。
- 断网时可以看缓存、点完成（排队），联网后自动同步（上传文件除外，需要联网）。

## 4a. 让大家填表格 / 交文件

- **关联链接**可以放多条：新建提醒时每行一个，可写「名称 链接」，比如 `盘点表模板 https://…`；Notion 表单、在线表格、WMS 页面都行。详情里点一下就在浏览器打开。
- 勾上 **需要回传文件**：被指派的人必须上传填好的表格 / 照片才能点完成（手机网页版可以直接拍照）。
  详情页列出谁交了什么、什么时候，「每人各自完成」模式下还会显示**未交名单**；创建人 / 管理员可以**全部下载**（打成一个 zip，文件名前面带人名）。
- 工位共用电脑：先选文件，再选是谁，文件就记在那个人名下。
- 文件存在 Supabase Storage 私有桶里，下载用 10 分钟有效的签名链接；权限跟提醒的可见范围一致。

## 4b. 手机上用（PWA）

- 浏览器打开网址 → 「添加到主屏幕」，之后跟装了个 App 一样：全屏、有图标、能离线看缓存。
- 底部四个页签（今天 / 看板 / 设置 / 我的）；iPhone 全屏模式下会自动避开状态栏和底部小横条。
- **安卓返回键**：先关掉当前打开的详情 / 弹窗，全关完了再按才退出应用。
- 列表往下拽不会触发浏览器刷新（在 PWA 里刷新等于重启应用）。
- 网页版有新版本时，关掉应用再打开就会自动换成新的（service worker `autoUpdate`）。

## 5. Notion「到柜登记表」自动同步

入库组在 Notion 里维护的到柜登记表会自动变成提醒（`supabase/functions/sync-notion-containers`）：

- 状态 = **已预约** 的每一柜 → 一条提醒，到柜时段到点、提前 30 分钟提醒、逾期每 60 分钟再提；**可见范围是全公司**（谁都能看到今天到几个柜），指派给整个入库组；点开有 Notion 那一行的链接
- 每个有到柜的日期 → 前一个工作日 16:00 一条「明天到柜 N 柜」汇总
- 表里改日期 / 时段 / 信息 → 提醒跟着改；状态改成 **已卸柜** → 自动完成（完成人显示 `Notion · 已卸柜`）；**改期 / 取消 / 爽约** → 自动消失
- 卡片和详情上带 `Notion` 标记；在应用里改这类提醒会被下次同步覆盖，请在 Notion 里改
- 定时同步只看最近 7 天起的行；要把更早的历史（已卸柜的柜）补成已完成记录，手动 POST 一次带 `{"since":"2026-08-01"}` 的请求即可（见下面第 5 步），重复跑不会重复建

部署（一次性）：

1. Notion：https://www.notion.so/profile/integrations → New integration（类型 Internal，验证方式「访问令牌」）→ 复制 `ntn_…` 密钥；到「到柜登记表」页面 `···` → Connections → 加上这个集成。
2. Supabase → SQL Editor 跑 `supabase/migrations/0002_sync_source.sql`。
3. Supabase → Edge Functions → 新建函数 `sync-notion-containers`，把 `supabase/functions/sync-notion-containers/index.ts` 贴进去部署，**关闭 Verify JWT**；
   Secrets 里加 `NOTION_TOKEN`（第 1 步的密钥）、`SYNC_SECRET`（随便一串长口令）、可选 `NOTION_DATABASE_ID`。
4. SQL Editor 跑 `supabase/cron.sql`（先把里面的 `<PROJECT_REF>` 和 `<SYNC_SECRET>` 换掉）→ 之后每 15 分钟同步一次。
5. 手动跑一次验证：`curl -X POST https://<ref>.supabase.co/functions/v1/sync-notion-containers -H "x-sync-secret: <SYNC_SECRET>"`，
   返回 `{"ok":true,"created":…}`；`select * from sync_runs order by id desc` 能看到日志。
   补历史：同样的请求加 `-H "Content-Type: application/json" -d '{"since":"2026-08-01"}'`（或在 SQL Editor 里用 `net.http_post` 发，参考 `supabase/cron.sql`）。

## 6. 以后可加

- 承运商时刻表（设置里一张表自动生成每天的截单 / 取件提醒）——现在先用「新建提醒」里的承运商模板手动建。
- 手机推送（Supabase Cron + Web Push）。
- 与 EC-WMS 联动。
