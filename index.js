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
  /** 额外扫描的工作区根（可选）：留空时只按 DSH 会话自动发现工作区。 */
  workspace: '',
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
  /** 日报保存时的软校验；只提醒，不阻断落盘。 */
  quality: { minEvidence: 3 },
  /** 主线账本：连续这么多天没有新产出就判「受阻」。 */
  mainline: { stallDays: 3 },
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

/** 空话词库：只用于日报软校验提醒，不决定落盘与否。 */
const FILLER_WORDS = [
  '继续推进', '加强沟通', '持续优化', '进一步提升', '稳步推进', '深入推进',
  '扎实做好', '高度重视', '协同发力', '形成闭环', '提质增效', '落地见效',
]

/** 建议小节里算「可执行」的命令线索。 */
const COMMAND_HINT = /(?:^|[\s`（(])(?:npm|pnpm|yarn|git|node|pwsh|powershell|python|pip|dotnet|cargo|docker|kubectl|rg|curl|make)\b|(?:^|[\s`（(])(?:Get|Set|New|Remove|Test|Start|Stop|Invoke|Import|Export|Select|Where|ForEach)-[A-Za-z]+/m

/**
 * 路径/提交号线索。分开写是为了让 Windows 盘符、UNC、POSIX/相对路径、
 * 带扩展名的文件名和 7–40 位十六进制提交号都能被认出来。
 */
const EVIDENCE_PATTERNS = [
  /[A-Za-z]:[\\/][^\s`"'<>|，。；：、）)]+/g,
  /\\\\[^\s`"'<>|，。；：、）)]+/g,
  /(?<![\w])(?:\.{1,2}[\\/]|[A-Za-z_][\w.-]*[\\/])[^\s`"'<>|，。；：、）)]+/g,
  /\b[\w.-]+\.(?:md|ps1|js|mjs|cjs|json|ya?ml|toml|txt|log|ts|tsx|jsx|py|cs|go|rs|sh|bat|cmd|exe|svg|png)\b/gi,
  /\b[0-9a-f]{7,40}\b/gi,
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
    workspaceDefault: '',
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
    '（表格 3–5 行，一行一条主线：`| 主线 | 工作区 | 今日产出 | 状态 | 下一步 |` + `|---|---|---|---|---|`；表后一句话结论）',
    '',
    '## 二、做了什么',
    '（按工作区分块：`### 工作区名（路径）`；块内每条主线一个 `#### M-YYYY-MM-DD-NN 标题` 小节，写清做了什么 → 落在哪个路径/模块 + 证据）',
    '（`####` 块内固定三行：`- 工作区：绝对路径`、`- 状态：进行中/完成/受阻/放弃`（四值精确，勿写「未完成」）、`- 判据：可验收的一句话`；新主线的 ID 日期用今天、序号两位；补写往日日报只补证据，状态与判据以最近一次为准）',
    '',
    '## 三、结果与产出',
    '（表格：产出物 | 路径 | 状态（完成/进行中/待验证）| 说明 | 主线）',
    '',
    '## 四、问题与风险',
    '（暴露的问题、未通过的验证、遗留脏数据；挂着的主线写 M-ID 与已挂天数，每条给出影响面）',
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
 * 正文里的路径/提交号引用，按去重后的条目数计。
 * @param {string} text - 日报正文。
 * @returns {Set<string>} 归一化后的引用。
 */
function evidenceRefs(text) {
  const found = new Set()
  // 链接里的域名和路径不算「工作证据」，先去掉；行内代码保留内容，方便识别 `index.js`。
  const clean = String(text).replace(/https?:\/\/\S+/g, ' ').replace(/`([^`]*)`/g, ' $1 ')
  for (const pattern of EVIDENCE_PATTERNS) {
    for (const match of clean.matchAll(pattern)) {
      const value = match[0]
        .replace(/^[`'"([（]+/, '')
        .replace(/[`'")\]）.,;:，。；：、]+$/, '')
        .toLowerCase()
      if (value.length >= 2) found.add(value)
    }
  }
  // 同一个 Windows 路径会同时命中「完整路径 / 相对后缀 / 文件名」，只留最长的那条，避免虚高。
  const refs = new Set()
  for (const value of [...found].sort((a, b) => b.length - a.length)) {
    if ([...refs].some(existing => existing.includes(value))) continue
    refs.add(value)
  }
  return refs
}

/** 建议小节里是否已有路径或可执行命令。 */
function hasPathOrCommand(text) {
  if (evidenceRefs(text).size > 0) return true
  if (COMMAND_HINT.test(text)) return true
  // 反引号里带空格的多半是命令或脚本调用，例如 `collect-day.ps1 -Date 2026-11-25`。
  return (String(text).match(/`[^`\n]+`/g) ?? []).some(span => /\s/.test(span.trim()))
}

/** 读取 `quality.minEvidence`：支持嵌套对象，也兼容扁平点号键；非法值退回默认 3。 */
function minEvidenceOf(config) {
  const quality = config?.quality
  const nested = quality && typeof quality === 'object' ? quality.minEvidence : quality
  const flat = config?.['quality.minEvidence']
  const raw = flat ?? nested ?? DEFAULTS.quality.minEvidence
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : DEFAULTS.quality.minEvidence
}

/**
 * 日报软校验：只生成提醒，不抛错，也不阻止落盘。
 * @param {string} content - 日报正文（未补 footer）。
 * @param {number} minEvidence - 证据引用下限。
 * @returns {string[]} 提醒文案。
 */
function qualityWarnings(content, minEvidence) {
  const warnings = []
  const refs = evidenceRefs(content)
  if (refs.size < minEvidence) {
    warnings.push(`证据偏少：正文只有 ${refs.size} 处路径/提交号引用（建议至少 ${minEvidence} 处）`)
  }
  const filler = FILLER_WORDS.filter(word => String(content).includes(word))
  if (filler.length > 0) {
    warnings.push(`空话词：${filler.join('、')}；换成具体动作、对象或结果`)
  }
  const advice = sectionLines(content, '五').join('\n')
  if (advice.trim() !== '' && !hasPathOrCommand(advice)) {
    warnings.push('「五、后续建议」没有路径或命令，建议补上具体文件、脚本或命令')
  }
  return warnings
}

/**
 * 投入统计（R35）：展示格式与 `scripts/collect-day.ps1` / `collect-range.ps1` 的
 * `Format-Duration` / `Format-TokenCount` 对齐，避免同一组数字在源数据和正文里长得不一样。
 */
function formatDuration(ms) {
  const value = Number(ms) || 0
  if (value <= 0) return '0m'
  const minutes = Math.round(value / 60000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

function formatTokens(value) {
  const n = Number(value) || 0
  // 999950 起改显示 M：否则 999_950 会被四舍五入成「1000.0K」。
  if (n >= 999950) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

function usageHitRate(usage) {
  const denom = (Number(usage?.input) || 0) + (Number(usage?.cache) || 0)
  return denom > 0 ? (Number(usage.cache) / denom * 100).toFixed(1) : '0.0'
}

function usageParts(usage, options = {}) {
  const { sessions = true, dayLabel = '会话' } = options
  const parts = []
  if (sessions && Number(usage?.sessions) > 0) parts.push(`${dayLabel} ${usage.sessions} 个`)
  parts.push(`活跃 ${formatDuration(usage?.activeMs)}`)
  parts.push(`模型 ${formatDuration(usage?.modelMs)}`)
  parts.push(`工具 ${formatDuration(usage?.toolMs)}`)
  parts.push(`等你确认 ${formatDuration(usage?.waitMs)}`)
  return parts.join(' · ')
}

function usageTokenParts(usage) {
  return `合计 ${formatTokens(usage?.total)}（新输入 ${formatTokens(usage?.input)} / 缓存读 ${formatTokens(usage?.cache)}`
    + ` / 输出 ${formatTokens(usage?.output)}，缓存命中 ${usageHitRate(usage)}%）`
}

/** 一行式投入汇总，日报正文直接照抄。 */
function usageSummaryLine(usage, dayLabel = '会话') {
  if (!usage) return ''
  return `投入：${usageParts(usage, { dayLabel })}｜Token ${formatTokens(usage?.total)}（新输入 ${formatTokens(usage?.input)}`
    + ` / 缓存读 ${formatTokens(usage?.cache)} / 输出 ${formatTokens(usage?.output)}，缓存命中 ${usageHitRate(usage)}%）`
}

/** 源数据里的机器可读行：`<!-- dsh-usage {…} -->`，区间版是 `dsh-usage-range`。 */
const USAGE_COMMENT = /^<!--\s*dsh-usage(?:-range)?\s+(\{.*\})\s*-->\s*$/m

function parseUsageComment(text) {
  if (!text) return null
  const match = USAGE_COMMENT.exec(text)
  if (!match) return null
  try {
    const value = JSON.parse(match[1])
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** 主线 ID 的形态；日期段用于区分「当天新建」与「引用旧账」。 */
const MAINLINE_ID_SOURCE = 'M-\\d{4}-\\d{2}-\\d{2}-\\d{2}'
const MAINLINE_HEADING = new RegExp(`^####\\s+(${MAINLINE_ID_SOURCE})\\s*(.*)$`)
const MAINLINE_ANY = new RegExp(`(${MAINLINE_ID_SOURCE})`, 'g')
const MAINLINE_STATUSES = ['进行中', '完成', '受阻', '放弃']
const LEDGER_FILE = '_主线.md'

/** 把状态文案归一；只认四个值本身或以其开头，否定式（未完成/待完成）一律返回空串。 */
function normalizeStatus(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (MAINLINE_STATUSES.includes(text)) return text
  if (/^(?:未|待|尚未|没有)/.test(text)) return ''
  return MAINLINE_STATUSES.find(status => text.startsWith(status)) ?? ''
}

/** 账本日期：只认 YYYY-MM-DD；`—`、空串、带说明的文字一律当没写。 */
function ledgerDate(value) {
  const text = String(value ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
}

/** 读文本文件，读不到返回空串（账本不存在是正常状态）。 */
async function readTextIfExists(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 解析 `_主线.md` 账本。只认 `## M-... 标题` 与固定字段/判据行，其余行当备注忽略。
 * @param {string} text - 账本正文。
 * @returns {Array<object>} 主线条目，保持文件里的顺序。
 */
function parseLedger(text) {
  const entries = []
  let current = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    const heading = new RegExp(`^##\\s+(${MAINLINE_ID_SOURCE})\\s*(.*)$`).exec(line)
    if (heading) {
      current = {
        id: heading[1], title: heading[2].trim(), workspace: '', status: '进行中',
        first: '', last: '', board: '', criteria: [], notes: [],
      }
      entries.push(current)
      continue
    }
    if (!current) continue
    const criterion = /^-\s*\[( |x|X)\]\s*(.+)$/.exec(line)
    if (criterion) {
      current.criteria.push({ done: criterion[1].toLowerCase() === 'x', text: criterion[2].trim() })
      continue
    }
    const field = /^-\s*(工作区|状态|首次产出|最近产出|判据|看板|备注)\s*[：:]\s*(.*)$/.exec(line)
    if (field) {
      const key = field[1]
      const value = field[2].trim()
      if (key === '工作区') current.workspace = value.replace(/^`|`$/g, '')
      else if (key === '状态') current.status = normalizeStatus(value) || '进行中'
      else if (key === '首次产出') current.first = ledgerDate(value)
      else if (key === '最近产出') current.last = ledgerDate(value)
      else if (key === '看板') current.board = value
      else if (key === '判据') {
        for (const part of value.split(/[；;]/).map(item => item.trim()).filter(Boolean)) {
          current.criteria.push({ done: false, text: part })
        }
      } else if (key === '备注' && value) current.notes.push(value)
      continue
    }
    if (line.startsWith('- ')) {
      const note = line.slice(2).trim()
      if (note) current.notes.push(note)
    }
  }
  return entries
}

/**
 * 从日报正文里抽出 `#### M-... 标题` 小节。遇到其他标题就结束当前小节，
 * 所以主线小节要写在「二、做了什么」内部、不要跨到下一节。
 * @param {string} content - 日报正文。
 * @returns {Array<object>} 每条的 id / 标题 / 工作区 / 状态 / 判据 / 看板。
 */
function parseReportMainlines(content) {
  const blocks = []
  let current = null
  for (const raw of String(content).split(/\r?\n/)) {
    const line = raw.trim()
    const heading = MAINLINE_HEADING.exec(line)
    if (heading) {
      current = {
        id: heading[1], title: heading[2].trim(), workspace: '', status: '', statusRaw: '', board: '', criteria: [],
      }
      blocks.push(current)
      continue
    }
    if (/^#{1,5}\s/.test(line)) { current = null; continue }
    if (!current) continue
    const criterion = /^-\s*\[( |x|X)\]\s*(.+)$/.exec(line)
    if (criterion) {
      current.criteria.push({ done: criterion[1].toLowerCase() === 'x', text: criterion[2].trim() })
      continue
    }
    const field = /^-\s*(工作区|状态|判据|看板)\s*[：:]\s*(.*)$/.exec(line)
    if (!field) continue
    const key = field[1]
    const value = field[2].trim()
    if (key === '工作区') current.workspace = value.replace(/^`|`$/g, '')
    else if (key === '状态') { current.statusRaw = value; current.status = normalizeStatus(value) }
    else if (key === '看板') current.board = value
    else if (key === '判据') {
      for (const part of value.split(/[；;]/).map(item => item.trim()).filter(Boolean)) {
        current.criteria.push({ done: false, text: part })
      }
    }
  }
  return blocks
}

/**
 * 主线引用校验：正文里出现的每个 M-ID 必须「账号本里的旧 ID」或「日期等于日报日期的新 ID」，
 * 新 ID 还必须写成 `####` 小节，否则不知道标题与判据。全部问题一次返回，便于一次修完。
 * @param {string} content - 日报正文。
 * @param {Array<object>} blocks - parseReportMainlines 的结果。
 * @param {string} date - 日报日期。
 * @param {Array<object>} ledger - 现有账本条目。
 * @returns {string[]} 问题列表；为空表示通过。
 */
function validateReportMainlines(content, blocks, date, ledger) {
  const known = new Set(ledger.map(entry => entry.id))
  const inHeading = new Set(blocks.map(block => block.id))
  const problems = []
  const seen = new Set()
  // 代码块里可能引用示例 ID（模板、命令输出），不该当成主线引用去报错。
  const plain = String(content).replace(/^[ \t]*```[\s\S]*?^[ \t]*```[ \t]*$/gm, '')
  for (const match of plain.matchAll(MAINLINE_ANY)) {
    const id = match[1]
    if (seen.has(id)) continue
    seen.add(id)
    const idDate = id.slice(2, 12)
    if (idDate > date) {
      problems.push(`主线 ${id} 的日期晚于日报日期 ${date}`)
    } else if (idDate !== date && !known.has(id)) {
      problems.push(`主线 ${id} 不在 ${LEDGER_FILE} 账本里：新主线的 ID 日期要等于日报日期 ${date}，旧主线要沿用账本里的 ID`)
    } else if (idDate === date && !known.has(id) && !inHeading.has(id)) {
      problems.push(`新主线 ${id} 还没有小节：在「二、做了什么」里写成 \`#### ${id} 标题\``)
    }
  }
  for (const block of blocks) {
    if (!block.statusRaw) {
      problems.push(`主线 ${block.id} 缺少 \`- 状态：\` 行：只能是 进行中 / 完成 / 受阻 / 放弃`)
    } else if (!block.status) {
      problems.push(`主线 ${block.id} 的状态只能是 进行中 / 完成 / 受阻 / 放弃，收到：${block.statusRaw}`)
    }
  }
  // 单数字序号不会被上面的正则识别，会静默漏账；这里单独点出来，让写的人补成两位。
  const shortIds = new Set()
  for (const match of plain.matchAll(/M-\d{4}-\d{2}-\d{2}-\d(?!\d)/g)) {
    if (shortIds.has(match[0])) continue
    shortIds.add(match[0])
    problems.push(`主线 ${match[0]} 的序号要两位，例如 M-${date}-01`)
  }
  return problems
}

/**
 * 把日报里的主线小节并入账本：新 ID 追加，旧 ID 只更新标题 / 工作区 / 状态 / 判据 / 看板，
 * 最近产出取较大日期（补写旧日报不会把最近产出往回拨）。
 * @param {Array<object>} ledger - 现有条目。
 * @param {Array<object>} blocks - 日报里的小节。
 * @param {string} date - 日报日期。
 * @returns {Array<object>} 合并后的条目。
 */
function mergeLedger(ledger, blocks, date) {
  const map = new Map(ledger.map(entry => [entry.id, {
    ...entry, criteria: entry.criteria.map(item => ({ ...item })), notes: [...entry.notes],
  }]))
  for (const block of blocks) {
    const entry = map.get(block.id) ?? {
      id: block.id, title: '', workspace: '', status: '进行中',
      first: date, last: date, board: '', criteria: [], notes: [],
    }
    // 补写旧日报只补证据；状态与判据进度只在「不早于最近产出」时更新，避免把完成回拨成进行中。
    const forward = !entry.last || date >= entry.last
    if (block.title) entry.title = block.title
    if (block.workspace) entry.workspace = block.workspace
    if (forward && block.status) entry.status = block.status
    if (block.board) entry.board = block.board
    if (forward && block.criteria.length > 0) entry.criteria = block.criteria
    if (!entry.first || date < entry.first) entry.first = date
    if (!entry.last || date > entry.last) entry.last = date
    map.set(block.id, entry)
  }
  return [...map.values()]
}

/**
 * 给账本条目算挂起天数与展示状态：完成 / 放弃保持原状，其余超过阈值显示「受阻」。
 * @param {Array<object>} entries - 账本条目。
 * @param {string} today - 参考日期。
 * @param {number} stallDays - 判定受阻的天数。
 * @returns {Array<object>} 用于输出与提醒的视图。
 */
function mainlineView(entries, today, stallDays) {
  return entries.map((entry) => {
    const last = ledgerDate(entry.last)
    const stall = last ? Math.max(0, daysBetween(last, today)) : 0
    const open = entry.status !== '完成' && entry.status !== '放弃'
    return {
      id: entry.id,
      title: entry.title || '（未命名）',
      workspace: entry.workspace,
      status: open && stall >= stallDays ? '受阻' : entry.status,
      lastOutput: last,
      stallDays: stall,
    }
  })
}

/** 把账本条目写回 Markdown：顺序即条目顺序，字段格式与 parseLedger 对应。 */
function ledgerMarkdown(entries) {
  const out = [
    '# 主线账本',
    '',
    '> 由 `daily_report_save` 自动维护：日报里的 `#### M-YYYY-MM-DD-NN 标题` 会新增或更新这里，不要手工改 ID。',
    '',
  ]
  for (const entry of entries) {
    out.push(`## ${entry.id} ${entry.title}`.trim())
    out.push('')
    out.push(`- 工作区：${entry.workspace || '（未标注）'}`)
    out.push(`- 状态：${entry.status}`)
    out.push(`- 首次产出：${entry.first || '—'}`)
    out.push(`- 最近产出：${entry.last || '—'}`)
    if (entry.board) out.push(`- 看板：${entry.board}`)
    for (const criterion of entry.criteria) {
      out.push(`- [${criterion.done ? 'x' : ' '}] ${criterion.text}`)
    }
    for (const note of entry.notes ?? []) out.push(`- 备注：${note}`)
    out.push('')
  }
  return out.join('\n')
}

/** 读取 `mainline.stallDays`：支持嵌套与扁平点号键，非法值退回 3。 */
function stallDaysOf(config) {
  const mainline = config?.mainline
  const nested = mainline && typeof mainline === 'object' ? mainline.stallDays : mainline
  const value = Number(config?.['mainline.stallDays'] ?? nested ?? DEFAULTS.mainline.stallDays)
  return Number.isInteger(value) && value > 0 ? value : DEFAULTS.mainline.stallDays
}

/**
 * 逐日热力值：非空行数 + 产出条目数 × 3。
 * 行数代表当天写了多少，产出条目代表落地的结果；权重 3 让「有产出」的一天明显亮于「写得长但没产出」。
 * @param {string} content - 日报正文。
 * @returns {{ lines: number, outputs: number, score: number }} 统计值。
 */function heatStats(content) {
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
 * 汇总区间内的主线：日报 `#### M-...` 小节给工作区/状态/最近推进，账本补首次产出与判据勾选。
 * 账本里未清、但区间日报没有小节的条目也会带上（标「本期未推进」），便于看出跨期停滞。
 * @param {string[]} days - 有日报的日期（升序）。
 * @param {Map<string, string>} daily - 日期 → 日报正文。
 * @param {Array<object>} ledger - parseLedger 的结果。
 * @param {string} endDate - 区间结束日，用它算挂起天数。
 * @param {number} stallDays - 判定受阻的天数。
 * @returns {Array<object>} 主线视图，按首次产出排序。
 */
function collectPeriodMainlines(days, daily, ledger, endDate, stallDays) {
  const map = new Map()
  const ensure = (id) => {
    if (!map.has(id)) {
      map.set(id, {
        id, title: '', workspace: '', status: '进行中', first: '', last: '',
        criteriaDone: 0, criteriaTotal: 0, touched: false, fromLedger: false,
      })
    }
    return map.get(id)
  }
  for (const entry of ledger) {
    const started = String(entry.id ?? '').match(/^M-(\d{4}-\d{2}-\d{2})-\d{2}$/)
    // 账本里可能有区间结束后才出现的主线，不能倒灌进历史周期的「本期未推进」。
    if (!started || started[1] > endDate) continue
    const item = ensure(entry.id)
    item.fromLedger = true
    if (entry.title) item.title = entry.title
    if (entry.workspace) item.workspace = entry.workspace
    if (entry.status) item.status = entry.status
    const first = ledgerDate(entry.first)
    const last = ledgerDate(entry.last)
    if (first) item.first = first
    if (last) item.last = last
    item.criteriaDone = entry.criteria.filter(criterion => criterion.done).length
    item.criteriaTotal = entry.criteria.length
  }
  for (const day of days) {
    for (const block of parseReportMainlines(daily.get(day))) {
      const item = ensure(block.id)
      item.touched = true
      if (block.title) item.title = block.title
      if (block.workspace) item.workspace = block.workspace
      if (block.status) item.status = block.status
      if (!item.first || day < item.first) item.first = day
      if (!item.last || day > item.last) item.last = day
      if (!item.fromLedger && block.criteria.length > 0) {
        item.criteriaDone = block.criteria.filter(criterion => criterion.done).length
        item.criteriaTotal = block.criteria.length
      }
    }
  }
  const view = []
  for (const item of map.values()) {
    if (item.first && item.first > endDate) continue
    const open = item.status !== '完成' && item.status !== '放弃'
    if (!open && !item.touched) continue
    const last = ledgerDate(item.last)
    const stall = last ? Math.max(0, daysBetween(last, endDate)) : 0
    view.push({ ...item, status: open && stall >= stallDays ? '受阻' : item.status, stallDays: stall })
  }
  return view.sort((a, b) => (a.first || '').localeCompare(b.first || '') || a.id.localeCompare(b.id))
}

/** 工作区展示名：能取到末级目录就「末级（全路径）」，取不到就原样。 */
function periodWorkspaceLabel(workspace) {
  const path = String(workspace || '').split(/[,，]/)[0].trim()
  if (!path) return '（未标工作区）'
  const leaf = path.split(/[\\/]/).filter(Boolean).pop()
  return leaf && leaf !== path ? `${leaf}（${path}）` : path
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
function composePeriodDraft(range, days, daily, board, today, ledger = [], stallDays = 3, usage = null) {
  const spec = PERIOD_KINDS[range.kind] ?? PERIOD_KINDS.custom
  const labels = periodSectionLabels(range.kind)
  const covered = days.filter(day => daily.has(day))
  const missing = days.filter(day => !daily.has(day))
  const mainlines = collectPeriodMainlines(covered, daily, ledger, range.to, stallDays)
  const heading = range.kind === 'month' && range.wholeMonth
    ? range.from.slice(0, 7)
    : `${range.from} ~ ${range.to}`

  const out = [`# ${spec.title} · ${heading}`, '', `> 区间：${range.from} ~ ${range.to}（${range.span} 天）`, '']

  out.push(`## 一、${labels[0]}`, '')
  out.push(`本区间 ${range.from} ~ ${range.to}，共 ${range.span} 天；有日报 ${covered.length} 天${missing.length ? `、缺 ${missing.length} 天（${missing.map(day => day.slice(5)).join('、')}）` : ''}。`)
  out.push('')
  if (usage) {
    out.push(`**投入：** ${usageParts(usage, { dayLabel: '会话·日' })}`)
    out.push(`**Token：** ${usageTokenParts(usage)}`)
    const rows = Array.isArray(usage.byWorkspace) ? usage.byWorkspace : []
    if (rows.length > 0) {
      out.push('')
      out.push('| 工作区 | 会话·日 | 活跃 | 模型 | 工具 | 等你确认 | Token | 缓存读 | 命中 |')
      out.push('|---|---|---|---|---|---|---|---|---|')
      for (const row of rows) {
        const denom = (Number(row.input) || 0) + (Number(row.cache) || 0)
        const hit = denom > 0 ? (Number(row.cache) / denom * 100).toFixed(1) : '0.0'
        out.push(`| ${row.name} | ${row.sessions ?? 0} | ${formatDuration(row.activeMs)} | ${formatDuration(row.modelMs)}`
          + ` | ${formatDuration(row.toolMs)} | ${formatDuration(row.waitMs)} | ${formatTokens(row.total)}`
          + ` | ${formatTokens(row.cache)} | ${hit}% |`)
      }
    }
    if (Number(usage.days) > 0 && Number(usage.daysWithUsage) > 0 && usage.daysWithUsage < usage.days) {
      out.push('')
      out.push(`_投入覆盖 ${usage.daysWithUsage}/${usage.days} 天；缺的部分重新采集对应日期即可补上。_`)
    }
    out.push('')
  }
  if (covered.length === 0) {
    out.push('_区间内没有日报，无法从记录里归纳主线。_')
  } else if (mainlines.length === 0) {
    out.push('_区间内日报没有主线小节，账本里也没有未清条目。_')
  } else {
    out.push('按工作区分组；「本期未推进」是账本里有、区间日报没有小节的未清主线。')
    out.push('')
    const groups = new Map()
    for (const item of mainlines) {
      const key = periodWorkspaceLabel(item.workspace)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }
    for (const [workspace, items] of groups) {
      out.push(`### ${workspace}`)
      out.push('')
      for (const item of items) {
        const from = item.first ? item.first.slice(5) : ''
        const to = item.last ? item.last.slice(5) : ''
        const span = from && from === to ? from : `${from || '—'} → ${to || '—'}`
        const parts = [item.status]
        if (item.criteriaTotal > 0) parts.push(`判据 ${item.criteriaDone}/${item.criteriaTotal}`)
        if (item.stallDays > 0) parts.push(`挂起 ${item.stallDays} 天`)
        if (!item.touched) parts.push('本期未推进')
        out.push(`- ${item.id} ${item.title}：${span}（${parts.join('，')}）`)
      }
      out.push('')
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
 * 校验并归一化看板更新参数：优先级、截止日、状态三者至少给一个。
 * @param {{ priority?: unknown, due?: unknown, status?: unknown }} input - 原始参数。
 * @returns {{ priority?: string, due?: string, status?: string }} 可传给脚本的参数。
 */
function boardPatch(input) {
  const patch = {}
  if (input.priority !== undefined) {
    const value = String(input.priority).trim().toUpperCase()
    if (!['P1', 'P2', 'P3', 'NONE'].includes(value)) throw new Error('priority 只能是 P1 / P2 / P3 / none')
    patch.priority = value === 'NONE' ? 'none' : value
  }
  if (input.due !== undefined) {
    const value = String(input.due).trim()
    if (value.toLowerCase() !== 'none') parseDay(value)
    patch.due = value.toLowerCase() === 'none' ? 'none' : value
  }
  if (input.status !== undefined) {
    const value = String(input.status).trim().toLowerCase()
    if (!['todo', 'doing', 'done', 'drop'].includes(value)) {
      throw new Error('status 只能是 todo / doing / done / drop')
    }
    patch.status = value
  }
  if (Object.keys(patch).length === 0) throw new Error('update 至少要给 priority / due / status 之一')
  return patch
}

/**
 * 调 push-to-board.ps1 改一条看板条目的优先级、截止日或状态。
 * @param {typeof DEFAULTS} config - 生效配置。
 * @param {string} keyword - 标题关键词或 #h 指纹。
 * @param {{ priority?: string, due?: string, status?: string }} patch - 更新参数。
 * @param {AbortSignal | undefined} signal - 取消信号。
 * @returns {Promise<{ stdout: string, board: { open: string[], text: string } }>} 脚本输出与更新后的看板。
 */
async function updateBoard(config, keyword, patch, signal) {
  const args = ['-Update', keyword, '-BoardPath', boardPathOf(config)]
  if (patch.priority !== undefined) args.push('-Priority', patch.priority)
  if (patch.due !== undefined) args.push('-Due', patch.due)
  if (patch.status !== undefined) args.push('-Status', patch.status)
  const result = await runScript(config, 'push-to-board.ps1', args, signal)
  if (result.code !== 0) {
    throw new Error(`更新看板失败（退出码 ${result.code}）：\n${tail(result.stderr || result.stdout)}`)
  }
  return { stdout: result.stdout.trim(), board: await readBoard(config.reportDir) }
}

/**
 * 读取 POST body；空 body 当 {}，非法 JSON 由调用方转成 400。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<Record<string, unknown>>} 解析后的 body。
 */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('请求体不是合法 JSON')
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
  '-Update', '-Priority', '-Due', '-Status',
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
/**
 * 从源数据「0. 工作区（近两天活跃）」表格里解析出工作区清单。
 * 解析失败返回空数组：页面和工具都不该因为一张表崩掉。
 * @param {string} text - 源数据正文。
 * @returns {Array<{ name: string, path: string, sessions: number, tools: number, files: number }>}
 */
function parseWorkspaceTable(text) {
  const lines = String(text).split(/\r?\n/)
  const start = lines.findIndex(line => /^##\s*0\.\s*工作区/.test(line.trim()))
  if (start < 0) return []
  const out = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (/^##\s/.test(line)) break
    const match = /^\|\s*(.+?)\s*\|\s*`(.+)`\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)/.exec(line)
    if (!match) continue
    out.push({
      name: match[1].trim(),
      path: match[2].trim(),
      sessions: Number(match[3]),
      tools: Number(match[4]),
      files: Number(match[5]),
    })
  }
  return out
}

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
  // 工作区清单以最近一份源数据为准：它由采集脚本从 DSH 会话里算出来，页面只读展示。
  let workspaces = []
  let workspaceSource = null
  try {
    const sourceNames = (await readdir(join(config.reportDir, '_源数据')))
      .filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort().reverse()
    if (sourceNames.length > 0) {
      workspaces = parseWorkspaceTable(await readFile(join(config.reportDir, '_源数据', sourceNames[0]), 'utf8'))
      workspaceSource = sourceNames[0].slice(0, 10)
    }
  } catch {
    workspaces = []
  }
  // 主线视图：账本由 daily_report_save 维护，这里只读，页面用来一眼看未清与受阻。
  let mainlines = []
  try {
    const ledgerText = await readTextIfExists(join(config.reportDir, LEDGER_FILE))
    mainlines = mainlineView(parseLedger(ledgerText), dateInZone(config.scheduleTimeZone), stallDaysOf(config))
  } catch {
    mainlines = []
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
    workspaces,
    workspaceSource,
    mainlines,
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
  if (config.workspace) void mkdir(config.workspace, { recursive: true }).catch(() => {})

  ctx.tools.register({
    name: 'daily_report_collect',
    description:
      '采集某一天的工作痕迹，生成日报的源数据文件并返回它的路径、小节清单和日报模板。'
      + '写日报前先调用它：结果里的 sourcePath 要读一遍，template 是必须填满的六节骨架。'
      + '采集写 _源数据；超过 60 个时自动把旧文件按季度归档到 _归档。',
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
          workspaces: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'path', 'sessions', 'tools', 'files'],
              properties: {
                name: { type: 'string' },
                path: { type: 'string' },
                sessions: { type: 'integer' },
                tools: { type: 'integer' },
                files: { type: 'integer' },
              },
            },
          },
          boardOpen: { type: 'integer' },
          usage: {
            type: 'object',
            description: '当日 token / 时间投入；源数据没有该节时省略（不返回该字段）。',
            properties: {
              sessions: { type: 'integer' },
              activeMs: { type: 'integer' },
              modelMs: { type: 'integer' },
              toolMs: { type: 'integer' },
              waitMs: { type: 'integer' },
              input: { type: 'integer' },
              cache: { type: 'integer' },
              output: { type: 'integer' },
              total: { type: 'integer' },
            },
          },
          usageLine: { type: 'string', description: '一行式投入汇总，可直接写进日报「一、今日概览」。' },
          template: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已采集 ${value.date} → ${value.sourcePath}（${value.lines} 行，看板未完成 ${value.boardOpen} 条）。`
          + (value.workspaces?.length
            ? `\n\n工作区（近两天活跃）：\n${value.workspaces.map(w => `- ${w.name} \`${w.path}\`（会话 ${w.sessions}，当日改动 ${w.files}）`).join('\n')}`
            : '\n\n未发现活跃工作区。')
          + (value.usageLine
            ? `\n\n投入（写进「一、今日概览」表下，数字照抄）：\n${value.usageLine}`
            : '')
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
          ...(config.workspace ? ['-Workspace', config.workspace] : []),
          '-ReportDir', config.reportDir,
          '-StallDays', String(stallDaysOf(config)),
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
      // 归档结果只出现在源数据里；这里顺手抄一行到运行日志，失败也不影响采集。
      for (const note of lines.filter(line => /^>\s*归档/.test(line))) {
        await logLine(config, note.includes('失败') ? 'warn' : 'info', note.replace(/^>\s*/, ''))
      }
      const headings = lines.filter(line => /^##\s/.test(line)).map(line => line.trim())
      const board = await readBoard(config.reportDir)
      const usage = parseUsageComment(text)
      return {
        date,
        sourcePath: join(config.reportDir, '_源数据', `${date}.md`),
        lines: lines.length,
        bytes: Buffer.byteLength(text, 'utf8'),
        headings,
        workspaces: parseWorkspaceTable(text),
        boardOpen: board.open.length,
        // 没有投入节时两个字段都不出现，避免把 null 塞给声明为 object 的输出 schema。
        ...(usage ? { usage, usageLine: usageSummaryLine(usage) } : {}),
        template: buildTemplate(date),
      }
    },
  })

  ctx.tools.register({
    name: 'daily_report_save',
    description:
      '校验并落盘当天日报，然后把它「六、明日开场清单」推进看板。'
      + '正文必须包含六个固定小节（一、今日概览 … 六、明日开场清单）；缺节或留占位符会直接报错且不写文件，'
      + '按报错修好后重调即可。已存在同名日报会被整篇覆盖。'
      + '主线写成 `#### M-YYYY-MM-DD-NN 标题` 小节（内部含 工作区 / 状态 / 判据），工具会据此维护 `_主线.md` 账本；'
      + '引用账本外的旧 ID、新 ID 缺小节或非法状态都会报错且不写文件。'
      + '落盘后会做证据密度、空话词、建议可执行性的软校验，提醒放在 warnings 与 text 里，不阻断写入。',
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
          warnings: {
            type: 'array',
            items: { type: 'string' },
            description: '软校验提醒（证据密度 / 空话词 / 建议可执行性）；为空表示没发现问题。',
          },
          mainlines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'title', 'workspace', 'status', 'lastOutput', 'stallDays'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                workspace: { type: 'string' },
                status: { type: 'string' },
                lastOutput: { type: 'string' },
                stallDays: { type: 'integer' },
              },
            },
          },
          stalled: { type: 'array', items: { type: 'string' } },
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
      // 主线：先校验引用（未知旧 ID、日期不属于今天且不在账本、新 ID 缺小节、非法状态），
      // 任一问题都按硬错误处理——日报与账本都不写，避免账本出现半截条目。
      const ledgerPath = join(config.reportDir, LEDGER_FILE)
      const ledger = parseLedger(await readTextIfExists(ledgerPath))
      const blocks = parseReportMainlines(content)
      problems.push(...validateReportMainlines(content, blocks, date, ledger))
      if (problems.length > 0) {
        throw new Error(`日报未写入，先修正：\n- ${problems.join('\n- ')}`)
      }
      // 质量检查放在硬校验之后、写盘之前：只收集提醒，不改变落盘结果。
      const merged = blocks.length > 0 ? mergeLedger(ledger, blocks, date) : ledger
      const stallDays = stallDaysOf(config)
      const views = mainlineView(merged, date, stallDays)
      const todayIds = new Set(blocks.map(block => block.id))
      const mainlines = views.filter(view => todayIds.has(view.id) || view.status === '受阻')
      const stalled = views.filter(view => view.status === '受阻').map(view => view.id)
      const warnings = qualityWarnings(content, minEvidenceOf(config))
      // 源数据里有投入节时，提醒正文把数字带上；只提醒，不阻断落盘。
      const sourceUsage = parseUsageComment(
        await readTextIfExists(join(config.reportDir, '_源数据', `${date}.md`)),
      )
      if (sourceUsage && !/token/i.test(content)) {
        warnings.push('源数据有 token/时间投入，正文没写「投入」行；把源数据 3.5 节的原句补在「一、今日概览」表下')
      }
      const riskText = sectionLines(content, '四').join('\n')
      for (const view of views) {
        if (view.status !== '受阻' || riskText.includes(view.id)) continue
        warnings.push(`主线 ${view.id} 已挂起 ${view.stallDays} 天，第四节没有提到`)
      }

      const stamp = stampInZone(config.scheduleTimeZone)
      const withFooter = /数据来源：/.test(content)
        ? content
        : `${content.replace(/\s*$/, '')}\n\n---\n数据来源：\`_源数据\\${date}.md\` ｜ 生成时间：${stamp}\n`
      const reportPath = join(config.reportDir, `日报-${date}.md`)
      await mkdir(config.reportDir, { recursive: true })
      // 账本先写：即使后面推看板失败，主线状态也已经记下来了。
      if (blocks.length > 0) await writeFile(ledgerPath, ledgerMarkdown(merged), 'utf8')
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
      const warningText = warnings.length > 0
        ? `质量提醒（不影响落盘）：\n- ${warnings.join('\n- ')}`
        : ''
      const mainlineText = mainlines.length > 0
        ? `主线：${mainlines.map(view => `${view.id} ${view.title}（${view.status}${view.status === '受阻' ? `，挂起 ${view.stallDays} 天` : ''}）`).join('；')}`
        : ''
      return {
        date,
        reportPath,
        pushed,
        skipped,
        boardOpen: board.open.length,
        warnings,
        mainlines,
        stalled,
        text: [summary, mainlineText, pushText, warningText].filter(Boolean).join('\n'),
      }
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
          usage: { type: 'object', description: '区间 token / 时间投入；旧区间源数据没有该节时省略（不返回该字段）。' },
          usageLine: { type: 'string', description: '一行式区间投入汇总，可写进周期报告第一节。' },
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
      const ledger = parseLedger(await readTextIfExists(join(config.reportDir, LEDGER_FILE)))
      const stallDays = stallDaysOf(config)
      const provided = typeof args.content === 'string' && args.content.trim() !== ''
      // 区间投入从源数据第 13 节的机器可读行读；旧区间没有就为 null。
      const rangeUsage = parseUsageComment(await readTextIfExists(periodPath))
      let content = provided
        ? String(args.content)
        : composePeriodDraft(range, days, daily, board, dateInZone(config.scheduleTimeZone), ledger, stallDays, rangeUsage)

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
      const usageNote = rangeUsage && !/token/i.test(content)
        ? '\n注意：区间源数据有 token/时间投入，正文没写数字；把第 13 节的原句补到第一节。'
        : ''
      return {
        periodPath,
        reportPath,
        pushed,
        skipped,
        boardOpen: after.open.length,
        ...(rangeUsage
          ? { usage: rangeUsage, usageLine: usageSummaryLine(rangeUsage, '会话·日') }
          : {}),
        text: `${summary}${provided ? '' : '\n正文由区间日报自动聚合，可直接使用，也可改写后用 content 重交。'}${usageNote}\n${pushText}`.trim(),
      }
    },
  })

  ctx.tools.register({
    name: 'daily_report_board',
    description:
      '查看或维护工作看板（_日报\\看板.md）。show 列出未完成待办；done 把匹配的待办移到「已完成」；'
      + 'drop 把决定不做的移到「已放弃」（不是完成）；update 改一条的优先级、截止日或状态。'
      + 'done/drop/update 需要 keyword（标题子串，或条目里的 #h 指纹）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['show', 'done', 'drop', 'update'], description: 'show | done | drop | update。' },
        keyword: { type: 'string', description: 'done/drop/update 必填，待办标题里的关键词或 #h 指纹。' },
        priority: { type: 'string', enum: ['P1', 'P2', 'P3', 'none'], description: 'update 可选：优先级，none 表示清空。' },
        due: { type: 'string', description: 'update 可选：截止日 YYYY-MM-DD，none 表示清空。' },
        status: { type: 'string', enum: ['todo', 'doing', 'done', 'drop'], description: 'update 可选：目标状态，省略则只改元数据。' },
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
          updated: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const action = args.action
      if (!['show', 'done', 'drop', 'update'].includes(action)) {
        throw new Error(`未知动作：${action}`)
      }
      if (action === 'update') {
        const keyword = String(args.keyword ?? '').trim()
        if (keyword === '') throw new Error('update 需要 keyword')
        const patch = boardPatch(args)
        const { stdout, board } = await updateBoard(config, keyword, patch, exec.signal)
        return {
          action,
          openCount: board.open.length,
          open: board.open,
          updated: stdout,
          text: `${stdout}\n未完成 ${board.open.length} 条。`.trim(),
        }
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
    const stateDispose = webCtx.webServer.register({
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

    // 看板页是唯一允许写文件的页面入口：只改条目元数据/状态，不碰日报正文。
    const boardDispose = webCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-work-summary/board',
      handler: async (req, res) => {
        const send = (status, value) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(value))
        }
        try {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' })
            res.end()
            return
          }
          const body = await readJsonBody(req)
          const keyword = String(body.keyword ?? '').trim()
          if (keyword === '') throw new Error('keyword 不能为空：写标题关键词或条目里的 #h 指纹')
          const patch = boardPatch(body)
          const { stdout, board } = await updateBoard(config, keyword, patch)
          send(200, { updated: stdout, openCount: board.open.length })
        } catch (error) {
          send(400, { error: String(error?.message ?? error) })
        }
      },
    })

    return () => {
      if (typeof stateDispose === 'function') stateDispose()
      if (typeof boardDispose === 'function') boardDispose()
    }
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
            if (value !== '' && !/^[A-Za-z]:[\\/]|^\\\\|^\//.test(value)) {
              throw new Error('额外工作区要写绝对路径，比如 D:\\projects；不想固定就留空')
            }
            if (value !== '') await mkdir(value, { recursive: true })
            await writeSettings({ workspace: value })
            config.workspace = value
            await logLine(config, 'info', value
              ? `额外工作区改为 ${value}（除自动发现外，固定也扫这里）`
              : '额外工作区已清空（只按 DSH 会话自动发现工作区）')
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
