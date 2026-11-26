/**
 * 每日工作日报 · Host 插件
 *
 * 把原先「计划任务提示词 + 两个 PowerShell 脚本」的日报自动化收进一个插件：
 * 采集、写盘、推看板由工具确定性地完成，模型只负责写正文。
 *
 * 不 import 任何 @deepseek-ai/* 包：本地目录安装是 link 而不是拷贝，
 * 插件目录里没有 node_modules，裸导入会解析失败。工具定义直接按
 * 注册表接受的普通对象写（name/description/parameters/output/execute）。
 *
 * @module dsh-work-summary
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-work-summary'
export const inject = ['tools']

/** 插件自身目录：脚本与 PROMPT.md 随仓库走，不依赖数据目录。 */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/** 插件的数据根：`~/.dsh/dsh-work-summary`，首次激活时创建。测试或多实例可用环境变量改。 */
const DATA_HOME = process.env.DSH_WORK_SUMMARY_HOME?.trim() || join(homedir(), '.dsh', 'dsh-work-summary')

/** 设置文件固定在数据根下：改了 reportDir 之后仍然读得到自己存过的值。 */
const SETTINGS_FILE = join(DATA_HOME, 'settings.json')

/** 插件配置默认值；patch 里的 config 覆盖同名键。 */
const DEFAULTS = {
  /** 数据目录：日报、看板、源数据、日志都在这里；设置页可改。 */
  reportDir: DATA_HOME,
  /** 采集脚本扫描的工作区根（collect-day.ps1 -Workspace）；默认也是数据根。 */
  workspace: DATA_HOME,
  /** 脚本目录：默认随插件仓库。 */
  scriptDir: join(PLUGIN_DIR, 'scripts'),
  /** 日报正文规则；默认随插件仓库。 */
  promptPath: join(PLUGIN_DIR, 'PROMPT.md'),
  /** PowerShell 可执行文件。 */
  pwsh: 'pwsh',
  /** 单个脚本的超时（毫秒）。 */
  timeoutMs: 240000,
  /** daily_report_save 默认是否顺带推看板。 */
  pushOnSave: true,
  /** 是否让插件托管每日计划任务。 */
  scheduleEnabled: true,
  /** 已有旧日报计划任务时，改写它的提示词而不是再建一个。 */
  scheduleAdopt: true,
  /** 插件自己创建的计划的标题。 */
  scheduleTitle: '每日工作日报',
  /** 计划时间 HH:mm（24 小时制）。 */
  scheduleTime: '23:00',
  /** 计划时区。 */
  scheduleTimeZone: 'Asia/Shanghai',
  /** 是否让插件托管每周周报任务（每周一生成上一周）。 */
  weekScheduleEnabled: true,
  /** 周报计划时间 HH:mm；固定每周一。 */
  weekScheduleTime: '01:00',
  /** 周报计划任务标题；标题稳定才好认领和更新。 */
  weekScheduleTitle: '每周工作周报',
  /** 是否让插件托管每月月报任务（每月 1 号生成上个月）。 */
  monthScheduleEnabled: true,
  /** 月报计划时间 HH:mm；固定每月 1 号。 */
  monthScheduleTime: '01:00',
  /** 月报计划任务标题。 */
  monthScheduleTitle: '每月工作月报',
  /** 运行日志目录；留空表示 `<reportDir>\_日志`。设置页改的是这个键。 */
  logDir: '',
}

/** 日报固定小节，顺序即写入顺序。 */
const SECTIONS = [
  ['一', '今日概览'],
  ['二', '做了什么'],
  ['三', '结果与产出'],
  ['四', '问题与风险'],
  ['五', '后续建议'],
  ['六', '明日开场清单'],
]

/**
 * 合并配置：只让显式给出的值覆盖默认值。
 * @param {Record<string, unknown>} config - patch 里的 config。
 * @returns {typeof DEFAULTS} 生效配置。
 */
function resolveConfig(config) {
  const merged = { ...DEFAULTS }
  for (const [key, value] of Object.entries(config ?? {})) {
    if (value !== undefined && value !== null) merged[key] = value
  }
  // 设置页保存的值优先级最高：那是用户在 UI 里的显式选择，重启后要能存活。
  const saved = readSettings()
  if (typeof saved.logDir === 'string' && saved.logDir.trim() !== '') merged.logDir = saved.logDir.trim()
  if (typeof saved.reportDir === 'string' && saved.reportDir.trim() !== '') merged.reportDir = saved.reportDir.trim()
  if (typeof saved.workspace === 'string' && saved.workspace.trim() !== '') merged.workspace = saved.workspace.trim()
  for (const key of ['weekScheduleTime', 'monthScheduleTime']) {
    if (typeof saved[key] === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(saved[key])) merged[key] = saved[key]
  }
  for (const key of ['weekScheduleEnabled', 'monthScheduleEnabled']) {
    if (typeof saved[key] === 'boolean') merged[key] = saved[key]
  }
  return merged
}

/**
 * 读取设置页保存的选项（数据根下的 settings.json）。读不到就是空对象。
 * @returns {Record<string, unknown>} 已保存的键值。
 */
function readSettings() {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 运行日志目录：显式配置优先，否则落在数据目录下的 `_日志`。
 * @param {typeof DEFAULTS} config - 生效配置。
 * @returns {string} 目录路径。
 */
function logDirOf(config) {
  const explicit = String(config.logDir ?? '').trim()
  return explicit !== '' ? explicit : join(config.reportDir, '_日志')
}

/**
 * 某时区的 `HH:mm:ss`。
 * @param {string} timeZone - IANA 时区。
 * @returns {string} 时刻。
 */
function clockInZone(timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date())
}

/**
 * 往当天的日志文件追加一行；日志写不下去只吞掉，不影响日报本身。
 * @param {typeof DEFAULTS} config - 生效配置。
 * @param {'info' | 'warn' | 'error'} level - 级别。
 * @param {string} message - 内容。
 * @returns {Promise<void>} 完成。
 */
async function logLine(config, level, message) {
  try {
    const dir = logDirOf(config)
    await mkdir(dir, { recursive: true })
    const day = dateInZone(config.scheduleTimeZone)
    const file = join(dir, `dsh-work-summary-${day}.log`)
    await appendFile(file, `${day} ${clockInZone(config.scheduleTimeZone)} [${level}] ${message}\n`, 'utf8')
  } catch {
    // 目录不可写不该让日报流程失败。
  }
}

/**
 * 写回设置页的选项。只认已知键，避免任意字段被塞进配置文件。
 * @param {Record<string, string | boolean | undefined>} patch - 要保存的键。
 * @returns {Promise<Record<string, unknown>>} 保存后的全部设置。
 */
