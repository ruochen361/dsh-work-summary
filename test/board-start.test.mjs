// 只测客户端「开工」的纯逻辑：不启浏览器，用假 React 取到 factory 的 __test。
import assert from 'node:assert/strict'

let spec = null
globalThis.window = {
  __ModuleLoader__: {
    load(value) { spec = value },
  },
}
const fakeReact = {
  createElement() { return null },
  useState(value) { return [value, () => {}] },
  useEffect() {},
  useCallback(fn) { return fn },
}
await import('../client.js?board-start')
assert.ok(spec && typeof spec.factory === 'function', 'client.js 应通过 __ModuleLoader__.load 注册 factory')
const exports = spec.factory(name => (name === 'react' ? fakeReact : {}))
const { activeWorkspace, boardStartPrompt, startBoardTask } = exports.__test

const item = {
  title: '补齐热力图空态',
  date: '2026-11-25',
  priority: 'P1',
  due: '2026-11-30',
  detail: '空格子也要有提示',
  source: '日报-2026-11-25.md',
  fingerprint: '#h12345678',
}

const prompt = boardStartPrompt(item)
for (const expected of ['看板待办：补齐热力图空态', '优先级：P1', '截止日：2026-11-30', '详情：空格子也要有提示', '来源：日报-2026-11-25.md', '看板指纹：#h12345678', '标记为已完成']) {
  assert.ok(prompt.includes(expected), `首条任务应包含「${expected}」`)
}
console.log('开工提示词 = 通过')

const workspaces = {
  list: {
    getSnapshot: () => ({
      items: [
        { workspaceId: 'w1', title: '插件', path: 'C:\\work\\plugin', sessionIds: ['s1'] },
        { workspaceId: 'w2', title: '文档', path: 'C:\\work\\docs', sessionIds: ['s2'] },
      ],
    }),
  },
}
const ui = {
  mainReference: { sessionId: 's2' },
  selection: { getSnapshot: () => ({ sessionId: 's2' }) },
}
const ctx = {
  get(name) {
    if (name === 'workspaces') return workspaces
    if (name === 'uiWorkspace') return ui
    return null
  },
}
assert.equal(activeWorkspace(ctx).workspaceId, 'w2', '优先取当前会话所属工作区')
ui.mainReference.sessionId = 's9'
assert.equal(activeWorkspace(ctx).workspaceId, 'w1', '找不到归属时退回第一个工作区')
workspaces.list.getSnapshot = () => ({ items: [] })
assert.equal(activeWorkspace(ctx), null, '没有工作区时返回 null')
console.log('当前工作区选择 = 通过')

const calls = []
workspaces.list.getSnapshot = () => ({ items: [{ workspaceId: 'w1', title: '插件', path: 'C:\\work\\plugin', sessionIds: [] }] })
ui.mainReference.sessionId = undefined
ui.selection.getSnapshot = () => ({ sessionId: undefined })
const sessions = {
  async create(options) {
    calls.push(['create', options])
    return 's9'
  },
  async using(id, options, operation) {
    calls.push(['using', id, options])
    return operation({
      binding: {
        session: {
          async prompt(content, mode) {
            calls.push(['prompt', content, mode])
            return { ok: true, value: { accepted: true } }
          },
        },
      },
    })
  },
}
ctx.get = name => {
  if (name === 'workspaces') return workspaces
  if (name === 'uiWorkspace') return ui
  if (name === 'sessions') return sessions
  return null
}
ui.openSession = id => calls.push(['open', id])

const result = await startBoardTask(ctx, item)
assert.equal(result.sessionId, 's9')
assert.deepEqual(calls[0], ['create', { workspaceId: 'w1' }])
assert.deepEqual(calls[1], ['using', 's9', { source: 'controllerOperation' }])
assert.equal(calls[2][0], 'prompt')
assert.equal(calls[2][2], 'queue')
assert.equal(calls[2][1][0].type, 'text')
assert.ok(calls[2][1][0].text.includes('看板待办：补齐热力图空态'))
assert.deepEqual(calls[3], ['open', 's9'])
console.log('新建会话并发送首条任务 = 通过')

sessions.using = async (id, options, operation) => operation({
  binding: { session: { async prompt() { return { ok: false, error: { message: '额度不足' } } } } },
})
const beforeFail = calls.length
await assert.rejects(() => startBoardTask(ctx, item), /额度不足/)
assert.ok(!calls.slice(beforeFail).some(call => call[0] === 'open'), '发送失败时不应切走当前页面')
console.log('拒绝原因透出 = 通过')

workspaces.list.getSnapshot = () => ({ items: [] })
await assert.rejects(() => startBoardTask(ctx, item), /还没有工作区/)
console.log('无工作区拒绝 = 通过')
