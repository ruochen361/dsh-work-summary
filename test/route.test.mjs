// 用假 ctx 驱动 index.js 的真实 apply：验证计划任务同步 + /dsh-work-summary/schedule 的 GET/POST。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

// 数据根改到临时目录，别碰真实的 ~/.dsh/dsh-work-summary；设置也清空，保证从默认值开始。
process.env.DSH_WORK_SUMMARY_HOME = 'F:\\dsh_plugins\\_probe\\home'
rmSync('F:\\dsh_plugins\\_probe\\home\\settings.json', { force: true })

// 热力图的数据来自 /state 里的日报正文统计；先放两份可预测的日报进去。
const probeData = 'F:\\dsh_plugins\\_probe\\data'
rmSync(probeData, { recursive: true, force: true })
mkdirSync(probeData, { recursive: true })
writeFileSync(`${probeData}\\日报-2026-11-25.md`, [
  '# 工作日报 · 2026-11-25',
  '',
  '## 一、今日概览',
  '',
  '今天对齐了热力图的数据口径。',
  '',
  '## 二、做了什么',
  '',
  '- 梳理 state 结构',
  '- 补统计函数',
  '',
  '## 三、结果与产出',
  '',
  '| 产出物 | 路径 | 状态 | 说明 |',
  '|---|---|---|---|',
  '| 热力图统计 | `index.js` | 完成 | `heatStats` |',
  '| 页面热力图 | `client.js` | 完成 | 13 周网格 |',
  '',
  '## 四、风险与阻塞',
  '',
  '- 无。',
  '',
  '## 五、明日计划',
  '',
  '- 跑测试。',
  '',
  '## 六、明日开场清单',
  '',
  '- 跑 `npm test`。',
  '',
].join('\n'), 'utf8')
writeFileSync(`${probeData}\\日报-2026-11-26.md`, [
  '# 工作日报 · 2026-11-26',
  '',
  '## 一、今日概览',
  '',
  '短日报。',
  '',
].join('\n'), 'utf8')

// 看板：老格式 + 新元数据 + 已完成条目，覆盖解析、改元数据、跨栏移动。
writeFileSync(`${probeData}\\看板.md`, [
  '# 工作看板',
  '',
  '## 待办',
  '',
  '- [ ] 2026-11-20 ｜ 老格式条目 ｜ 来源：日报-2026-11-20.md ｜ #h11111111',
  '  - 详情：老格式条目正文',
  '- [ ] 2026-11-21 ｜ 待设优先级 ｜ 来源：日报-2026-11-21.md ｜ #h22222222 ｜ @P2 ｜ !2026-11-30',
  '  - 详情：待设优先级正文',
  '',
  '## 进行中',
  '',
  '## 已完成',
  '',
  '- [x] 2026-11-01 ｜ 已完成条目 ｜ 来源：日报-2026-11-01.md ｜ #h33333333（完成 2026-11-02）',
  '',
  '## 已放弃',
  '',
].join('\n'), 'utf8')
const { apply } = await import('../index.js')

const realTask = {
  id: 'schedule-a2768a57-4ac3-473e-a1fb-459070c6fd22',
  kind: 'rrule',
  title: '每日工作日报（23:00）',
  prompt: '旧提示词：运行 F:\\dsh_work\\_日报\\collect-day.ps1 采集，返回 problems 就改。',
  rrule: 'DTSTART;TZID=Asia/Shanghai:20261106T230000\nRRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=23;BYMINUTE=0',
  status: 'active',
  scheduledAtLocal: '2026-11-23T23:00:00+08:00',
  target: { kind: 'session', sessionId: 'session-ade8c7f4-623f-4c77-973a-8217035b19c1' },
}

const tasks = [{ ...realTask }]
const edits = []
const schedule = {
  list: async () => ({ items: tasks, shown: tasks.length, total: tasks.length }),
  edit: async ({ id, patch }) => {
    edits.push({ id, patch })
    const task = tasks.find(item => item.id === id)
    // 模拟 dsh-schedule 的归一化：写 timing 之后 list 里能看到顶层 rrule，写 active 之后 status 跟着变。
    Object.assign(task, patch)
    if (patch.timing && typeof patch.timing.rrule === 'string') task.rrule = patch.timing.rrule
    if (typeof patch.active === 'boolean') task.status = patch.active ? 'active' : 'paused'
    return task
  },
  create: async (input) => {
    const task = {
      id: `schedule-new-${tasks.length + 1}`,
      kind: 'rrule',
      title: input.title,
      prompt: input.prompt,
      rrule: input.timing?.rrule ?? '',
      status: 'active',
      scheduledAtLocal: null,
      target: input.target,
    }
    tasks.push(task)
    edits.push({ created: input })
    return task
  },
}