async function writeSettings(patch) {
  const current = readSettings()
  const next = {}
  for (const key of ['reportDir', 'logDir', 'workspace', 'weekScheduleTime', 'monthScheduleTime']) {
    const value = typeof patch[key] === 'string' ? patch[key] : current[key]
    if (typeof value === 'string') next[key] = value
  }
  for (const key of ['weekScheduleEnabled', 'monthScheduleEnabled']) {
    const value = typeof patch[key] === 'boolean' ? patch[key] : current[key]
    if (typeof value === 'boolean') next[key] = value
  }
  await mkdir(dirname(SETTINGS_FILE), { recursive: true })
  await writeFile(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/**
 * 设置页要的完整状态：日报/周报/月报三条定时任务 + 目录。
 * @param {{ daily: Awaited<ReturnType<typeof scheduleState>>, week: Record<string, unknown>, month: Record<string, unknown> }} states - 定时任务状态。
 * @param {typeof DEFAULTS} config - 生效配置。
 * @returns {Record<string, unknown>} 响应体。
 */
function settingsPayload(states, config) {
  return {
    ...states.daily,
    reportDir: config.reportDir,
    reportDirDefault: DATA_HOME,
    workspace: config.workspace,
    workspaceDefault: DATA_HOME,
    logDir: logDirOf(config),
    logDirDefault: join(config.reportDir, '_日志'),
    logPattern: 'dsh-work-summary-YYYY-MM-DD.log',
    week: states.week,
    month: states.month,
    weekTitle: config.weekScheduleTitle,
    monthTitle: config.monthScheduleTitle,
    weekTimeDefault: config.weekScheduleTime,
    monthTimeDefault: config.monthScheduleTime,
  }
}

/**
 * 某时区的今天。
 * @param {string} timeZone - IANA 时区。
 * @returns {string} YYYY-MM-DD。
 */
function dateInZone(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/**
 * 某时区的当前时间戳。
 * @param {string} timeZone - IANA 时区。
 * @returns {string} YYYY-MM-DD HH:mm。
 */
function stampInZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const get = type => parts.find(part => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/**
 * 列出缺失的固定小节标题。
 * @param {string} text - 日报正文。
 * @returns {string[]} 形如 `## 一、今日概览`。
 */
function missingSections(text) {
  const missing = []
  for (const [num, title] of SECTIONS) {
    const pattern = new RegExp(`^##\\s*${num}\\s*[、.．]\\s*${title}`, 'm')
    if (!pattern.test(text)) missing.push(`## ${num}、${title}`)
  }
  return missing
}

/**
 * 日报骨架，交给模型填空。
 * @param {string} date - YYYY-MM-DD。
 * @returns {string} Markdown 模板。
 */
function buildTemplate(date) {
  return [
    `# 工作日报 · ${date}`,
    '',
    '## 一、今日概览',
    '（3–5 句：今天的主线、投入方向、一句话结论）',
    '',
    '## 二、做了什么',
    '（按主题分组，不按时间流水账；每条写清「做了什么 → 落在哪个路径/模块」，并给证据）',
    '',
    '## 三、结果与产出',
    '（表格：产出物 | 路径 | 状态（完成/进行中/待验证）| 说明）',
    '',
    '## 四、问题与风险',
    '（暴露的问题、未通过的验证、遗留脏数据；每条给出影响面）',
    '',
    '## 五、后续建议',
    '（3–6 条，按优先级；每条：建议 | 为什么现在做 | 预估工作量 | 何时做）',
    '',
    '## 六、明日开场清单',
    '（明天 30 分钟内能动手的 3 件事，具体到文件/命令）',
  ].join('\n')
}

/**
 * 周期报告（周报/月报）的类型表：标题前缀与首尾两节的名字随类型变。
 * 中间两节固定为「关键产出」「未清与复发」。
 */
const PERIOD_KINDS = {
  week: { label: '周报', title: '工作周报', first: '本周主线', last: '下周开场' },
  month: { label: '月报', title: '工作月报', first: '本月主线', last: '下月开场' },
  custom: { label: '周期报告', title: '周期总结', first: '本期主线', last: '下期开场' },
}

/**
 * 解析 YYYY-MM-DD 为 UTC 零点毫秒数；格式或日期不存在都直接报错。
 * @param {string} text - 日期。
 * @returns {number} 毫秒时间戳。
 */
function parseDay(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`日期格式应为 YYYY-MM-DD，收到：${text}`)
  const [year, month, day] = text.split('-').map(Number)
  const stamp = Date.UTC(year, month - 1, day)
  const check = new Date(stamp)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`日期不存在：${text}`)
  }
  return stamp
}

/** 两个 YYYY-MM-DD 之间相差的天数（b - a）。 */
function daysBetween(from, to) {
  return Math.round((parseDay(to) - parseDay(from)) / 86400000)
}

/** 在 YYYY-MM-DD 上加若干天。 */
function shiftDay(date, delta) {
  return new Date(parseDay(date) + delta * 86400000).toISOString().slice(0, 10)
}

/** 某月的最后一天。 */
function lastDayOfMonth(date) {
  const [year, month] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

/**
 * 把工具入参解析成区间：类型、起止、天数、是否整月。
 * 不传 from/to 时按 kind 取默认区间（week=本周一至今天，month=本月 1 号至今天）；
 * offset 表示往前数几个完整周期（周报=整周，月报=整月），定时任务用它生成上一周期。
 * @param {{ from?: string, to?: string, kind?: 'week'|'month'|'custom', offset?: number }} args - 工具入参。
 * @param {string} timeZone - 时区。
 * @returns {{ from: string, to: string, kind: 'week'|'month'|'custom', span: number, wholeMonth: boolean }} 区间。
 */
function resolvePeriod(args, timeZone) {
  let from = typeof args.from === 'string' ? args.from.trim() : ''
  let to = typeof args.to === 'string' ? args.to.trim() : ''
  let kind = args.kind
  const offset = args.offset === undefined ? 0 : Number(args.offset)

  if (!Number.isInteger(offset) || offset < 0 || offset > 60) {
    throw new Error(`offset 应为 0–60 的整数，收到：${args.offset}`)
  }
  if (offset > 0 && (from || to)) throw new Error('给了 from/to 就不要再传 offset')
  if ((from && !to) || (!from && to)) throw new Error('from 和 to 要么都传，要么都不传')
  if (kind !== undefined && !Object.prototype.hasOwnProperty.call(PERIOD_KINDS, kind)) {
    throw new Error(`kind 只能是 week / month / custom，收到：${kind}`)
  }

  const today = dateInZone(timeZone)
  if (!from) {
    if (kind === 'custom') throw new Error('custom 周期需要同时给 from 和 to')
    if (kind === 'month') {
      const [year, month] = today.split('-').map(Number)
      from = new Date(Date.UTC(year, month - 1 - offset, 1)).toISOString().slice(0, 10)
      to = offset === 0 ? today : lastDayOfMonth(from)
    } else {
      kind = 'week'
      const weekday = new Date(parseDay(today)).getUTCDay()
      const monday = shiftDay(today, weekday === 0 ? -6 : 1 - weekday)
      from = shiftDay(monday, -7 * offset)
      to = offset === 0 ? today : shiftDay(from, 6)
    }
  }

  const span = daysBetween(from, to) + 1
  if (span < 1) throw new Error(`结束日期不能早于起始日期：${from} ~ ${to}`)
  if (span > 400) throw new Error(`区间最长 400 天，当前 ${span} 天：${from} ~ ${to}`)

  const wholeMonth = from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && to === lastDayOfMonth(from)
  if (kind === undefined) {
    kind = wholeMonth ? 'month' : span === 7 ? 'week' : 'custom'
  }
  return { from, to, kind, span, wholeMonth }
}

/**
 * 周期报告的文件名。整月月报用 `月报-YYYY-MM.md`，方便按月份排序。
 * @param {{ from: string, to: string, kind: string, wholeMonth: boolean }} range - 区间。
 * @returns {string} 文件名。
 */
function periodReportName(range) {
  if (range.kind === 'week') return `周报-${range.from}_${range.to}.md`
  if (range.kind === 'month') {
    return range.wholeMonth ? `月报-${range.from.slice(0, 7)}.md` : `月报-${range.from}_${range.to}.md`
  }
  return `周期-${range.from}_${range.to}.md`
}

/**
 * 周期报告的四节标题。首节接受「本周/本月/本期主线」，末节接受「下周/下月/下期开场」。
 * @param {string} kind - week / month / custom。
 * @returns {string[]} 四节标题。
 */
function periodSectionLabels(kind) {
  const spec = PERIOD_KINDS[kind] ?? PERIOD_KINDS.custom
  return [spec.first, '关键产出', '未清与复发', spec.last]
}

/**
 * 列出周期报告缺少的固定小节；首尾两节兼容三种前缀。
 * @param {string} text - 周期报告正文。
 * @param {string} kind - week / month / custom。
 * @returns {string[]} 形如 `## 一、本周主线`。
 */
function missingPeriodSections(text, kind) {
  const holes = []
  const specs = [
    ['一', '(?:本周|本月|本期)主线'],
    ['二', '关键产出'],
    ['三', '未清与复发'],
    ['四', '(?:下周|下月|下期)开场'],
  ]
  for (const [num, label] of specs) {
    const pattern = new RegExp(`^##\\s*(?:[一二三四五六七八九十]+\\s*[、.．]\\s*)?${label}`, 'm')
    if (!pattern.test(text)) holes.push(`## ${num}、${periodSectionLabels(kind)[['一', '二', '三', '四'].indexOf(num)]}`)
  }
  return holes
}

/**
 * 周期报告骨架，交给模型填空；留着「待填」时校验会拒绝。
 * @param {{ from: string, to: string, kind: string, wholeMonth: boolean }} range - 区间。
 * @returns {string} Markdown 模板。
 */
function buildPeriodTemplate(range) {
  const spec = PERIOD_KINDS[range.kind] ?? PERIOD_KINDS.custom
  const heading = range.kind === 'month' && range.wholeMonth
    ? range.from.slice(0, 7)
    : `${range.from} ~ ${range.to}`
  const labels = periodSectionLabels(range.kind)
  return [
    `# ${spec.title} · ${heading}`,
    '',
    `> 区间：${range.from} ~ ${range.to}（${range.span} 天）`,
    '',
    `## 一、${labels[0]}`,
    '（待填：这段区间真正推进的一两条主线，给证据，不要逐日流水账）',
    '',
    `## 二、${labels[1]}`,
    '（待填：产出物 | 路径 | 状态 | 说明；只写区间内新增或完成的）',
    '',
    `## 三、${labels[2]}`,
    '（待填：仍未清掉的事项、跨天复发的风险；写明已经挂了几天）',
    '',
    `## 四、${labels[3]}`,
    `（待填：下个周期开工就能动手的 3 件事，具体到文件/命令）`,
  ].join('\n')
}

/**
 * 取日报某小节里的非空行。
 * @param {string} text - 日报正文。
 * @param {string} number - 中文序号：一/二/…
 * @returns {string[]} 行。
 */
function sectionLines(text, number) {
  const lines = String(text).split(/\r?\n/)
  const startPattern = new RegExp(`^##\\s*${number}\\s*[、.．]`)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (startPattern.test(lines[i])) { start = i + 1; break }
  }
  if (start < 0) return []
  const out = []
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break
    const trimmed = lines[i].trim()
    if (trimmed === '' || /^---+$/.test(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

/**
 * 逐日热力值：非空行数 + 产出条目数 × 3。
 * 行数代表当天写了多少，产出条目代表落地的结果；权重 3 让「有产出」的一天明显亮于「写得长但没产出」。
 * @param {string} content - 日报正文。
 * @returns {{ lines: number, outputs: number, score: number }} 统计值。
 */
function heatStats(content) {
  const text = String(content)
  const lines = text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim()
    return trimmed !== '' && !/^---+$/.test(trimmed)
  }).length
  let outputs = 0
  for (const line of sectionLines(text, '三')) {
    const trimmed = line.trim()
    if (/^\|[\s:|-]+\|$/.test(trimmed)) continue
    if (/^\|/.test(trimmed)) {
      const first = trimmed.slice(1).split('|')[0].trim()
      if (/^(产出物|项目|条目|路径)$/.test(first)) continue
      outputs += 1
      continue
    }
    if (/^(?:[-*]|\d+[.、])\s+/.test(trimmed)) outputs += 1
  }
  return { lines, outputs, score: lines + outputs * 3 }
}

/** 去掉列表序号与加粗标记，保留正文。 */
function cleanItem(line) {
  return String(line).replace(/^\s*(?:\d+[.、]|[-*])\s+/, '').replace(/\*\*/g, '').trim()
}

/** 表格行转成「单元格 ｜ 单元格」；不是表格行就原样返回。 */
function tableCells(line) {
  const trimmed = line.trim()
  if (!/^\|.*\|$/.test(trimmed)) return cleanItem(trimmed)
  return trimmed.slice(1, -1).split('|').map(cell => cell.trim()).filter(Boolean).join(' ｜ ')
}

/** 看板条目的标题：`日期 ｜ 标题 ｜ 来源…` 取第二段。 */
function boardTitle(line) {
  const parts = String(line).split('｜')
  return (parts.length >= 2 ? parts[1] : parts[0]).trim()
}

/** 截断过长的一行，避免自动草稿把整段原文搬进去。 */
function clip(text, max) {
  const value = String(text).replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * 不传 content 时的兜底草稿：按区间日报的六节与看板拼出四节，保证验收里「直接产出可读周报」。
 * 只做摘录和计数，不做跨天推断；模型可以在此基础上改写后再提交。
 * @param {{ from: string, to: string, kind: string, span: number, wholeMonth: boolean }} range - 区间。
 * @param {string[]} days - 区间内每一天。
 * @param {Map<string, string>} daily - 日期 → 日报正文。
 * @param {{ open: string[] }} board - 看板未完成条目。
 * @param {string} today - 今天 YYYY-MM-DD（用于算待办已挂天数）。
 * @returns {string} 四节正文。
 */
function composePeriodDraft(range, days, daily, board, today) {
  const spec = PERIOD_KINDS[range.kind] ?? PERIOD_KINDS.custom
  const labels = periodSectionLabels(range.kind)
  const covered = days.filter(day => daily.has(day))
  const missing = days.filter(day => !daily.has(day))
  const heading = range.kind === 'month' && range.wholeMonth
    ? range.from.slice(0, 7)
    : `${range.from} ~ ${range.to}`

  const out = [`# ${spec.title} · ${heading}`, '', `> 区间：${range.from} ~ ${range.to}（${range.span} 天）`, '']

  out.push(`## 一、${labels[0]}`, '')
  out.push(`本区间 ${range.from} ~ ${range.to}，共 ${range.span} 天；有日报 ${covered.length} 天${missing.length ? `、缺 ${missing.length} 天（${missing.map(day => day.slice(5)).join('、')}）` : ''}。`)
  out.push('')
  if (covered.length === 0) {
    out.push('_区间内没有日报，无法从记录里归纳主线。_')
  } else {
    out.push('按天摘录日报「今日概览」里的主线，未做跨天推断：')
    out.push('')
    for (const day of covered) {
      const first = sectionLines(daily.get(day), '一')[0]
      if (first) out.push(`- **${day.slice(5)}**：${clip(cleanItem(first), 180)}`)
    }
  }
  out.push('')

  out.push(`## 二、${labels[1]}`, '')
  const outputs = []
  for (const day of covered) {
    for (const line of sectionLines(daily.get(day), '三')) {
      if (/^\|[\s:|-]+\|$/.test(line) || /^\|\s*(产出物|建议|项目)\s*\|/.test(line)) continue
      outputs.push(`- ${day.slice(5)}：${clip(tableCells(line), 220)}`)
      if (outputs.length >= 24) break
    }
    if (outputs.length >= 24) break
  }
  out.push(...(outputs.length ? outputs : ['_区间日报里没有产出记录。_']))
  out.push('')

  out.push(`## 三、${labels[2]}`, '')
  const open = Array.isArray(board.open) ? board.open : []
  out.push(`看板当前未完成 ${open.length} 条：`)
  out.push('')
  if (open.length === 0) {
    out.push('_看板没有未完成条目。_')
  } else {
    for (const line of open.slice(0, 8)) {
      const bare = line.replace(/^-\s*\[ \]\s*/, '')
      const dateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(bare)
      let age = ''
      if (dateMatch) {
        const gap = daysBetween(dateMatch[1], today)
        if (gap >= 0) age = `（已挂 ${gap} 天）`
      }
      out.push(`- ${boardTitle(bare)}${age}`)
    }
  }
  out.push('')

  const riskDays = new Map()
  for (const day of covered) {
    for (const line of sectionLines(daily.get(day), '四')) {
      const item = cleanItem(line)
      const key = item
        .replace(/（[^）]*）/g, '')
        .replace(/\d+/g, '#')
        .replace(/[\s，。；：、！？,.;:!?（）()【】\[\]「」“”"-]/g, '')
        .slice(0, 40)
      if (key.length < 6) continue
      if (!riskDays.has(key)) riskDays.set(key, { dates: [], sample: clip(item, 60) })
      const entry = riskDays.get(key)
      if (!entry.dates.includes(day)) entry.dates.push(day)
    }
  }
  const repeated = [...riskDays.values()].filter(entry => entry.dates.length >= 2).sort((a, b) => b.dates.length - a.dates.length)
  if (repeated.length > 0) {
    out.push('跨天重复出现的风险：')
    out.push('')
    for (const entry of repeated.slice(0, 6)) {
      out.push(`- ${entry.sample}（${entry.dates.length} 天：${entry.dates.map(day => day.slice(5)).join('、')}）`)
    }
    out.push('')
  }

  out.push(`## 四、${labels[3]}`, '')
  const lastWithList = [...covered].reverse().find(day => sectionLines(daily.get(day), '六').length > 0)
  let actions = lastWithList
    ? sectionLines(daily.get(lastWithList), '六').map(cleanItem).filter(Boolean).slice(0, 3)
    : []
  if (actions.length === 0) actions = open.map(boardTitle).slice(0, 3)
  if (actions.length === 0) actions = ['先补上区间内缺失的日报，再决定下个周期主攻方向。']
  out.push(lastWithList
    ? `取自 ${lastWithList} 日报「明日开场清单」的末版（${actions.length} 条）：`
    : `取自看板当前未完成条目（${actions.length} 条）：`)
  out.push('')
  actions.forEach((item, index) => out.push(`${index + 1}. ${item}`))
  out.push('')

  return out.join('\n')
}

/** 周期报告的统一 footer：写清正文依据的区间源数据。 */
function withPeriodFooter(content, range, stamp) {
  if (/数据来源：/.test(content)) return content
  const source = `_源数据\\周期-${range.from}_${range.to}.md`
  return `${content.replace(/\s*$/, '')}\n\n---\n数据来源：\`${source}\` ｜ 生成时间：${stamp}\n`
}

/**
 * 看板文件路径（push-to-board.ps1 的 -BoardPath）。
 * @param {typeof DEFAULTS} config - 生效配置。
 * @returns {string} 看板路径。
 */
function boardPathOf(config) {
  return join(config.reportDir, '看板.md')
}

/**
 * 读看板里的未完成条目。
 * @param {string} reportDir - 日报目录。
 * @returns {Promise<{open: string[], text: string}>} 未完成条目与看板全文。
 */
async function readBoard(reportDir) {
  try {
    const text = await readFile(join(reportDir, '看板.md'), 'utf8')
    const open = text.split(/\r?\n/).map(line => line.trim()).filter(line => /^- \[ \]/.test(line))
    return { open, text }
  } catch {
    return { open: [], text: '' }
  }
}

/**
 * 取输出末尾若干行用于报错。
 * @param {string} text - 进程输出。
 * @returns {string} 截断后的输出。
 */
function tail(text) {
  const trimmed = String(text ?? '').trim()
  return trimmed.length > 1200 ? `…${trimmed.slice(-1200)}` : trimmed
}

/**
 * 允许以裸参数形式传给脚本的开关；其余参数一律当作字符串字面量。
 * 注意：PowerShell 里给参数名加引号它就变成普通位置参数了（实测
 * `& script '-Date' x` 会把 "-Date" 绑到第一个位置参数），所以新增开关必须补进这里。
 */
const PS_SWITCHES = new Set([
  '-Date', '-From', '-To', '-Section', '-NoSessions', '-Report', '-BoardPath', '-Show', '-Done', '-Drop', '-DryRun',
  '-Workspace', '-ReportDir', '-DshHome',
])

/**
 * 运行一次 PowerShell 脚本。
 * @param {string} command - pwsh 可执行文件。
 * @param {string[]} args - 参数。
 * @param {AbortSignal | undefined} signal - 调用方取消信号。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} 退出码与输出。
 */
function runProcess(command, args, signal, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) child.kill()
    }, timeoutMs)
    const finish = (code, note) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve({ code, stdout, stderr: note ? `${stderr}\n${note}` : stderr })
    }
    const onAbort = () => child.kill()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', error => finish(-1, `无法启动 ${command}：${error.message}`))
    child.on('close', code => finish(code ?? -1, code === null ? '进程被超时或取消终止' : ''))
  })
}

