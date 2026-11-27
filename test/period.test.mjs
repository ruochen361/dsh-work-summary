// 周期聚合的端到端测试：真跑 work_summary_period（含 collect-range.ps1 与 push-to-board.ps1），
// 验证四节校验、文件命名、看板去重与非法区间。数据放在 test/.tmp-period，不碰真实日报目录。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '.tmp-period')
rmSync(root, { recursive: true, force: true })
const dataDir = join(root, 'data')
const workDir = join(root, 'work')
const homeDir = join(root, 'home')
mkdirSync(dataDir, { recursive: true })
mkdirSync(workDir, { recursive: true })
mkdirSync(homeDir, { recursive: true })

process.env.DSH_WORK_SUMMARY_HOME = homeDir
const { apply } = await import('../index.js')

const tools = []
const ctx = {
  tools: { register: (definition) => { tools.push(definition); return () => {} } },
  inject: () => () => {},
  logger: { info: () => {}, warn: () => {} },
}
apply(ctx, { reportDir: dataDir, workspace: workDir, scheduleEnabled: false })

const daily = (day, index) => [
  `# 工作日报 · ${day}`,
  '',
  '## 一、今日概览',
  '| 主线 | 工作区 | 今日产出 | 状态 | 下一步 |',
  '|---|---|---|---|---|',
  `| 周期聚合 | 小说 | 第 ${index} 版草稿 | 进行中 | 继续改 |`,
  '',
  '## 二、做了什么',
  '### 小说（F:\\novel）',
  '#### M-2026-11-18-01 周期聚合主线',
  '- 工作区：F:\\novel',
  '- 状态：进行中',
  '- 判据：四节齐全；看板去重',
  '',
  '- 改了 `index.js` 的聚合逻辑，并补了测试。',
  '',
  '## 三、结果与产出',
  '| 产出物 | 路径 | 状态 | 说明 | 主线 |',
  '|---|---|---|---|---|',
  `| 周期聚合 v${index} | \`index.js\` | 完成 | 第 ${index} 天 | M-2026-11-18-01 |`,
  '',
  '## 四、问题与风险',
  `1. **投资网未提交文件**：已到第 ${index + 8} 天，仍未动。（M-2026-11-01-07）`,
  '',
  '## 五、后续建议',
  '| 建议 | 为什么现在做 | 预估 | 何时做 |',
  '|---|---|---|---|',
  '| 先提交文件 | 挂太久了 | 10 min | 明早 |',
  '',
  '## 六、明日开场清单',
  '1. 提交投资网 9 个未跟踪文件',
  '2. 修插件采集编码',
  '3. 清测试残留',
  '',
].join('\n')

for (let i = 0; i < 7; i += 1) {
  const day = `2026-11-${String(18 + i).padStart(2, '0')}`
  writeFileSync(join(dataDir, `日报-${day}.md`), daily(day, i + 1), 'utf8')
}

writeFileSync(join(dataDir, '_主线.md'), [
  '# 主线账本',
  '',
  '## M-2026-11-18-01 周期聚合主线',
  '- 工作区：F:\\novel',
  '- 状态：进行中',
  '- 首次产出：2026-11-18',
  '- 最近产出：2026-11-24',
  '- [x] 四节齐全',
  '- [ ] 看板去重',
  '',
  '## M-2026-11-01-07 投资网未提交文件',
  '- 工作区：F:\\projects\\invest',
  '- 状态：进行中',
  '- 首次产出：2026-11-05',
  '- 最近产出：2026-11-10',
  '- [ ] 9 个未跟踪文件提交',
  '',
  '## M-2026-11-26-09 区间之后才出现的主线',
  '- 工作区：F:\\novel',
  '- 状态：进行中',
  '- 首次产出：2026-11-26',
  '- 最近产出：2026-11-26',
  '- [ ] 不该出现在 11-18~11-24 的周报里',
  '',
  '## M-2026-11-02-03 没有日期的旧主线',
  '- 工作区：F:\\dsh_work',
  '- 状态：进行中',
  '- 首次产出：—',
  '- 最近产出：—',
  '- [ ] 账本手工改坏日期时也要能出报告',
  '',
].join('\n'), 'utf8')

writeFileSync(join(dataDir, '看板.md'), [
  '# 工作看板',
  '',
  '## 待办',
  '',
  '- [ ] 2026-11-18 ｜ 提交投资网 9 个未跟踪文件 ｜ 来源：日报-2026-11-18.md ｜ #h11111111',
  '  - 详情：提交投资网 9 个未跟踪文件',
  '- [ ] 2026-11-20 ｜ 中转方案落盘 ｜ 来源：日报-2026-11-20.md ｜ #h22222222',
  '  - 详情：中转方案落盘',
  '',
  '## 已完成',
  '',
].join('\n'), 'utf8')

const period = tools.find(tool => tool.name === 'work_summary_period')
if (!period) throw new Error('没有注册 work_summary_period')

const first = await period.execute({ from: '2026-11-18', to: '2026-11-24' }, {})
console.log('首次 =', JSON.stringify({
  periodPath: first.periodPath,
  reportPath: first.reportPath,
  pushed: first.pushed,
  skipped: first.skipped,
  boardOpen: first.boardOpen,
}))
if (!existsSync(first.reportPath)) throw new Error(`周报文件不存在：${first.reportPath}`)
if (!existsSync(first.periodPath)) throw new Error(`周期源数据不存在：${first.periodPath}`)
if (!first.reportPath.endsWith('周报-2026-11-18_2026-11-24.md')) throw new Error(`文件名不对：${first.reportPath}`)

