// R29：工作区自动发现 —— 从近两天有活动的 DSH 会话 cwd 里找根，多根采集、别名、忽略、父子去重。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const root = join(process.cwd(), 'test', '.tmp-workspace')
rmSync(root, { recursive: true, force: true })

const script = join(process.cwd(), 'scripts', 'collect-day.ps1')
const home = join(root, 'home')
const data = join(home, 'dsh-work-summary')
const work = join(root, 'work')
for (const dir of [home, data, work]) mkdirSync(dir, { recursive: true })

function localToday() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
const today = localToday()

function findZstd() {
  const known = 'C:\\Program Files\\poppler\\Library\\bin\\zstd.exe'
  if (existsSync(known)) return known
  const where = spawnSync('where', ['zstd'], { encoding: 'utf8' })
  return where.status === 0 ? where.stdout.split(/\r?\n/)[0].trim() : null
}
const zstd = findZstd()

/** 造一个今天有活动的会话：cwd + 标题 + 两次工具调用。 */
function seedSession(cwd, tag) {
  if (!zstd) return null
  const dir = join(home, 'sessions', `--${tag}--`, `session-${tag}`)
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const lines = [
    { type: 'session', cwd, time: now },
    { type: 'session/title', data: { title: `测试 ${tag}` }, time: now },
    { type: 'tool/call', data: { name: 'edit' }, time: now },
    { type: 'tool/call', data: { name: 'read' }, time: now },
  ]
  const jsonl = join(dir, 'raw.jsonl')
  writeFileSync(jsonl, lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf8')
  const out = join(dir, 'session.v4.jsonl.zstd')
  const packed = spawnSync(zstd, ['-q', '-f', jsonl, '-o', out], { stdio: 'inherit' })
  assert.equal(packed.status, 0, `zstd 压缩失败：退出码 ${packed.status}`)
  rmSync(jsonl)
  return out
}

function runCollect(args) {
  const result = spawnSync('pwsh', ['-NoProfile', '-File', script, ...args], { stdio: 'inherit' })
  assert.equal(result.status, 0, `采集失败：退出码 ${result.status}`)
  return ''
}

function sourceText(date = today) {
  return readFileSync(join(data, '_源数据', `${date}.md`), 'utf8')
}

/** 从「0. 工作区」表里取一行。 */
function workspaceRow(text, name) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells[0] === name) return cells
  }
  return null
}

if (!zstd) {
  console.log('跳过：找不到 zstd，无法造会话文件')
  process.exit(0)
}

const wsA = join(work, 'alpha')
const wsB = join(work, 'novel')
const wsParent = join(work, 'parent')
const wsChild = join(wsParent, 'child')
for (const dir of [wsA, wsB, wsParent, wsChild]) mkdirSync(dir, { recursive: true })
writeFileSync(join(wsA, 'a.txt'), 'a')
writeFileSync(join(wsB, 'b.txt'), 'b')
writeFileSync(join(wsChild, 'c.txt'), 'c')

seedSession(wsA, 'alpha')
seedSession(wsB, 'novel')
seedSession(wsParent, 'parent')
seedSession(wsChild, 'child')
// 数据目录自己的会话不该出现在工作区表里。
seedSession(data, 'data')

// 别名写在采集前，验证「路径 → 显示名」。
writeFileSync(join(data, '_工作区.md'), [
  '# 工作区',
  '',
  '## 别名',
  `- ${wsB} = 小说`,
  '',
  '## 忽略',
  '',
].join('\n'), 'utf8')

runCollect(['-Date', today, '-DshHome', home, '-ReportDir', data])
const first = sourceText()

assert.ok(existsSync(join(data, '_工作区.md')), '_工作区.md 应自动存在')
assert.match(first, /## 0\. 工作区/, '源数据应有第 0 节')
assert.ok(workspaceRow(first, 'alpha'), 'wsA 应被自动发现')
assert.ok(workspaceRow(first, '小说'), '别名应生效')
assert.equal(workspaceRow(first, 'dsh-work-summary'), null, '数据目录不应被当成工作区')

const childRow = workspaceRow(first, 'child')
assert.ok(childRow, '子工作区应单列')
assert.equal(Number(childRow[4]), 1, '子工作区应统计到自己的 1 个改动文件')
const parentRow = workspaceRow(first, 'parent')
assert.ok(parentRow, '父工作区应单列')
assert.equal(Number(parentRow[4]), 0, '父工作区应跳过子工作区，不重复计数')
assert.match(first, /### 小说（`/, '第 1 节应按工作区分块')

// 注释块里只是示例，不能变成真实别名 / 忽略。
writeFileSync(join(data, '_工作区.md'), [
  '# 工作区',
  '',
  '## 别名',
  '<!-- 一行一个：- 绝对路径 = 显示名。例：',
  `- ${wsA} = 注释里的名字`,
  '-->',
  '',
  '## 忽略',
  '',
  '<!--',
  `- ${wsB}`,
  '-->',
].join('\n'), 'utf8')
runCollect(['-Date', today, '-DshHome', home, '-ReportDir', data])
const commented = sourceText()
assert.ok(workspaceRow(commented, 'alpha'), '注释里的别名不应生效，应仍显示 alpha')
assert.equal(workspaceRow(commented, '注释里的名字'), null, '注释里的别名被当成真配置了')
assert.ok(workspaceRow(commented, 'novel'), '注释里的忽略不应生效，novel 仍应出现')

// 无会话时：显式根仍然采样；一个根都没给时退回数据根并说明原因。
const data2 = join(root, 'data2')
mkdirSync(data2, { recursive: true })
runCollect(['-Date', today, '-DshHome', home, '-ReportDir', data2, '-Workspace', wsA, '-NoSessions'])
const explicitOnly = readFileSync(join(data2, '_源数据', `${today}.md`), 'utf8')
assert.ok(workspaceRow(explicitOnly, 'alpha'), '显式根应出现在工作区表里')
assert.doesNotMatch(explicitOnly, /未从会话发现工作区/, '给了显式根就不该说退回')

runCollect(['-Date', today, '-DshHome', home, '-ReportDir', data, '-NoSessions'])
const fallback = sourceText(today)
assert.match(fallback, /未从会话发现工作区，退回指定根/, '无会话且无显式根时应说明退回')
assert.ok(workspaceRow(fallback, 'dsh-work-summary'), '回退时应把数据根列出来')

// Host 侧：采集结果要带上工作区列表，页面才能只读展示。
process.env.DSH_WORK_SUMMARY_HOME = join(root, 'host-home')
const { apply } = await import('../index.js')
const tools = []
apply({
  tools: { register: definition => { tools.push(definition); return () => {} } },
  inject: () => () => {},
  logger: { info: () => {}, warn: () => {} },
}, {
  reportDir: join(root, 'host-data'),
  workspace: wsA,
  logDir: join(root, 'logs'),
  scheduleEnabled: false,
})
const collect = tools.find(item => item.name === 'daily_report_collect')
const result = await collect.execute({ date: today, sessions: false }, {})
assert.ok(Array.isArray(result.workspaces), 'collect 应返回 workspaces')
assert.equal(result.workspaces[0].path, wsA, 'workspaces 应解析出显式根')
assert.ok(result.workspaces[0].files >= 1, 'workspaces 应带当日改动文件数')

console.log('workspace.test.mjs 通过：自动发现、别名、忽略、父子去重、无会话回退。')