/**
 * 运行日报目录里的某个脚本。
 * @param {typeof DEFAULTS} config - 生效配置。
 * @param {string} script - 脚本文件名。
 * @param {string[]} args - 脚本参数。
 * @param {AbortSignal | undefined} signal - 取消信号。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} 结果。
 */
function runScript(config, script, args, signal) {
  // 用 -Command 而不是 -File：只有进到 PowerShell 里才能先把控制台输出编码
  // 设成 UTF-8（-File 模式没有插话的位置）。管道重定向下 pwsh 默认按系统
  // ANSI（936）写 stdout，Node 按 utf8 解码就会得到乱码，中文解析全失效。
  const command = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
    + '$OutputEncoding = [System.Text.Encoding]::UTF8; '
    + `& ${[psQuote(join(config.scriptDir, script)), ...args.map(psArg)].join(' ')}`
  const started = Date.now()
  return runProcess(
    config.pwsh,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    signal,
    config.timeoutMs,
  ).then((result) => {
    const head = `${script} ${args.join(' ')} → exit ${result.code}，${Date.now() - started}ms`
    if (result.code === 0) {
      void logLine(config, 'info', head)
    } else {
      void logLine(config, 'error', `${head}\n${tail(result.stderr || result.stdout, 800)}`)
    }
    return result
  })
}