const report = readFileSync(first.reportPath, 'utf8')
for (const heading of ['## 一、本周主线', '## 二、关键产出', '## 三、未清与复发', '## 四、下周开场']) {
  if (!report.includes(heading)) throw new Error(`周报缺小节：${heading}`)
}
if (/待填|\{\{/.test(report)) throw new Error('周报里还有占位符')
if (report.trim().length < 400) throw new Error(`周报太短：${report.trim().length}`)
console.log('四节齐全 = true | 字符数 =', report.trim().length)

// 一、主线按工作区分组；账本里跨期未动的主线要带出来并标挂起。
if (!report.includes('### novel（F:\\novel）')) throw new Error('周报没有按工作区分组')
if (!report.includes('M-2026-11-18-01 周期聚合主线：11-18 → 11-24（进行中，判据 1/2）')) {
  throw new Error('周报主线行不对')
}
if (!report.includes('M-2026-11-01-07 投资网未提交文件：11-05 → 11-10（受阻，判据 0/1，挂起 14 天，本期未推进）')) {
  throw new Error('周报没有带出跨期受阻主线')
}
// 账本日期被手工改成 `—` 时，报告仍要生成，只是区间显示成 `—`。
if (!report.includes('M-2026-11-02-03 没有日期的旧主线：— → —')) {
  throw new Error('日期为空的主线没有容错成 —')
}
// 区间结束之后才出现的主线不能倒灌进历史周报。
if (report.includes('M-2026-11-26-09')) throw new Error('区间之后的主线倒灌进了周报')
const source = readFileSync(first.periodPath, 'utf8')
if (!source.includes('## 12. 主线（区间）')) throw new Error('源数据缺第 12 节')
if (!source.includes('- M-2026-11-01-07 投资网未提交文件：11-05 → 11-10（受阻，判据 0/1，挂起 14 天，本期未推进）')) {
  throw new Error('源数据第 12 节没有跨期主线')
}
if (source.includes('M-2026-11-26-09')) throw new Error('源数据第 12 节混进了区间之后的主线')
console.log('主线分组 = true | 跨期受阻 = true')

const boardBefore = readFileSync(join(dataDir, '看板.md'), 'utf8')
const openBefore = boardBefore.split('\n').filter(line => line.startsWith('- [ ]')).length
const second = await period.execute({ from: '2026-11-18', to: '2026-11-24' }, {})
const openAfter = readFileSync(join(dataDir, '看板.md'), 'utf8').split('\n').filter(line => line.startsWith('- [ ]')).length
console.log('第二次 =', JSON.stringify({ pushed: second.pushed, skipped: second.skipped, openBefore, openAfter }))
if (second.pushed !== 0) throw new Error(`第二次应写入 0 条，实际 ${second.pushed}`)
if (openAfter !== openBefore) throw new Error(`看板被重复追加：${openBefore} → ${openAfter}`)

const month = await period.execute({ from: '2026-11-01', to: '2026-11-30', kind: 'month' }, {})
console.log('整月 =', month.reportPath)
if (!month.reportPath.endsWith('月报-2026-11.md')) throw new Error(`整月命名不对：${month.reportPath}`)

// offset=1 是定时任务用的「上一完整周期」：周报应为 7 天，且不能是本周。
const previous = await period.execute({ kind: 'week', offset: 1 }, {})
const previousName = previous.reportPath.split(/[\\/]/).pop()
const previousMatch = /^周报-(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.md$/.exec(previousName)
if (!previousMatch) throw new Error(`offset 周报命名不对：${previousName}`)
const previousSpan = (Date.parse(previousMatch[2]) - Date.parse(previousMatch[1])) / 86400000 + 1
console.log('上一周 =', previousMatch[1], '~', previousMatch[2], `(${previousSpan} 天)`)
if (previousSpan !== 7) throw new Error(`offset 周报应为 7 天，实际 ${previousSpan}`)

async function expectFail(label, args, pattern) {
  try {
    await period.execute(args, {})
  } catch (error) {
    const message = String(error?.message ?? error)
    console.log(`${label} = 拒绝：${message.split('\n')[0]}`)
    if (!pattern.test(message)) throw new Error(`${label} 的报错不对：${message}`)
    return
  }
  throw new Error(`${label} 应该报错但没有`)
}

await expectFail('from>to', { from: '2026-11-24', to: '2026-11-18' }, /结束日期不能早于起始日期/)
await expectFail('超过 400 天', { from: '2025-01-01', to: '2026-11-24' }, /最长 400 天/)
await expectFail('只给 from', { from: '2026-11-18' }, /要么都传/)
await expectFail('日期不存在', { from: '2026-02-30', to: '2026-03-01' }, /日期不存在/)
await expectFail('offset 负数', { kind: 'week', offset: -1 }, /offset 应为 0–60/)
await expectFail('offset 与 from/to 冲突', { from: '2026-11-18', to: '2026-11-24', offset: 1 }, /不要再传 offset/)

const shortPath = join(dataDir, '周报-2026-11-17_2026-11-23.md')
await expectFail('四节缺失', {
  from: '2026-11-17', to: '2026-11-23', push: false,
  content: '# 工作周报 · 2026-11-17 ~ 2026-11-23\n\n## 一、本周主线\n\n只写了一节，正文也不够长。',
}, /缺少小节/)
if (existsSync(shortPath)) throw new Error('校验失败时不应写文件')

console.log('周期聚合测试通过')
