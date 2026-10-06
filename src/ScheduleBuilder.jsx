import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, Copy, Plus, Send, Settings2, Trash2, X } from 'lucide-react'
import {
  deleteCoverageRule,
  deleteShift,
  loadCoverageRules,
  loadScheduleStaff,
  loadScheduleWeek,
  loadStoreLeave,
  loadStoreSchedule,
  publishSchedule,
  saveCoverageRule,
  saveShift,
} from './lib/myhrPay'
import { canFill, clock, isoDay, roleColour, shiftHours, shiftRole, weekSummary, weekWarnings } from './lib/scheduleRules'
import { RESTRICTIONS } from './lib/myhrPay'

// Schedule Builder (managers): employees down the side, Monday–Sunday across
// the top. Drag a shift to move it (hold Ctrl or Alt to copy it), drag its
// edges to change the times, drag an employee's name onto a day to give them
// a shift, click a shift to edit it. Coverage needs and per-employee rules
// are checked as you go; the bar at the top totals hours, labour and
// warnings. Changes stay a draft until Publish Schedule.

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DEFAULT_ROLES = ['Manager', 'Supervisor', 'Keyholder', 'Employee']
const SNAP = 15
const PX_PER_SNAP = 8
const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 })
const minutesOf = (time) => { const [h, m] = String(time).split(':').map(Number); return h * 60 + (m || 0) }
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
const hoursText = (value) => `${Math.round(value * 100) / 100}h`
const RESTRICTION_LABELS = Object.fromEntries(RESTRICTIONS)

// "Mon 3:30 PM–10 PM · Sat not available" (days with limits only).
function availabilitySummary(person) {
  const parts = []
  for (const weekday of [1, 2, 3, 4, 5, 6, 0]) {
    const windows = person.availability?.[String(weekday)]
    if (!Array.isArray(windows)) continue
    parts.push(`${DAY_SHORT[weekday]} ${windows.length ? windows.map((window) => `${clock(minutesOf(window.from))}–${clock(minutesOf(window.to))}`).join(', ') : 'not available'}`)
  }
  return parts
}

function mondayOf(date) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7))
  return day
}
const at = (day, minutes) => { const date = new Date(`${day}T00:00:00`); date.setMinutes(minutes); return date }
const minutesIntoDay = (iso, day) => Math.round((new Date(iso) - new Date(`${day}T00:00:00`)) / 60000)
const sameShift = (a, b) => a && b && a.employee_id === b.employee_id && new Date(a.starts_at).getTime() === new Date(b.starts_at).getTime()
  && new Date(a.ends_at).getTime() === new Date(b.ends_at).getTime() && (a.role || '') === (b.role || '') && Number(a.break_minutes || 0) === Number(b.break_minutes || 0)