/**
 * 把单个命令行参数转成 PowerShell 里的写法。
 * 已知开关保持裸写（`-Date`），其余一律按单引号字面量引用，值里的 `'` 翻倍。
 * @param {string} arg - 原始参数。
 * @returns {string} PowerShell 写法。
 */
function psArg(arg) {
  return PS_SWITCHES.has(arg) ? arg : psQuote(arg)
}

/**
 * 引用一个 PowerShell 单引号字符串字面量。
 * @param {string} value - 原始字符串。
 * @returns {string} 带引号的字面量。
 */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** 文本输出的通用渲染。 */
const renderText = (_args, value) => [{ type: 'text', text: value.text }]

/** 侧边栏页面要的一份只读快照：看板全文 + 最近若干天日报正文。 */
async function readState(config) {
  const board = await readBoard(config.reportDir)
  const lines = board.text.split(/\r?\n/).map(line => line.trim())
  let names = []
  try {
    names = (await readdir(config.reportDir)).filter(name => /^日报-\d{4}-\d{2}-\d{2}\.md$/.test(name))
  } catch {
    names = []
  }
  const reports = []
  for (const name of names.sort().reverse().slice(0, 91)) {
    try {
      const content = await readFile(join(config.reportDir, name), 'utf8')
      const stats = heatStats(content)
      reports.push({
        date: name.slice(3, 13),
        file: name,
        size: Buffer.byteLength(content, 'utf8'),
        lines: stats.lines,
        outputs: stats.outputs,
        score: stats.score,
        content,
      })
    } catch {
      // 单篇读不了就跳过，不让整个页面失败
    }
  }
  const periods = []
  let periodNames = []
  try {
    periodNames = (await readdir(config.reportDir)).filter(name => /^(?:周报|月报|周期)-.+\.md$/.test(name))
  } catch {
    periodNames = []
  }
  for (const name of periodNames.sort().reverse().slice(0, 40)) {
    try {
      const content = await readFile(join(config.reportDir, name), 'utf8')
      const kind = name.startsWith('周报') ? 'week' : name.startsWith('月报') ? 'month' : 'custom'
      const period = name.replace(/^(?:周报|月报|周期)-/, '').replace(/\.md$/, '').replace('_', ' ~ ')
      periods.push({
        file: name,
        kind,
        period,
        size: Buffer.byteLength(content, 'utf8'),
        content,
      })
    } catch {
      // 同上：单篇失败不拖垮页面
    }
  }
  return {
    reportDir: config.reportDir,
    today: dateInZone(config.scheduleTimeZone),
    updatedAt: new Date().toISOString(),
    board: {
      text: board.text,
      open: board.open.length,
      done: lines.filter(line => /^- \[x\]/i.test(line)).length,
    },
    reports,
    periods,
  }
}