const routes = []
const tools = []
const ctx = {
  tools: { register: (definition) => { tools.push(definition); return () => {} } },
  inject: (deps, callback) => {
    const bag = {}
    if (deps.includes('webServer')) bag.webServer = { register: (route) => { routes.push(route); return () => {} } }
    if (deps.includes('schedule')) bag.schedule = schedule
    return callback(bag)
  },
  logger: { info: () => {}, warn: (message) => console.log('WARN', message) },
}

apply(ctx, { reportDir: 'F:\\dsh_plugins\\_probe\\data' })
await new Promise(resolve => setTimeout(resolve, 60))

console.log('tools =', tools.map(item => item.name).join(','))
console.log('routes =', routes.map(item => item.path).join(','))
console.log('计划任务 =', tasks.map(item => `${item.title}(${item.status})`).join(' | '))
const syncEdit = edits.find(item => item.patch && typeof item.patch.prompt === 'string')
console.log('prompt 已同步 =', Boolean(syncEdit), '| 仍含「返回 problems」 =', String(tasks[0].prompt).includes('返回 problems'))
console.log('同步后首行 =', String(tasks[0].prompt).split('\n')[0])

const route = routes.find(item => item.path === '/dsh-work-summary/schedule')

// 热力图：/state 必须带上今天、逐日行数 / 产出条数 / 强度分。
const stateRoute = routes.find(item => item.path === '/dsh-work-summary/state')
const stateResponse = await stateRoute.resource()
const statePayload = await stateResponse.json()
const heatSample = statePayload.reports.find(report => report.date === '2026-11-25')
const heatShort = statePayload.reports.find(report => report.date === '2026-11-26')
console.log('热力图数据 =', JSON.stringify({
  today: statePayload.today,
  reports: statePayload.reports.length,
  sample: heatSample && { lines: heatSample.lines, outputs: heatSample.outputs, score: heatSample.score },
  short: heatShort && { lines: heatShort.lines, outputs: heatShort.outputs, score: heatShort.score },
}))
console.log('热力图校验 =',
  /^\d{4}-\d{2}-\d{2}$/.test(statePayload.today)
  && heatSample && heatSample.outputs === 2 && heatSample.score === heatSample.lines + 6
  && heatShort && heatShort.outputs === 0 && heatShort.score === heatShort.lines
    ? '通过'
    : '不符合预期')

// 看板写回：老格式解析、元数据更新、跨栏移动、错误拒绝、重复更新幂等。
const boardRoute = routes.find(item => item.path === '/dsh-work-summary/board')
const boardFile = `${probeData}\\看板.md`
const readBoard = () => readFileSync(boardFile, 'utf8')
function check(condition, message) {
  if (!condition) throw new Error(`看板断言失败：${message}`)
}
async function callBoard(method, body) {
  const req = {
    method,
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
    },
  }
  let status = 0
  let payload = ''
  const res = {
    writeHead(code) { status = code },
    end(chunk) { payload = chunk === undefined ? '' : String(chunk) },
  }
  await boardRoute.handler(req, res)
  return { status, json: payload ? JSON.parse(payload) : null }
}

const boardGet = await callBoard('GET')
check(boardGet.status === 405, `GET 应 405，实际 ${boardGet.status}`)

const noPatch = await callBoard('POST', { keyword: '老格式条目' })
check(noPatch.status === 400 && /至少要给/.test(noPatch.json.error), '空 patch 应 400')

const missing = await callBoard('POST', { keyword: '没有这条', priority: 'P1' })
check(missing.status === 400 && /没有匹配/.test(missing.json.error), '未知条目应 400')

const oldMeta = await callBoard('POST', { keyword: '老格式条目', priority: 'p1', due: '2026-12-15' })
check(oldMeta.status === 200, `老格式更新应 200，实际 ${oldMeta.status} ${JSON.stringify(oldMeta.json)}`)
let boardText = readBoard()
check(/老格式条目.*@P1.*!2026-12-15/.test(boardText), '老格式条目应写入 @P1 与截止日')
check(boardText.includes('  - 详情：老格式条目正文'), '更新后详情行应保留')

