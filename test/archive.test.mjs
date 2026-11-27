// R20：采集结束时只保留最近 60 个源数据，更旧的按季度归档，失败不阻断采集。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const root = join(process.cwd(), 'test', '.tmp-archive')
process.env.DSH_WORK_SUMMARY_HOME = join(root, 'home')
rmSync(root, { recursive: true, force: true })

const { apply } = await import('../index.js')

function boot(reportDir, workspace) {
  const tools = []
  const ctx = {
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    inject: () => () => {},
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx, {
    reportDir,
    workspace,
    logDir: join(root, 'logs'),
    scheduleEnabled: false,
  })
  const collect = tools.find(item => item.name === 'daily_report_collect')
  assert.ok(collect, 'daily_report_collect 应已注册')
  return collect
}

function q(text) {
  return `'${String(text).replace(/'/g, "''")}'`
}

/** 造 61 个 Q3 源数据，返回文件名 → 原始字节，便于之后逐字节比对。 */
function seed(dir, count = 61) {
  const src = join(dir, '_源数据')
  mkdirSync(src, { recursive: true })
  const originals = new Map()
  const base = Date.UTC(2026, 6, 1)
  for (let i = 0; i < count; i += 1) {
    const day = new Date(base + i * 86400000).toISOString().slice(0, 10)
    const bytes = Buffer.from(`# 源数据 ${day}\n\n内容 ${i}\n`, 'utf8')
    writeFileSync(join(src, `${day}.md`), bytes)
    originals.set(`${day}.md`, bytes)
  }
  return originals
}

function sourceFiles(dir) {
  return readdirSync(join(dir, '_源数据')).filter(name => name.endsWith('.md')).sort()
}

// 1) 61 个旧文件 + 今天的新文件 = 62，归档最旧的 2 个，保留 60 个。
const data = join(root, 'data')
const work = join(root, 'work')
mkdirSync(work, { recursive: true })
const originals = seed(data)
const collect = boot(data, work)
const result = await collect.execute({ date: '2026-11-26', sessions: false }, {})
const sourceText = readFileSync(result.sourcePath, 'utf8')

assert.equal(sourceFiles(data).length, 60, '_源数据 应只保留 60 个')
assert.ok(!existsSync(join(data, '_源数据', '2026-07-01.md')), '最旧的文件应已移走')
assert.ok(existsSync(join(data, '_源数据', '2026-11-26.md')), '当天文件必须保留')

const zipPath = join(data, '_归档', '2026-Q3.zip')
const indexPath = join(data, '_归档', '索引.md')
assert.ok(existsSync(zipPath), '应生成 2026-Q3.zip')
const indexText = readFileSync(indexPath, 'utf8')
assert.match(indexText, /2026-Q3/)
assert.match(indexText, /\+2/)

assert.match(sourceText, /归档：2 个源数据/)
assert.match(sourceText, /2026-07-01 ~ 2026-07-02/)
// 日志文件名按运行当天取，不按采集日期，所以取日志目录里最新的一个。
const logDir = join(root, 'logs')
const logFiles = readdirSync(logDir).filter(name => name.endsWith('.log')).sort()
const logText = readFileSync(join(logDir, logFiles[logFiles.length - 1]), 'utf8')
assert.match(logText, /归档：2 个源数据/, '归档结果应同时写运行日志')

// 解压后逐字节比对；只比较被归档的两个文件。
const unzip = join(root, 'unzip')
const expand = spawnSync('pwsh', [
  '-NoProfile', '-NonInteractive', '-Command',
  `Expand-Archive -LiteralPath ${q(zipPath)} -DestinationPath ${q(unzip)} -Force`,
], { encoding: 'utf8' })
assert.equal(expand.status, 0, `解压失败：${expand.stderr || expand.stdout}`)
for (const day of ['2026-07-01', '2026-07-02']) {
  const archived = readFileSync(join(unzip, `${day}.md`))
  assert.deepEqual(archived, originals.get(`${day}.md`), `${day} 归档前后字节应一致`)
}
assert.ok(!existsSync(join(unzip, '2026-11-26.md')), '当天文件不应进归档包')

// 1b) 再补两个旧的源数据，归档应更新同一个季度包，而不是新建包。
const extra = ['2026-09-10', '2026-09-11']
for (const day of extra) {
  writeFileSync(join(data, '_源数据', `${day}.md`), Buffer.from(`# 源数据 ${day}\n\n补录\n`, 'utf8'))
}
await collect.execute({ date: '2026-11-26', sessions: false }, {})
assert.equal(sourceFiles(data).length, 60, '补录后仍应保留 60 个')
assert.ok(!existsSync(join(data, '_归档', '2026-Q3-2.zip')), '同一季度应更新原包')
const unzip2 = join(root, 'unzip2')
const expand2 = spawnSync('pwsh', [
  '-NoProfile', '-NonInteractive', '-Command',
  `Expand-Archive -LiteralPath ${q(zipPath)} -DestinationPath ${q(unzip2)} -Force`,
], { encoding: 'utf8' })
assert.equal(expand2.status, 0, `第二次解压失败：${expand2.stderr || expand2.stdout}`)
const updatedEntries = readdirSync(unzip2).filter(name => name.endsWith('.md')).sort()
assert.equal(updatedEntries.length, 4, '季度包应追加到 4 个条目')
assert.ok(updatedEntries.includes('2026-07-03.md') && updatedEntries.includes('2026-07-04.md'), '新增的应是最旧的两个')
assert.match(readFileSync(indexPath, 'utf8'), /\+2 \| 2026-07-03 ~ 2026-07-04/, '索引应追加第二次归档')

// 2) 不足 60 个时再采一次，不应产生新的归档或重复行。
const rowCount = readFileSync(indexPath, 'utf8').trim().split('\n').length
await collect.execute({ date: '2026-11-26', sessions: false }, {})
assert.equal(sourceFiles(data).length, 60, '重复采集不应改变保留数量')
assert.equal(readFileSync(indexPath, 'utf8').trim().split('\n').length, rowCount, '无新增时不应追加索引行')

// 3) 归档目录不可创建时，采集仍然成功，源数据里出现「归档失败」，旧文件不动。
const failData = join(root, 'fail-data')
const failWork = join(root, 'fail-work')
mkdirSync(failWork, { recursive: true })
const failOriginals = seed(failData)
writeFileSync(join(failData, '_归档'), '占位文件，阻止创建同名目录')
const failCollect = boot(failData, failWork)
const failResult = await failCollect.execute({ date: '2026-11-27', sessions: false }, {})
const failText = readFileSync(failResult.sourcePath, 'utf8')
assert.match(failText, /归档失败/)
assert.equal(sourceFiles(failData).length, 62, '归档失败时源文件不应被删除')
assert.ok(existsSync(join(failData, '_源数据', '2026-07-01.md')), '失败时最旧文件仍在')
for (const [name, bytes] of failOriginals) {
  assert.deepEqual(readFileSync(join(failData, '_源数据', name)), bytes, `${name} 不应被修改`)
}

console.log('archive 正常 = 60 个保留，2026-Q3.zip 2 个条目，字节一致')
console.log('archive 重复 = 无新增归档行')
console.log('archive 失败 = 采集成功，源数据含「归档失败」，旧文件未删')
console.log('archive 测试 = 通过')