/** 找出插件托管的那条日报任务：标题前缀或提示词特征都算。周期任务的提示词不含日报特征。 */
function findOwnTask(items, config) {
  return items.find((task) => {
    const title = String(task.title ?? '')
    const prompt = String(task.prompt ?? '')
    const looksDaily = /daily_report_collect|dsh-work-summary/.test(prompt) && !/work_summary_period/.test(prompt)
    return title === config.scheduleTitle
      || title.startsWith(config.scheduleTitle)
      || looksDaily
  }) ?? null
}

/** 按标题找插件自己的任务；标题是稳定契约，不靠提示词猜。 */
function findTaskByTitle(items, title) {
  return items.find((task) => {
    const current = String(task.title ?? '')
    return current === title || current.startsWith(title)
  }) ?? null
}

/** 从任务的 rrule 里读出小时、分钟与时区。 */
function parseRruleTime(task) {
  const rrule = String(task?.rrule ?? '')
  const start = /DTSTART(?:;TZID=([^:]+))?:(\d{8})T(\d{2})(\d{2})/.exec(rrule)
  const byHour = /BYHOUR=(\d{1,2})/.exec(rrule)
  const byMinute = /BYMINUTE=(\d{1,2})/.exec(rrule)
  const hour = byHour ? Number(byHour[1]) : start ? Number(start[3]) : null
  const minute = byMinute ? Number(byMinute[1]) : start ? Number(start[4]) : null
  return { hour, minute, timeZone: start?.[1] ?? null }
}

/** 每天固定时刻的 rrule（与既有任务同一种写法）。 */
function dailyRrule(timeZone, time) {
  const [hour, minute] = String(time).split(':').map(Number)
  const today = dateInZone(timeZone).replace(/-/g, '')
  const hh = String(hour).padStart(2, '0')
  const mm = String(minute).padStart(2, '0')
  return `DTSTART;TZID=${timeZone}:${today}T${hh}${mm}00\nRRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=${hour};BYMINUTE=${minute}`
}

/** 从某天起最近的一个指定星期几（0=周日，1=周一）。 */
function nextWeekday(date, weekday) {
  const current = new Date(parseDay(date)).getUTCDay()
  return shiftDay(date, (weekday - current + 7) % 7)
}

/** 每周一固定时刻的 rrule：周报任务用。 */
function weeklyRrule(timeZone, time) {
  const [hour, minute] = String(time).split(':').map(Number)
  const start = nextWeekday(dateInZone(timeZone), 1).replace(/-/g, '')
  const hh = String(hour).padStart(2, '0')
  const mm = String(minute).padStart(2, '0')
  return `DTSTART;TZID=${timeZone}:${start}T${hh}${mm}00\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;BYHOUR=${hour};BYMINUTE=${minute}`
}

/** 每月 1 号固定时刻的 rrule：月报任务用。 */
function monthlyRrule(timeZone, time) {
  const [hour, minute] = String(time).split(':').map(Number)
  const today = dateInZone(timeZone)
  const [year, month, day] = today.split('-').map(Number)
  const start = day === 1
    ? today
    : `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`
  const hh = String(hour).padStart(2, '0')
  const mm = String(minute).padStart(2, '0')
  return `DTSTART;TZID=${timeZone}:${start.replace(/-/g, '')}T${hh}${mm}00\nRRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1;BYHOUR=${hour};BYMINUTE=${minute}`
}

/** 通用任务状态：没找到时用配置里的默认时间撑住设置页。 */
async function taskState(scheduleCtx, title, fallbackTime, timeZone) {
  const page = await scheduleCtx.schedule.list({ limit: 200 })
  const task = findTaskByTitle(page.items ?? [], title)
  if (!task) return { found: false, title, timeZone, time: fallbackTime }
  const parsed = parseRruleTime(task)
  const hour = parsed.hour ?? Number(fallbackTime.split(':')[0])
  const minute = parsed.minute ?? Number(fallbackTime.split(':')[1] ?? 0)
  return {
    found: true,
    id: task.id,
    title: task.title,
    active: task.status === 'active',
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    timeZone: parsed.timeZone ?? timeZone,
    nextRunAt: task.scheduledAtLocal ?? task.scheduledAt ?? null,
    target: task.target?.kind ?? null,
  }
}

/** 设置页要的日报任务状态。 */
async function scheduleState(scheduleCtx, config) {
  const state = await taskState(scheduleCtx, config.scheduleTitle, config.scheduleTime, config.scheduleTimeZone)
  if (!state.found) {
    return { found: false, scheduleTitle: config.scheduleTitle, timeZone: config.scheduleTimeZone, time: config.scheduleTime }
  }
  return state
}

/** 设置页要的周报/月报任务状态。 */
async function periodScheduleState(scheduleCtx, config, kind) {
  const week = kind === 'week'
  return taskState(
    scheduleCtx,
    week ? config.weekScheduleTitle : config.monthScheduleTitle,
    week ? config.weekScheduleTime : config.monthScheduleTime,
    config.scheduleTimeZone,
  )
}