const beforeIdempotent = boardText
const again = await callBoard('POST', { keyword: '#h11111111', priority: 'P1', due: '2026-12-15' })
check(again.status === 200 && readBoard() === beforeIdempotent, '重复更新应幂等')

const completed = await callBoard('POST', { keyword: '#h33333333', priority: 'P1' })
check(completed.status === 200, `已完成条目更新应 200，实际 ${completed.status}`)
boardText = readBoard()
check(/- \[x\] 2026-11-01 ｜ 已完成条目.*@P1（完成 2026-11-02）/.test(boardText), '改优先级不应改写完成日期')

const doing = await callBoard('POST', { keyword: '待设优先级', status: 'doing' })
check(doing.status === 200, `移到进行中应 200，实际 ${doing.status}`)
boardText = readBoard()
const doingSection = boardText.split('## 进行中')[1].split('## 已完成')[0]
check(doingSection.includes('待设优先级') && doingSection.includes('  - 详情：待设优先级正文'), '进行中应保留条目与详情')

const dropped = await callBoard('POST', { keyword: '#h11111111', status: 'drop' })
check(dropped.status === 200, `移到已放弃应 200，实际 ${dropped.status}`)
boardText = readBoard()
check(/⛔ .*老格式条目.*（放弃 \d{4}-\d{2}-\d{2}）/.test(boardText), '已放弃条目应带放弃日期')

const restored = await callBoard('POST', { keyword: '#h11111111', status: 'todo' })
check(restored.status === 200, `移回待办应 200，实际 ${restored.status}`)
boardText = readBoard()
check(!/⛔ .*老格式条目/.test(boardText) && /- \[ \] .*老格式条目/.test(boardText), '移回待办应恢复复选框')

const ambiguous = await callBoard('POST', { keyword: '条目', priority: 'P1' })
check(ambiguous.status === 400 && /匹配到 \d+ 条/.test(ambiguous.json.error), '多条匹配应 400')

const badJson = await callBoard('POST', '{bad json')
check(badJson.status === 400, '非法 JSON 应 400')

const boardTool = tools.find(item => item.name === 'daily_report_board')
const toolUpdate = await boardTool.execute({ action: 'update', keyword: '#h22222222', priority: 'P3' }, {})
check(toolUpdate.action === 'update' && /@P3/.test(readBoard()), '工具 update 应改优先级')
console.log('看板写回校验 = 通过')

