window.__ModuleLoader__.load({
  id: 'dsh-work-summary',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React
    // apply(ctx) 里保存，供「开工」按钮新建会话、发送首条任务。
    let appCtx = null

    const PANEL_ID = 'dsh-work-summary'
    const ENDPOINT = '/dsh-work-summary/state'
    const SCHEDULE_ENDPOINT = '/dsh-work-summary/schedule'
    const BOARD_ENDPOINT = '/dsh-work-summary/board'
    // 4 档活跃度；0 档（无日报）用虚线边框表示，不占颜色。
    const HEAT_COLORS = [
      'rgba(47,158,68,.22)',
      'rgba(47,158,68,.44)',
      'rgba(47,158,68,.68)',
      'rgba(47,158,68,.95)',
    ]
    const DAY_MS = 86400000
    // 热力图格子随窗口放大，窄屏收回到 20px，宽屏最大 50px。
    const HEAT_CELL = 'clamp(20px, 4.6vw, 50px)'
    const HEAT_GAP = 6
    const DELIVERY_COLORS = {
      done: '#2f9e44',
      doing: '#1971c2',
      todo: '#d9480f',
      drop: '#868e96',
    }

    const S = {
      page: {
        boxSizing: 'border-box',
        height: '100%',
        overflow: 'auto',
        padding: '24px 32px 48px',
        marginTop: 'var(--dsh-frame-top-clearance, 0px)',
        color: 'inherit',
        fontSize: 14,
        lineHeight: 1.65,
      },
      bar: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' },
      title: { fontSize: 20, fontWeight: 600, margin: 0 },
      tabs: { display: 'flex', gap: 4, marginLeft: 'auto' },
      tab: (active) => ({
        border: '1px solid rgba(127,127,127,.28)',
        background: active ? 'rgba(127,127,127,.16)' : 'transparent',
        color: 'inherit',
        borderRadius: 8,
        padding: '5px 12px',
        fontSize: 13,
        cursor: 'pointer',
      }),
      ghost: {
        border: '1px solid rgba(127,127,127,.28)', background: 'transparent', color: 'inherit',
        borderRadius: 8, padding: '5px 12px', fontSize: 13, cursor: 'pointer',
      },
      muted: { opacity: 0.62, fontSize: 12 },
      split: { display: 'flex', gap: 20, alignItems: 'flex-start' },
      list: {
        flex: '0 0 176px', display: 'flex', flexDirection: 'column', gap: 2,
        maxHeight: 'calc(100vh - 200px)', overflow: 'auto', paddingRight: 4,
      },
      item: (active) => ({
        textAlign: 'left', border: 'none', borderRadius: 8, cursor: 'pointer', color: 'inherit',
        background: active ? 'rgba(99,155,255,.16)' : 'transparent',
        fontWeight: active ? 600 : 400, padding: '6px 10px', fontSize: 13, display: 'block', width: '100%',
      }),
      doc: { flex: 1, minWidth: 0, maxWidth: 860 },
      heading: { fontWeight: 600, margin: '18px 0 6px' },
      para: { margin: '4px 0' },
      bullet: { margin: '3px 0', paddingLeft: 4 },
      tableWrap: { margin: '8px 0 12px', overflowX: 'auto' },
      table: { borderCollapse: 'collapse', borderSpacing: 0, width: '100%', fontSize: 13, lineHeight: 1.55 },
      th: {
        padding: '5px 10px', borderBottom: '1px solid rgba(127,127,127,.38)',
        background: 'rgba(127,127,127,.1)', fontWeight: 600, whiteSpace: 'nowrap',
      },
      td: { padding: '5px 10px', borderBottom: '1px solid rgba(127,127,127,.16)', verticalAlign: 'top' },
      tableRaw: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12.5, whiteSpace: 'pre-wrap' },
      summaryPanel: {
        margin: '0 0 16px', border: '1px solid rgba(127,127,127,.22)', borderRadius: 10, padding: '12px 14px',
      },
      summaryHead: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 6 },
      summaryTitle: { fontSize: 15, fontWeight: 600 },
      summaryTable: { borderCollapse: 'collapse', width: '100%', fontSize: 12.5, lineHeight: 1.5 },
      summaryTh: {
        padding: '4px 8px', textAlign: 'left', fontWeight: 600, opacity: 0.68, whiteSpace: 'nowrap',
        borderBottom: '1px solid rgba(127,127,127,.3)',
      },
      summaryTd: { padding: '4px 8px', borderBottom: '1px solid rgba(127,127,127,.12)', verticalAlign: 'top' },
      statusChip: (status) => ({
        display: 'inline-block', padding: '0 6px', borderRadius: 5, fontSize: 11, lineHeight: '18px', whiteSpace: 'nowrap',
        color: status === '受阻' ? '#d14343' : status === '完成' ? '#2f9e44' : status === '放弃' ? 'inherit' : '#1971c2',
        background: status === '受阻' ? 'rgba(209,67,67,.12)' : status === '完成' ? 'rgba(47,158,68,.12)' : 'rgba(127,127,127,.14)',
      }),
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12.5, background: 'rgba(127,127,127,.14)', padding: '1px 4px', borderRadius: 4 },
      quote: { margin: '6px 0', paddingLeft: 10, borderLeft: '3px solid rgba(127,127,127,.3)', opacity: 0.8 },
      hr: { border: 'none', borderTop: '1px solid rgba(127,127,127,.24)', margin: '14px 0' },
      section: { marginBottom: 22 },
      boardHead: { fontSize: 15, fontWeight: 600, margin: '0 0 8px' },
      row: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '5px 0' },
      dot: (open) => ({
        flex: '0 0 auto', width: 13, height: 13, borderRadius: 3, marginTop: 4,
        border: '1.5px solid rgba(127,127,127,.6)',
        background: open ? 'transparent' : 'rgba(127,127,127,.55)',
      }),
      boardItem: { flex: 1, minWidth: 0 },
      boardGroup: { marginBottom: 12 },
      boardGroupHead: { fontSize: 12.5, fontWeight: 600, opacity: 0.72, margin: '10px 0 2px' },
      boardBadge: (kind) => ({
        display: 'inline-block', marginLeft: 6, padding: '0 5px', borderRadius: 5, fontSize: 11,
        lineHeight: '18px', whiteSpace: 'nowrap',
        color: kind === 'overdue' ? '#d14343' : kind === 'P1' ? '#d9480f' : kind === 'P2' ? '#1971c2' : kind === 'P3' ? '#5f3dc4' : 'inherit',
        background: kind === 'overdue' ? 'rgba(209,67,67,.12)' : 'rgba(127,127,127,.14)',
      }),
      boardControls: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' },
      boardSelect: {
        border: '1px solid rgba(127,127,127,.3)', background: 'transparent', color: 'inherit',
        borderRadius: 8, padding: '2px 4px', fontSize: 12, fontFamily: 'inherit',
      },
      boardDate: {
        border: '1px solid rgba(127,127,127,.3)', background: 'transparent', color: 'inherit',
        borderRadius: 8, padding: '2px 4px', fontSize: 12, fontFamily: 'inherit', width: 125,
      },
      boardHint: { fontSize: 12, opacity: 0.62, margin: '0 0 14px', maxWidth: 760 },
      boardStart: {
        border: '1px solid rgba(47,158,68,.45)', background: 'rgba(47,158,68,.12)', color: 'inherit',
        borderRadius: 8, padding: '2px 9px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
      },
      empty: { opacity: 0.6, padding: '24px 0' },
      heatCount: { fontSize: 13.5, opacity: 0.75, margin: '0 0 16px' },
      heatScroll: { width: '100%', overflowX: 'auto' },
      heatGrid: { display: 'flex', gap: 12, alignItems: 'flex-start', width: 'max-content', margin: '0 auto' },
      heatWeekdays: { display: 'flex', flexDirection: 'column', gap: HEAT_GAP, paddingTop: 22 },
      heatWeekday: {
        width: 20, height: HEAT_CELL, lineHeight: HEAT_CELL,
        textAlign: 'right', fontSize: 10.5, opacity: 0.55,
      },
      heatBody: { display: 'flex', flexDirection: 'column', gap: 4 },
      heatMonths: { display: 'flex', gap: HEAT_GAP, height: 18 },
      heatMonth: {
        flexGrow: 0, flexShrink: 0, flexBasis: HEAT_CELL, width: HEAT_CELL,
        fontSize: 11, lineHeight: '18px', opacity: 0.55, whiteSpace: 'nowrap',
      },
      heatWeeks: { display: 'flex', gap: HEAT_GAP },
      heatWeek: { display: 'flex', flexDirection: 'column', gap: HEAT_GAP },
      heatCell: (level, future) => ({
        boxSizing: 'border-box', width: HEAT_CELL, height: HEAT_CELL, padding: 0, borderRadius: 4,
        border: level > 0 ? '1px solid transparent' : '1px solid rgba(127,127,127,.28)',
        background: level > 0 ? HEAT_COLORS[level - 1] : 'transparent',
        cursor: future ? 'default' : 'pointer',
        opacity: future ? 0.35 : 1,
      }),
      heatLegend: {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 8, marginTop: 18, fontSize: 13, opacity: 0.8, flexWrap: 'wrap',
      },
      heatSwatch: (level) => ({
        width: 16, height: 16, borderRadius: 3, display: 'inline-block',
        border: level > 0 ? '1px solid transparent' : '1px solid rgba(127,127,127,.28)',
        background: level > 0 ? HEAT_COLORS[level - 1] : 'transparent',
      }),
      heatNotice: { marginTop: 14, fontSize: 13.5, opacity: 0.8 },
      statsPage: { width: '100%', maxWidth: 1120, margin: '0 auto' },
      statsPanel: {
        border: '1px solid rgba(127,127,127,.18)', borderRadius: 14,
        background: 'rgba(127,127,127,.035)', padding: '18px 20px 20px',
      },
      statsPanelHead: {
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: 14, flexWrap: 'wrap', marginBottom: 14,
      },
      statsPanelTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 3px' },
      statsPanelHint: { fontSize: 12.5, opacity: 0.68, margin: 0 },
      statsCoverage: {
        flex: '0 0 auto', borderRadius: 999, padding: '1px 10px',
        background: 'rgba(47,158,68,.12)', color: '#2f9e44',
        fontSize: 12, lineHeight: '22px', whiteSpace: 'nowrap',
      },
      statsGrid: {
        display: 'flex', flexWrap: 'wrap', alignItems: 'stretch',
        gap: 18, marginTop: 18,
      },
      statCard: {
        display: 'flex', flexDirection: 'column', flex: '1 1 340px',
        minWidth: 'min(100%, 320px)', minHeight: 0,
        border: '1px solid rgba(127,127,127,.22)', borderRadius: 12,
        background: 'rgba(127,127,127,.02)', padding: '16px 18px 18px',
      },
      statCardWide: { flex: '1.6 1 560px' },
      statCardHead: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 10, marginBottom: 2,
      },
      statTitle: { fontSize: 14.5, fontWeight: 600, margin: 0 },
      statPill: {
        flex: '0 0 auto', borderRadius: 999, padding: '0 8px',
        background: 'rgba(127,127,127,.12)', opacity: 0.8,
        fontSize: 11.5, lineHeight: '20px', whiteSpace: 'nowrap',
      },
      statHint: { fontSize: 12, opacity: 0.62, margin: '0 0 10px' },
      statNote: { fontSize: 11.5, opacity: 0.55, marginTop: 10 },
      trendChart: { width: '100%', minWidth: 0 },
      trendPlot: { position: 'relative', height: 160, marginTop: 4 },
      trendGrid: {
        position: 'absolute', top: 0, bottom: 0, left: 24, right: 4,
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between', pointerEvents: 'none',
      },
      trendGridLine: { borderTop: '1px solid rgba(127,127,127,.14)' },
      trendBars: {
        position: 'absolute', top: 0, bottom: 0, left: 24, right: 4,
        display: 'flex', alignItems: 'flex-end', gap: 2,
      },
      trendBarWrap: { flex: '1 1 0', height: '100%', display: 'flex', alignItems: 'flex-end', minWidth: 0 },
      trendBar: { width: '100%', borderRadius: '2px 2px 0 0' },
      trendLine: {
        position: 'absolute', top: 0, left: 24, width: 'calc(100% - 28px)',
        height: '100%', overflow: 'visible', pointerEvents: 'none',
      },
      trendMax: { position: 'absolute', left: 0, top: -3, fontSize: 10, opacity: 0.5 },
      trendZero: { position: 'absolute', left: 0, bottom: -3, fontSize: 10, opacity: 0.5 },
      trendAxis: {
        display: 'flex', justifyContent: 'space-between',
        margin: '4px 4px 0 24px', fontSize: 10.5, opacity: 0.55,
      },
      statLegend: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 14px', marginTop: 8, fontSize: 12, opacity: 0.72 },
      statKey: { display: 'inline-flex', alignItems: 'center', gap: 5 },
      statSwatch: (color) => ({ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }),
      deliveryBody: { display: 'flex', flexDirection: 'column', flex: 1 },
      deliveryBar: {
        display: 'flex', width: '100%', height: 26, borderRadius: 7, overflow: 'hidden',
        background: 'rgba(127,127,127,.12)', margin: '6px 0 12px',
      },
      deliveryLegend: { display: 'flex', flexWrap: 'wrap', gap: '7px 14px', fontSize: 12.5 },
      deliveryItem: { display: 'inline-flex', alignItems: 'center', gap: 6 },
      deliveryDot: (color) => ({ width: 9, height: 9, borderRadius: 2, background: color, display: 'inline-block' }),
      statKpis: {
        display: 'flex', flexWrap: 'wrap', gap: '14px 28px',
        marginTop: 'auto', paddingTop: 14, borderTop: '1px solid rgba(127,127,127,.14)',
      },
      statKpi: { display: 'flex', flexDirection: 'column', gap: 1 },
      statKpiValue: { fontSize: 21, fontWeight: 600, lineHeight: 1.15 },
      statKpiLabel: { fontSize: 11.5, opacity: 0.6 },
      error: { color: '#d14343', margin: '12px 0', whiteSpace: 'pre-wrap' },
      notice: { color: '#2f9e44', fontSize: 13 },
      field: { display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0' },
      label: { width: 88, opacity: 0.75, fontSize: 13 },
      input: {
        border: '1px solid rgba(127,127,127,.3)', background: 'transparent', color: 'inherit',
        borderRadius: 8, padding: '5px 8px', fontSize: 13, fontFamily: 'inherit',
      },
      hint: { opacity: 0.62, fontSize: 12, lineHeight: 1.7, marginTop: 20, maxWidth: 620 },
    }

    function inline(text) {
      const out = []
      const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
      let last = 0
      let match
      let key = 0
      while ((match = re.exec(text)) !== null) {
        if (match.index > last) out.push(text.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) out.push(h('strong', { key: `b${key++}` }, token.slice(2, -2)))
        else out.push(h('code', { key: `c${key++}`, style: S.code }, token.slice(1, -1)))
        last = match.index + token.length
      }
      if (last < text.length) out.push(text.slice(last))
      return out.length === 0 ? text : out
    }

    // 拆一行表格：去掉首尾竖线，`\|` 按字面竖线处理，单元格去空白。
    function splitRow(line) {
      const text = String(line).trim().replace(/^\|/, '').replace(/\|$/, '')
      const cells = []
      let cell = ''
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (ch === '\\' && text[i + 1] === '|') {
          cell += '|'
          i += 1
          continue
        }
        if (ch === '|') {
          cells.push(cell.trim())
          cell = ''
          continue
        }
        cell += ch
      }
      cells.push(cell.trim())
      return cells
    }

    // 分隔行：|---|:--:|---，每格只允许冒号与短横，且必须带竖线（`---` 是分隔线不是表格）。
    function isTableSeparator(line) {
      const text = String(line).trim()
      if (!text.includes('-') || !text.includes('|')) return false
      return splitRow(text).every(cell => /^:?-{1,}:?$/.test(cell))
    }

    // 可能的表格行：以竖线开头 / 结尾，或含分隔竖线的多列文本；否则返回 null。
    function tableRowCells(line) {
      const text = String(line).trim()
      if (!text.includes('|')) return null
      const cells = splitRow(text)
      if (cells.length >= 2) return cells
      return text.startsWith('|') || text.endsWith('|') ? cells : null
    }

    // `:--` 左对齐、`--:` 右对齐、`:-:` 居中；默认左对齐。
    function columnAligns(separator) {
      return splitRow(separator).map(cell => {
        const left = cell.startsWith(':')
        const right = cell.endsWith(':')
        return left && right ? 'center' : right ? 'right' : 'left'
      })
    }

    // 按表头列数裁剪：多出的格子丢弃，缺少的补空，避免行与列错位。
    function tableCells(row, count) {
      const cells = row.slice(0, count)
      while (cells.length < count) cells.push('')
      return cells
    }

    function renderTable(rows, aligns, key) {
      const count = Math.max(aligns.length, 1)
      const head = tableCells(rows[0] || [], count)
      const body = rows.slice(1).map(row => tableCells(row, count))
      return h('div', { key, style: S.tableWrap },
        h('table', { style: S.table },
          h('thead', null, h('tr', null, head.map((cell, index) => h('th', {
            key: index,
            style: { ...S.th, textAlign: aligns[index] || 'left' },
          }, inline(cell))))),
          body.length > 0
            ? h('tbody', null, body.map((row, rowIndex) => h('tr', { key: rowIndex }, row.map((cell, index) => h('td', {
              key: index,
              style: { ...S.td, textAlign: aligns[index] || 'left' },
            }, inline(cell))))))
            : null,
        ),
      )
    }

    // 正文渲染：表头 + 分隔行 + 连续表格行合成真正的表格，其余逐行按原规则渲染。
    function renderMarkdown(text) {
      const lines = String(text ?? '').split(/\r?\n/)
      const out = []
      let index = 0
      while (index < lines.length) {
        const head = tableRowCells(lines[index])
        if (head && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
          const aligns = columnAligns(lines[index + 1])
          const rows = [head]
          index += 2
          while (index < lines.length) {
            const cells = tableRowCells(lines[index])
            if (!cells || isTableSeparator(lines[index])) break
            rows.push(cells)
            index += 1
          }
          out.push(renderTable(rows, aligns, `table${index}`))
          continue
        }
        out.push(renderLine(lines[index], index))
        index += 1
      }
      return out
    }

    function renderLine(line, index) {
      const text = line.replace(/\s+$/, '')
      const trimmed = text.trim()
      if (trimmed === '') return h('div', { key: index, style: { height: 7 } })
      if (/^(---|\*\*\*)$/.test(trimmed)) return h('hr', { key: index, style: S.hr })
      let match
      if ((match = /^(#{1,4})\s+(.*)$/.exec(trimmed))) {
        const level = match[1].length
        const size = [21, 17, 15.5, 14.5][level - 1]
        return h('div', { key: index, style: { ...S.heading, fontSize: size, marginTop: level === 1 ? 0 : 18 } }, inline(match[2]))
      }
      if ((match = /^[-*]\s+(.*)$/.exec(trimmed))) {
        return h('div', { key: index, style: S.bullet }, '• ', inline(match[1]))
      }
      if ((match = /^(\d+)[.、]\s+(.*)$/.exec(trimmed))) {
        return h('div', { key: index, style: S.bullet }, `${match[1]}. `, inline(match[2]))
      }
      if (trimmed.startsWith('|')) return h('div', { key: index, style: S.tableRaw }, text)
      if (trimmed.startsWith('>')) return h('div', { key: index, style: S.quote }, inline(trimmed.replace(/^>\s?/, '')))
      return h('div', { key: index, style: S.para }, inline(trimmed))
    }

    const BOARD_STATUS = { '待办': 'todo', '进行中': 'doing', '已完成': 'done', '已放弃': 'drop' }

    // 条目格式：日期 ｜ 标题 ｜ 来源：… ｜ #h指纹 ｜ @P1 ｜ !2026-11-30；后两段可省略。
    function parseBoardItem(text) {
      const parts = String(text).split('｜').map(part => part.trim()).filter(Boolean)
      const priorityMatch = /(?:^|\s)@([Pp][1-3])(?=\s|$)/.exec(text)
      const dueMatch = /(?:^|\s)!(\d{4}-\d{2}-\d{2})(?=\s|$)/.exec(text)
      const hashMatch = /#h([0-9a-fA-F]{8})/.exec(text)
      const sourcePart = parts.find(part => /^来源[：:]/.test(part))
      let title = parts.length >= 2 ? parts[1] : (parts[0] || '')
      title = title
        .replace(/(?:^|\s)@[Pp][1-3](?=\s|$)/g, ' ')
        .replace(/(?:^|\s)!\d{4}-\d{2}-\d{2}(?=\s|$)/g, ' ')
        .replace(/（(?:完成|放弃) \d{4}-\d{2}-\d{2}）\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim()
      return {
        open: false,
        title: title || (parts[0] || ''),
        date: /^\d{4}-\d{2}-\d{2}$/.test(parts[0] || '') ? parts[0] : '',
        source: sourcePart ? sourcePart.replace(/^来源[：:]\s*/, '') : '',
        fingerprint: hashMatch ? `#h${hashMatch[1]}` : '',
        priority: priorityMatch ? priorityMatch[1].toUpperCase() : '',
        due: dueMatch ? dueMatch[1] : '',
        detail: '',
      }
    }

    function parseBoard(text) {
      const sections = []
      let current = null
      let last = null
      for (const raw of String(text ?? '').split(/\r?\n/)) {
        const heading = /^##\s+(.+?)\s*$/.exec(raw)
        if (heading) {
          current = { title: heading[1], status: BOARD_STATUS[heading[1]] || 'todo', items: [] }
          sections.push(current)
          last = null
          continue
        }
        const item = /^\s*-\s*(?:\[( |x|X)\]|⛔)\s*(.*)$/.exec(raw)
        if (item && current) {
          const parsed = parseBoardItem(item[2])
          parsed.open = item[1] === ' '
          current.items.push(parsed)
          last = parsed
          continue
        }
        const detail = /^\s{2,}-\s*详情[：:]\s*(.+)$/.exec(raw)
        if (detail && last) last.detail = detail[1].trim()
      }
      return sections.filter(section => section.items.length > 0)
    }

    // 待办/进行中：过期单独一组，其余按 P1/P2/P3/未标注；组内先按截止日，再按日期倒序。
    function boardGroups(items, today) {
      const groups = [
        { key: 'overdue', title: '已过期', items: [] },
        { key: 'P1', title: 'P1', items: [] },
        { key: 'P2', title: 'P2', items: [] },
        { key: 'P3', title: 'P3', items: [] },
        { key: 'none', title: '未标注', items: [] },
      ]
      const byKey = new Map(groups.map(group => [group.key, group]))
      for (const item of items) {
        const overdue = item.open && item.due !== '' && item.due < today
        const key = overdue ? 'overdue' : (item.priority || 'none')
        byKey.get(key).items.push(item)
      }
      for (const group of groups) {
        group.items.sort((a, b) => {
          const dueA = a.due || '9999-99-99'
          const dueB = b.due || '9999-99-99'
          if (dueA !== dueB) return dueA < dueB ? -1 : 1
          return b.date.localeCompare(a.date)
        })
      }
      return groups.filter(group => group.items.length > 0)
    }

    function parseIsoDay(text) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''))
      return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN
    }

    function isoFromMs(ms) {
      const date = new Date(ms)
      const pad = value => String(value).padStart(2, '0')
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    }

    function shiftIsoDay(date, delta) {
      return isoFromMs(parseIsoDay(date) + delta * DAY_MS)
    }

    function mondayOffset(date) {
      return (new Date(parseIsoDay(date)).getUTCDay() + 6) % 7
    }

    function localIsoDay() {
      const now = new Date()
      const pad = value => String(value).padStart(2, '0')
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    }

    // 最近 13 周（周一到周日），按当天热力值在样本里的四分位切成 4 档。
    function buildHeat(state) {
      const reports = state.reports || []
      const byDate = new Map()
      for (const report of reports) byDate.set(report.date, report)
      const today = Number.isFinite(parseIsoDay(state.today)) ? state.today : localIsoDay()
      const start = shiftIsoDay(today, -mondayOffset(today) - 12 * 7)
      const scores = reports
        .filter(report => report.date >= start && report.date <= today)
        .map(report => Number(report.score) || 0)
        .sort((a, b) => a - b)
      const pick = (ratio) => {
        if (scores.length === 0) return 0
        return scores[Math.min(scores.length - 1, Math.floor((scores.length - 1) * ratio))]
      }
      const thresholds = [pick(0.25), pick(0.5), pick(0.75)]
      const levelOf = (score) => {
        if (!(score > 0)) return 0
        let level = 1
        for (const threshold of thresholds) if (score > threshold) level += 1
        return level
      }
      const weeks = []
      let previousMonth = ''
      for (let week = 0; week < 13; week += 1) {
        const days = []
        for (let offset = 0; offset < 7; offset += 1) {
          const date = shiftIsoDay(start, week * 7 + offset)
          const report = byDate.get(date) || null
          days.push({
            date,
            report,
            future: date > today,
            level: report ? levelOf(Number(report.score) || 0) : 0,
          })
        }
        const month = days[0].date.slice(0, 7)
        weeks.push({ days, label: month !== previousMonth ? `${Number(month.slice(5))}月` : '' })
        previousMonth = month
      }
      const days = weeks.flatMap(week => week.days).filter(day => !day.future)
      return {
        today,
        start,
        weeks,
        total: days.length,
        covered: days.filter(day => day.report).length,
      }
    }

    // 最近 N 个自然日，缺日报的日期补 0，避免趋势把空档“连”起来。
    function buildTrend(state, days = 30) {
      const count = Math.max(7, Math.min(91, Math.floor(Number(days) || 30)))
      const reports = state.reports || []
      const byDate = new Map()
      for (const report of reports) byDate.set(report.date, report)
      const today = Number.isFinite(parseIsoDay(state.today)) ? state.today : localIsoDay()
      const start = shiftIsoDay(today, -(count - 1))
      const points = []
      for (let index = 0; index < count; index += 1) {
        const date = shiftIsoDay(start, index)
        const report = byDate.get(date) || null
        points.push({
          date,
          outputs: report ? Number(report.outputs) || 0 : 0,
          lines: report ? Number(report.lines) || 0 : 0,
          hasReport: Boolean(report),
        })
      }
      const values = points.map(point => point.outputs)
      const max = Math.max(2, Math.ceil(Math.max(1, ...values) / 2) * 2)
      const average = points.map((point, index) => {
        const window = values.slice(Math.max(0, index - 6), index + 1)
        return window.reduce((sum, value) => sum + value, 0) / window.length
      })
      return {
        start,
        today,
        points,
        max,
        average,
        total: values.reduce((sum, value) => sum + value, 0),
        covered: points.filter(point => point.hasReport).length,
      }
    }

    function boardStats(state) {
      const sections = parseBoard(state && state.board ? state.board.text : '')
      const counts = { todo: 0, doing: 0, done: 0, drop: 0 }
      for (const section of sections) {
        if (section.status in counts) counts[section.status] += section.items.length
      }
      const total = counts.todo + counts.doing + counts.done + counts.drop
      const rate = value => (total > 0 ? Math.round((value / total) * 100) : 0)
      return {
        counts,
        total,
        open: counts.todo + counts.doing,
        doneRate: rate(counts.done),
        dropRate: rate(counts.drop),
        closedRate: rate(counts.done + counts.drop),
      }
    }

    function Icon(props) {
      const size = (props && props.size) || 16
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
        h('rect', { x: 3, y: 2, width: 10, height: 12, rx: 1.5 }),
        h('path', { d: 'M5.5 5.5h5M5.5 8h5M5.5 10.5h3' }),
      )
    }

    /** 工作区路径取末级目录做短标签，完整路径放在 title 里。 */
    function workspaceLeaf(path) {
      const text = String(path || '').replace(/[\\/]+$/, '')
      const parts = text.split(/[\\/]/)
      return parts[parts.length - 1] || text || '（未标注）'
    }

    /** 日报页顶部的主线面板：只读 `_主线.md` 账本，先列未清，受阻排前面。 */
    function MainlinePanel({ mainlines, today }) {
      const all = mainlines || []
      const open = all.filter(item => item.status !== '完成' && item.status !== '放弃')
      if (all.length === 0) {
        return h('div', { style: S.summaryPanel },
          h('div', { style: S.summaryHead }, h('span', { style: S.summaryTitle }, '主线')),
          h('div', { style: S.muted },
            '还没有主线记录：日报里用 #### M-YYYY-MM-DD-NN 标题 标记后，保存时会自动记到 _主线.md。'),
        )
      }
      const rank = { 受阻: 0, 进行中: 1, 完成: 2, 放弃: 3 }
      const rows = open.slice().sort((a, b) => {
        const byStatus = (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
        return byStatus !== 0 ? byStatus : String(b.lastOutput || '').localeCompare(String(a.lastOutput || ''))
      })
      return h('div', { style: S.summaryPanel },
        h('div', { style: S.summaryHead },
          h('span', { style: S.summaryTitle }, '主线'),
          h('span', { style: S.muted }, `未清 ${open.length} 条 / 共 ${all.length} 条 · 截至 ${today}`),
        ),
        rows.length === 0
          ? h('div', { style: S.muted }, '所有主线都已收尾。')
          : h('div', { style: { overflowX: 'auto' } },
            h('table', { style: S.summaryTable },
              h('thead', null, h('tr', null,
                ['主线', '工作区', '状态', '最近产出', '挂起'].map(label => h('th', { key: label, style: S.summaryTh }, label)))),
              h('tbody', null, rows.map(item => h('tr', { key: item.id },
                h('td', { style: S.summaryTd },
                  h('div', { style: { fontWeight: 600 } }, item.title),
                  h('div', { style: S.muted }, item.id)),
                h('td', { style: S.summaryTd, title: item.workspace || '' }, workspaceLeaf(item.workspace)),
                h('td', { style: S.summaryTd }, h('span', { style: S.statusChip(item.status) }, item.status)),
                h('td', { style: S.summaryTd }, item.lastOutput || '—'),
                h('td', { style: S.summaryTd }, item.stallDays ? `${item.stallDays} 天` : '—'),
              )))),
          ),
      )
    }

    function ReportsView({ state, focus, onFocusDone }) {
      const reports = state.reports || []
      const [selected, setSelected] = useState(reports.length > 0 ? reports[0].file : null)
      useEffect(() => {
        if (!reports.some(report => report.file === selected)) setSelected(reports.length > 0 ? reports[0].file : null)
      }, [reports, selected])
      useEffect(() => {
        if (!focus) return
        const target = reports.find(report => report.date === focus)
        if (target) setSelected(target.file)
        onFocusDone()
      }, [focus, reports, onFocusDone])
      const current = reports.find(report => report.file === selected)
      if (reports.length === 0) {
        return h('div', null,
          h(MainlinePanel, { mainlines: state.mainlines, today: state.today }),
          h('div', { style: S.empty }, '这个目录里还没有日报。'),
        )
      }
      return h('div', null,
        h(MainlinePanel, { mainlines: state.mainlines, today: state.today }),
        h('div', { style: S.split },
          h('div', { style: S.list }, reports.map(report => h('button', {
            key: report.file,
            type: 'button',
            onClick: () => setSelected(report.file),
            style: S.item(report.file === selected),
            title: `${report.file} · ${Math.round(report.size / 102.4) / 10} KB`,
          }, report.date))),
          h('div', { style: S.doc },
            current
              ? [
                h('div', { key: 'meta', style: S.muted },
                  `${current.date} · ${Math.round(current.size / 102.4) / 10} KB · ${current.file}`),
                ...renderMarkdown(current.content),
              ]
              : h('div', { style: S.empty }, '选一天看。'),
          ),
        ),
      )
    }

    function PeriodsView({ state }) {
      const periods = state.periods || []
      const [selected, setSelected] = useState(periods.length > 0 ? periods[0].file : null)
      useEffect(() => {
        if (!periods.some(period => period.file === selected)) setSelected(periods.length > 0 ? periods[0].file : null)
      }, [periods, selected])
      const current = periods.find(period => period.file === selected)
      if (periods.length === 0) return h('div', { style: S.empty }, '还没有周报或月报：生成时会写到日报目录下。')
      const label = (period) => {
        const badge = period.kind === 'month' ? '月' : period.kind === 'week' ? '周' : '期'
        const short = period.kind === 'month' ? period.period : String(period.period).replace(/\d{4}-/g, '')
        return `${badge} ${short}`
      }
      return h('div', { style: S.split },
        h('div', { style: S.list }, periods.map(period => h('button', {
          key: period.file,
          type: 'button',
          onClick: () => setSelected(period.file),
          style: S.item(period.file === selected),
          title: `${period.file} · ${Math.round(period.size / 102.4) / 10} KB`,
        }, label(period)))),
        h('div', { style: S.doc },
          current
            ? [
              h('div', { key: 'meta', style: S.muted },
                `${current.period} · ${Math.round(current.size / 102.4) / 10} KB · ${current.file}`),
              ...renderMarkdown(current.content),
            ]
            : h('div', { style: S.empty }, '选一份周期报告看。'),
        ),
      )
    }

    // 当前会话所在的工作区优先；没有会话归属时退回第一个工作区。
    function activeWorkspace(ctx) {
      const workspaces = ctx && typeof ctx.get === 'function' ? ctx.get('workspaces') : null
      const store = workspaces && workspaces.list
      const snapshot = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null
      const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
      if (items.length === 0) return null
      const ui = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
      const selection = ui && ui.selection && typeof ui.selection.getSnapshot === 'function'
        ? ui.selection.getSnapshot() : null
      const sessionId = (ui && ui.mainReference && ui.mainReference.sessionId)
        || (selection && selection.sessionId)
        || ''
      const current = sessionId
        ? items.find(item => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
        : null
      return current || items[0]
    }

    function boardStartPrompt(item) {
      const title = String(item && item.title ? item.title : '').trim() || '未命名待办'
      const lines = [`看板待办：${title}`]
      if (item.date) lines.push(`登记日期：${item.date}`)
      if (item.priority) lines.push(`优先级：${item.priority}`)
      if (item.due) lines.push(`截止日：${item.due}`)
      if (item.detail) lines.push(`详情：${item.detail}`)
      if (item.source) lines.push(`来源：${item.source}`)
      if (item.fingerprint) lines.push(`看板指纹：${item.fingerprint}`)
      lines.push('', '请先简短说明打算怎么做，然后直接开始处理。完成后把这条待办在看板里标记为已完成。')
      return lines.join('\n')
    }

    async function startBoardTask(ctx, item) {
      const workspace = activeWorkspace(ctx)
      if (!workspace) throw new Error('还没有工作区：先在左侧新建一个工作区，再点「开工」。')
      const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
      if (!sessions || typeof sessions.create !== 'function' || typeof sessions.using !== 'function') {
        throw new Error('当前 DSH 版本不支持从插件新建会话，请升级 DSH 后重试。')
      }
      const created = await sessions.create({ workspaceId: workspace.workspaceId })
      const sessionId = typeof created === 'string' ? created : created && created.sessionId
      if (!sessionId) throw new Error('新会话没有创建成功，请再试一次。')
      await sessions.using(sessionId, { source: 'controllerOperation' }, async (reference) => {
        if (reference && reference.ready && typeof reference.ready.then === 'function') await reference.ready
        const session = reference && reference.binding ? reference.binding.session : null
        if (!session || typeof session.prompt !== 'function') throw new Error('新会话没有准备好，请再试一次。')
        const result = await session.prompt([{ type: 'text', text: boardStartPrompt(item) }], 'queue')
        if (result && result.ok === false) {
          throw new Error(result.error && result.error.message ? result.error.message : '会话拒绝了这条任务')
        }
      })
      // 先确认首条任务已被接受，再切走；发送失败就留在看板显示原因。
      const ui = ctx.get('uiWorkspace')
      if (ui && typeof ui.openSession === 'function') ui.openSession(sessionId)
      return { sessionId, workspace }
    }

    function BoardView({ state, onChanged }) {
      const sections = parseBoard(state.board && state.board.text)
      const today = /^\d{4}-\d{2}-\d{2}$/.test(String(state.today || '')) ? state.today : localIsoDay()
      const [busy, setBusy] = useState(null)
      const [starting, setStarting] = useState(null)
      const [notice, setNotice] = useState(null)
      const [error, setError] = useState(null)

      const mutate = useCallback(async (item, patch) => {
        const key = item.fingerprint || item.title
        setBusy(key)
        setNotice(null)
        setError(null)
        try {
          const response = await fetch(BOARD_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ keyword: key, ...patch }),
          })
          const payload = await response.json()
          if (!response.ok) throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`)
          setNotice(String(payload.updated || '已更新').split(/\r?\n/)[0])
          if (onChanged) await onChanged()
        } catch (cause) {
          setError(`更新看板失败：${cause && cause.message ? cause.message : String(cause)}`)
        } finally {
          setBusy(null)
        }
      }, [onChanged])

      const start = async (item) => {
        const key = item.fingerprint || item.title
        setStarting(key)
        setNotice(null)
        setError(null)
        try {
          const result = await startBoardTask(appCtx, item)
          const where = result.workspace.title || result.workspace.path || '当前工作区'
          setNotice(`已在新会话开始处理：${item.title}（${where}）`)
        } catch (cause) {
          setError(`开始处理失败：${cause && cause.message ? cause.message : String(cause)}`)
        } finally {
          setStarting(null)
        }
      }

      if (sections.length === 0) return h('div', { style: S.empty }, '看板里还没有条目。')

      const statusOptions = [['todo', '待办'], ['doing', '进行中'], ['done', '已完成'], ['drop', '已放弃']]
      const priorityOptions = [['', '未标注'], ['P1', 'P1'], ['P2', 'P2'], ['P3', 'P3']]

      const row = (item, section, index) => {
        const overdue = item.open && item.due !== '' && item.due < today
        const key = item.fingerprint || item.title
        const disabled = busy === key || starting === key
        const editable = section.status === 'todo' || section.status === 'doing'
        const meta = [item.date, item.source ? `来源 ${item.source}` : '', item.fingerprint].filter(Boolean).join(' · ')
        return h('div', { key: `${section.title}-${index}-${key}`, style: S.row },
          h('span', { style: S.dot(item.open) }),
          h('div', { style: S.boardItem },
            h('div', { style: item.open ? undefined : { opacity: 0.65 } },
              item.title,
              item.priority ? h('span', { style: S.boardBadge(item.priority) }, item.priority) : null,
              item.due
                ? h('span', { style: S.boardBadge(overdue ? 'overdue' : 'due') },
                  overdue ? `已过期 · ${item.due}` : `截止 ${item.due}`)
                : null,
            ),
            meta ? h('div', { style: S.muted }, meta) : null,
            item.detail ? h('div', { style: S.muted }, `详情：${item.detail}`) : null,
          ),
          h('div', { style: S.boardControls },
            editable
              ? h('button', {
                type: 'button',
                style: S.boardStart,
                disabled,
                title: '把这条待办带进新会话，立即开始处理',
                'aria-label': `开工：${item.title}`,
                onClick: () => start(item),
              }, starting === key ? '建会话…' : '开工')
              : null,
            editable
              ? h('select', {
                value: item.priority,
                disabled,
                style: S.boardSelect,
                title: '优先级',
                onChange: event => mutate(item, { priority: event.target.value || 'none' }),
              }, priorityOptions.map(([value, label]) => h('option', { key: value, value }, label)))
              : null,
            editable
              ? h('input', {
                type: 'date',
                value: item.due,
                disabled,
                style: S.boardDate,
                title: '截止日',
                onChange: event => mutate(item, { due: event.target.value || 'none' }),
              })
              : null,
            h('select', {
              value: section.status,
              disabled,
              style: S.boardSelect,
              title: '状态',
              onChange: event => mutate(item, { status: event.target.value }),
            }, statusOptions.map(([value, label]) => h('option', { key: value, value }, label))),
          ),
        )
      }

      return h('div', null,
        h('div', { style: S.boardHint },
          '待办 / 进行中按「已过期 → P1 → P2 → P3 → 未标注」分组；优先级、截止日或状态一改就写回看板。点「开工」会在当前工作区新建会话，并把标题、详情和来源作为首条任务发出去。'),
        error ? h('div', { style: S.error }, error) : null,
        notice ? h('div', { style: S.notice, role: 'status' }, notice) : null,
        sections.map(section => {
          const editable = section.status === 'todo' || section.status === 'doing'
          const groups = editable ? boardGroups(section.items, today) : [{ key: 'all', title: '', items: section.items }]
          return h('div', { key: section.title, style: S.section },
            h('h3', { style: S.boardHead }, `${section.title}（${section.items.length}）`),
            groups.map(group => h('div', { key: group.key, style: S.boardGroup },
              group.title
                ? h('div', { style: S.boardGroupHead }, `${group.title}（${group.items.length}）`)
                : null,
              group.items.map((item, index) => row(item, section, index)),
            )),
          )
        }),
      )
    }

    function TrendChart({ trend }) {
      const count = trend.points.length
      const labelIndexes = [0, Math.floor((count - 1) / 2), count - 1]
      const linePoints = trend.average
        .map((value, index) => `${((index + 0.5) / count) * 100},${100 - (value / trend.max) * 100}`)
        .join(' ')

      return h('div', {
        style: S.trendChart,
        role: 'img',
        'aria-label': `最近 ${count} 天产出趋势，共 ${trend.total} 条产出，有日报 ${trend.covered} 天`,
      },
        h('div', { style: S.trendPlot },
          h('div', { style: S.trendGrid },
            [0, 1, 2].map(index => h('div', { key: index, style: S.trendGridLine })),
          ),
          h('div', { style: S.trendBars },
            trend.points.map((point, index) => h('div', {
              key: point.date,
              style: S.trendBarWrap,
              title: point.hasReport
                ? `${point.date} · ${point.outputs} 条产出 · ${point.lines} 行`
                : `${point.date} · 无日报`,
            }, h('div', {
              style: {
                ...S.trendBar,
                height: `${(point.outputs / trend.max) * 100}%`,
                background: index === count - 1 ? 'rgba(25,113,194,.9)' : 'rgba(25,113,194,.55)',
              },
            }))),
          ),
          h('svg', {
            viewBox: '0 0 100 100',
            preserveAspectRatio: 'none',
            'aria-hidden': true,
            style: S.trendLine,
          }, h('polyline', {
            points: linePoints,
            fill: 'none',
            stroke: '#e8590c',
            strokeWidth: 2,
            vectorEffect: 'non-scaling-stroke',
            strokeLinejoin: 'round',
            strokeLinecap: 'round',
          })),
          h('span', { style: S.trendMax }, String(trend.max)),
          h('span', { style: S.trendZero }, '0'),
        ),
        h('div', { style: S.trendAxis },
          labelIndexes.map((index, order) => h('span', {
            key: `x-${index}`,
            style: { textAlign: order === 0 ? 'left' : order === 2 ? 'right' : 'center' },
          }, trend.points[index].date.slice(5))),
        ),
      )
    }

    function DeliveryBar({ delivery }) {
      if (delivery.total === 0) return null
      const rows = [
        { key: 'done', label: '已完成', color: DELIVERY_COLORS.done },
        { key: 'doing', label: '进行中', color: DELIVERY_COLORS.doing },
        { key: 'todo', label: '待办', color: DELIVERY_COLORS.todo },
        { key: 'drop', label: '已放弃', color: DELIVERY_COLORS.drop },
      ]
      const label = `看板共 ${delivery.total} 条：完成 ${delivery.counts.done}、进行中 ${delivery.counts.doing}、待办 ${delivery.counts.todo}、已放弃 ${delivery.counts.drop}`
      return h('div', { style: S.deliveryBody },
        h('div', { style: S.deliveryBar, role: 'img', 'aria-label': label },
          rows.filter(row => delivery.counts[row.key] > 0).map(row => h('div', {
            key: row.key,
            title: `${row.label} ${delivery.counts[row.key]} 条`,
            style: {
              width: `${(delivery.counts[row.key] / delivery.total) * 100}%`,
              height: '100%',
              background: row.color,
            },
          })),
        ),
        h('div', { style: S.deliveryLegend },
          rows.map(row => h('span', { key: row.key, style: S.deliveryItem },
            h('span', { style: S.deliveryDot(row.color) }),
            `${row.label} ${delivery.counts[row.key]}`,
          )),
        ),
        h('div', { style: S.statNote }, '完成率按全部条目算；放弃也计入已关闭。'),
        h('div', { style: S.statKpis },
          h('div', { style: S.statKpi },
            h('span', { style: S.statKpiValue }, `${delivery.doneRate}%`),
            h('span', { style: S.statKpiLabel }, '完成率'),
          ),
          h('div', { style: S.statKpi },
            h('span', { style: S.statKpiValue }, `${delivery.dropRate}%`),
            h('span', { style: S.statKpiLabel }, '放弃率'),
          ),
          h('div', { style: S.statKpi },
            h('span', { style: S.statKpiValue }, String(delivery.open)),
            h('span', { style: S.statKpiLabel }, '未关闭'),
          ),
        ),
      )
    }

    function StatsView({ state, onOpen }) {
      const heat = buildHeat(state)
      const trend = buildTrend(state, 30)
      const delivery = boardStats(state)
      const [notice, setNotice] = useState(null)
      if ((state.reports || []).length === 0) {
        return h('div', { style: S.empty }, '还没有日报：写完第一份后，这里会按天亮起来。')
      }

      const tooltip = (day) => {
        if (day.future) return `${day.date} · 还没到`
        if (!day.report) return `${day.date} · 无日报`
        return `${day.date} · ${day.report.lines} 行 · ${day.report.outputs} 条产出 · 强度 ${day.report.score}`
      }

      const clickCell = (day) => {
        if (day.future) return
        if (!day.report) {
          setNotice(`该日无日报（${day.date}）`)
          return
        }
        setNotice(null)
        onOpen(day.date)
      }

      return h('div', { style: S.statsPage },
        h('section', { style: S.statsPanel },
          h('div', { style: S.statsPanelHead },
            h('div', null,
              h('h3', { style: S.statsPanelTitle }, '贡献热力图'),
              h('div', { style: S.statsPanelHint },
                `最近 13 周（${heat.start} ~ ${heat.today}）。点亮的格子点一下就到当天日报。`),
            ),
            h('span', { style: S.statsCoverage }, `${heat.covered} / ${heat.total} 天有日报`),
          ),
          h('div', { style: S.heatScroll },
            h('div', { style: S.heatGrid },
              h('div', { style: S.heatWeekdays },
                ['一', '', '三', '', '五', '', ''].map((label, index) => (
                  h('div', { key: index, style: S.heatWeekday }, label)
                )),
              ),
              h('div', { style: S.heatBody },
                h('div', { style: S.heatMonths },
                  heat.weeks.map((week, index) => h('div', { key: index, style: S.heatMonth }, week.label)),
                ),
                h('div', { style: S.heatWeeks },
                  heat.weeks.map((week, index) => h('div', { key: index, style: S.heatWeek },
                    week.days.map(day => h('button', {
                      key: day.date,
                      type: 'button',
                      title: tooltip(day),
                      'aria-label': tooltip(day),
                      disabled: day.future,
                      onClick: () => clickCell(day),
                      style: S.heatCell(day.level, day.future),
                    })),
                  )),
                ),
              ),
            ),
          ),
          h('div', { style: S.heatLegend },
            h('span', null, '图例：'),
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
              h('span', { style: S.heatSwatch(0) }), '无日报'),
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 3 } },
              [1, 2, 3, 4].map(level => h('span', { key: level, style: S.heatSwatch(level) }))),
            h('span', null, '少 → 多（按当天行数 + 产出条数 × 3 分档）'),
          ),
          notice ? h('div', { style: S.heatNotice, role: 'status' }, notice) : null,
        ),
        h('div', { style: S.statsGrid },
          h('section', { style: { ...S.statCard, ...S.statCardWide } },
            h('div', { style: S.statCardHead },
              h('h3', { style: S.statTitle }, '产出趋势'),
              h('span', { style: S.statPill }, `30 天 · ${trend.total} 条`),
            ),
            h('div', { style: S.statHint },
              `${trend.start} ~ ${trend.today} · 有日报 ${trend.covered} / 30 天`),
            h(TrendChart, { trend }),
            h('div', { style: S.statLegend },
              h('span', { style: S.statKey },
                h('span', { style: S.statSwatch('rgba(25,113,194,.55)') }), '柱：当日产出'),
              h('span', { style: S.statKey },
                h('span', { style: S.statSwatch('#e8590c') }), '线：7 日均值'),
            ),
          ),
          h('section', { style: S.statCard },
            h('div', { style: S.statCardHead },
              h('h3', { style: S.statTitle }, '看板交付结构'),
              h('span', { style: S.statPill }, `共 ${delivery.total} 条`),
            ),
            h('div', { style: S.statHint },
              delivery.total > 0
                ? `已关闭 ${delivery.counts.done + delivery.counts.drop} 条 · 未关闭 ${delivery.open} 条`
                : '看板里还没有条目。'),
            h(DeliveryBar, { delivery }),
          ),
        ),
      )
    }

    function SettingsView() {
      const [info, setInfo] = useState(null)
      const [time, setTime] = useState('23:00')
      const [weekTime, setWeekTime] = useState('01:00')
      const [monthTime, setMonthTime] = useState('01:00')
      const [weekActive, setWeekActive] = useState(true)
      const [monthActive, setMonthActive] = useState(true)
      const [reportDir, setReportDir] = useState('')
      const [workspace, setWorkspace] = useState('')
      const [discovered, setDiscovered] = useState([])
      const [logDir, setLogDir] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [error, setError] = useState(null)

      const applyPayload = useCallback((payload) => {
        if (payload.time) setTime(payload.time)
        if (typeof payload.reportDir === 'string') setReportDir(payload.reportDir)
        if (typeof payload.workspace === 'string') setWorkspace(payload.workspace)
        if (typeof payload.logDir === 'string') setLogDir(payload.logDir)
        if (payload.week) {
          if (payload.week.time) setWeekTime(payload.week.time)
          if (typeof payload.week.active === 'boolean') setWeekActive(payload.week.active)
        }
        if (payload.month) {
          if (payload.month.time) setMonthTime(payload.month.time)
          if (typeof payload.month.active === 'boolean') setMonthActive(payload.month.active)
        }
      }, [])

      const load = useCallback(async () => {
        try {
          const response = await fetch(SCHEDULE_ENDPOINT, { cache: 'no-store' })
          const payload = await response.json()
          if (!response.ok) throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`)
          setInfo(payload)
          applyPayload(payload)
          setError(null)
        } catch (cause) {
          setError(`读取定时设置失败：${cause && cause.message ? cause.message : String(cause)}`)
        }
        // 工作区清单是只读展示，读不到不影响设置页其他部分。
        try {
          const response = await fetch(ENDPOINT, { cache: 'no-store' })
          const payload = await response.json()
          if (response.ok && Array.isArray(payload.workspaces)) setDiscovered(payload.workspaces)
        } catch {
          setDiscovered([])
        }
      }, [applyPayload])

      useEffect(() => { load() }, [load])

      const save = useCallback(async (patch) => {
        setBusy(true)
        setNotice(null)
        setError(null)
        try {
          const response = await fetch(SCHEDULE_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          const payload = await response.json()
          if (!response.ok) throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`)
          setInfo(payload)
          applyPayload(payload)
          // 改了额外根之后，最近一次采集的清单可能就旧了；顺手重拉一次，失败不影响保存结果。
          if (Object.prototype.hasOwnProperty.call(patch, 'workspace')) {
            try {
              const stateResponse = await fetch(ENDPOINT, { cache: 'no-store' })
              const statePayload = await stateResponse.json()
              if (stateResponse.ok && Array.isArray(statePayload.workspaces)) setDiscovered(statePayload.workspaces)
            } catch {
              // 只影响设置页下方的只读列表
            }
          }
          setNotice('已保存')
        } catch (cause) {
          setError(`保存失败：${cause && cause.message ? cause.message : String(cause)}`)
        } finally {
          setBusy(false)
        }
      }, [applyPayload])

      if (!info) return error ? h('div', { style: S.error }, error) : h('div', { style: S.empty }, '加载中…')

      const scheduleBlock = info.found
        ? h('div', null,
          h('h3', { style: S.boardHead }, '日报定时'),
          h('div', { style: S.field },
            h('span', { style: S.label }, '每天'),
            h('input', {
              type: 'time',
              value: time,
              style: S.input,
              onChange: event => setTime(event.target.value),
            }),
            h('span', { style: S.muted }, info.timeZone),
          ),
          h('div', { style: S.field },
            h('span', { style: S.label }, '启用'),
            h('input', {
              type: 'checkbox',
              checked: Boolean(info.active),
              onChange: event => save({ active: event.target.checked }),
            }),
            h('span', { style: S.muted }, info.active ? '到点投递到会话' : '已暂停，任务仍保留'),
          ),
          h('div', { style: S.field },
            h('button', { type: 'button', style: S.ghost, disabled: busy, onClick: () => save({ time }) },
              busy ? '保存中…' : '保存时间'),
            notice ? h('span', { style: S.notice }, notice) : null,
          ),
        )
        : h('div', { style: S.empty }, '还没找到日报计划任务：重启一次 DSH，插件会把它建出来。')

      const periodBlock = (label, ruleText, sub, timeValue, setTimeValue, timeField, activeField, activeValue, setActiveValue) => {
        if (!sub || !sub.found) {
          return h('div', { key: label },
            h('h3', { style: S.boardHead }, `${label}定时`),
            h('div', { style: S.empty }, `还没找到${label}计划任务：重启一次 DSH，开关打开时会按设置建出来。`),
          )
        }
        return h('div', { key: label },
          h('h3', { style: S.boardHead }, `${label}定时`),
          h('div', { style: S.field },
            h('span', { style: S.label }, '规则'),
            h('span', { style: S.muted }, ruleText),
          ),
          h('div', { style: S.field },
            h('span', { style: S.label }, '时间'),
            h('input', {
              type: 'time',
              value: timeValue,
              style: S.input,
              onChange: event => setTimeValue(event.target.value),
            }),
            h('button', { type: 'button', style: S.ghost, disabled: busy, onClick: () => save({ [timeField]: timeValue }) },
              busy ? '保存中…' : '保存时间'),
            h('span', { style: S.muted }, sub.timeZone),
          ),
          h('div', { style: S.field },
            h('span', { style: S.label }, '启用'),
            h('input', {
              type: 'checkbox',
              checked: Boolean(activeValue),
              onChange: (event) => {
                setActiveValue(event.target.checked)
                save({ [activeField]: event.target.checked })
              },
            }),
            h('span', { style: S.muted }, activeValue ? '到点生成并投递' : '已暂停，任务仍保留'),
          ),
          sub.nextRunAt ? h('div', { style: S.hint }, `下次触发：${sub.nextRunAt}`) : null,
        )
      }

      return h('div', { style: { maxWidth: 640 } },
        h('h3', { style: S.boardHead }, '日报文件目录'),
        h('div', { style: S.field },
          h('span', { style: S.label }, '目录'),
          h('input', {
            type: 'text',
            value: reportDir,
            placeholder: info.reportDirDefault,
            style: { ...S.input, width: 360 },
            onChange: event => setReportDir(event.target.value),
          }),
          h('button', { type: 'button', style: S.ghost, disabled: busy, onClick: () => save({ reportDir }) },
            busy ? '保存中…' : '保存目录'),
        ),
        h('div', { style: { ...S.hint, marginTop: 4 } },
          `默认 ${info.reportDirDefault}；日报、看板、_源数据 都写在这里。改目录不会搬动已有文件。`,
        ),
        h('h3', { style: S.boardHead }, '工作区'),
        h('div', { style: { ...S.hint, marginBottom: 6 } },
          '工作区不用登记：每次采集会从近两天有活动的 DSH 会话里自动发现。下面这一项只是额外固定的根，可留空。'),
        h('div', { style: S.field },
          h('span', { style: S.label }, '额外根'),
          h('input', {
            type: 'text',
            value: workspace,
            placeholder: '可选：例如 F:\\projects',
            style: { ...S.input, width: 360 },
            onChange: event => setWorkspace(event.target.value),
          }),
          h('button', { type: 'button', style: S.ghost, disabled: busy, onClick: () => save({ workspace }) },
            busy ? '保存中…' : '保存根目录'),
        ),
        discovered.length > 0
          ? h('div', { style: { ...S.hint, marginTop: 6 } },
            '最近一次采集发现的工作区：',
            ...discovered.map(item => h('div', { key: item.path, style: { ...S.hint, marginTop: 2 } },
              `${item.name}  ${item.path}  （会话 ${item.sessions} · 当日改动 ${item.files} 个文件）`)))
          : h('div', { style: { ...S.hint, marginTop: 6 } }, '还没有采集记录；跑一次日报采集后这里会列出发现的工作区。'),
        scheduleBlock,
        periodBlock('周报', '每周一生成上一周（周一至周日）', info.week,
          weekTime, setWeekTime, 'weekTime', 'weekActive', weekActive, setWeekActive),
        periodBlock('月报', '每月 1 号生成上一个自然月', info.month,
          monthTime, setMonthTime, 'monthTime', 'monthActive', monthActive, setMonthActive),
        h('h3', { style: S.boardHead }, '日志'),
        h('div', { style: S.field },
          h('span', { style: S.label }, '目录'),
          h('input', {
            type: 'text',
            value: logDir,
            placeholder: info.logDirDefault,
            style: { ...S.input, width: 360 },
            onChange: event => setLogDir(event.target.value),
          }),
          h('button', { type: 'button', style: S.ghost, disabled: busy, onClick: () => save({ logDir }) },
            busy ? '保存中…' : '保存目录'),
        ),
        h('div', { style: { ...S.hint, marginTop: 4 } },
          `留空表示用数据目录下的 _日志（${info.logDirDefault}）。`,
          h('br'),
          `文件名 ${info.logPattern}，每次调脚本记一行：参数、退出码、耗时；失败带 stderr 尾部。`,
        ),
        error ? h('div', { style: S.error }, error) : null,
        info.found
          ? h('div', { style: S.hint },
            `任务：${info.title}（${info.id}）`,
            h('br'),
            info.nextRunAt ? `下次触发：${info.nextRunAt}` : '当前没有下次触发时间',
            h('br'),
            '日报时间改的是任务本身，重启后不会被 scheduleTime 默认值盖回去；周报 / 月报的时间会同时记住。暂停只停投递，不删任务。',
          )
          : null,
      )
    }

    function Panel() {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [tab, setTab] = useState('board')
      const [focusDate, setFocusDate] = useState(null)
      const [busy, setBusy] = useState(false)
      const clearFocus = useCallback(() => setFocusDate(null), [])

      const load = useCallback(async () => {
        setBusy(true)
        try {
          const response = await fetch(ENDPOINT, { cache: 'no-store' })
          const payload = await response.json()
          if (!response.ok) throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`)
          setState(payload)
          setError(null)
        } catch (cause) {
          setError(`读取日报数据失败：${cause && cause.message ? cause.message : String(cause)}`)
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => { load() }, [load])

      const open = state && state.board ? state.board.open : 0
      return h('div', { style: S.page },
        h('div', { style: S.bar },
          h('h1', { style: S.title }, '工作日报'),
          state ? h('span', { style: S.muted }, `${state.reportDir} · 待办 ${open} 条`) : null,
          h('div', { style: S.tabs },
            h('button', { type: 'button', style: S.tab(tab === 'board'), onClick: () => setTab('board') }, '看板'),
            h('button', { type: 'button', style: S.tab(tab === 'reports'), onClick: () => { setFocusDate(null); setTab('reports') } }, '日报'),
            h('button', { type: 'button', style: S.tab(tab === 'periods'), onClick: () => setTab('periods') }, '周期'),
            h('button', { type: 'button', style: S.tab(tab === 'stats'), onClick: () => setTab('stats') }, '统计'),
            h('button', { type: 'button', style: S.tab(tab === 'settings'), onClick: () => setTab('settings') }, '设置'),
            h('button', { type: 'button', style: S.ghost, onClick: load, disabled: busy }, busy ? '刷新中…' : '刷新'),
          ),
        ),
        error ? h('div', { style: S.error }, error) : null,
        tab === 'settings' ? h(SettingsView)
          : !state ? (error ? null : h('div', { style: S.empty }, '加载中…'))
            : tab === 'reports' ? h(ReportsView, { state, focus: focusDate, onFocusDone: clearFocus })
              : tab === 'periods' ? h(PeriodsView, { state })
                : tab === 'stats' ? h(StatsView, {
                  state,
                  onOpen: (date) => { setFocusDate(date); setTab('reports') },
                }) : h(BoardView, { state, onChanged: load }),
      )
    }

    return {
      inject: ['slots'],
      __test: { activeWorkspace, boardStartPrompt, startBoardTask, buildTrend, boardStats, StatsView, renderMarkdown, MainlinePanel, workspaceLeaf },
      apply(ctx) {
        appCtx = ctx
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 10,
          label: '日报',
        }, Icon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, Panel))
      },
    }
  },
})