function ShiftCard({ shift, person, day, warned, unpublished, selected, onSelect, onResize }) {
  const [drag, setDrag] = useState(null) // { edge, startX, delta }
  const start = minutesIntoDay(shift.starts_at, day)
  const end = minutesIntoDay(shift.ends_at, day)
  const preview = drag ? {
    start: drag.edge === 'start' ? Math.min(start + drag.delta, end - SNAP) : start,
    end: drag.edge === 'end' ? Math.max(end + drag.delta, start + SNAP) : end,
  } : { start, end }
  const hours = (preview.end - preview.start) / 60 - Number(shift.break_minutes || 0) / 60
  const role = shiftRole(shift, person)

  const handle = (edge) => ({
    onPointerDown: (event) => { event.stopPropagation(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDrag({ edge, startX: event.clientX, delta: 0 }) },
    onPointerMove: (event) => { if (drag) setDrag((current) => ({ ...current, delta: Math.round((event.clientX - current.startX) / PX_PER_SNAP) * SNAP })) },
    onPointerUp: () => { if (drag && drag.delta) onResize(preview.start, preview.end); setDrag(null) },
  })

  return (
    <div
      className={`sb-card${selected ? ' selected' : ''}${warned ? ' warned' : ''}`}
      style={{ '--role': roleColour(role) }}
      draggable={!drag}
      onDragStart={(event) => { event.dataTransfer.setData('text/x-shift', String(shift.id)); event.dataTransfer.effectAllowed = 'copyMove' }}
      onClick={(event) => { event.stopPropagation(); onSelect() }}
      title="Drag to move (hold Ctrl or Alt to copy). Drag the edges to change the times. Click to edit."
    >
      <span className="sb-edge start" {...handle('start')} />
      <strong>{person?.short_name || person?.name}</strong>
      <span className="sb-role">{role}</span>
      <span className="sb-time">{clock(preview.start)} – {clock(preview.end)} · {hoursText(hours)}</span>
      {warned ? <AlertTriangle className="sb-warn" size={13} /> : null}
      {unpublished ? <i className="sb-unpublished" title="Not published yet" /> : null}
      <span className="sb-edge end" {...handle('end')} />
    </div>
  )
}

function CoverageNeeds({ storeId, rules, roles, onChanged }) {
  const [form, setForm] = useState({ days: [6], start: '09:00', end: '17:00', role: 'Manager', needed: '1', label: '' })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  async function add(event) {
    event.preventDefault()
    if (!form.days.length) { setProblem('Pick at least one day.'); return }
    if (form.end <= form.start) { setProblem('The end has to be after the start.'); return }
    setBusy(true)
    setProblem('')
    try {
      for (const weekday of form.days) {
        await saveCoverageRule(storeId, { weekday, start: form.start, end: form.end, role: form.role, needed: Number(form.needed) || 1, label: form.label })
      }
      await onChanged()
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  async function remove(rule) {
    setBusy(true)
    try { await deleteCoverageRule(storeId, rule.id); await onChanged() } catch (error) { setProblem(error?.message || String(error)) } finally { setBusy(false) }
  }

  const order = [1, 2, 3, 4, 5, 6, 0]
  return (
    <section className="myhr-sap-panel">
      <div className="myhr-sap-head"><strong>Coverage needs</strong><small className="myhr-muted">What the store needs on the floor, every week</small></div>
      <div className="sb-rules">
        {order.map((weekday) => {
          const list = rules.filter((rule) => Number(rule.weekday) === weekday)
          return (
            <div key={weekday} className="sb-rules-day">
              <strong>{DAY_LONG[weekday]}</strong>
              {list.length ? list.map((rule) => (
                <span key={rule.id} className="sb-rule">
                  <i style={{ background: roleColour(rule.role) }} />
                  {clock(minutesOf(rule.start_time))}–{clock(minutesOf(rule.end_time))} · {rule.needed} {rule.role}{Number(rule.needed) > 1 ? 's' : ''}{rule.label ? ` · ${rule.label}` : ''}
                  <button type="button" onClick={() => remove(rule)} disabled={busy} aria-label="Remove"><X size={12} /></button>
                </span>
              )) : <small className="myhr-muted">No needs set</small>}
            </div>
          )
        })}
      </div>
      <form className="sb-rule-form" onSubmit={add}>
        <span className="sb-rule-days">
          {order.map((weekday) => (
            <label key={weekday}>
              <input type="checkbox" checked={form.days.includes(weekday)} onChange={(event) => setForm((current) => ({ ...current, days: event.target.checked ? [...current.days, weekday] : current.days.filter((day) => day !== weekday) }))} />
              {DAY_SHORT[weekday]}
            </label>
          ))}
        </span>
        <input type="time" value={form.start} onChange={(event) => setForm((current) => ({ ...current, start: event.target.value }))} aria-label="From" />
        <input type="time" value={form.end} onChange={(event) => setForm((current) => ({ ...current, end: event.target.value }))} aria-label="To" />
        <input type="number" min="1" max="50" value={form.needed} onChange={(event) => setForm((current) => ({ ...current, needed: event.target.value }))} aria-label="How many" className="sb-needed" />
        <input list="sb-roles" value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))} aria-label="Role" placeholder="Role" />
        <input value={form.label} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} placeholder="Label (e.g. Closing)" />
        <button type="submit" className="gold-button" disabled={busy}><Plus size={14} /> Add need</button>
        <datalist id="sb-roles">{roles.map((role) => <option key={role} value={role} />)}</datalist>
      </form>
      <small className="myhr-muted ts-pad">"Employee" means anyone. A need for a role is met by someone working as that role, or someone the organization allows to cover it.</small>
      {problem ? <p className="myhr-editor-problem ts-pad">{problem}</p> : null}
    </section>
  )
}