/**
 * 注册三个工具，并按配置托管计划任务。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {Record<string, unknown>} rawConfig - patch 配置。
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  // 装好第一次激活就把目录建出来；之后所有产物都落在它们下面。建不出来也不该拖垮插件。
  void mkdir(DATA_HOME, { recursive: true }).catch(() => {})
  void mkdir(config.reportDir, { recursive: true }).catch(() => {})
  void mkdir(config.workspace, { recursive: true }).catch(() => {})

  ctx.tools.register({
    name: 'daily_report_collect',
    description:
      '采集某一天的工作痕迹，生成日报的源数据文件并返回它的路径、小节清单和日报模板。'
      + '写日报前先调用它：结果里的 sourcePath 要读一遍，template 是必须填满的六节骨架。'
      + '采集是只读的，只写 _源数据 目录。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string', description: '本地日期 YYYY-MM-DD，默认今天。补写往日日报时传。' },
        sessions: { type: 'boolean', description: '是否解析 DSH 会话，默认 true；工作区文件很多时可设 false 提速。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'sourcePath', 'lines', 'boardOpen', 'template'],
        properties: {
          date: { type: 'string' },
          sourcePath: { type: 'string' },
          lines: { type: 'integer' },
          bytes: { type: 'integer' },
          headings: { type: 'array', items: { type: 'string' } },
          boardOpen: { type: 'integer' },
          template: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已采集 ${value.date} → ${value.sourcePath}（${value.lines} 行，看板未完成 ${value.boardOpen} 条）。`
          + (value.headings?.length
            ? `\n\n采集到的小节：\n${value.headings.map(h => `- ${h.replace(/^##\s*/, '')}`).join('\n')}`
            : '')
          + `\n\n日报模板（把每节内容替换掉提示语）：\n\n\`\`\`markdown\n${value.template}\n\`\`\``,
      }],
    },
    async execute(args, exec) {
      const date = args.date ?? dateInZone(config.scheduleTimeZone)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期格式应为 YYYY-MM-DD，收到：${date}`)
      const result = await runScript(
        config,
        'collect-day.ps1',
        [
          '-Date', date,
          '-Workspace', config.workspace,
          '-ReportDir', config.reportDir,
          ...(args.sessions === false ? ['-NoSessions'] : []),
        ],
        exec.signal,
      )
      if (result.code !== 0) {
        throw new Error(`采集失败（退出码 ${result.code}）：\n${tail(result.stderr || result.stdout)}`)
      }
      let text
      try {
        text = await readFile(join(config.reportDir, '_源数据', `${date}.md`), 'utf8')
      } catch (error) {
        throw new Error(`采集脚本未产出 ${date} 的源数据：${tail(result.stdout) || String(error)}`)
      }
      const lines = text.split(/\r?\n/)
      const headings = lines.filter(line => /^##\s/.test(line)).map(line => line.trim())
      const board = await readBoard(config.reportDir)
      return {
        date,
        sourcePath: join(config.reportDir, '_源数据', `${date}.md`),
        lines: lines.length,
        bytes: Buffer.byteLength(text, 'utf8'),
        headings,
        boardOpen: board.open.length,
        template: buildTemplate(date),
      }
    },
  })

  ctx.tools.register({
    name: 'daily_report_save',
    description:
      '校验并落盘当天日报，然后把它「六、明日开场清单」推进看板。'
      + '正文必须包含六个固定小节（一、今日概览 … 六、明日开场清单）；缺节或留占位符会直接报错且不写文件，'
      + '按报错修好后重调即可。已存在同名日报会被整篇覆盖。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['content'],
      properties: {
        content: { type: 'string', description: '完整日报 Markdown 正文，从 `# 工作日报 · 日期` 开始。' },
        date: { type: 'string', description: '本地日期 YYYY-MM-DD，默认今天。' },
        push: { type: 'boolean', description: '是否推送看板，默认 true。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'reportPath', 'pushed', 'skipped', 'boardOpen'],
        properties: {
          date: { type: 'string' },
          reportPath: { type: 'string' },
          pushed: { type: 'integer' },
          skipped: { type: 'integer' },
          boardOpen: { type: 'integer' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const date = args.date ?? dateInZone(config.scheduleTimeZone)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期格式应为 YYYY-MM-DD，收到：${date}`)
      const content = String(args.content ?? '')
      const problems = []
      const missing = missingSections(content)
      if (missing.length > 0) problems.push(`缺少小节：${missing.join('、')}`)
      const body = content.replace(/^#[^\n]*\n/m, '')
      if (body.trim().length < 200) problems.push(`正文过短（${body.trim().length} 字符），确认不是只写了骨架`)
      if (/\bTODO\b|待填|\{\{/.test(content)) problems.push('仍留有占位符（TODO / 待填 / {{…}}）')
      if (problems.length > 0) {
        throw new Error(`日报未写入，先修正：\n- ${problems.join('\n- ')}`)
      }

      const stamp = stampInZone(config.scheduleTimeZone)
      const withFooter = /数据来源：/.test(content)
        ? content
        : `${content.replace(/\s*$/, '')}\n\n---\n数据来源：\`_源数据\\${date}.md\` ｜ 生成时间：${stamp}\n`
      const reportPath = join(config.reportDir, `日报-${date}.md`)
      await mkdir(config.reportDir, { recursive: true })
      await writeFile(reportPath, withFooter, 'utf8')

      const shouldPush = args.push ?? config.pushOnSave
      let pushed = 0
      let skipped = 0
      let pushText = ''
      if (shouldPush) {
        const result = await runScript(config, 'push-to-board.ps1', ['-Report', reportPath, '-BoardPath', boardPathOf(config)], exec.signal)
        if (result.code !== 0) {
          throw new Error(`日报已写入 ${reportPath}，但推送看板失败（退出码 ${result.code}）：\n${tail(result.stderr || result.stdout)}`)
        }
        pushText = result.stdout.trim()
        const match = /已写入\s*(\d+)\s*条[，,]\s*跳过重复\s*(\d+)\s*条/.exec(pushText)
        if (match) {
          pushed = Number(match[1])
          skipped = Number(match[2])
        }
      }
      const board = await readBoard(config.reportDir)
      const summary = shouldPush
        ? `日报已写入 ${reportPath}；看板 ${pushed ? `新增 ${pushed} 条` : '无新增条目'}${skipped ? `，跳过重复 ${skipped} 条` : ''}，当前未完成 ${board.open.length} 条。`
        : `日报已写入 ${reportPath}；按要求未推送看板。`
      return { date, reportPath, pushed, skipped, boardOpen: board.open.length, text: `${summary}\n${pushText}`.trim() }
    },
  })

  ctx.tools.register({
    name: 'work_summary_period',
    description:
      '聚合一个日期区间的周报/月报：先跑 collect-range.ps1 生成区间源数据，再写四节正文并推看板。'
      + '四节固定为「主线 / 关键产出 / 未清与复发 / 开场」，缺节、正文过短或留占位符会报错且不写文件。'
      + '不传 content 时按区间日报与看板自动拼一份可读草稿；传了 content 就按给定正文校验落盘。'
      + 'kind 不传时自动推断：整月=month、跨度 7 天=week、其余=custom。'
      + 'offset 用于定时任务生成上一完整周期：周报 offset=1 是上周一至周日，月报 offset=1 是上一个自然月。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', description: '起始日 YYYY-MM-DD；与 to 成对出现。都不传时 week=本周一至今天、month=本月 1 号至今天。' },
        to: { type: 'string', description: '结束日 YYYY-MM-DD（含当天）。' },
        kind: { type: 'string', enum: ['week', 'month', 'custom'], description: '报告类型；不传则按区间推断。' },
        offset: { type: 'integer', minimum: 0, maximum: 60, description: '往前数几个完整周期，默认 0；与 from/to 互斥。周报=整周，月报=整月。' },
        content: { type: 'string', description: '四节正文；不传则用区间日报自动聚合成草稿。' },
        push: { type: 'boolean', description: '是否把「开场」小节推进看板，默认 true。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['periodPath', 'reportPath', 'pushed', 'skipped', 'boardOpen', 'text'],
        properties: {
          periodPath: { type: 'string' },
          reportPath: { type: 'string' },
          pushed: { type: 'integer' },
          skipped: { type: 'integer' },
          boardOpen: { type: 'integer' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const range = resolvePeriod(args, config.scheduleTimeZone)
      const periodPath = join(config.reportDir, '_源数据', `周期-${range.from}_${range.to}.md`)
      const collected = await runScript(
        config,
        'collect-range.ps1',
        ['-From', range.from, '-To', range.to, '-Workspace', config.workspace, '-ReportDir', config.reportDir],
        exec.signal,
      )
      if (collected.code !== 0) {
        throw new Error(`区间采集失败（退出码 ${collected.code}）：\n${tail(collected.stderr || collected.stdout)}`)
      }
      if (!existsSync(periodPath)) {
        throw new Error(`区间采集脚本未产出 ${periodPath}：\n${tail(collected.stdout)}`)
      }

      const days = []
      for (let day = range.from; day <= range.to; day = shiftDay(day, 1)) days.push(day)
      const daily = new Map()
      for (const day of days) {
        try {
          daily.set(day, await readFile(join(config.reportDir, `日报-${day}.md`), 'utf8'))
        } catch {
          // 缺日报就跳过；缺了几天不影响整体聚合
        }
      }

      const board = await readBoard(config.reportDir)
      const provided = typeof args.content === 'string' && args.content.trim() !== ''
      let content = provided
        ? String(args.content)
        : composePeriodDraft(range, days, daily, board, dateInZone(config.scheduleTimeZone))

      const problems = []
      const missing = missingPeriodSections(content, range.kind)
      if (missing.length > 0) problems.push(`缺少小节：${missing.join('、')}`)
      const body = content.replace(/^#[^\n]*\n/m, '')
      if (body.trim().length < 200) problems.push(`正文过短（${body.trim().length} 字符），确认不是只写了骨架`)
      if (/\bTODO\b|待填|\{\{/.test(content)) problems.push('仍留有占位符（TODO / 待填 / {{…}}）')
      if (problems.length > 0) {
        throw new Error(`周期报告未写入，先修正：\n- ${problems.join('\n- ')}`)
      }

      const stamp = stampInZone(config.scheduleTimeZone)
      const reportName = periodReportName(range)
      const reportPath = join(config.reportDir, reportName)
      await mkdir(config.reportDir, { recursive: true })
      await writeFile(reportPath, withPeriodFooter(content, range, stamp), 'utf8')

      const shouldPush = args.push ?? config.pushOnSave
      let pushed = 0
      let skipped = 0
      let pushText = ''
      if (shouldPush) {
        const section = periodSectionLabels(range.kind)[3]
        const result = await runScript(
          config,
          'push-to-board.ps1',
          ['-Report', reportPath, '-BoardPath', boardPathOf(config), '-Section', section],
          exec.signal,
        )
        if (result.code !== 0) {
          throw new Error(`周期报告已写入 ${reportPath}，但推送看板失败（退出码 ${result.code}）：\n${tail(result.stderr || result.stdout)}`)
        }
        pushText = result.stdout.trim()
        const match = /已写入\s*(\d+)\s*条[，,]\s*跳过重复\s*(\d+)\s*条/.exec(pushText)
        if (match) {
          pushed = Number(match[1])
          skipped = Number(match[2])
        }
      }

      const after = await readBoard(config.reportDir)
      const kindLabel = PERIOD_KINDS[range.kind]?.label ?? '周期报告'
      const summary = shouldPush
        ? `${kindLabel}已写入 ${reportPath}；区间源数据 ${periodPath}；看板 ${pushed ? `新增 ${pushed} 条` : '无新增条目'}${skipped ? `，跳过重复 ${skipped} 条` : ''}，当前未完成 ${after.open.length} 条。`
        : `${kindLabel}已写入 ${reportPath}；区间源数据 ${periodPath}；按要求未推送看板。`
      return {
        periodPath,
        reportPath,
        pushed,
        skipped,
        boardOpen: after.open.length,
        text: `${summary}${provided ? '' : '\n正文由区间日报自动聚合，可直接使用，也可改写后用 content 重交。'}\n${pushText}`.trim(),
      }
    },
  })

  ctx.tools.register({
    name: 'daily_report_board',
    description:
      '查看或维护工作看板（_日报\\看板.md）。show 列出未完成待办；done 把匹配的待办移到「已完成」；'
      + 'drop 把决定不做的移到「已放弃」（不是完成）。done/drop 需要 keyword，按标题子串匹配。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['show', 'done', 'drop'], description: 'show | done | drop。' },
        keyword: { type: 'string', description: 'done/drop 必填，待办标题里的关键词。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'openCount', 'text'],
        properties: {
          action: { type: 'string' },
          openCount: { type: 'integer' },
          open: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const action = args.action
      if (action !== 'show' && action !== 'done' && action !== 'drop') {
        throw new Error(`未知动作：${action}`)
      }
      if (action !== 'show') {
        const keyword = String(args.keyword ?? '').trim()
        if (keyword === '') throw new Error(`${action} 需要 keyword`)
        const flag = action === 'done' ? '-Done' : '-Drop'
        const result = await runScript(config, 'push-to-board.ps1', [flag, keyword, '-BoardPath', boardPathOf(config)], exec.signal)
        if (result.code !== 0) {
          throw new Error(`${action} 失败（退出码 ${result.code}）：\n${tail(result.stderr || result.stdout)}`)
        }
        const board = await readBoard(config.reportDir)
        return {
          action,
          openCount: board.open.length,
          open: board.open,
          text: `${result.stdout.trim()}\n未完成 ${board.open.length} 条。`.trim(),
        }
      }
      const result = await runScript(config, 'push-to-board.ps1', ['-Show', '-BoardPath', boardPathOf(config)], exec.signal)
      if (result.code !== 0) {
        throw new Error(`读取看板失败（退出码 ${result.code}）：\n${tail(result.stderr || result.stdout)}`)
      }
      const board = await readBoard(config.reportDir)
      const listed = board.open.slice(0, 30).join('\n')
      return {
        action,
        openCount: board.open.length,
        open: board.open.slice(0, 50),
        text: board.open.length === 0
          ? '看板没有未完成待办。'
          : `未完成 ${board.open.length} 条：\n${listed}`,
      }
    },
  })

  // 侧边栏「日报」页面读的数据：只读、同源、不缓存。Host 没接 Web 服务时这段自动缺席。
  ctx.inject(['webServer'], (webCtx) => {
    const dispose = webCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-work-summary/state',
      resource: async () => {
        try {
          const payload = await readState(config)
          return new Response(JSON.stringify(payload), {
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          })
        } catch (error) {
          return new Response(JSON.stringify({ error: String(error?.message ?? error) }), {
            status: 500,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          })
        }
      },
    })
    return () => { if (typeof dispose === 'function') dispose() }
  })

  // 设置页：读/改那条日报计划任务。任务的 rrule 就是唯一真源，不另存一份配置。
  ctx.inject(['webServer', 'schedule'], (sc) => {
    const send = (res, status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    const dispose = sc.webServer.register({
      kind: 'exact',
      path: '/dsh-work-summary/schedule',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET' || req.method === 'HEAD') {
            const [daily, week, month] = await Promise.all([
              scheduleState(sc, config),
              periodScheduleState(sc, config, 'week'),
              periodScheduleState(sc, config, 'month'),
            ])
            send(res, 200, settingsPayload({ daily, week, month }, config))
            return
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'GET, HEAD, POST' })
            res.end()
            return
          }
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const raw = Buffer.concat(chunks).toString('utf8')
          const body = raw.trim() === '' ? {} : JSON.parse(raw)
          const patch = {}
          let touched = false
          // 周报/月报：时间与启停都先落到 settings.json，再改任务本身；任务被删了还能按保存的值重建。
          for (const spec of [
            { kind: 'week', label: '周报', timeField: 'weekTime', activeField: 'weekActive', timeKey: 'weekScheduleTime', enabledKey: 'weekScheduleEnabled', rrule: weeklyRrule },
            { kind: 'month', label: '月报', timeField: 'monthTime', activeField: 'monthActive', timeKey: 'monthScheduleTime', enabledKey: 'monthScheduleEnabled', rrule: monthlyRrule },
          ]) {
            const time = body[spec.timeField]
            const wantActive = body[spec.activeField]
            if (time === undefined && wantActive === undefined) continue
            touched = true
            const current = await periodScheduleState(sc, config, spec.kind)
            if (!current.found) throw new Error(`没找到${spec.label}计划任务；先重启一次让插件把它建出来`)
            const periodPatch = {}
            if (time !== undefined) {
              if (typeof time !== 'string') throw new Error(`${spec.timeField} 应为字符串`)
              if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`时间格式应为 HH:MM，收到：${time}`)
              periodPatch.timing = { kind: 'rrule', rrule: spec.rrule(current.timeZone, time) }
              await writeSettings({ [spec.timeKey]: time })
              config[spec.timeKey] = time
            }
            if (wantActive !== undefined) {
              if (typeof wantActive !== 'boolean') throw new Error(`${spec.activeField} 应为布尔值`)
              periodPatch.active = wantActive
              await writeSettings({ [spec.enabledKey]: wantActive })
              config[spec.enabledKey] = wantActive
            }
            if (Object.keys(periodPatch).length > 0) {
              await sc.schedule.edit({ id: current.id, action: 'update', patch: periodPatch })
            }
          }
          if (typeof body.time === 'string' || typeof body.active === 'boolean') {
            touched = true
            const current = await scheduleState(sc, config)
            if (!current.found) throw new Error('没找到日报计划任务；先重启一次让插件把它建出来')
            if (typeof body.time === 'string') {
              if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) throw new Error(`时间格式应为 HH:MM，收到：${body.time}`)
              patch.timing = { kind: 'rrule', rrule: dailyRrule(current.timeZone, body.time) }
            }
            if (typeof body.active === 'boolean') patch.active = body.active
          }
          if (body.reportDir !== undefined) {
            touched = true
            if (typeof body.reportDir !== 'string') throw new Error('reportDir 应为字符串')
            const value = body.reportDir.trim()
            if (!/^[A-Za-z]:[\\/]|^\\\\|^\//.test(value)) {
              throw new Error('日报目录要写绝对路径，比如 D:\\reports')
            }
            await mkdir(value, { recursive: true })
            await writeSettings({ reportDir: value })
            config.reportDir = value
            await logLine(config, 'info', `日报目录改为 ${value}（日报、看板、源数据都写到这里）`)
          }
          if (body.workspace !== undefined) {
            touched = true
            if (typeof body.workspace !== 'string') throw new Error('workspace 应为字符串')
            const value = body.workspace.trim()
            if (!/^[A-Za-z]:[\\/]|^\\\\|^\//.test(value)) {
              throw new Error('工作空间要写绝对路径，比如 D:\\projects')
            }
            await mkdir(value, { recursive: true })
            await writeSettings({ workspace: value })
            config.workspace = value
            await logLine(config, 'info', `工作空间改为 ${value}（日报会扫描这里当天的改动）`)
          }
          if (body.logDir !== undefined) {
            touched = true
            if (typeof body.logDir !== 'string') throw new Error('logDir 应为字符串')
            const value = body.logDir.trim()
            if (value !== '' && !/^[A-Za-z]:[\\/]|^\\\\|^\//.test(value)) {
              throw new Error('日志目录要写绝对路径，比如 D:\\logs；留空表示用数据目录下的 _日志')
            }
            const target = value === '' ? join(config.reportDir, '_日志') : value
            await mkdir(target, { recursive: true })
            await writeSettings({ logDir: value })
            config.logDir = value
            await logLine(config, 'info', `日志目录改为 ${logDirOf(config)}`)
          }
          if (!touched) {
            throw new Error('没有要改的字段（time / active / weekTime / weekActive / monthTime / monthActive / reportDir / workspace / logDir）')
          }
          if (Object.keys(patch).length > 0) {
            await sc.schedule.edit({ id: (await scheduleState(sc, config)).id, action: 'update', patch })
          }
          const [daily, week, month] = await Promise.all([
            scheduleState(sc, config),
            periodScheduleState(sc, config, 'week'),
            periodScheduleState(sc, config, 'month'),
          ])
          send(res, 200, settingsPayload({ daily, week, month }, config))
        } catch (error) {
          send(res, 400, { error: String(error?.message ?? error) })
        }
      },
    })
    return () => { if (typeof dispose === 'function') dispose() }
  })

  if (config.scheduleEnabled) installSchedule(ctx, config)
}

