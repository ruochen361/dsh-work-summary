# dsh-work-summary · 日报 / 周报 / 月报

把「定时写工作日报」扩展成日报、周报、月报三条流水线：采集、校验、写盘、推看板由工具确定性地完成，模型只负责写正文。

运行期数据都放在 `~/.dsh/dsh-work-summary`（Windows：`%USERPROFILE%\.dsh\dsh-work-summary`）：日报、周报/月报、看板、`_源数据`、`_归档`、`_日志`、`settings.json`。首次激活时自动创建，目录可在设置页改；代码与提示词随插件仓库走。

## 它提供什么

| 工具 | 作用 |
|---|---|
| `daily_report_collect` | 运行 `collect-day.ps1` 采集当天痕迹，返回源数据路径、小节清单、看板未完成条数，以及六节日报模板；超过 60 个源数据时自动按季度归档 |
| `daily_report_save` | 校验六个固定小节（一、今日概览 … 六、明日开场清单），写 `日报-YYYY-MM-DD.md`，再把「明日开场清单」推进看板；返回质量软校验 `warnings` |
| `work_summary_period` | 跑 `collect-range.ps1` 采集区间底稿，按区间日报 + 看板拼四节周报/月报，同款校验后落盘并推看板；`offset: 1` 取上一周期 |
| `daily_report_board` | `show` 列未完成待办；`done` 移到「已完成」；`drop` 移到「已放弃」 |

`daily_report_save` 缺小节、只写了骨架、或留有 `TODO / 待填 / {{…}}` 时会直接报错且**不写文件**，按报错补齐后重调即可；同一日期重复提交会整篇覆盖。采集写 `_源数据`，超过 60 个时自动把旧文件归档到 `_归档`。

## 质量自检（软校验）

质量检查在结构硬校验之后、写盘之前执行，**只返回提醒，不改变落盘结果**。`daily_report_save` 的结果多一个 `warnings` 数组，`text` 里也会列出同样内容：

- **证据密度**：统计正文中的路径（Windows 盘符、UNC、POSIX/相对路径、带扩展名文件名）与 7–40 位十六进制提交号，去重后少于 `quality.minEvidence`（默认 3）就提醒。
- **空话词**：命中「继续推进 / 加强沟通 / 持续优化 / 进一步提升 / 稳步推进 / 深入推进 / 扎实做好 / 高度重视 / 协同发力 / 形成闭环 / 提质增效 / 落地见效」时列出命中词，提醒换成具体动作、对象或结果。
- **建议可执行性**：`## 五、后续建议` 里既没有路径，也没有命令（`npm test`、`pwsh …`、`Get-…` 等）时提醒补具体文件或命令。

`quality.minEvidence` 可以写成嵌套对象，也兼容扁平的 `quality.minEvidence` 键；非正整数退回默认 3。`warnings` 为空表示没发现问题，日报照常写入并推看板。

## 源数据归档

每次 `collect-day.ps1` 结束时会数一遍 `_源数据/*.md`。超过 60 个时，按文件名里的数据日期排序，把最旧的超出部分按季度打进 `_归档/YYYY-QN.zip`：

- 只处理不是当天的文件；当天文件永远留在 `_源数据`。
- 打包后先读 zip 条目，确认这些文件都在，再删除原文件；失败只写一行「归档失败」，采集照常以退出码 0 结束。
- 同一季度包已存在时用 `-Update` 追加，并在 `_归档/索引.md` 追加一行（归档时间、季度、新增数、区间、包名）。
- 归档结果同时写进当天源数据的「6. 源数据归档」和运行日志；没触发归档时两处都不写。

## 周报 / 月报聚合

`work_summary_period { from?, to?, kind?, offset?, content?, push? }` 把「一段区间」当成一份更大的日报来做：

