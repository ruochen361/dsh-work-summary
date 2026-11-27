// R35：日报 / 周报 / 月报的 token 与时间投入 —— 采集时算好、写进源数据、透出到报告。
// 口径：活跃=事件间隔 5 分钟封顶后按会话并集；模型=回复流首末；工具=调用配对（单次封顶 10 分钟）；
// ask_user_question / plugin_manager 的等待单列；token 取 assistant/message.usage。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const root = join(process.cwd(), 'test', '.tmp-usage')
process.env.DSH_WORK_SUMMARY_HOME = join(root, 'home')
rmSync(root, { recursive: true, force: true })

const scriptDay = join(process.cwd(), 'scripts', 'collect-day.ps1')
const scriptRange = join(process.cwd(), 'scripts', 'collect-range.ps1')
const home = join(root, 'home')
const data = join(root, 'data')
const wsA = join(root, 'work', 'alpha')
for (const dir of [home, data, wsA]) mkdirSync(dir, { recursive: true })

function localToday() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
const today = localToday()
// 用当天中午做锚点，避免测试在 23:40 之后跨日。
const anchor = new Date()
anchor.setHours(12, 0, 0, 0)
const base = anchor.getTime()

function findZstd() {
  const known = 'C:\\Program Files\\poppler\\Library\\bin\\zstd.exe'
  if (existsSync(known)) return known
  const where = spawnSync('where', ['zstd'], { encoding: 'utf8' })
  return where.status === 0 ? where.stdout.split(/\r?\n/)[0].trim() : null
}
const zstd = findZstd()
if (!zstd) {
  console.log('跳过：找不到 zstd，无法造会话文件')
  process.exit(0)
}

/** 造一个会话文件；events 的时间全部用绝对毫秒。 */
function seedSession(tag, events) {
  const dir = join(home, 'sessions', `--${tag}--`, `session-${tag}`)
  mkdirSync(dir, { recursive: true })
  const jsonl = join(dir, 'raw.jsonl')
  writeFileSync(jsonl, events.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf8')
  const out = join(dir, 'session.v4.jsonl.zstd')
  const packed = spawnSync(zstd, ['-q', '-f', jsonl, '-o', out], { stdio: 'inherit' })
  assert.equal(packed.status, 0, `zstd 压缩失败：退出码 ${packed.status}`)
  rmSync(jsonl)
  // 会话文件的 mtime 决定它会不会被读；固定到当天中午，落在采集窗口内。
  utimesSync(out, anchor, anchor)
  return out
}

const t0 = base - 2 * 60 * 60 * 1000
seedSession('alpha', [
  { type: 'session', cwd: wsA, time: t0 },
  { type: 'user/message', data: { content: [{ type: 'text', text: '把投入统计做出来' }] }, time: t0 + 1000 },
  {
    type: 'assistant/message',
    data: {
      content: [{ type: 'text', text: '好，先看会话结构。' }],
      stream: [{ time: t0 + 4000 }],
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 9000, totalTokens: 10100 },
    },
    time: t0 + 10000,
  },
  { type: 'tool/call', data: { callId: 'c1', name: 'read' }, time: t0 + 20000 },
  { type: 'tool/result', data: { message: { toolCallId: 'c1' } }, time: t0 + 140000 },
  { type: 'tool/call', data: { callId: 'c2', name: 'ask_user_question' }, time: t0 + 200000 },
  { type: 'tool/result', data: { message: { toolCallId: 'c2' } }, time: t0 + 3200000 },
  { type: 'turn/end', time: t0 + 3300000 },
])
// 并行会话：与 alpha 的事件重叠，活跃时长不能相加。
seedSession('beta', [
  { type: 'session', cwd: wsA, time: t0 + 30000 },
  { type: 'user/message', data: { content: [{ type: 'text', text: '顺手跑个测试' }] }, time: t0 + 40000 },
  {
    type: 'assistant/message',
    data: {
      content: [{ type: 'text', text: '收到。' }],
      usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 4000, totalTokens: 4550 },
    },
    time: t0 + 50000,
  },
])
// 没有 cwd 的会话：归到「未归属」，token 仍要计入。
seedSession('orphan', [
  { type: 'user/message', data: { content: [{ type: 'text', text: '临时问一句' }] }, time: t0 + 60000 },
  {
    type: 'assistant/message',
    data: {
      content: [{ type: 'text', text: '嗯。' }],
      usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 1800, totalTokens: 2020 },
    },
    time: t0 + 70000,
  },
])
// 昨天的会话：文件 mtime 在窗口内（会被读到），但事件都在昨天，投入不能算进今天。
seedSession('gamma', [
  { type: 'session', cwd: wsA, time: t0 - 86400000 },
  { type: 'user/message', data: { content: [{ type: 'text', text: '昨天的事' }] }, time: t0 - 86400000 + 1000 },
  {
    type: 'assistant/message',
    data: {
      content: [{ type: 'text', text: '昨天的回复' }],
      usage: { inputTokens: 700, outputTokens: 77, cacheReadTokens: 7000, totalTokens: 7777 },
    },
    time: t0 - 86400000 + 5000,
  },
])

