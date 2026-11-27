// 主线账本：落盘生成、旧 ID 复用不重复、陌生旧 ID 拒绝、挂起提醒、采集第 7 节。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const home = 'F:\\dsh_plugins\\dsh-work-summary\\test\\.tmp-mainline\\home'
const data = 'F:\\dsh_plugins\\dsh-work-summary\\test\\.tmp-mainline\\data'
const ws = 'F:\\dsh_plugins\\dsh-work-summary\\test\\.tmp-mainline\\ws'
process.env.DSH_WORK_SUMMARY_HOME = home
for (const dir of [home, data, ws]) rmSync(dir, { recursive: true, force: true })
mkdirSync(ws, { recursive: true })
mkdirSync(data, { recursive: true })

const { apply } = await import('../index.js')

const tools = []
const ctx = {
  tools: { register: (definition) => { tools.push(definition); return () => {} } },
  inject: (deps, callback) => {
    const bag = {}
    if (deps.includes('webServer')) bag.webServer = { register: () => () => {} }
    if (deps.includes('schedule')) {
      bag.schedule = {
        list: async () => ({ items: [] }),
        create: async () => ({}),
        edit: async () => ({}),
      }
    }
    return callback(bag)
  },
  logger: { info: () => {}, warn: (message) => console.log('WARN', message) },
}
apply(ctx, { reportDir: data })
await new Promise(resolve => setTimeout(resolve, 80))

const save = tools.find(tool => tool.name === 'daily_report_save')
if (!save) throw new Error('未注册 daily_report_save')
const ledgerPath = `${data}\\_主线.md`
const reportPath = date => `${data}\\日报-${date}.md`

function content(date, blocks, risk = '- 无。') {
  const rows = blocks.map(block => `| ${block.id} ${block.title} | \`${ws}\` | 改代码 | ${block.status} | 明天继续 |`)
  const detail = blocks.map(block => [
    `#### ${block.id} ${block.title}`,
    '',
    `- 工作区：${ws}`,
    `- 状态：${block.status}`,
    `- 判据：${block.criteria ?? 'npm test 通过'}`,
    '',
    `改了 \`index.js\` 的 ${block.id} 分支，提交 abc1234；证据见 \`_源数据\\${date}.md\`。`,
  ].join('\n'))
  return [
    `# 工作日报 · ${date}`,
    '',
    '## 一、今日概览',
    '',
    '| 主线 | 工作区 | 今日产出 | 状态 | 下一步 |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    `今天围绕 ${blocks.length} 条主线推进，证据都落在 \`index.js\` 与提交记录里，没有凭印象补的内容。`,
    '',
    '## 二、做了什么',
    '',
    `### 测试工作区（\`${ws}\`）`,
    '',
    ...detail,
    '',
    '## 三、结果与产出',
    '',
    '| 产出物 | 路径 | 状态 | 说明 | 主线 |',
    '|---|---|---|---|---|',
    `| 主线账本 | \`_主线.md\` | 完成 | 自动维护 | ${blocks[0].id} |`,
    '',
    '## 四、问题与风险',
    '',
    risk,
    '',
    '## 五、后续建议',
    '',
    '1. 跑 `node test/mainline.test.mjs` | 验证账本 | 10 分钟 | 今天',
    '',
    '## 六、明日开场清单',
    '',
    `- 接着做 ${blocks[0].id}，命令 \`npm run check\`。`,
    '',
  ].join('\n')
}

async function saveReport(date, blocks, risk) {
  return save.execute({ date, content: content(date, blocks, risk), push: false }, { signal: undefined })
}

function ledgerText() {
  return existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : ''
}

// 1. 首份日报：两条主线落账本。
const first = await saveReport('2026-11-27', [
  { id: 'M-2026-11-27-01', title: '工作区自动发现', status: '完成', criteria: 'workspace.test.mjs 通过' },
  { id: 'M-2026-11-27-02', title: '主线账本', status: '进行中' },
])
if (!existsSync(reportPath('2026-11-27'))) throw new Error('日报未写入')
let ledger = ledgerText()
for (const id of ['M-2026-11-27-01', 'M-2026-11-27-02']) {
  if (!ledger.includes(`## ${id} `)) throw new Error(`账本缺少 ${id}`)
}
if (first.mainlines.length !== 2) throw new Error(`返回主线数应为 2，实际 ${first.mainlines.length}`)
if (first.stalled.length !== 0) throw new Error('首份日报不应有受阻主线')

