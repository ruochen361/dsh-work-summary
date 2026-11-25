# dsh-work-summary

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

DeepSeek Harness 插件：把「每天定时写一份工作日报」变成一条确定流水线——**采集、校验、落盘、推看板交给工具，模型只写正文**。

- 采集工作区当天的改动、Git 提交、DSH 会话、看板与产物目录，生成源数据底稿；
- 正文强制六节结构，缺节、空骨架、占位符直接报错且不写文件；
- 写盘后把「明日开场清单」按指纹去重推进看板，已完成 / 已放弃可回写；
- 侧边栏内置页面：读日报、看待办、改定时与目录，不用切会话。

## 安装

```bash
# 从 npm 安装（已发布时；也可在设置 → 插件里填包名）
plugin_manager install_bundle dsh-work-summary

```

装完重启 DSH。默认数据目录 `~/.dsh/dsh-work-summary` 在首次激活时自动创建，首次启用还会接管（或新建）每日计划任务，保留原有的触发时间与投递会话。

## 工具

| 工具 | 作用 |
|---|---|
| `daily_report_collect` | 采集当天痕迹，返回源数据路径、小节、看板未完成数、六节模板 |
| `daily_report_save` | 校验六节 → 写 `日报-YYYY-MM-DD.md` → 推看板 |
| `daily_report_board` | `show` 未完成；`done` 移到已完成；`drop` 移到已放弃 |

## 配置

设置页（侧边栏「日报 → 设置」）改的值写在 `~/.dsh/dsh-work-summary/settings.json`，优先级高于默认值；其余键可在 profile 的 `cordis.patch.yml` 里覆盖。

| 键 | 默认 | 说明 |
|---|---|---|
| `reportDir` | `~/.dsh/dsh-work-summary` | 数据目录：日报、看板、源数据、日志 |
| `workspace` | 同 `reportDir` | 采集扫描的工作区根，指向你平时干活的目录才有料 |
| `logDir` | `<reportDir>\_日志` | 运行日志，按天切 `dsh-work-summary-YYYY-MM-DD.log` |
| `scheduleEnabled` / `scheduleAdopt` | `true` / `true` | 托管 / 认领每日计划任务 |
| `scheduleTime` / `scheduleTimeZone` | `23:00` / `Asia/Shanghai` | 仅新建任务时用；之后以任务自身 rrule 为准 |
| `pwsh` / `timeoutMs` | `pwsh` / `240000` | PowerShell 可执行文件与单次超时 |

> 定时时间不写进 YAML：设置页改的是计划任务自己的 rrule，重启不会被默认值盖回去。

## 数据布局

```
~/.dsh/dsh-work-summary/
├── 日报-YYYY-MM-DD.md     # 日报正文
├── 看板.md                # 待办看板（- [ ] 未完成）
├── _源数据/YYYY-MM-DD.md  # 采集底稿，只读生成
├── _日志/                 # 运行日志
└── settings.json          # 设置页保存的选项
```

代码随插件仓库走（`scripts/`、`PROMPT.md`），数据目录只放运行期产物，不进版本库。

## 手动跑脚本

```powershell
pwsh -File .\scripts\collect-day.ps1 -Workspace D:\work -ReportDir "$env:USERPROFILE\.dsh\dsh-work-summary"

pwsh -File .\scripts\push-to-board.ps1 -BoardPath "$env:USERPROFILE\.dsh\dsh-work-summary\看板.md" -Show
pwsh -File .\scripts\push-to-board.ps1 -BoardPath ...\看板.md -DryRun    # 预演，不写
pwsh -File .\scripts\push-to-board.ps1 -BoardPath ...\看板.md -Done "关键词"
```

`-BoardPath` 必须显式传：脚本不猜看板位置，避免搬家后写错目录。

## 开发

```powershell
node test\route.test.mjs   # 假 ctx 驱动真实 apply：工具、路由、计划任务同步、POST 校验
```

仓库结构：`index.js`（Host：工具 / 计划任务 / HTTP 路由）、`client.js`（侧边栏与设置页）、`scripts/*.ps1`（采集与看板）、`PROMPT.md`（正文规则，改完下一轮生效）、`docs/DETAIL.md`（详细说明）。

## 限制

- 会话解析依赖 `zstd.exe`，缺失时该节降级为空。
- 只能看到文件与会话痕迹，线下工作需要在正文里补一句。
- 计划任务只在 DSH 运行时投递；卸插件前先停任务，否则投递到的会话调不到工具。
- 改目录只影响之后的写入位置，不搬动已有文件。

## 许可

[MIT](LICENSE) © 2026 dsh-work-summary contributors