- 区间：`from` / `to` 成对；都不传时 `week` 取本周一至今天、`month` 取本月 1 号至今天。`kind` 可省，整月判 `month`、跨度 7 天判 `week`、其余 `custom`；最长 400 天。定时任务用 `offset: 1` 取上一个周期（上一周 / 上一月），`offset` 取 0–60，且不能与 `from` / `to` 同时给。
- 采集：`scripts/collect-range.ps1` 写 `_源数据/周期-<from>_<to>.md`，含区间概况、日报覆盖、每日概览、产出汇总、问题与风险、开场清单、看板现状、Git 提交、工作区改动、源数据覆盖、复发候选。
- 正文：四节固定（首节 `本周/本月/本期主线`，末节 `下周/下月/下期开场`，中间「关键产出」「未清与复发」）。不传 `content` 时从区间日报 + 看板自动拼草稿；传了就走同一套缺节 / 空骨架 / 占位符校验。
- 落盘：周报 `周报-<from>_<to>.md`；整月 `月报-YYYY-MM.md`，非整月 `月报-<from>_<to>.md`；自定义 `周期-<from>_<to>.md`。
- 看板：只推最后一节，`push-to-board.ps1 -Section <末节名>`，按标题 / 条目指纹去重，同一区间连跑第二次新增 0 条。

## 计划任务

`scheduleEnabled` 打开时（默认打开），插件在激活后确保存在三条托管任务。日报按标题（精确或前缀）识别，周报 / 月报按各自标题识别；日报还会用提示词认领引用 `collect-day.ps1` 的旧任务，避免互相认领：

- **日报**：标题 `scheduleTitle`（默认 `每日工作日报`），时间 `scheduleTime`（默认 23:00）。
- **周报**：标题 `weekScheduleTitle`（默认 `每周工作周报`），每周一 `weekScheduleTime`（默认 01:00），生成上一周（周一至周日）。
- **月报**：标题 `monthScheduleTitle`（默认 `每月工作月报`），每月 1 号 `monthScheduleTime`（默认 01:00），生成上一个自然月。

已有任务时：同步提示词到当前版本；周报 / 月报还会把任务的时间与启停对齐 `settings.json` 里保存的值（小时或分钟不同才改 rrule）。都没有时：

- 日报：`scheduleAdopt` 打开则先认领提示词里引用 `collect-day.ps1` 的旧任务，改写提示词但**保留原来的时间与投递会话**；否则新建一条，投递到可复用的新会话（`new_once`）。
- 周报 / 月报：对应 `weekScheduleEnabled` / `monthScheduleEnabled` 为 `true`（默认）才新建，`false` 就不建。

设置页改周报 / 月报的时间或启停时，先写 `settings.json` 再 `schedule.edit`；任务被删掉后，下次重启会按保存的值重建。日报时间仍然只改任务自己的 rrule。

计划任务只是把流程讲一遍，正文规则仍以 `promptPath`（默认插件目录下的 `PROMPT.md`）为准，改规则不用改插件代码。周期任务的提示词要求调用 `work_summary_period` 并传 `{"kind":"week","offset":1}`（月报同理），由工具自己算上一周期。

新建的周报 / 月报任务从下一个触发点开始，不会补跑刚过去的周期；要补当期报告，直接手动调一次 `work_summary_period`。

## 侧边栏页面

插件带一个浏览器半（`client.js`，由 `package.json` 的 `dsh.client` 声明）：在左侧栏注册「日报」入口，点击后在主区打开同名页面，不必切换会话。

