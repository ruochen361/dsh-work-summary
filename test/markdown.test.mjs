// 只测客户端正文渲染的表格分支：表头/分隔行/数据行合成 <table>，不启浏览器。
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
await import('../client.js?markdown')
assert.ok(spec && typeof spec.factory === 'function', 'client.js 应通过 __ModuleLoader__.load 注册 factory')
const exports = spec.factory(name => (name === 'react' ? fakeReact : {}))
const { renderMarkdown } = exports.__test
assert.equal(typeof renderMarkdown, 'function', '__test 应暴露 renderMarkdown')

// 把渲染树摊平成文本，便于断言单元格内容。
function textOf(node) {
  if (node === null || node === undefined || typeof node !== 'object') return String(node ?? '')
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props.children)
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    node.forEach(child => findAll(child, predicate, out))
    return out
  }
  if (typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  findAll(node.props.children, predicate, out)
  return out
}

const doc = [
  '## 三、结果与产出',
  '',
  '| 产出物 | 路径 | 状态 | 说明 |',
  '| --- | --- | --- | --- |',
  '| 表格渲染 | `client.js` | 完成 | 连续行合成一张表 |',
  '| 覆盖测试 | `test/markdown.test.mjs` | 完成 | 对齐与裁剪 |',
  '',
  '结尾段落。',
].join('\n')

const tree = renderMarkdown(doc)
const tables = findAll(tree, node => node.type === 'table')
assert.equal(tables.length, 1, '表头 + 分隔行 + 数据行应渲染成一张表')
const table = tables[0]
assert.deepEqual(findAll(table, node => node.type === 'th').map(textOf), ['产出物', '路径', '状态', '说明'])
const cells = findAll(table, node => node.type === 'td')
assert.equal(cells.length, 8, '两行数据各四列')
assert.equal(textOf(cells[0]), '表格渲染')
assert.equal(textOf(cells[1]), 'client.js', '单元格里的行内代码应还原成文本')
assert.ok(textOf(tree).includes('结尾段落。'), '表格后面的普通段落仍要渲染')
assert.equal(
  findAll(tree, node => node.type === 'div' && node.props.style && node.props.style.whiteSpace === 'pre-wrap').length,
  0,
  '合成表格后不应再有原始竖线文本',
)
console.log('表格合成 = 通过')

const aligned = renderMarkdown([
  '| 左 | 右 | 中 |',
  '| :--- | ---: | :---: |',
  '| a | b | c |',
].join('\n'))
const heads = findAll(aligned, node => node.type === 'th')
assert.deepEqual(heads.map(node => node.props.style.textAlign), ['left', 'right', 'center'])
console.log('表格对齐 = 通过')

const ragged = renderMarkdown([
  '| a | b |',
  '| --- | --- | --- |',
  '| 1 |',
  '| 1 | 2 | 3 |',
].join('\n'))
const raggedCells = findAll(ragged, node => node.type === 'td')
assert.equal(raggedCells.length, 6, '列数以分隔行为准，过短补空、过长截断')
assert.equal(textOf(raggedCells[1]), '', '缺列的数据行补空单元格')
assert.equal(textOf(raggedCells[4]), '2')
console.log('表格列裁剪 = 通过')

const escaped = renderMarkdown(['| a \\| b | c |', '| --- | --- |', '| 1 | 2 |'].join('\n'))
const escapedHead = findAll(escaped, node => node.type === 'th')
assert.deepEqual(escapedHead.map(textOf), ['a | b', 'c'], '转义竖线应留在单元格内')
console.log('表格转义竖线 = 通过')

const plain = renderMarkdown(['| 没有分隔行 |', '普通一行'].join('\n'))
assert.equal(findAll(plain, node => node.type === 'table').length, 0, '没有分隔行就不当表格')
assert.equal(
  findAll(plain, node => node.type === 'div' && node.props.style && node.props.style.whiteSpace === 'pre-wrap').length,
  1,
  '落单的竖线行退回等宽纯文本',
)
console.log('非表格竖线行 = 通过')

const nested = renderMarkdown(['说明：不是表头，只是一句话', '| --- | --- |'].join('\n'))
assert.equal(findAll(nested, node => node.type === 'table').length, 0, '没有竖线的普通行不当表头')
console.log('表格表头判定 = 通过')

const bare = renderMarkdown(['产出物 | 路径', '--- | ---', 'a | b'].join('\n'))
assert.equal(findAll(bare, node => node.type === 'table').length, 1, '省略首尾竖线的表格也要认出来')
assert.deepEqual(findAll(bare, node => node.type === 'th').map(textOf), ['产出物', '路径'])
console.log('省略首尾竖线 = 通过')

const rule = renderMarkdown(['a | b', '---', 'c'].join('\n'))
assert.equal(findAll(rule, node => node.type === 'table').length, 0, '`---` 是分隔线，不是表格分隔行')
assert.equal(findAll(rule, node => node.type === 'hr').length, 1)
console.log('分隔线与表格区分 = 通过')

const compact = renderMarkdown(['| 产出物 | 路径 |', '|---|---|', '| a | b |'].join('\n'))
assert.equal(findAll(compact, node => node.type === 'th').length, 2, '`|---|---|` 这种紧凑分隔行要认成表格')
assert.equal(findAll(compact, node => node.type === 'td').length, 2)
console.log('紧凑分隔行 = 通过')