async function call(method, body) {
  const req = {
    method,
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
  let status = 0
  let headers = {}
  let payload = ''
  const res = {
    writeHead(code, extra) { status = code; headers = extra || {} },
    end(chunk) { payload = chunk === undefined ? '' : String(chunk) },
  }
  await route.handler(req, res)
  return { status, headers, json: payload ? JSON.parse(payload) : null }
}

const first = await call('GET')
console.log('GET#1 =', first.status, JSON.stringify({
  found: first.json.found, time: first.json.time, active: first.json.active,
  tz: first.json.timeZone, id: first.json.id, next: first.json.nextRunAt,
}))
console.log('周期任务 =', JSON.stringify({
  week: first.json.week && { found: first.json.week.found, time: first.json.week.time, active: first.json.week.active },
  month: first.json.month && { found: first.json.month.found, time: first.json.month.time, active: first.json.month.active },
}))

const changed = await call('POST', { time: '07:30' })
console.log('POST 07:30 =', changed.status, JSON.stringify({
  time: changed.json.time, active: changed.json.active, next: changed.json.nextRunAt,
}))
console.log('写入的 rrule =', JSON.stringify(edits.filter(item => item.patch && item.patch.timing).pop()?.patch.timing.rrule))

const afterChange = await call('GET')
console.log('GET#2 =', afterChange.status, afterChange.json.time)

const bad = await call('POST', { time: '7:30' })
console.log('POST 7:30 =', bad.status, JSON.stringify(bad.json))

const empty = await call('POST', {})
console.log('POST {} =', empty.status, JSON.stringify(empty.json))

const paused = await call('POST', { active: false })
console.log('POST active:false =', paused.status, JSON.stringify({ active: paused.json.active }))

const resumed = await call('POST', { active: true })
console.log('POST active:true =', resumed.status, JSON.stringify({ active: resumed.json.active }))

const weekChanged = await call('POST', { weekTime: '08:15' })
console.log('POST weekTime =', weekChanged.status, JSON.stringify({
  time: weekChanged.json.week && weekChanged.json.week.time,
  rrule: weekChanged.json.week && tasks.find(item => item.title === '每周工作周报')?.rrule,
}))

const weekPaused = await call('POST', { weekActive: false })
console.log('POST weekActive:false =', weekPaused.status, JSON.stringify({
  active: weekPaused.json.week && weekPaused.json.week.active,
}))

const monthChanged = await call('POST', { monthTime: '08:45' })
console.log('POST monthTime =', monthChanged.status, JSON.stringify({
  time: monthChanged.json.month && monthChanged.json.month.time,
  rrule: monthChanged.json.month && tasks.find(item => item.title === '每月工作月报')?.rrule,
}))

const badWeek = await call('POST', { weekTime: '8:15' })
console.log('POST weekTime 8:15 =', badWeek.status, JSON.stringify(badWeek.json))

const rejected = await call('DELETE')
console.log('DELETE =', rejected.status)

const logSet = await call('POST', { logDir: 'F:\\dsh_plugins\\_probe\\logs' })
console.log('POST logDir =', logSet.status, JSON.stringify({
  logDir: logSet.json.logDir, logDirDefault: logSet.json.logDirDefault, logPattern: logSet.json.logPattern,
}))

const settingsFile = 'F:\\dsh_plugins\\_probe\\home\\settings.json'
console.log('settings 已落盘 =', existsSync(settingsFile))
if (existsSync(settingsFile)) console.log('settings 内容 =', readFileSync(settingsFile, 'utf8').trim().replace(/\s+/g, ' '))

const logFiles = existsSync('F:\\dsh_plugins\\_probe\\logs') ? readdirSync('F:\\dsh_plugins\\_probe\\logs') : []
console.log('日志文件 =', logFiles.join(',') || '(无)')
if (logFiles.length > 0) {
  console.log('日志首行 =', readFileSync(`F:\\dsh_plugins\\_probe\\logs\\${logFiles[0]}`, 'utf8').split('\n')[0])
}

const badDir = await call('POST', { logDir: 'relative\\logs' })
console.log('POST 相对路径 =', badDir.status, JSON.stringify(badDir.json))

const reportSet = await call('POST', { reportDir: 'F:\\dsh_plugins\\_probe\\reports' })
console.log('POST reportDir =', reportSet.status, JSON.stringify({
  reportDir: reportSet.json.reportDir, default: reportSet.json.reportDirDefault,
}))
console.log('目录已建 =', existsSync('F:\\dsh_plugins\\_probe\\reports'))
console.log('settings 内容(改目录后) =', readFileSync(settingsFile, 'utf8').trim().replace(/\s+/g, ' '))

const badReport = await call('POST', { reportDir: 'reports' })
console.log('POST reportDir 相对路径 =', badReport.status, JSON.stringify(badReport.json))

const wsBefore = await call('GET')
console.log('GET workspace 默认 =', JSON.stringify({ workspace: wsBefore.json.workspace, def: wsBefore.json.workspaceDefault }))

const wsSet = await call('POST', { workspace: 'F:\\dsh_plugins\\_probe\\work' })
console.log('POST workspace =', wsSet.status, JSON.stringify({ workspace: wsSet.json.workspace }))
console.log('工作空间目录已建 =', existsSync('F:\\dsh_plugins\\_probe\\work'))

const badWs = await call('POST', { workspace: 'work' })
console.log('POST workspace 相对路径 =', badWs.status, JSON.stringify(badWs.json))

// 周期聚合的非法区间：必须在跑脚本之前就拒绝，不能写任何文件。
const period = tools.find(item => item.name === 'work_summary_period')
console.log('period 工具 =', Boolean(period))
for (const [label, args, pattern] of [
  ['周期 from>to', { from: '2026-11-24', to: '2026-11-18' }, /结束日期不能早于起始日期/],
  ['周期 跨 400 天', { from: '2025-01-01', to: '2026-11-24' }, /最长 400 天/],
]) {
  try {
    await period.execute(args, {})
    console.log(label, '= 未报错（不符合预期）')
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    console.log(label, '=', pattern.test(message) ? '已拒绝' : `报错不符：${message}`)
  }
}

