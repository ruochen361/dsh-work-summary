# AGENTS.md

本文件给在本仓库工作的编码代理。动手前先读这里，再看 `docs/ROADMAP.md` 与 `docs/DETAIL.md`。

## 项目

`dsh-work-summary` 是 DeepSeek Harness（DSH）插件，由三部分组成：

- **Host** `index.js`：ESM，注册工具、HTTP 路由、计划任务；不直接读写浏览器。
- **浏览器半** `client.js`：通过 `window.__ModuleLoader__.load(...)` 挂侧边栏「日报」页面，含看板、日报、周期、统计、设置五个视图，默认落在看板；日报页顶部有只读的主线面板（未清 / 挂起），统计页含热力图、产出趋势与看板交付结构。
- **脚本半** `scripts/*.ps1`：PowerShell 7 采集与看板操作，由 Host 通过 `pwsh` 调用。

运行期数据默认在 `~/.dsh/dsh-work-summary`，不属于代码仓库。不要 import `@deepseek-ai/*`：插件按本地 link 安装，没有 `node_modules`。

## 目录

| 路径 | 作用 |
|---|---|
| `index.js` | Host：工具、校验、HTTP、计划任务、周期区间解析 |
| `client.js` | 侧边栏面板与设置页 |
| `scripts/collect-day.ps1` | 单日采集：从近两天有活动的 DSH 会话自动发现工作区，多根扫描改动 / Git / 产物；写 `_源数据/YYYY-MM-DD.md`；超过 60 个按季度归档到 `_归档` |
| `scripts/collect-range.ps1` | 区间采集，写 `_源数据/周期-from_to.md` |
| `scripts/push-to-board.ps1` | 日报/周报/月报的末节推看板，按指纹去重；也可改条目优先级/截止日/状态 |
| `PROMPT.md` | 日报/周期正文规则，运行期读取 |
| `test/route.test.mjs` | 假 ctx 驱动 Host：工具、路由、计划任务、参数校验、热力图统计、看板写回 |
| `test/period.test.mjs` | 周期聚合：四节、命名、offset、看板去重、主线按工作区分组与跨期受阻、拒绝非法区间 |
| `test/quality.test.mjs` | 质量软校验：空话/缺证据仍落盘、正常日报零提醒、阈值配置 |
| `test/archive.test.mjs` | 源数据归档：保留 60 个、季度包字节一致、失败不阻断 |
| `test/board-start.test.mjs` | 看板开工：提示词、当前工作区选择、建会话并发送、拒绝原因、无工作区 |
| `test/stats.test.mjs` | 统计页：趋势补零、7 日均值、默认 30 天窗口、看板交付计数、空看板、渲染冒烟 |
| `test/markdown.test.mjs` | 正文表格：表头合成、对齐、列裁剪补空、转义竖线、无分隔行回退纯文本 |
| `test/workspace.test.mjs` | 工作区发现：会话 cwd 自动发现、`_工作区.md` 别名与忽略、父子去重、无会话回退 |
| `test/mainline.test.mjs` | 主线账本：生成、旧 ID 复用、未知 ID 拒绝、挂起提醒、采集第 7 节、缺状态行 / 否定状态 / 单数字 ID、补写不回拨、备注保留 |
| `docs/DETAIL.md` | 机制与配置细节 |
| `docs/ROADMAP.md` | 需求清单，一需求一 ID |

## 命令

```powershell
npm run check                      # node --check index.js && node --check client.js
npm test                           # stats + markdown + workspace + mainline + board-start + route + period + quality + archive 九份测试
node test/stats.test.mjs           # 单跑（纯客户端，不启动 pwsh）
node test/markdown.test.mjs        # 单跑（纯客户端，不启动 pwsh）
node test/workspace.test.mjs       # 单跑（启动 pwsh + zstd 造会话文件）
node test/mainline.test.mjs        # 单跑（启动 pwsh 采集第 7 节）
node test/route.test.mjs           # 单跑
node test/period.test.mjs          # 单跑
node test/quality.test.mjs         # 单跑
node test/archive.test.mjs         # 单跑
node test/board-start.test.mjs     # 单跑
```

测试会启动 `pwsh`。在 DSH 沙箱里，受限模式会因命名管道报 `Access to the path '\\.\pipe\LOCAL\dotnet_...' is denied`，需要以完整权限运行；`mainline.test.mjs` 的子进程用 `stdio: 'inherit'`，受限模式下也能单跑。测试使用 `test/.tmp-period`、`test/.tmp-quality`、`test/.tmp-archive`、`test/.tmp-workspace`、`test/.tmp-mainline` 与 `_probe` 作为临时根，不要指向真实的 `~/.dsh/dsh-work-summary`。

## 编码约定