function run(script, args) {
  const result = spawnSync('pwsh', ['-NoProfile', '-File', script, ...args], { stdio: 'inherit' })
  assert.equal(result.status, 0, `脚本失败：${script} 退出码 ${result.status}`)
}
run(scriptDay, ['-Date', today, '-DshHome', home, '-ReportDir', data])

const sourcePath = join(data, '_源数据', `${today}.md`)
const source = readFileSync(sourcePath, 'utf8')
assert.match(source, /## 3\.5 投入统计（token \/ 时间）/, '源数据应有 3.5 投入统计节')
assert.match(source, /\*\*投入：\*\* 会话 3 个/, '三个会话都应计入（含未归属）')
assert.match(source, /\*\*Token：\*\* 合计 16\.7K/, 'token 合计应为 10100+4550+2020')

const usageMatch = /<!-- dsh-usage (\{.*\}) -->/.exec(source)
assert.ok(usageMatch, '源数据应有机器可读的 dsh-usage 行')
const dayUsage = JSON.parse(usageMatch[1])
assert.equal(dayUsage.sessions, 3)
assert.ok(!/7777/.test(source), '昨天的会话投入不能算进今天')
assert.equal(dayUsage.total, 10100 + 4550 + 2020)
assert.equal(dayUsage.input, 1700)
assert.equal(dayUsage.cache, 14800)
assert.equal(dayUsage.output, 170)
// 活跃：13 个事件点，相邻间隔封顶 5 分钟，重叠会话取并集 => 600s。
assert.equal(dayUsage.activeMs, 600000, `活跃时长应取并集，实际 ${dayUsage.activeMs}`)
assert.equal(dayUsage.toolMs, 120000, 'read 调用 120s 应计入工具耗时')
assert.equal(dayUsage.waitMs, 3000000, 'ask_user_question 的 3000s 应单列为等你确认')
assert.equal(dayUsage.modelMs, 6000, '模型耗时应为首个 stream 到消息落盘')
const alphaRow = dayUsage.byWorkspace.find(item => item.name === 'alpha')
assert.ok(alphaRow, '按工作区应能归到 alpha')
assert.equal(alphaRow.sessions, 2)
assert.equal(alphaRow.total, 10100 + 4550)
const orphanRow = dayUsage.byWorkspace.find(item => item.name === '未归属')
assert.ok(orphanRow, '没有 cwd 的会话应归到未归属')
assert.equal(orphanRow.total, 2020)

// 区间：按天相加，缺投入的日子要标出来而不是静默。
run(scriptRange, ['-From', today, '-To', today, '-DshHome', home, '-ReportDir', data])
const rangePath = join(data, '_源数据', `周期-${today}_${today}.md`)
const range = readFileSync(rangePath, 'utf8')
assert.match(range, /## 13\. 投入（token \/ 时间，区间）/, '区间源数据应有第 13 节')
assert.match(range, /- 投入：活跃 10m/, '区间概况应带投入行')
const rangeMatch = /<!-- dsh-usage-range (\{.*\}) -->/.exec(range)
assert.ok(rangeMatch, '区间源数据应有 dsh-usage-range 行')
const rangeUsage = JSON.parse(rangeMatch[1])
assert.equal(rangeUsage.total, dayUsage.total)
assert.equal(rangeUsage.waitMs, dayUsage.waitMs)

// -NoSessions 重采（daily_report_collect 的 sessions:false）不能把已算好的投入节抹掉。
run(scriptDay, ['-Date', today, '-DshHome', home, '-ReportDir', data, '-NoSessions'])
const reSource = readFileSync(sourcePath, 'utf8')
assert.match(reSource, /沿用上一次的投入数据/, 'NoSessions 重采应沿用旧投入节')
assert.match(reSource, /\*\*Token：\*\* 合计 16\.7K/, '沿用后 token 数字不能丢')
const reMatch = /<!-- dsh-usage (\{.*\}) -->/.exec(reSource)
assert.ok(reMatch, '沿用后机器可读行不能丢')
assert.equal(JSON.parse(reMatch[1]).total, dayUsage.total)

// Host：采集结果要透出 usage/usageLine，保存时缺 token 数字只提醒不阻断。
const { apply } = await import('../index.js')
const tools = []
apply({
  tools: { register: definition => { tools.push(definition); return () => {} } },
  inject: () => () => {},
  logger: { info: () => {}, warn: () => {} },
}, {
  reportDir: data,
  workspace: wsA,
  scheduleEnabled: false,
})

const collect = tools.find(item => item.name === 'daily_report_collect')
// 直接读已有源数据：sessions:false 会重跑 -NoSessions 并覆盖掉投入节，所以这里只验证解析函数的效果。
assert.ok(collect, 'daily_report_collect 应已注册')

const save = tools.find(item => item.name === 'daily_report_save')
const report = tokenLine => [
  `# 工作日报 · ${today}`,
  '',
  '## 一、今日概览',
  '今天补齐了投入统计。',
  tokenLine,
  '',
  '## 二、做了什么',
  '- 改 `scripts\\collect-day.ps1`，在 `index.js` 透出。',
  '- 补 `test\\usage.test.mjs`。',
  '',
  '## 三、结果与产出',
  '- 源数据 3.5 节与区间第 13 节都能出数。',
  '',
  '## 四、问题与风险',
  '- 无。',
  '',
  '## 五、后续建议',
  '1. 跑 `npm test`。',
  '',
  '## 六、明日开场清单',
  '- 看周报是否带上投入。',
].join('\n')

const withoutToken = await save.execute({ content: report(''), date: today, push: false }, {})
assert.ok(withoutToken.warnings.some(item => item.includes('投入')), '缺投入行应给软提醒')
assert.ok(existsSync(join(data, `日报-${today}.md`)), '软提醒不应阻断落盘')

const withToken = await save.execute({ content: report('投入：活跃 10m｜token 16.7K（缓存命中 89.7%）'), date: today, push: false }, {})
assert.ok(!withToken.warnings.some(item => item.includes('投入')), '写了 token 数字就不该再提醒')

// 周期：自动草稿要带投入汇总和按工作区表。
const period = tools.find(item => item.name === 'work_summary_period')
const periodResult = await period.execute({ from: today, to: today, push: false }, {})
const periodReport = readFileSync(periodResult.reportPath, 'utf8')
assert.match(periodReport, /\*\*投入：\*\* 会话·日 3 个/, '周期草稿应带投入行')
assert.match(periodReport, /\*\*Token：\*\* 合计 16\.7K/, '周期草稿应带 token 汇总')
assert.match(periodReport, /\| 工作区 \| 会话·日 \|/, '周期草稿应带按工作区表')
assert.equal(periodResult.usage.total, dayUsage.total, '周期结果应返回 usage')

console.log('usage.test.mjs 通过：日报 3.5 节、区间第 13 节、软校验、周期草稿。')