/**
 * 插件自管的计划任务：日报每天一条，周报每周一、月报每月 1 号各一条。
 * 已有同标题任务就同步提示词/时间/启停；日报没有则认领旧任务，周报月报没有则按开关新建。
 * 失败只记日志，不影响工具可用。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {typeof DEFAULTS} config - 生效配置。
 * @returns {void}
 */
function installSchedule(ctx, config) {
  const prompt = schedulePrompt(config)
  ctx.inject(['schedule'], (scheduleCtx) => {
    void (async () => {
      const page = await scheduleCtx.schedule.list({ limit: 200 })
      const items = page.items ?? []
      const own = findOwnTask(items, config)
      if (own) {
        if (own.status === 'active' && own.prompt !== prompt) {
          await scheduleCtx.schedule.edit({ id: own.id, action: 'update', patch: { prompt } })
          ctx.logger?.info?.('dsh-work-summary: 已同步日报计划任务的提示词')
          void logLine(config, 'info', `计划任务「${own.title}」的提示词已同步到当前版本`)
        }
      } else {
        const legacy = config.scheduleAdopt
          ? items.find(task => task.status === 'active' && /collect-day\.ps1|daily_report_collect/.test(String(task.prompt ?? '')))
          : null
        if (legacy) {
          await scheduleCtx.schedule.edit({ id: legacy.id, action: 'update', patch: { prompt } })
          ctx.logger?.info?.(`dsh-work-summary: 已把旧日报计划任务「${legacy.title}」切到插件工具`)
          void logLine(config, 'info', `已认领旧任务「${legacy.title}」，提示词切到插件工具`)
        } else {
          const today = dateInZone(config.scheduleTimeZone).replace(/-/g, '')
          const [hour, minute] = config.scheduleTime.split(':')
          const rrule = `DTSTART;TZID=${config.scheduleTimeZone}:${today}T${hour}${minute}00\nRRULE:FREQ=DAILY`
          await scheduleCtx.schedule.create({
            title: config.scheduleTitle,
            prompt,
            timing: { kind: 'rrule', rrule },
            target: { kind: 'new_once' },
          })
          ctx.logger?.info?.(`dsh-work-summary: 已创建每日 ${config.scheduleTime} 的日报计划任务`)
          void logLine(config, 'info', `已创建每日 ${config.scheduleTime} 的日报计划任务`)
        }
      }
      await installPeriodTask(ctx, scheduleCtx, config, 'week')
      await installPeriodTask(ctx, scheduleCtx, config, 'month')
    })().catch((error) => {
      ctx.logger?.warn?.(`dsh-work-summary: 计划任务处理失败：${error instanceof Error ? error.message : String(error)}`)
    })
  })
}

