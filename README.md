# dsh-work-summary

[![npm version](https://img.shields.io/npm/v/dsh-work-summary?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-work-summary)
[![npm downloads](https://img.shields.io/npm/dm/dsh-work-summary?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-work-summary)
[![dsh](https://img.shields.io/badge/dsh-0.2.2--rc.5%20~%200.2.x-4D6BFE)](#安装)
[![dshfind](https://img.shields.io/badge/dshfind-插件页-4D6BFE)](https://dshfind.com/zh/plugins/ruochen361/dsh-work-summary)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

DeepSeek Harness 插件：定时生成日报、周报、月报。采集、结构校验、落盘、推看板交给工具，模型只写正文。

## 能做什么

- 每天 23:00 自动发现近两天活跃的工作区，采改动、Git 提交、DSH 会话、看板与产物目录，生成六节日报。
- 日报按「工作区 × 主线」组织：一条主线是一次完整交付，`#### M-…` 小节落盘时同步维护 `_主线.md`，跨天复用 ID，状态只用进行中/完成/受阻/放弃四值，补写旧日报不会回拨已有状态，超 3 天没产出标「受阻」。
- 源数据只保留最近 60 个，更旧的按季度自动归档到 `_归档`，失败不影响当天采集。
- 每周一 01:00 生成上一周周报，每月 1 号 01:00 生成上一个自然月月报；首节按工作区分组列主线，跨期没推进的标「本期未推进」与挂起天数。
- 缺节、空骨架、占位符直接报错且不写文件；同一区间连跑两次，看板不重复。
- 保存日报时顺带做质量软提醒：路径/提交号太少、空话词、建议不可执行只提示，不阻断落盘。
- 侧边栏内置「日报」页面，默认打开看板：看待办并一键开工、调优先级与截止日，读日报、看周报/月报、在「统计」里看 13 周热力图、30 天产出趋势与看板交付结构、改定时与目录；日报页顶部有主线面板，一眼看到未清与挂起。

## 安装

```bash
dsh plugin --profile web add dsh-work-summary

plugin_manager install_bundle dsh-work-summary
```

重启 DSH。默认数据目录 `~/.dsh/dsh-work-summary`；首次激活会创建日报、周报、月报三条计划任务，并保留已有任务的时间与投递会话。需要 PowerShell 7（`pwsh`）。

## 工具

| 工具 | 作用 |
|---|---|
| `daily_report_collect` | 采集当天痕迹，返回源数据路径与六节模板；超 60 个自动归档 |
| `daily_report_save` | 校验六节 → 写日报 → 维护 `_主线.md` → 推看板；返回质量 `warnings` 与主线状态 |
| `work_summary_period` | 聚合区间，写周报/月报并推看板；`offset: 1` 取上一周期 |
| `daily_report_board` | `show` 未完成，`done` / `drop` 回写看板，`update` 改优先级 / 截止日 / 状态 |

## 配置

设置页（侧边栏「日报 → 设置」）保存到 `settings.json`，优先级高于默认值；其余键可在 profile 的 `cordis.patch.yml` 覆盖。

| 键 | 默认 | 说明 |
|---|---|---|
| `reportDir` | `~/.dsh/dsh-work-summary` | 日报、看板、源数据、日志 |
| `workspace` | 空 | 额外固定扫描的工作区根；留空只按 DSH 会话自动发现 |
| `scheduleTime` / `scheduleTimeZone` | `23:00` / `Asia/Shanghai` | 日报时间；时区也用于判断「今天」 |
| `weekScheduleTime` | `01:00` | 周报时间（每周一，生成上一周） |
| `monthScheduleTime` | `01:00` | 月报时间（每月 1 号，生成上月） |
| `weekScheduleEnabled` / `monthScheduleEnabled` | `true` | 周报 / 月报任务开关 |
| `pushOnSave` | `true` | 日报保存后是否自动推看板 |
| `quality.minEvidence` | `3` | 日报软校验要求的最少路径/提交号引用数 |
| `mainline.stallDays` | `3` | 主线连续多少天零产出算「受阻」 |
| `pwsh` / `timeoutMs` | `pwsh` / `240000` | PowerShell 与单次超时 |

## 数据布局

```
~/.dsh/dsh-work-summary/
├── 日报-YYYY-MM-DD.md
├── 周报-YYYY-MM-DD_YYYY-MM-DD.md
├── 月报-YYYY-MM.md
├── 看板.md
├── _工作区.md         # 自动生成：别名与忽略
├── _主线.md           # 主线账本：状态、首次/最近产出、判据
├── _源数据/          # 采集底稿，只保留最近 60 个
├── _归档/            # 更旧源数据按季度打包，含索引.md
├── _日志/
└── settings.json
```

## 开发

```bash
npm run check   # node --check index.js / client.js
npm test        # 假 ctx 驱动工具、路由、计划任务、周期聚合、质量软校验、归档、工作区发现、主线账本与看板开工
```

测试会启动 `pwsh`，在受限沙箱里需完整权限。仓库：`index.js`（Host）、`client.js`（侧边栏）、`scripts/*.ps1`（采集/看板）、`PROMPT.md`（正文规则）。

详细说明见 [docs/DETAIL.md](docs/DETAIL.md)，需求清单见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 许可

[MIT](LICENSE)
