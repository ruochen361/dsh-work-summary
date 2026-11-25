# dsh-work-summary · 每日工作日报

把原来「一条长提示词 + 两个 PowerShell 脚本」的日报自动化收进一个插件：采集、校验、写盘、推看板由工具确定性地完成，模型只负责写正文。

插件自己的文件都放在 `~/.dsh/dsh-work-summary`（Windows：`%USERPROFILE%\.dsh\dsh-work-summary`）：日报、看板、`_源数据`、`_日志`、`settings.json`。首次激活时自动创建，目录可在设置页改。

## 它提供什么

| 工具 | 作用 |
|---|---|
| `daily_report_collect` | 运行 `collect-day.ps1` 采集当天痕迹，返回源数据路径、小节清单、看板未完成条数，以及六节日报模板 |
| `daily_report_save` | 校验六个固定小节（一、今日概览 … 六、明日开场清单），写 `日报-YYYY-MM-DD.md`，再把「明日开场清单」推进看板 |
| `daily_report_board` | `show` 列未完成待办；`done` 移到「已完成」；`drop` 移到「已放弃」 |

`daily_report_save` 缺小节、只写了骨架、或留有 `TODO / 待填 / {{…}}` 时会直接报错且**不写文件**，按报错补齐后重调即可；同一日期重复提交会整篇覆盖。采集是只读的，只写 `_源数据` 目录。

## 计划任务

`scheduleEnabled` 打开时（默认打开），插件在激活后确保存在一条每日计划任务，时区与时间由 `scheduleTimeZone` / `scheduleTime` 决定（默认 `Asia/Shanghai` 23:00）：

- 已有同标题（`scheduleTitle`）任务：同步它的提示词到当前版本；
- 否则认领提示词里引用 `collect-day.ps1` 的旧日报任务，改写它的提示词，**保留原来的时间与投递会话**；
- 都没有才新建一条，投递到可复用的新会话（`new_once`）。

计划任务只是把流程讲一遍，正文规则仍以 `promptPath`（默认插件目录下的 `PROMPT.md`）为准，改规则不用改插件代码。

## 侧边栏页面

插件带一个浏览器半（`client.js`，由 `package.json` 的 `dsh.client` 声明）：在左侧栏注册「日报」入口，点击后在主区打开同名页面，不必切换会话。

- 日报列表按日期倒序，点一天看正文；标题、列表、表格、引用做了轻量排版，其余按纯文本渲染。
- 看板按「待办 / 进行中 / 已完成 / 已放弃」分节展示，未完成与已完成用不同色块区分。
- 「设置」标签可以改日报文件目录、工作空间、每日触发时间、临时暂停或恢复投递、改运行日志目录：读写走 `GET|POST /dsh-work-summary/schedule`，POST body 为 `{"reportDir":"D:\\reports"}`、`{"time":"HH:MM"}`、`{"active":true|false}` 或 `{"workspace":"D:\\projects"}` 或 `{"logDir":"D:\\logs"}`（logDir 空串表示回落到默认目录）。
- 定时时间以那条计划任务的 rrule 为唯一真源：设置页直接 `schedule.edit` 改 `timing`，不写 YAML，也不另存配置，所以重启后不会被 `scheduleTime` 默认值盖回去（它只在需要新建任务时用一次）。
- 页面数据由 Host 的路由提供：`GET /dsh-work-summary/state`（看板全文 + 最近 90 天日报正文，`cache-control: no-store`）与上面那条设置路由。
- 页面不改日报与看板文件。要标记完成或放弃，用 `daily_report_board` 工具，或命令行跑 `push-to-board.ps1 -Done/-Drop`。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `reportDir` | `~/.dsh/dsh-work-summary` | 数据目录：日报、看板、源数据（不含代码）；设置页可改 |
| `workspace` | `~/.dsh/dsh-work-summary` | 采集脚本扫描的工作区根；想看自己的工作区就改成那 |
| `scriptDir` | `<插件目录>\scripts` | 两个 PowerShell 脚本的位置，随仓库走 |
| `promptPath` | `<插件目录>\PROMPT.md` | 日报正文规则，随仓库走 |
| `pwsh` | `pwsh` | PowerShell 可执行文件 |
| `timeoutMs` | `240000` | 单个脚本超时 |
| `pushOnSave` | `true` | `daily_report_save` 默认是否推看板 |
| `scheduleEnabled` | `true` | 是否托管计划任务 |
| `scheduleAdopt` | `true` | 是否认领旧日报任务 |
| `scheduleTitle` | `每日工作日报` | 插件自建任务的标题 |
| `scheduleTime` | `23:00` | 触发时间 HH:mm |
| `scheduleTimeZone` | `Asia/Shanghai` | 触发时区，也用于判断「今天」 |
| `logDir` | `<reportDir>\_日志` | 运行日志目录；设置页改它，留空用默认 |

## 运行日志

每次调用脚本都往 `logDir` 里追加一行，文件按天切：`dsh-work-summary-YYYY-MM-DD.log`。

```
2026-11-23 14:31:42 [info] push-to-board.ps1 -Report ~\.dsh\dsh-work-summary\日报-2026-11-23.md -BoardPath ~\.dsh\dsh-work-summary\看板.md → exit 0，812ms
```

- 记的是：脚本名、参数、退出码、耗时；失败时再带 stderr 尾部（截 800 字符）。
- 计划任务同步/认领/创建、设置页改日报/日志目录也会落一行。
- 日志目录不可写不会影响日报本身（写失败直接跳过）。
- 设置页的「日志 · 目录」改的就是它，空值表示回落到 `<reportDir>\_日志`；设置（日报目录 + 工作空间 + 日志目录）存在 `~/.dsh/dsh-work-summary\settings.json`。

## 使用示例

```
帮我补一下 2026-11-18 的日报
→ daily_report_collect { date: "2026-11-18" }
→ 读 sourcePath，写正文
→ daily_report_save { date: "2026-11-18", content: "…" }
```

日常只需说「写今天的日报」，模型会依次调用 collect → save。

## 限制

- 代码（`scripts\` 与 `PROMPT.md`）随插件仓库走，`reportDir` 只放运行期数据；插件不改写它们，只调用。
- 采集脚本依赖 `zstd.exe` 解析会话，缺失时该段自动降级为空。
- 调用脚本走 `pwsh -Command`，命令开头固定把 `[Console]::OutputEncoding` 与 `$OutputEncoding` 设为 UTF-8。管道重定向下 pwsh 默认按系统 ANSI（936）写 stdout，Node 按 utf8 解码就会得到乱码，`已写入 N 条` 这类中文输出将解析失败；改动这行前请先跑一次 `daily_report_board show` 确认中文正常。
- 计划任务只在 Host 运行时投递；关闭插件前请先停掉或改回插件自建的任务，否则投递到的会话会调用不到工具。
- 日报只看文件与会话痕迹，线下工作仍需手动补一句。
