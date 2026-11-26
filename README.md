# dsh-work-summary

[![npm version](https://img.shields.io/npm/v/dsh-work-summary?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-work-summary)
[![npm downloads](https://img.shields.io/npm/dm/dsh-work-summary?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-work-summary)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.3--alpha.2-4D6BFE)](#安装)
[![dshfind](https://img.shields.io/badge/dshfind-插件页-4D6BFE)](https://dshfind.com/zh/plugins/ruochen361/dsh-work-summary)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

DeepSeek Harness 插件：定时生成日报、周报、月报。采集、结构校验、落盘、推看板交给工具，模型只写正文。

## 能做什么

- 每天 23:00 采工作区改动、Git 提交、DSH 会话、看板与产物目录，生成六节日报。
- 每周一 01:00 生成上一周周报，每月 1 号 01:00 生成上一个自然月月报。
- 缺节、空骨架、占位符直接报错且不写文件；同一区间连跑两次，看板不重复。
- 侧边栏内置「日报」页面：读日报、看周报/月报、看待办、改定时与目录。

## 安装

```bash
plugin_manager install_bundle dsh-work-summary
```

重启 DSH。默认数据目录 `~/.dsh/dsh-work-summary`；首次激活会创建日报、周报、月报三条计划任务，并保留已有任务的时间与投递会话。需要 PowerShell 7（`pwsh`）。

## 工具

| 工具 | 作用 |
|---|---|
| `daily_report_collect` | 采集当天痕迹，返回源数据路径与六节模板 |
| `daily_report_save` | 校验六节 → 写日报 → 推看板 |
| `work_summary_period` | 聚合区间，写周报/月报并推看板；`offset: 1` 取上一周期 |
| `daily_report_board` | `show` 未完成，`done` / `drop` 回写看板 |

## 配置

设置页（侧边栏「日报 → 设置」）保存到 `settings.json`，优先级高于默认值；其余键可在 profile 的 `cordis.patch.yml` 覆盖。

| 键 | 默认 | 说明 |
|---|---|---|
| `reportDir` | `~/.dsh/dsh-work-summary` | 日报、看板、源数据、日志 |
| `workspace` | 同 `reportDir` | 采集扫描的工作区根 |
| `scheduleTime` / `scheduleTimeZone` | `23:00` / `Asia/Shanghai` | 日报时间；时区也用于判断「今天」 |
| `weekScheduleTime` | `01:00` | 周报时间（每周一，生成上一周） |
| `monthScheduleTime` | `01:00` | 月报时间（每月 1 号，生成上月） |
| `weekScheduleEnabled` / `monthScheduleEnabled` | `true` | 周报 / 月报任务开关 |
| `pushOnSave` | `true` | 日报保存后是否自动推看板 |
| `pwsh` / `timeoutMs` | `pwsh` / `240000` | PowerShell 与单次超时 |

## 数据布局

```
~/.dsh/dsh-work-summary/
├── 日报-YYYY-MM-DD.md
├── 周报-YYYY-MM-DD_YYYY-MM-DD.md
├── 月报-YYYY-MM.md
├── 看板.md
├── _源数据/          # 采集底稿，只读生成
├── _日志/
└── settings.json
```

## 开发

```bash
npm run check   # node --check index.js / client.js
npm test        # 假 ctx 驱动工具、路由、计划任务与周期聚合
```

测试会启动 `pwsh`，在受限沙箱里需完整权限。仓库：`index.js`（Host）、`client.js`（侧边栏）、`scripts/*.ps1`（采集/看板）、`PROMPT.md`（正文规则）。

详细说明见 [docs/DETAIL.md](docs/DETAIL.md)，需求清单见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 许可

[MIT](LICENSE)
