window.__ModuleLoader__.load({
  id: 'dsh-work-summary',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const PANEL_ID = 'dsh-work-summary'
    const ENDPOINT = '/dsh-work-summary/state'
    const SCHEDULE_ENDPOINT = '/dsh-work-summary/schedule'

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
      table: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12.5, whiteSpace: 'pre-wrap' },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12.5, background: 'rgba(127,127,127,.14)', padding: '1px 4px', borderRadius: 4 },
      quote: { margin: '6px 0', paddingLeft: 10, borderLeft: '3px solid rgba(127,127,127,.3)', opacity: 0.8 },
      hr: { border: 'none', borderTop: '1px solid rgba(127,127,127,.24)', margin: '14px 0' },
      section: { marginBottom: 22 },
      boardHead: { fontSize: 15, fontWeight: 600, margin: '0 0 8px' },
      row: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0' },
      dot: (open) => ({
        flex: '0 0 auto', width: 13, height: 13, borderRadius: 3, marginTop: 4,
        border: '1.5px solid rgba(127,127,127,.6)',
        background: open ? 'transparent' : 'rgba(127,127,127,.55)',
      }),
      empty: { opacity: 0.6, padding: '24px 0' },
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
      if (trimmed.startsWith('|')) return h('div', { key: index, style: S.table }, text)
      if (trimmed.startsWith('>')) return h('div', { key: index, style: S.quote }, inline(trimmed.replace(/^>\s?/, '')))
      return h('div', { key: index, style: S.para }, inline(trimmed))
    }

    function parseBoard(text) {
      const sections = []
      let current = null
      for (const raw of String(text ?? '').split(/\r?\n/)) {
        const heading = /^##\s+(.+?)\s*$/.exec(raw)
        if (heading) {
          current = { title: heading[1], items: [] }
          sections.push(current)
          continue
        }
        const item = /^\s*-\s*\[( |x|X)\]\s*(.*)$/.exec(raw)
        if (item && current) current.items.push({ open: item[1] === ' ', text: item[2] })
      }
      return sections.filter(section => section.items.length > 0)
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

    function ReportsView({ state }) {
      const reports = state.reports || []
      const [selected, setSelected] = useState(reports.length > 0 ? reports[0].file : null)
      useEffect(() => {
        if (!reports.some(report => report.file === selected)) setSelected(reports.length > 0 ? reports[0].file : null)
      }, [reports, selected])
      const current = reports.find(report => report.file === selected)
      if (reports.length === 0) return h('div', { style: S.empty }, '这个目录里还没有日报。')
      return h('div', { style: S.split },
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
              ...current.content.split(/\r?\n/).map(renderLine),
            ]
            : h('div', { style: S.empty }, '选一天看。'),
        ),
      )
    }

    function BoardView({ state }) {
      const sections = parseBoard(state.board && state.board.text)
      if (sections.length === 0) return h('div', { style: S.empty }, '看板里还没有条目。')
      return h('div', null, sections.map(section => h('div', { key: section.title, style: S.section },
        h('h3', { style: S.boardHead }, `${section.title}（${section.items.length}）`),
        section.items.map((item, index) => h('div', { key: `${section.title}-${index}`, style: S.row },
          h('span', { style: S.dot(item.open) }),
          h('span', { style: item.open ? undefined : { opacity: 0.65 } }, item.text),
        )),
      )))
    }

    function SettingsView() {
      const [info, setInfo] = useState(null)
      const [time, setTime] = useState('23:00')
      const [reportDir, setReportDir] = useState('')
      const [workspace, setWorkspace] = useState('')
      const [logDir, setLogDir] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [error, setError] = useState(null)

      const load = useCallback(async () => {
        try {
          const response = await fetch(SCHEDULE_ENDPOINT, { cache: 'no-store' })
          const payload = await response.json()
          if (!response.ok) throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`)
          setInfo(payload)
          if (payload.time) setTime(payload.time)
          if (typeof payload.reportDir === 'string') setReportDir(payload.reportDir)
          if (typeof payload.workspace === 'string') setWorkspace(payload.workspace)
          if (typeof payload.logDir === 'string') setLogDir(payload.logDir)
          setError(null)
        } catch (cause) {
          setError(`读取定时设置失败：${cause && cause.message ? cause.message : String(cause)}`)
        }
      }, [])

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
          if (payload.time) setTime(payload.time)
          if (typeof payload.reportDir === 'string') setReportDir(payload.reportDir)
          if (typeof payload.workspace === 'string') setWorkspace(payload.workspace)
          if (typeof payload.logDir === 'string') setLogDir(payload.logDir)
          setNotice('已保存')
        } catch (cause) {
          setError(`保存失败：${cause && cause.message ? cause.message : String(cause)}`)
        } finally {
          setBusy(false)
        }
      }, [])

      if (!info) return error ? h('div', { style: S.error }, error) : h('div', { style: S.empty }, '加载中…')

      const scheduleBlock = info.found
        ? h('div', null,
          h('h3', { style: S.boardHead }, '定时'),
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
        h('h3', { style: S.boardHead }, '工作空间'),
        h('div', { style: S.field },
          h('span', { style: S.label }, '目录'),
          h('input', {
            type: 'text',
            value: workspace,
            placeholder: info.workspaceDefault,
            style: { ...S.input, width: 360 },
            onChange: event => setWorkspace(event.target.value),
          }),
          h('button', { type: 'button', style: S.ghost, disabled: busy, onClick: () => save({ workspace }) },
            busy ? '保存中…' : '保存目录'),
        ),
        h('div', { style: { ...S.hint, marginTop: 4 } },
          '日报从这里扫当天改了哪些文件、有哪些 git 仓库；默认和插件数据目录同一个（装好就有），填你平时干活的目录更贴合实际。',
        ),
        scheduleBlock,
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
            '时间改的是计划任务本身，重启后不会被默认值盖回去；暂停只停投递，不删任务。',
          )
          : null,
      )
    }

    function Panel() {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [tab, setTab] = useState('reports')
      const [busy, setBusy] = useState(false)

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
            h('button', { type: 'button', style: S.tab(tab === 'reports'), onClick: () => setTab('reports') }, '日报'),
            h('button', { type: 'button', style: S.tab(tab === 'board'), onClick: () => setTab('board') }, '看板'),
            h('button', { type: 'button', style: S.tab(tab === 'settings'), onClick: () => setTab('settings') }, '设置'),
            h('button', { type: 'button', style: S.ghost, onClick: load, disabled: busy }, busy ? '刷新中…' : '刷新'),
          ),
        ),
        error ? h('div', { style: S.error }, error) : null,
        tab === 'settings' ? h(SettingsView)
          : !state ? (error ? null : h('div', { style: S.empty }, '加载中…'))
            : tab === 'reports' ? h(ReportsView, { state }) : h(BoardView, { state }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
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