export default function ScheduleBuilder({ storeId }) {
  const [weekStart, setWeekStart] = useState(() => { const next = mondayOf(new Date()); next.setDate(next.getDate() + 7); return next })
  const [staff, setStaff] = useState([])
  const [shifts, setShifts] = useState([])
  const [rules, setRules] = useState([])
  const [leave, setLeave] = useState([])
  const [published, setPublished] = useState(null)
  const [selectedId, setSelectedId] = useState('')
  const [editor, setEditor] = useState(null)
  const [highlight, setHighlight] = useState(null)
  const [showWarnings, setShowWarnings] = useState(false)
  const [showNeeds, setShowNeeds] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const gridRef = useRef(null)

  const weekKey = isoDay(weekStart)
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 7)
  const days = Array.from({ length: 7 }, (_, index) => { const day = new Date(weekStart); day.setDate(day.getDate() + index); return isoDay(day) })

  async function reloadShifts() {
    setShifts(await loadStoreSchedule(storeId, weekStart, weekEnd))
  }
  async function reloadRules() {
    setRules(await loadCoverageRules(storeId))
  }
  useEffect(() => {
    let live = true
    setLoading(true)
    Promise.all([loadScheduleStaff(storeId), loadStoreSchedule(storeId, weekStart, weekEnd), loadCoverageRules(storeId), loadStoreLeave(storeId).catch(() => []), loadScheduleWeek(storeId, weekKey)])
      .then(([people, weekShifts, needs, away, publishedWeek]) => {
        if (!live) return
        setStaff(people)
        setShifts(weekShifts)
        setRules(needs)
        setLeave(away)
        setPublished(publishedWeek)
        setProblem('')
      })
      .catch((error) => { if (live) setProblem(error?.message || String(error)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [storeId, weekKey])

  const staffById = useMemo(() => Object.fromEntries(staff.map((person) => [person.id, person])), [staff])
  const { warnings, coverage } = useMemo(() => weekWarnings({ days, staff, shifts, rules, leave }), [weekKey, staff, shifts, rules, leave])
  const summary = useMemo(() => weekSummary({ staff, shifts, warnings }), [staff, shifts, warnings])
  const roles = useMemo(() => [...new Set([...DEFAULT_ROLES, ...staff.map((person) => person.schedule_role), ...staff.flatMap((person) => person.can_cover || []), ...rules.map((rule) => rule.role)].filter(Boolean))], [staff, rules])

  // Draft vs published.
  const publishedById = useMemo(() => Object.fromEntries((published?.shifts || []).map((shift) => [shift.id, shift])), [published])
  const unpublishedIds = new Set(shifts.filter((shift) => !sameShift(shift, publishedById[shift.id])).map((shift) => shift.id))
  const removedSincePublish = (published?.shifts || []).filter((shift) => !shifts.some((draft) => draft.id === shift.id)).length
  const changeCount = unpublishedIds.size + removedSincePublish

  const warnedShift = (shift) => warnings.some((warning) => warning.severity !== 'info' && warning.shiftId === shift.id)
  const personWarnings = (person) => warnings.filter((warning) => warning.employeeId === person.id && warning.kind === 'hours')

  // Saving (the screen updates straight away; Supabase follows).
  async function persist(changes, message) {
    setBusy(true)
    setProblem('')
    try {
      await changes()
      await reloadShifts()
      if (message) setNotice(message)
    } catch (error) {
      setProblem(error?.message || String(error))
      await reloadShifts().catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  function defaultTimes(person, day) {
    const weekday = new Date(`${day}T00:00:00`).getDay()
    const matching = rules.filter((rule) => Number(rule.weekday) === weekday && canFill(rule.role, {}, person))
    if (!matching.length) return [9 * 60, 17 * 60]
    return [Math.min(...matching.map((rule) => minutesOf(rule.start_time))), Math.max(...matching.map((rule) => minutesOf(rule.end_time)))]
  }

  function addShiftFor(person, day) {
    const [start, end] = defaultTimes(person, day)
    persist(() => saveShift(storeId, { employeeId: person.id, startsAt: at(day, start), endsAt: at(day, end), role: '', breakMinutes: end - start > 6 * 60 ? 30 : 0 }),
      `Added ${person.short_name || person.name} on ${DAY_LONG[new Date(`${day}T00:00:00`).getDay()]}.`)
  }

  function onDrop(event, person, day) {
    event.preventDefault()
    const shiftId = event.dataTransfer.getData('text/x-shift')
    const staffId = event.dataTransfer.getData('text/x-staff')
    if (staffId) { const dragged = staffById[staffId]; if (dragged) addShiftFor(dragged, day); return }
    const shift = shifts.find((entry) => String(entry.id) === shiftId)
    if (!shift) return
    const fromDay = isoDay(new Date(shift.starts_at))
    const start = minutesIntoDay(shift.starts_at, fromDay)
    const length = (new Date(shift.ends_at) - new Date(shift.starts_at)) / 60000
    const copy = event.ctrlKey || event.altKey
    const moved = { employeeId: person.id, startsAt: at(day, start), endsAt: at(day, start + length), role: shift.role, breakMinutes: shift.break_minutes, note: shift.note }
    if (!copy && fromDay === day && shift.employee_id === person.id) return
    if (!copy) setShifts((current) => current.map((entry) => (entry.id === shift.id ? { ...entry, employee_id: person.id, starts_at: moved.startsAt.toISOString(), ends_at: moved.endsAt.toISOString() } : entry)))
    persist(() => saveShift(storeId, { ...moved, id: copy ? null : shift.id }), copy ? 'Shift copied.' : 'Shift moved.')
  }

  function resize(shift, day, start, end) {
    setShifts((current) => current.map((entry) => (entry.id === shift.id ? { ...entry, starts_at: at(day, start).toISOString(), ends_at: at(day, end).toISOString() } : entry)))
    persist(() => saveShift(storeId, { id: shift.id, employeeId: shift.employee_id, startsAt: at(day, start), endsAt: at(day, end), role: shift.role, breakMinutes: shift.break_minutes, note: shift.note }))
  }

  function select(shift) {
    const day = isoDay(new Date(shift.starts_at))
    setSelectedId(shift.id)
    setEditor({
      id: shift.id, employeeId: shift.employee_id, day,
      start: hhmm(minutesIntoDay(shift.starts_at, day)), end: hhmm(minutesIntoDay(shift.ends_at, day)),
      role: shift.role || '', breakMinutes: String(shift.break_minutes || 0), note: shift.note || '',
    })
  }
  function closeEditor() { setSelectedId(''); setEditor(null) }

  function saveEditor(event) {
    event?.preventDefault()
    let endMinutes = minutesOf(editor.end)
    const startMinutes = minutesOf(editor.start)
    if (endMinutes <= startMinutes) endMinutes += 24 * 60 // overnight
    persist(() => saveShift(storeId, { id: editor.id, employeeId: editor.employeeId, startsAt: at(editor.day, startMinutes), endsAt: at(editor.day, endMinutes), role: editor.role, breakMinutes: editor.breakMinutes, note: editor.note }), 'Shift saved.')
    closeEditor()
  }
  function duplicateEditor() {
    const next = new Date(`${editor.day}T00:00:00`)
    next.setDate(next.getDate() + 1)
    const day = isoDay(next)
    let endMinutes = minutesOf(editor.end)
    if (endMinutes <= minutesOf(editor.start)) endMinutes += 24 * 60
    persist(() => saveShift(storeId, { employeeId: editor.employeeId, startsAt: at(day, minutesOf(editor.start)), endsAt: at(day, endMinutes), role: editor.role, breakMinutes: editor.breakMinutes, note: editor.note }), 'Shift copied to the next day.')
  }
  function deleteEditor() {
    const id = editor.id
    setShifts((current) => current.filter((entry) => entry.id !== id))
    persist(() => deleteShift(storeId, id), 'Shift removed.')
    closeEditor()
  }

  async function publish() {
    setBusy(true)
    setProblem('')
    try {
      const version = await publishSchedule(storeId, weekKey)
      setPublished(await loadScheduleWeek(storeId, weekKey))
      setNotice(`Published${Number(version) > 1 ? ` (version ${version}; changes are marked for staff)` : ''}. Staff can now see the week of ${weekStart.toLocaleDateString([], { month: 'long', day: 'numeric' })}.`)
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  function jumpTo(warning) {
    setHighlight({ day: warning.day, employeeId: warning.employeeId })
    const target = gridRef.current?.querySelector(warning.employeeId && warning.day ? `[data-cell="${warning.employeeId}|${warning.day}"]` : warning.employeeId ? `[data-row="${warning.employeeId}"]` : `[data-day="${warning.day}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
    setTimeout(() => setHighlight(null), 2500)
  }

  function moveWeek(weeks) {
    const next = new Date(weekStart)
    next.setDate(next.getDate() + weeks * 7)
    setWeekStart(next)
    closeEditor()
    setNotice('')
  }

  const hoursFor = (person) => Math.round(shifts.filter((shift) => shift.employee_id === person.id).reduce((sum, shift) => sum + shiftHours(shift), 0) * 100) / 100

  return (
    <div className="sb-page">
      <div className="sb-summary">
        <span><b>Scheduled:</b> {hoursText(summary.scheduled)} · <b>Target:</b> {hoursText(summary.target)} · <b className={summary.diff > 0 ? 'over' : summary.diff < 0 ? 'under' : ''}>{summary.diff > 0 ? '+' : ''}{hoursText(summary.diff)}</b></span>
        <span><b>Labour:</b> {money.format(summary.labour)}{summary.missingRates ? <small className="myhr-muted" title="Some scheduled staff have no pay rate set by the organization"> (some rates missing)</small> : null}</span>
        <button type="button" className={`sb-warnings-button${summary.total ? ' has' : ''}`} onClick={() => setShowWarnings((open) => !open)}>
          <AlertTriangle size={15} /> {summary.coverageWarnings} Coverage Warning{summary.coverageWarnings === 1 ? '' : 's'}{summary.total - summary.coverageWarnings ? ` · ${summary.total - summary.coverageWarnings} other` : ''}
        </button>
        <span className="sb-publish">
          {published?.published_at
            ? <small className="myhr-muted">Published v{published.version} · {new Date(published.published_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}{changeCount ? ` · ${changeCount} unpublished change${changeCount === 1 ? '' : 's'}` : ''}</small>
            : <small className="myhr-muted">Draft: staff can't see this week yet</small>}
          <button type="button" className="gold-button" onClick={publish} disabled={busy || loading || (published && !changeCount)}><Send size={14} /> {published ? 'Publish changes' : 'Publish Schedule'}</button>
        </span>
      </div>

      {showWarnings ? (
        <ul className="sb-warning-list">
          {warnings.length ? warnings.map((warning) => (
            <li key={warning.id}><button type="button" className={warning.severity} onClick={() => jumpTo(warning)}>{warning.severity === 'info' ? 'ℹ' : '⚠'} {warning.text}</button></li>
          )) : <li className="myhr-muted">No problems found.</li>}
        </ul>
      ) : null}

      <div className="myhr-sap-filter sb-toolbar">
        <button type="button" onClick={() => moveWeek(-1)}><ChevronLeft size={14} /> Previous week</button>
        <strong>Week of {weekStart.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}</strong>
        <button type="button" onClick={() => moveWeek(1)}>Next week <ChevronRight size={14} /></button>
        <button type="button" onClick={() => { setWeekStart(mondayOf(new Date())); closeEditor() }}>This week</button>
        <button type="button" className="sb-needs-button" onClick={() => setShowNeeds((open) => !open)}><Settings2 size={14} /> Coverage needs</button>
      </div>
      {notice ? <p className="myhr-notice">{notice}</p> : null}
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      {showNeeds ? <CoverageNeeds storeId={storeId} rules={rules} roles={roles} onChanged={reloadRules} /> : null}

      <div className="sb-grid-wrap" ref={gridRef} onClick={closeEditor}>
        <table className="sb-grid">
          <thead>
            <tr>
              <th className="sb-person-head">Employee</th>
              {days.map((day) => {
                const date = new Date(`${day}T00:00:00`)
                return <th key={day} data-day={day} className={`${day === isoDay(new Date()) ? 'today' : ''}${highlight?.day === day && !highlight.employeeId ? ' flash' : ''}`}>{DAY_SHORT[date.getDay()]} {date.getDate()}</th>
              })}
            </tr>
            <tr className="sb-coverage-row">
              <th>Coverage</th>
              {days.map((day) => {
                const result = coverage[day] || { results: [], surplus: [] }
                return (
                  <td key={day} data-day={day}>
                    {result.results.length ? result.results.map((item) => (
                      <span key={item.rule.id} className={`sb-cov ${item.ok ? 'ok' : 'bad'}`} title={item.rule.label || ''}>
                        {item.ok ? '✓' : '⚠'} {clock(minutesOf(item.rule.start_time)).replace(':00', '')}–{clock(minutesOf(item.rule.end_time)).replace(':00', '')} {item.rule.needed} {item.rule.role}{item.ok ? '' : ` (${item.missing} short)`}
                      </span>
                    )) : <small className="myhr-muted">No needs set</small>}
                    {result.surplus.map((segment) => <span key={segment.from} className="sb-cov over" title={`Overstaffed by ${segment.value} · +${segment.extraHours} labour hours`}>+{segment.value} over · {clock(segment.from).replace(':00', '')}–{clock(segment.to).replace(':00', '')}</span>)}
                  </td>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={8} className="myhr-muted">Loading…</td></tr> : staff.map((person) => {
              const hours = hoursFor(person)
              const target = person.target_hours != null ? Number(person.target_hours) : null
              const flagged = personWarnings(person)
              return (
                <tr key={person.id} data-row={person.id} className={highlight?.employeeId === person.id && !highlight.day ? 'flash' : ''}>
                  <th className="sb-person">
                    <span className="sb-person-chip" draggable onDragStart={(event) => { event.dataTransfer.setData('text/x-staff', person.id); event.dataTransfer.effectAllowed = 'copy' }} title="Drag onto a day to add a shift">
                      <i style={{ background: roleColour(person.schedule_role) }} />
                      <strong>{person.name}</strong>
                    </span>
                    <small>{person.schedule_role}{person.can_cover?.length ? ` · covers ${person.can_cover.join(', ')}` : ''}</small>
                    <small className={flagged.length ? 'bad' : ''} title={flagged.map((warning) => warning.text).join('\n')}>{hoursText(hours)}{target != null ? ` / ${hoursText(target)} target` : ''}{person.preferred_hours != null ? ` · prefers ${hoursText(Number(person.preferred_hours))}` : ''}</small>
                    {availabilitySummary(person).length || person.restrictions?.length || person.availability_note ? (
                      <span className="sb-avail" title={[...availabilitySummary(person), person.most_hours != null ? `At most ${Number(person.most_hours)} hrs/week` : '', person.availability_note || ''].filter(Boolean).join('\n')}>
                        {availabilitySummary(person).slice(0, 2).map((text) => <small key={text}>{text}</small>)}
                        {availabilitySummary(person).length > 2 ? <small>+{availabilitySummary(person).length - 2} more</small> : null}
                        {(person.restrictions || []).map((key) => <b key={key} className="sb-restriction">{RESTRICTION_LABELS[key] || key}</b>)}
                      </span>
                    ) : null}
                  </th>
                  {days.map((day) => {
                    const dayShifts = shifts.filter((shift) => shift.employee_id === person.id && isoDay(new Date(shift.starts_at)) === day)
                    const flash = highlight && highlight.day === day && highlight.employeeId === person.id
                    return (
                      <td
                        key={day}
                        data-cell={`${person.id}|${day}`}
                        className={`sb-cell${flash ? ' flash' : ''}`}
                        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = event.ctrlKey || event.altKey ? 'copy' : 'move' }}
                        onDrop={(event) => onDrop(event, person, day)}
                      >
                        {dayShifts.map((shift) => (
                          <ShiftCard
                            key={shift.id}
                            shift={shift}
                            person={person}
                            day={day}
                            warned={warnedShift(shift)}
                            unpublished={Boolean(published) && unpublishedIds.has(shift.id)}
                            selected={selectedId === shift.id}
                            onSelect={() => select(shift)}
                            onResize={(start, end) => resize(shift, day, start, end)}
                          />
                        ))}
                        <button type="button" className="sb-add" onClick={(event) => { event.stopPropagation(); addShiftFor(person, day) }} disabled={busy} aria-label={`Add a shift for ${person.name} on ${DAY_LONG[new Date(`${day}T00:00:00`).getDay()]}`}><Plus size={13} /></button>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {editor ? (
        <form className="myhr-sap-panel sb-editor" onSubmit={saveEditor} onClick={(event) => event.stopPropagation()}>
          <div className="myhr-sap-head"><strong>Edit shift</strong><button type="button" onClick={closeEditor} aria-label="Close"><X size={14} /></button></div>
          <div className="sb-editor-fields">
            <label>Employee
              <select value={editor.employeeId} onChange={(event) => setEditor((current) => ({ ...current, employeeId: event.target.value }))}>
                {staff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              </select>
            </label>
            <label>Day
              <select value={editor.day} onChange={(event) => setEditor((current) => ({ ...current, day: event.target.value }))}>
                {days.map((day) => <option key={day} value={day}>{DAY_LONG[new Date(`${day}T00:00:00`).getDay()]}</option>)}
              </select>
            </label>
            <label>Start<input type="time" value={editor.start} onChange={(event) => setEditor((current) => ({ ...current, start: event.target.value }))} /></label>
            <label>End<input type="time" value={editor.end} onChange={(event) => setEditor((current) => ({ ...current, end: event.target.value }))} /></label>
            <label>Role<input list="sb-roles-editor" value={editor.role} placeholder={staffById[editor.employeeId]?.schedule_role || 'Employee'} onChange={(event) => setEditor((current) => ({ ...current, role: event.target.value }))} /></label>
            <label>Break (min)<input type="number" min="0" max="240" step="5" value={editor.breakMinutes} onChange={(event) => setEditor((current) => ({ ...current, breakMinutes: event.target.value }))} /></label>
            <label className="wide">Note<input value={editor.note} onChange={(event) => setEditor((current) => ({ ...current, note: event.target.value }))} placeholder="e.g. opening, card night" /></label>
            <datalist id="sb-roles-editor">{roles.map((role) => <option key={role} value={role} />)}</datalist>
          </div>
          <div className="myhr-editor-actions sb-editor-actions">
            <button type="button" onClick={deleteEditor} disabled={busy}><Trash2 size={14} /> Remove</button>
            <button type="button" onClick={duplicateEditor} disabled={busy}><Copy size={14} /> Copy to next day</button>
            <button type="submit" className="gold-button" disabled={busy}>Save shift</button>
          </div>
        </form>
      ) : null}
      <small className="myhr-muted">Drag a shift to move it, hold Ctrl or Alt while dropping to copy it, drag its left or right edge to change the start or end (15-minute steps), or click it to edit. Drag a name onto a day, or press +, to add a shift. Staff only see a week once it's published.</small>
    </div>
  )
}