- Node ESM；2 空格缩进、单引号、不写分号，跟随现有文件风格。
- 面向用户的文案用中文；报错要说明「哪里错、怎么改」，不要只抛状态码。
- 日期一律用 `YYYY-MM-DD` 字符串。日期运算走 `parseDay` / `shiftDay` / `daysBetween` 的 UTC 逻辑，不要用本地时区 `new Date('YYYY-MM-DD')` 做天数计算。
- 周区间以周一为起点；计划任务时间使用 `scheduleTimeZone`（默认 `Asia/Shanghai`），「今天」用 `dateInZone`。
- 日报固定六节（`SECTIONS`），周报/月报固定四节；缺节、正文过短、含 `TODO`/`待填`/`{{` 必须在写文件前抛错。
- 日报质量软校验只返回 `warnings` 并拼进 `text`，不得阻断落盘；阈值 `quality.minEvidence` 默认 3，支持嵌套与扁平点号键。
- 主线是「一次完整交付」，可以跨天跨工作区；日报用 `#### M-YYYY-MM-DD-NN 标题` 标记（序号固定两位），`daily_report_save` 是 `_主线.md` 的唯一写方：先校验引用（未知旧 ID、新 ID 缺小节、缺 `- 状态：` 行、非法状态、单数字序号都报错且日报与账本都不写），再合并（旧 ID 不追加、首次产出取小、最近产出取大；状态与判据只在日报日期不早于最近产出时更新，补写旧日报不回拨）。挂起阈值 `mainline.stallDays` 默认 3，判定在 `mainlineView`，采集第 7 节与周期首节用同一规则。
- 看板按标题/条目指纹去重；周报/月报推最后一节，调用 `push-to-board.ps1 -Section <末节名>`。条目优先级/截止日/状态用 `-Update` 改，页面走 `POST /dsh-work-summary/board`。
- 看板「开工」是纯客户端：当前工作区 `sessions.create` → `sessions.using` 里 `session.prompt(..., 'queue')` 确认发送成功 → `uiWorkspace.openSession`；不改 Host 路由与看板文件。
- 工作区不靠登记：`collect-day.ps1` 从 `session.v4.jsonl.zstd` 的 `cwd` 自动发现近两天有活动的根，工作区数量上限 12、单区文件 400、仓库 12、目录 20000；只精确忽略 `HOME` 本身（家目录下的项目仍可发现），`_工作区.md` 只用于别名（`- <绝对路径> = <显示名>`）与忽略（`- <绝对路径>`），`<!-- -->` 注释块不生效；`settings.json` 的 `workspace` 是额外固定的根，可留空，但显式也不接受盘符根。子工作区从父区扫描中剪掉，避免重复计数。
- 计划任务按标题识别。日报的 `findOwnTask` 会排除提示词含 `work_summary_period` 的任务；周期提示词不要写 `dsh-work-summary`，否则可能被日报认领。
- 测试与脚本不得写入真实数据目录；临时文件放 `test/`、`_probe/`，并确认已在 `.gitignore` 中。

## 改动流程

1. 先确认需求在 `docs/ROADMAP.md` 有 ID；只增不改号，完成时标「已完成」并补「实际改动」。
2. Host、客户端、`PROMPT.md`、文档一起改；只改 Host 不会有客户端入口，只改客户端不会创建任务。
3. 新行为补测试：成功路径、拒绝路径、重复执行的幂等性（例如同一区间第二次推看板为 0）。
4. 功能变更升 `package.json` 版本；README 保持 GitHub 首页的简短版，细节放 `docs/DETAIL.md`。
5. 提交前跑 `npm run check` 与 `npm test`；Host 改动需要重启 DSH 才生效，客户端页面刷新后加载。
6. 除非用户明确要求，不要 `git commit`；结束时说明改了哪些文件、测试结果、是否重启生效。

## 当前基线

- 计划任务默认：日报 `23:00`；周报每周一 `01:00` 生成上一周；月报每月 1 号 `01:00` 生成上一个自然月。
- 周期工具：`work_summary_period { from, to, kind?, offset?, content?, push? }`；`offset: 1` 取上一完整周期，不能与 `from`/`to` 同传。
- 数据文件命名：`日报-YYYY-MM-DD.md`、`周报-from_to.md`、整月 `月报-YYYY-MM.md`、非整月 `月报-from_to.md`、自定义 `周期-from_to.md`。
- 源数据归档：`_源数据` 只保留最近 60 个 `.md`；更旧的按数据日期分季度写入 `_归档/YYYY-QN.zip`，成功校验条目后才删原文件，失败只记一行且不阻断采集。
- 工作区：采集窗口是「日历日 D-1 ~ D」两个自然日；源数据第 0 节列出发现的工作区（名字、路径、会话数、工具调用数、当日改动文件数），Host 解析成 `workspaces` 随采集结果返回；页面只读展示，不提供编辑。
