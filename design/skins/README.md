# 皮肤的来源

应用里「设置 → 通用 → 皮肤」的几套配色都是从这里的 DESIGN.md 翻译成 CSS 变量的（`src/skins.css`）。

| 皮肤 | 来源 | 怎么来的 |
| --- | --- | --- |
| opencode.ai | `opencode.ai/DESIGN.md` | `npx getdesign@latest add opencode.ai`（getdesign，MIT） |
| Notion | `notion/DESIGN.md` | `npx getdesign@latest add notion` |
| Popcart | `popcart/DESIGN.md` | 自己在 Claude Design 里做的「Popcart Design System」，摘了 token |

## 再加一套

1. `npx getdesign@latest list` 看有哪些，`npx getdesign@latest add <brand> --out design/skins/<brand>/DESIGN.md`
2. 在 `src/skins.css` 里照着现有的写一段 `:root[data-skin='<id>'] { … }`，把 DESIGN.md 的 colors / rounded / typography 对到这些 token：
   `--bg --bg-2 --card --surface --ink --muted --faint --ghost --hair --hair-2 --red --red-ink --green --amber
    --primary --primary-hover --on-primary --link --warn-ink --callout-bg --callout-line --glass --glass-strong --scrim
    --shadow-sm --shadow --shadow-lg --rs（圆角倍数） --font --font-display`
3. `src/lib/types.ts` 的 `Skin` 加上 id；`src/lib/skins.ts` 的 `SKINS` 加一行（名字、预览色），`FONT_LOADERS` 里加字体
   （`npm i @fontsource/<font>`，只 import `latin-<weight>.css`）
4. 深色皮肤目前没有：`--on-ink`、几处写死的投影和 `#fff` 头像字（团队颜色上）还是按浅色底设计的，做深色要一起检查。
