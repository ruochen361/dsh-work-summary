// 用假 ctx 驱动 index.js 的真实 apply：验证计划任务同步 + /dsh-work-summary/schedule 的 GET/POST。
import { existsSync, readdirSync, readFileSync } from 'node:fs'

// 数据根改到临时目录，别碰真实的 ~/.dsh/dsh-work-summary。
process.env.DSH_WORK_SUMMARY_HOME = 'F:\\dsh_plugins\\_probe\\home'
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
    edits.push({ created: input })
    return input
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
const syncEdit = edits.find(item => item.patch && typeof item.patch.prompt === 'string')
console.log('prompt 已同步 =', Boolean(syncEdit), '| 仍含「返回 problems」 =', String(tasks[0].prompt).includes('返回 problems'))
console.log('同步后首行 =', String(tasks[0].prompt).split('\n')[0])

const route = routes.find(item => item.path === '/dsh-work-summary/schedule')

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

