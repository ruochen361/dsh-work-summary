// 只测客户端统计页的纯逻辑：趋势补零、看板交付计数，不启浏览器。
import assert from 'node:assert/strict'

let spec = null
globalThis.window = {
  __ModuleLoader__: {
    load(value) { spec = value },
  },
}
const fakeReact = {
  createElement(type, props, ...children) {
    const input = { ...(props || {}), children: children.length <= 1 ? children[0] : children }
    return typeof type === 'function' ? type(input) : { type, props: input }
  },
  useState(value) { return [value, () => {}] },
  useEffect() {},
  useCallback(fn) { return fn },
}
await import('../client.js?stats')
assert.ok(spec && typeof spec.factory === 'function', 'client.js 应通过 __ModuleLoader__.load 注册 factory')
const exports = spec.factory(name => (name === 'react' ? fakeReact : {}))
const { buildTrend, boardStats, StatsView, MainlinePanel } = exports.__test

const state = {
  today: '2026-11-26',
  reports: [
    { date: '2026-11-25', outputs: 12, lines: 64 },
    { date: '2026-11-24', outputs: 3, lines: 28 },
    { date: '2026-11-20', outputs: 0, lines: 40 },
  ],
  board: {
    text: [
      '## 待办',
      '- [ ] 2026-11-25 ｜ 补测试 ｜ 来源：日报-2026-11-25.md ｜ #h12345678 ｜ @P1 ｜ !2026-11-30',
      '  - 详情：给统计页补纯函数测试',
      '## 进行中',
      '- [ ] 2026-11-24 ｜ 改页面 ｜ 来源：日报-2026-11-24.md ｜ #h23456789',
      '## 已完成',
      '- [x] 2026-11-23 ｜ 写文档（完成 2026-11-24）',
      '## 已放弃',
      '- ⛔ 2026-11-22 ｜ 旧方案（放弃 2026-11-23）',
    ].join('\n'),
  },
}

const trend = buildTrend(state, 7)
assert.equal(trend.points.length, 7, '7 天趋势应有 7 个点')
assert.equal(trend.start, '2026-11-20', '7 天窗口应从今天往前数 6 天')
assert.equal(trend.points[0].date, '2026-11-20')
assert.equal(trend.points[6].date, '2026-11-26')
assert.equal(trend.points[4].outputs, 3, '11-24 的产出应被取到')
assert.equal(trend.points[5].outputs, 12, '11-25 的产出应被取到')
assert.equal(trend.points[6].hasReport, false, '今天没有日报时应补 0')
assert.equal(trend.total, 15, '窗口内产出合计应为 15')
assert.equal(trend.covered, 3, '窗口内有日报的天数应为 3')
assert.equal(trend.max, 12, '纵轴最大值为 12')
assert.ok(Math.abs(trend.average[6] - 15 / 7) < 1e-9, '最后一天 7 日均值应为 15/7')
console.log('产出趋势补零与均值 = 通过')

const month = buildTrend(state)
assert.equal(month.points.length, 30, '默认趋势窗口为 30 天')
assert.equal(month.start, '2026-10-28', '30 天窗口起始日应为 2026-10-28')
console.log('趋势默认窗口 = 通过')

const delivery = boardStats(state)
assert.deepEqual(delivery.counts, { todo: 1, doing: 1, done: 1, drop: 1 })
assert.equal(delivery.total, 4)
assert.equal(delivery.open, 2)
assert.equal(delivery.doneRate, 25)
assert.equal(delivery.dropRate, 25)
assert.equal(delivery.closedRate, 50)
console.log('看板交付结构 = 通过')

const empty = boardStats({ board: { text: '' } })
assert.equal(empty.total, 0)
assert.equal(empty.open, 0)
assert.equal(empty.doneRate, 0)
assert.equal(empty.dropRate, 0)
console.log('空看板交付结构 = 通过')

const rendered = StatsView({ state, onOpen() {} })
assert.ok(rendered, '统计页应能渲染出树')
const emptyView = StatsView({ state: { ...state, reports: [] }, onOpen() {} })
assert.ok(emptyView, '没有日报时应渲染空态而不是抛错')
const noBoard = StatsView({ state: { ...state, board: { text: '' } }, onOpen() {} })
assert.ok(noBoard, '有日报但空看板时应渲染趋势而不是除零')
console.log('统计页渲染冒烟 = 通过')

// 主线面板：只列未清，受阻在前，完成的不掺进来。
const collectText = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join(' ')
  return collectText(node.props && node.props.children)
}
const panel = MainlinePanel({
  today: '2026-11-27',
  mainlines: [
    { id: 'M-2026-11-25-01', title: '日报主线面板', workspace: 'F:\\dsh_plugins\\dsh-work-summary', status: '受阻', lastOutput: '2026-11-20', stallDays: 7 },
    { id: 'M-2026-11-24-02', title: '周期聚合', workspace: 'F:\\novel', status: '进行中', lastOutput: '2026-11-26', stallDays: 1 },
    { id: 'M-2026-11-20-03', title: '已收尾的交付', workspace: 'F:\\novel', status: '完成', lastOutput: '2026-11-20', stallDays: 7 },
  ],
})
const panelText = collectText(panel)
assert.match(panelText, /未清 2 条 \/ 共 3 条/, '只数未清主线')
assert.match(panelText, /日报主线面板/)
assert.ok(panelText.indexOf('日报主线面板') < panelText.indexOf('周期聚合'), '受阻应排在前面')
assert.doesNotMatch(panelText, /已收尾的交付/, '完成的主线不列在面板里')
const emptyPanel = collectText(MainlinePanel({ today: '2026-11-27', mainlines: [] }))
assert.match(emptyPanel, /_主线\.md/, '没有账本时提示怎么生成')
console.log('主线面板渲染 = 通过')