// 2. 第二天复用旧 ID：账本不追加重复条目，首次 / 最近产出分别取小 / 取大。
const second = await saveReport('2026-11-28', [
  { id: 'M-2026-11-27-02', title: '主线账本', status: '进行中', criteria: '报错不写文件' },
  { id: 'M-2026-11-28-01', title: '采集第 7 节', status: '进行中' },
])
ledger = ledgerText()
const count = (ledger.match(/^## M-/gm) ?? []).length
if (count !== 3) throw new Error(`账本条目应为 3，实际 ${count}`)
if (!/## M-2026-11-27-02[\s\S]*?- 首次产出：2026-11-27[\s\S]*?- 最近产出：2026-11-28/.test(ledger)) {
  throw new Error('旧主线的首次 / 最近产出没有按日期取小 / 取大')
}
if (second.stalled.length !== 0) throw new Error('当天写过的主线不应判受阻')

// 3. 引用账本外的旧 ID：报错且日报、账本都不改。
const before = ledgerText()
let rejected = ''
try {
  await saveReport('2026-11-29', [{ id: 'M-2026-11-25-09', title: '不存在的旧主线', status: '进行中' }])
} catch (error) {
  rejected = String(error.message)
}
if (!/不在 _主线\.md 账本里/.test(rejected)) throw new Error(`未知旧 ID 应报错，实际：${rejected}`)
if (existsSync(reportPath('2026-11-29'))) throw new Error('报错时不应写日报')
if (ledgerText() !== before) throw new Error('报错时不应改账本')

// 4. 连续多天没写：旧主线判受阻，且提醒第四节没提到。
const stalled = await saveReport('2026-12-02', [
  { id: 'M-2026-12-02-01', title: '新的交付', status: '进行中' },
])
const old = stalled.mainlines.find(item => item.id === 'M-2026-11-27-02')
if (!old || old.status !== '受阻' || old.stallDays !== 4) {
  throw new Error(`旧主线应受阻 4 天，实际：${JSON.stringify(old)}`)
}
if (!stalled.warnings.some(text => /已挂起 4 天/.test(text))) throw new Error('缺少挂起提醒')
if (!stalled.stalled.includes('M-2026-11-27-02')) throw new Error('stalled 未包含受阻主线')

// 5. 非法状态：报错且不写文件。
let badStatus = ''
try {
  await saveReport('2026-12-03', [{ id: 'M-2026-12-03-01', title: '状态写错', status: '搁置' }])
} catch (error) {
  badStatus = String(error.message)
}
if (!/状态只能是/.test(badStatus)) throw new Error(`非法状态应报错，实际：${badStatus}`)

// 6. 采集第 7 节：账本里的未完成主线按挂起天数判受阻。
const collect = spawnSync('pwsh', [
  '-NoProfile', '-File', 'scripts/collect-day.ps1',
  '-Date', '2026-12-02', '-ReportDir', data, '-Workspace', ws, '-NoSessions',
], { cwd: 'F:\\dsh_plugins\\dsh-work-summary', stdio: 'inherit' })
if (collect.status !== 0) throw new Error(`采集失败：退出码 ${collect.status}`)
const source = readFileSync(`${data}\\_源数据\\2026-12-02.md`, 'utf8')
if (!/## 7\. 未清主线/.test(source)) throw new Error('源数据缺少第 7 节')
if (!/\| M-2026-11-27-02 \|.*\| 受阻 \|.*\| 4 \|/.test(source)) {
  throw new Error('第 7 节未把挂起 4 天的主线标成受阻')
}

// 7. 完全没写状态行：与模板「固定三行」不一致，应该拒绝。
const noStatus = content('2026-12-04', [{ id: 'M-2026-12-04-01', title: '缺状态行', status: '进行中' }])
  .replace(/^- 状态：.*$/m, '')
let missingStatus = ''
try {
  await save.execute({ date: '2026-12-04', content: noStatus, push: false })
} catch (error) {
  missingStatus = String(error.message)
}
if (!/缺少.*状态/.test(missingStatus)) throw new Error(`缺状态行应报错，实际：${missingStatus}`)
if (existsSync(reportPath('2026-12-04'))) throw new Error('缺状态行时不应写日报')

// 8. 否定式状态不能被子串匹配成「完成」。
let negatedStatus = ''
try {
  await saveReport('2026-12-05', [{ id: 'M-2026-12-05-01', title: '否定状态', status: '未完成' }])
} catch (error) {
  negatedStatus = String(error.message)
}
if (!/状态只能是/.test(negatedStatus)) throw new Error(`「未完成」应报错，实际：${negatedStatus}`)

// 9. 单数字序号：必须明确报错，不能静默忽略。
let shortId = ''
try {
  await saveReport('2026-12-06', [{ id: 'M-2026-12-06-1', title: '序号写短', status: '进行中' }])
} catch (error) {
  shortId = String(error.message)
}
if (!/序号要两位/.test(shortId)) throw new Error(`单数字 ID 应报错，实际：${shortId}`)

// 10. 补写旧日报：只补证据，不回拨已完成的状态与判据。
await saveReport('2026-12-06', [{ id: 'M-2026-12-06-01', title: '跨天交付', status: '进行中', criteria: '先跑通' }])
await saveReport('2026-12-08', [{ id: 'M-2026-12-06-01', title: '跨天交付', status: '完成', criteria: 'a；b' }])
await saveReport('2026-12-07', [{ id: 'M-2026-12-06-01', title: '跨天交付（补写）', status: '进行中', criteria: 'c' }])
ledger = ledgerText()
const rolled = /## M-2026-12-06-01[\s\S]*?(?=\n## M-|\s*$)/.exec(ledger)?.[0] ?? ''
if (!/- 状态：完成/.test(rolled)) throw new Error('补写旧日报把已完成状态回拨了')
if (!/- 最近产出：2026-12-08/.test(rolled)) throw new Error('补写旧日报把最近产出回拨了')
if (!/- \[ \] a/.test(rolled) || !/- \[ \] b/.test(rolled) || /- \[ \] c/.test(rolled)) {
  throw new Error('补写旧日报覆盖了判据')
}

// 11. 账本里的备注：保存后要写回，不能悄悄丢掉。
ledger = ledgerText().replace(
  /(## M-2026-11-27-02[\s\S]*?)(?=\n## M-|$)/,
  '$1- 备注：等 0.3.2 一起发\n',
)
writeFileSync(ledgerPath, ledger, 'utf8')
await saveReport('2026-12-09', [{ id: 'M-2026-11-27-02', title: '主线账本', status: '进行中' }])
if (!/- 备注：等 0\.3\.2 一起发/.test(ledgerText())) throw new Error('保存后账本备注丢了')

console.log('主线账本 = 生成 / 复用 / 拒绝 / 挂起 / 补写不回拨 全部通过')
console.log('账本条目 =', (ledgerText().match(/^## M-/gm) ?? []).length)
