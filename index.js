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
import { readFileSync } from 'node:fs'
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
 * @param {{ reportDir?: string, logDir?: string, workspace?: string }} patch - 要保存的键。
 * @returns {Promise<Record<string, unknown>>} 保存后的全部设置。
 */
async function writeSettings(patch) {
  const current = readSettings()
  const next = {}
  for (const key of ['reportDir', 'logDir', 'workspace']) {
    const value = typeof patch[key] === 'string' ? patch[key] : current[key]
    if (typeof value === 'string') next[key] = value
  }
  await mkdir(dirname(SETTINGS_FILE), { recursive: true })
  await writeFile(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/**
 * 设置页要的完整状态：定时任务 + 日志目录。
 * @param {Awaited<ReturnType<typeof scheduleState>>} state - 定时任务状态。
 * @param {typeof DEFAULTS} config - 生效配置。
 * @returns {Record<string, unknown>} 响应体。
 */
function settingsPayload(state, config) {
  return {
    ...state,
    reportDir: config.reportDir,
    reportDirDefault: DATA_HOME,
    workspace: config.workspace,
    workspaceDefault: DATA_HOME,
    logDir: logDirOf(config),
    logDirDefault: join(config.reportDir, '_日志'),
    logPattern: 'dsh-work-summary-YYYY-MM-DD.log',
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
  '-Date', '-NoSessions', '-Report', '-BoardPath', '-Show', '-Done', '-Drop', '-DryRun',
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
  for (const name of names.sort().reverse().slice(0, 90)) {
    try {
      const content = await readFile(join(config.reportDir, name), 'utf8')
      reports.push({
        date: name.slice(3, 13),
        file: name,
        size: Buffer.byteLength(content, 'utf8'),
        content,
      })
    } catch {
      // 单篇读不了就跳过，不让整个页面失败
    }
  }
  return {
    reportDir: config.reportDir,
    updatedAt: new Date().toISOString(),
    board: {
      text: board.text,
      open: board.open.length,
      done: lines.filter(line => /^- \[x\]/i.test(line)).length,
    },
    reports,
  }
}

/** 找出插件托管的那条日报任务：标题前缀或提示词特征都算。 */
function findOwnTask(items, config) {
  return items.find((task) => {
    const title = String(task.title ?? '')
    const prompt = String(task.prompt ?? '')
    return title === config.scheduleTitle
      || title.startsWith(config.scheduleTitle)
      || /daily_report_collect|dsh-work-summary/.test(prompt)
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

/** 设置页要的定时任务状态。 */
async function scheduleState(scheduleCtx, config) {
  const page = await scheduleCtx.schedule.list({ limit: 200 })
  const task = findOwnTask(page.items ?? [], config)
  if (!task) {
    return { found: false, scheduleTitle: config.scheduleTitle, timeZone: config.scheduleTimeZone, time: config.scheduleTime }
  }
  const parsed = parseRruleTime(task)
  const hour = parsed.hour ?? Number(config.scheduleTime.split(':')[0])
  const minute = parsed.minute ?? Number(config.scheduleTime.split(':')[1] ?? 0)
  return {
    found: true,
    id: task.id,
    title: task.title,
    active: task.status === 'active',
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    timeZone: parsed.timeZone ?? config.scheduleTimeZone,
    nextRunAt: task.scheduledAtLocal ?? task.scheduledAt ?? null,
    target: task.target?.kind ?? null,
  }
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
            send(res, 200, settingsPayload(await scheduleState(sc, config), config))
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
          if (typeof body.time === 'string' || typeof body.active === 'boolean') {
            const current = await scheduleState(sc, config)
            if (!current.found) throw new Error('没找到日报计划任务；先重启一次让插件把它建出来')
            if (typeof body.time === 'string') {
              if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) throw new Error(`时间格式应为 HH:MM，收到：${body.time}`)
              patch.timing = { kind: 'rrule', rrule: dailyRrule(current.timeZone, body.time) }
            }
            if (typeof body.active === 'boolean') patch.active = body.active
          }
          if (body.reportDir !== undefined) {
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
          if (Object.keys(patch).length === 0 && body.logDir === undefined && body.reportDir === undefined && body.workspace === undefined) {
            throw new Error('没有要改的字段（time / active / reportDir / workspace / logDir）')
          }
          if (Object.keys(patch).length > 0) {
            await sc.schedule.edit({ id: (await scheduleState(sc, config)).id, action: 'update', patch })
          }
          send(res, 200, settingsPayload(await scheduleState(sc, config), config))
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
 * 插件自管的每日计划任务：已有同标题任务就同步提示词；
 * 否则认领引用 collect-day.ps1 的旧任务（改写提示词），都没有才新建。
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
        return
      }
      if (config.scheduleAdopt) {
        const legacy = items.find(task => task.status === 'active' && /collect-day\.ps1|daily_report_collect/.test(String(task.prompt ?? '')))
        if (legacy) {
          await scheduleCtx.schedule.edit({ id: legacy.id, action: 'update', patch: { prompt } })
          ctx.logger?.info?.(`dsh-work-summary: 已把旧日报计划任务「${legacy.title}」切到插件工具`)
          void logLine(config, 'info', `已认领旧任务「${legacy.title}」，提示词切到插件工具`)
          return
        }
      }
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
    })().catch((error) => {
      ctx.logger?.warn?.(`dsh-work-summary: 计划任务处理失败：${error instanceof Error ? error.message : String(error)}`)
    })
  })
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