- 日报列表按日期倒序，点一天看正文；「周期」标签单列周报/月报，点一份看整篇；「热力图」按天展示最近 13 周的产出强度，点格子跳到当天日报；标题、列表、表格、引用做了轻量排版，其余按纯文本渲染。
- 看板按「待办 / 进行中 / 已完成 / 已放弃」分节展示，未完成与已完成用不同色块区分。
- 「设置」标签可以改日报文件目录、工作空间、日报 / 周报 / 月报的触发时间、临时暂停或恢复投递、改运行日志目录：读写走 `GET|POST /dsh-work-summary/schedule`，POST body 为 `{"reportDir":"D:\\reports"}`、`{"time":"HH:MM"}`、`{"active":true|false}`、`{"weekTime":"HH:MM"}`、`{"weekActive":true|false}`、`{"monthTime":"HH:MM"}`、`{"monthActive":true|false}`、`{"workspace":"D:\\projects"}` 或 `{"logDir":"D:\\logs"}`（logDir 空串表示回落到默认目录）。
- 日报时间以那条任务的 rrule 为唯一真源：设置页直接 `schedule.edit` 改 `timing`，不写 YAML，也不另存配置，所以重启后不会被 `scheduleTime` 默认值盖回去（它只在需要新建任务时用一次）。周报 / 月报的时间与启停额外落到 `settings.json`，重启时再对齐任务，任务被删也能重建。
- 页面数据由 Host 的路由提供：`GET /dsh-work-summary/state`（看板全文 + 最近 91 份日报正文 + 最近 40 份周报/月报，`cache-control: no-store`）与上面那条设置路由。每份日报额外带 `lines`（非空行数）、`outputs`（第三节「结果与产出」里的表格行或列表项数）和 `score = lines + outputs * 3`，顶层带 `today`（按 `scheduleTimeZone` 算的当天）。
- 页面不改日报与看板文件。要标记完成或放弃，用 `daily_report_board` 工具，或命令行跑 `push-to-board.ps1 -Done/-Drop`。

## 贡献热力图

「热力图」页签把最近 13 周（周一起始，最多 91 天，未来格禁用）排成 7 行 × 13 列的日历格，颜色只表示当天日报的 `score`：

- 强度按窗口内**有日报**样本的 25 / 50 / 75 分位动态切 4 档，没有固定阈值；样本少于 4 天时上档会自然空着，不会硬凑。
- 未到日期画成禁用格；有日期但无日报画虚框，点击提示「该日无日报（日期）」；有日报点击切到「日报」页签并定位到该日。
- 格子 `title` / `aria-label` 写明「日期 · N 行 · N 条产出 · 强度 N」，图例注明「行数 + 产出条数 × 3」的口径，颜色不是阅读正文的替代品。
- 数据只来自 `/state`，渲染是纯前端映射；91 格的节点量级不需要额外请求或缓存。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `reportDir` | `~/.dsh/dsh-work-summary` | 数据目录：日报、看板、源数据、归档（不含代码）；设置页可改 |
| `workspace` | `~/.dsh/dsh-work-summary` | 采集脚本扫描的工作区根；想看自己的工作区就改成那 |
| `scriptDir` | `<插件目录>\scripts` | 三个 PowerShell 脚本（单日 / 区间 / 推看板）的位置，随仓库走 |
| `promptPath` | `<插件目录>\PROMPT.md` | 日报正文规则，随仓库走 |
| `pwsh` | `pwsh` | PowerShell 可执行文件 |
| `timeoutMs` | `240000` | 单个脚本超时 |
| `pushOnSave` | `true` | `daily_report_save` 默认是否推看板 |
| `quality.minEvidence` | `3` | 日报软校验要求的最少路径/提交号引用数；嵌套或扁平点号键都可 |
| `scheduleEnabled` | `true` | 是否托管计划任务 |
| `scheduleAdopt` | `true` | 是否认领旧日报任务 |
| `scheduleTitle` | `每日工作日报` | 日报任务标题，也是识别依据 |
| `scheduleTime` / `scheduleTimeZone` | `23:00` / `Asia/Shanghai` | 日报触发时间 / 时区；时区也用于判断「今天」 |
| `weekScheduleEnabled` / `weekScheduleTime` | `true` / `01:00` | 周报任务启停与触发时间（周一生成上一周） |
| `weekScheduleTitle` | `每周工作周报` | 周报任务标题，也是识别依据 |
| `monthScheduleEnabled` / `monthScheduleTime` | `true` / `01:00` | 月报任务启停与触发时间（1 号生成上月） |
| `monthScheduleTitle` | `每月工作月报` | 月报任务标题，也是识别依据 |
| `logDir` | `<reportDir>\_日志` | 运行日志目录；设置页改它，留空用默认 |

## 运行日志

