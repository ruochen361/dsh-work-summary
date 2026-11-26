// R12：日报软校验只提醒、不阻断。用假 ctx 驱动真实的 daily_report_save。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(process.cwd(), 'test', '.tmp-quality')
process.env.DSH_WORK_SUMMARY_HOME = join(root, 'home')
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, 'data'), { recursive: true })
mkdirSync(join(root, 'work'), { recursive: true })

const { apply } = await import('../index.js')

/** 每个用例独立 apply，避免 config 互相污染。 */
function boot(config = {}) {
  const tools = []
  const ctx = {
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    // 本用例只测工具，不注册 web / schedule 路由。
    inject: () => () => {},
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx, {
    reportDir: join(root, 'data'),
    workspace: join(root, 'work'),
    scheduleEnabled: false,
    ...config,
  })
  const save = tools.find(item => item.name === 'daily_report_save')
  assert.ok(save, 'daily_report_save 应已注册')
  return save
}

// 正文只反复写「继续推进项目」：够长以通过结构硬校验，但质量提醒必须命中。
const filler = '继续推进项目。'.repeat(5)
const fillerReport = [
  '# 工作日报 · 2026-11-20',
  '',
  '## 一、今日概览',
  filler,
  '',
  '## 二、做了什么',
  filler,
  '',
  '## 三、结果与产出',
  filler,
  '',
  '## 四、问题与风险',
  filler,
  '',
  '## 五、后续建议',
  filler,
  '',
  '## 六、明日开场清单',
  filler,
].join('\n')

const normalReport = [
  '# 工作日报 · 2026-11-21',
  '',
  '## 一、今日概览',
  '今天完成日报质量自检，主要改动在 F:\\dsh_plugins\\dsh-work-summary\\index.js 和 client.js，核心逻辑已拆成独立函数。',
  '',
  '## 二、做了什么',
  '- 在 scripts\\collect-day.ps1 增加采集字段，并更新 test\\route.test.mjs 的断言。',
  '- 核对提交 48d27dc，确认 package.json 版本与 docs\\ROADMAP.md 的 R12 一致。',
  '- 复查 docs\\DETAIL.md，把软校验说明补到保存流程一节。',
  '',
  '## 三、结果与产出',
  '| 产出物 | 路径 | 状态 |',
  '|---|---|---|',
  '| 软校验 | F:\\dsh_plugins\\dsh-work-summary\\index.js | 完成 |',
  '| 回归测试 | test\\quality.test.mjs | 完成 |',
  '',
  '## 四、问题与风险',
  '- 低：测试仍依赖 pwsh，受限沙箱下需要完整权限。',
  '',
  '## 五、后续建议',
  '1. 运行 `npm test`，再跑 `npm run check`。',
  '2. 打开 F:\\dsh_plugins\\dsh-work-summary\\docs\\DETAIL.md 核对文案。',
  '',
  '## 六、明日开场清单',
  '1. 跑 `npm test`。',
].join('\n')

// 1) 只有空话、没有路径：仍然落盘，但 warnings 必须提醒并列出命中词。
const save = boot()
const data = join(root, 'data')
const fillerResult = await save.execute({ content: fillerReport, date: '2026-11-20', push: false }, {})
assert.ok(existsSync(join(data, '日报-2026-11-20.md')), '软校验不应阻止落盘')
assert.ok(fillerResult.warnings.length >= 1, '空话日报应有 warnings')
assert.match(fillerResult.text, /继续推进/, 'text 应列出命中的空话词')
assert.match(fillerResult.text, /证据偏少/, 'text 应包含证据提醒')
assert.match(fillerResult.text, /后续建议/, 'text 应包含建议可执行性提醒')
console.log('quality 空话日报 =', fillerResult.warnings.length, '条提醒 |', fillerResult.warnings.join(' / '))

// 2) 正常日报：证据 >=5、建议带命令和路径，不应有提醒。
const normalResult = await save.execute({ content: normalReport, date: '2026-11-21', push: false }, {})
assert.deepEqual(normalResult.warnings, [], `正常日报不应有 warnings：${normalResult.warnings.join(' / ')}`)
console.log('quality 正常日报 = 0 条提醒')

// 3) 阈值可从嵌套 quality.minEvidence 读；提高阈值后同一份正文应提醒。
const strict = boot({ quality: { minEvidence: 20 } })
const strictResult = await strict.execute({ content: normalReport, date: '2026-11-22', push: false }, {})
assert.ok(strictResult.warnings.some(item => item.includes('至少 20 处')), 'quality.minEvidence 应生效')
console.log('quality 阈值 nested =', strictResult.warnings.join(' / '))

// 4) 兼容扁平点号键 quality.minEvidence。
const flat = boot({ 'quality.minEvidence': 20 })
const flatResult = await flat.execute({ content: normalReport, date: '2026-11-23', push: false }, {})
assert.ok(flatResult.warnings.some(item => item.includes('至少 20 处')), '扁平 quality.minEvidence 应生效')
console.log('quality 阈值 flat =', flatResult.warnings.join(' / '))

console.log('quality 测试 = 通过')