/**
 * 托管一条周期任务：时间/启停以插件配置为准，标题是稳定识别键。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {*} scheduleCtx - schedule 服务上下文。
 * @param {typeof DEFAULTS} config - 生效配置。
 * @param {'week'|'month'} kind - 周报或月报。
 * @returns {Promise<void>} 完成。
 */
async function installPeriodTask(ctx, scheduleCtx, config, kind) {
  const week = kind === 'week'
  const title = week ? config.weekScheduleTitle : config.monthScheduleTitle
  const time = week ? config.weekScheduleTime : config.monthScheduleTime
  const enabled = Boolean(week ? config.weekScheduleEnabled : config.monthScheduleEnabled)
  const prompt = periodPrompt(config, kind)
  const rrule = (week ? weeklyRrule : monthlyRrule)(config.scheduleTimeZone, time)
  const items = (await scheduleCtx.schedule.list({ limit: 200 })).items ?? []
  const task = findTaskByTitle(items, title)
  const label = week ? '周报' : '月报'

  if (!task) {
    if (!enabled) return
    await scheduleCtx.schedule.create({
      title,
      prompt,
      timing: { kind: 'rrule', rrule },
      target: { kind: 'new_once' },
    })
    ctx.logger?.info?.(`dsh-work-summary: 已创建${label}计划任务（${time}）`)
    void logLine(config, 'info', `已创建${label}计划任务「${title}」（${time}）`)
    return
  }

  const patch = {}
  if (task.prompt !== prompt) patch.prompt = prompt
  const parsed = parseRruleTime(task)
  const [hour, minute] = time.split(':').map(Number)
  if (parsed.hour !== hour || parsed.minute !== minute) patch.timing = { kind: 'rrule', rrule }
  if ((task.status === 'active') !== enabled) patch.active = enabled
  if (Object.keys(patch).length === 0) return
  await scheduleCtx.schedule.edit({ id: task.id, action: 'update', patch })
  ctx.logger?.info?.(`dsh-work-summary: 已同步${label}计划任务`)
  void logLine(config, 'info', `${label}计划任务「${title}」已同步（${enabled ? time : '已暂停'}）`)
}

/**
 * 交给计划任务执行的提示词：只说流程，细则留在 PROMPT.md。
 * @param {typeof DEFAULTS} config - 生效配置。
 * @returns {string} 提示词正文。
 */
function schedulePrompt(config) {
  return [
    '每日工作日报时间到。用 dsh-work-summary 插件的工具完成今日日报：',
    '',
    '1. 调用 `daily_report_collect`（不传 date 即今天），然后读取返回的 sourcePath（源数据底稿）。',
    `2. 按 \`${config.promptPath}\` 的规则写正文，结构用 collect 返回的 template 六节。`,
    '3. 调用 `daily_report_save` 提交：它会校验结构、写日报文件、把「明日开场清单」推进看板。报错就按提示修正后重试。',
    '4. 回复：日报路径 + 写入看板条数 + 三条最重要结论（≤5 行）。',
    '',
    '只写有证据支撑的内容，推断标「推断：」；采集失败或数据缺失就写明原因，不要编造。当天几乎无产出就写短版。',
  ].join('\n')
}

/**
 * 周报/月报计划任务的提示词：固定生成上一完整周期，避免月初/周一拿到空区间。
 * @param {typeof DEFAULTS} config - 生效配置。
 * @param {'week'|'month'} kind - 周报或月报。
 * @returns {string} 提示词正文。
 */
function periodPrompt(config, kind) {
  const week = kind === 'week'
  const label = week ? '周报' : '月报'
  const span = week ? '上一周（周一至周日）' : '上一个自然月'
  return [
    `定时${label}时间到。用 work_summary_period 工具生成${span}的${label}：`,
    '',
    `1. 调用 \`work_summary_period\`，参数 { "kind": "${kind}", "offset": 1 }；它会先采集区间源数据，再写四节正文并推看板。`,
    '2. 读返回的 reportPath，核对四节是否齐全，并记下哪些日期缺日报。',
    `3. 回复：${label}路径 + 看板新增条数 + 三条最重要结论（≤5 行）；缺日报的日期一并点出。`,
    '',
    '只写有证据支撑的内容，不要编造；写入失败就说明原因，不要重复硬跑。',
  ].join('\n')
}