每次调用脚本都往 `logDir` 里追加一行，文件按天切：`dsh-work-summary-YYYY-MM-DD.log`。

```
2026-11-23 14:31:42 [info] push-to-board.ps1 -Report ~\.dsh\dsh-work-summary\日报-2026-11-23.md -BoardPath ~\.dsh\dsh-work-summary\看板.md → exit 0，812ms
```

- 记的是：脚本名、参数、退出码、耗时；失败时再带 stderr 尾部（截 800 字符）。
- 计划任务同步/认领/创建、设置页改目录或周报 / 月报时间也会落一行。
- 日志目录不可写不会影响日报本身（写失败直接跳过）。
- 设置页的「日志 · 目录」改的就是它，空值表示回落到 `<reportDir>\_日志`；设置（日报目录 + 工作空间 + 日志目录 + 周报 / 月报的时间与启停）存在 `~/.dsh/dsh-work-summary\settings.json`。

## 使用示例

```
帮我补一下 2026-11-18 的日报
→ daily_report_collect { date: "2026-11-18" }
→ 读 sourcePath，写正文
→ daily_report_save { date: "2026-11-18", content: "…" }
```

日常只需说「写今天的日报」，模型会依次调用 collect → save。

```
帮我写上周的周报
→ work_summary_period { from: "2026-11-18", to: "2026-11-24", kind: "week" }
→ 工具跑 collect-range.ps1、拼四节草稿、写 周报-2026-11-18_2026-11-24.md、推看板
→ 回复里给：文件路径 + 本周主线 3 条以内
```

也支持 `{ "kind": "month" }` 不传日期（本月 1 号至今天）、`{ "kind": "week", "offset": 1 }` 取上一周，或传 `content` 自己写四节正文。

## 仓库文件与协作

| 文件 | 用途 |
|---|---|
| `AGENTS.md` | 给编码代理的项目约定：结构、命令、日期与时区、校验与发版流程 |
| `README.md` | GitHub 首页的简短版：功能、安装、工具、常用配置、数据布局 |
| `docs/DETAIL.md` | 本文：机制、计划任务、设置路由、完整配置与限制 |
| `docs/ROADMAP.md` | 需求清单，一需求一 ID；完成时补「实际改动」 |
| `PROMPT.md` | 运行期正文规则，改完下一轮生成生效 |
| `test/route.test.mjs` | 假 ctx 驱动 Host：工具、路由、计划任务、参数校验 |
| `test/period.test.mjs` | 周期聚合：四节、命名、offset、看板去重、非法区间 |
| `test/quality.test.mjs` | 质量软校验：空话/缺证据仍落盘、正常日报零提醒、两种阈值配置 |
| `test/archive.test.mjs` | 源数据归档：保留 60 个、季度包字节一致、重复采集不追加、失败不阻断 |

```powershell
npm run check   # node --check index.js / client.js
npm test        # 四份测试串行跑
```

测试会启动 `pwsh`；受限沙箱可能因命名管道拒绝访问，需要完整权限。测试只写 `test/.tmp-period`、`test/.tmp-quality`、`test/.tmp-archive` 与 `_probe` 临时根，不碰真实数据目录。

## 限制

- 代码（`scripts\` 与 `PROMPT.md`）随插件仓库走，`reportDir` 只放运行期数据；插件不改写它们，只调用。
- 采集脚本依赖 `zstd.exe` 解析会话，缺失时该段自动降级为空。
- 调用脚本走 `pwsh -Command`，命令开头固定把 `[Console]::OutputEncoding` 与 `$OutputEncoding` 设为 UTF-8。管道重定向下 pwsh 默认按系统 ANSI（936）写 stdout，Node 按 utf8 解码就会得到乱码，`已写入 N 条` 这类中文输出将解析失败；改动这行前请先跑一次 `daily_report_board show` 确认中文正常。
- 计划任务只在 Host 运行时投递；关闭插件前请先停掉或改回插件自建的任务，否则投递到的会话会调用不到工具。
- 日报只看文件与会话痕迹，线下工作仍需手动补一句。
