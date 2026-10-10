import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Copy, LayoutGrid, Plus, Send, Settings2, Sparkles, Trash2, X } from 'lucide-react'
import {
  deleteCoverageRule,
  deleteShift,
  clearSchedule,
  clearCoverageRules,
  loadCoverageRules,
  loadScheduleStaff,
  loadScheduleWeek,
  loadStoreLeave,
  loadStoreSchedule,
  emailPublishedSchedule,
  publishSchedule,
  saveCoverageRule,
  saveShift,
} from './lib/myhrPay'
import { MAX_DAYS_PER_WEEK, canFill, clock, isoDay, roleColour, shiftHours, shiftRole, weekSummary, weekWarnings } from './lib/scheduleRules'
import { RESTRICTIONS } from './lib/myhrPay'
import { dayHours, loadStoreOpeningHours } from './lib/storeHours'
import { loadStoreSalesActivity } from './lib/salesHistory'

// Schedule Builder (managers): each day is a large drop zone with a draggable
// staff roster on the right. Drag a shift to move it (hold Ctrl or Alt to copy
// it), drag its edges to change the times, drag an employee's name onto a day
// to give them a shift, click a shift to edit it. Coverage needs and
// per-employee rules are checked as you go; the bar at the top totals hours,
// labour and warnings. Changes stay a draft until Publish Schedule.

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DEFAULT_ROLES = ['Manager', 'Supervisor', 'Keyholder', 'Employee', 'Cashier']
const COVERAGE_ROLES = ['Manager', 'Supervisor', 'Cashier']
const SNAP = 15
const MIN_SHIFT_MINUTES = 4 * 60
const MAX_SHIFT_MINUTES = 8 * 60
const PX_PER_SNAP = 8
const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 })
const minutesOf = (time) => { const [h, m] = String(time).split(':').map(Number); return h * 60 + (m || 0) }
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
const hoursText = (value) => `${Math.round(value * 100) / 100}h`
const RESTRICTION_LABELS = Object.fromEntries(RESTRICTIONS)
const padTime = (value) => String(value).padStart(2, '0')
const breakForShift = (duration) => duration >= MAX_SHIFT_MINUTES ? 60 : duration >= MIN_SHIFT_MINUTES ? 15 : 0

function coverageSuggestions({ storeHours = {}, salesActivity = [], rules = [], staff = [] }) {
  const suggestions = []
  const existing = new Set(rules.map((rule) => `${rule.weekday}|${String(rule.start_time).slice(0, 5)}|${String(rule.end_time).slice(0, 5)}|${String(rule.role).toLowerCase()}|${rule.needed}`))
  const roleCapacity = (role) => staff.length ? staff.filter((person) => canFill(role, {}, person)).length : null
  const add = (weekday, start, end, role, needed, label, reason, bounds = { open: 0, close: 24 * 60 }) => {
    const capacity = roleCapacity(role)
    if (capacity === 0) return
    const open = bounds.open
    const close = bounds.close
    const requestedStart = minutesOf(start)
    const requestedEnd = minutesOf(end)
    const windows = []
    let cursor = requestedStart
    const requestedLength = requestedEnd - requestedStart
    if (requestedLength > MAX_SHIFT_MINUTES && (role === 'Manager' || role === 'Cashier')) {
      windows.push([requestedStart, requestedStart + MAX_SHIFT_MINUTES], [requestedEnd - MAX_SHIFT_MINUTES, requestedEnd])
    } else if (requestedLength > MAX_SHIFT_MINUTES) {
      while (cursor < requestedEnd) {
        const remaining = requestedEnd - cursor
        const length = remaining < MIN_SHIFT_MINUTES && windows.length ? remaining : Math.min(MAX_SHIFT_MINUTES, remaining)
        if (remaining < MIN_SHIFT_MINUTES && windows.length) {
          windows[windows.length - 1] = [windows[windows.length - 1][0], requestedEnd - MIN_SHIFT_MINUTES]
          windows.push([requestedEnd - MIN_SHIFT_MINUTES, requestedEnd])
          break
        }
        windows.push([cursor, cursor + length])
        cursor += length
      }
    } else {
      windows.push([requestedStart, requestedEnd])
    }
    for (const [windowStart, windowEnd] of windows) {
      const requested = Math.min(MAX_SHIFT_MINUTES, Math.max(MIN_SHIFT_MINUTES, windowEnd - windowStart))
      let startMinutes = windowStart
      let endMinutes = startMinutes + requested
      if (startMinutes < open) { startMinutes = open; endMinutes = open + requested }
      if (endMinutes > close) { endMinutes = close; startMinutes = close - requested }
      if (startMinutes < open || endMinutes > close || endMinutes <= startMinutes) continue
      const blockStart = hhmm(startMinutes)
      const blockEnd = hhmm(endMinutes)
      const roleTotal = suggestions.filter((item) => item.weekday === weekday && item.role.toLowerCase() === role.toLowerCase()).reduce((sum, item) => sum + Number(item.needed || 0), 0)
      const available = capacity == null ? Number(needed) : Math.min(Number(needed), Math.max(0, capacity - roleTotal))
      if (available <= 0) continue
      const key = `${weekday}|${blockStart}|${blockEnd}|${role.toLowerCase()}|${available}`
      if (existing.has(key) || suggestions.some((item) => item.key === key)) continue
      suggestions.push({ key, weekday, start: blockStart, end: blockEnd, role, needed: available, label, reason })
    }
  }

  for (let weekday = 0; weekday < 7; weekday += 1) {
    const hours = dayHours(storeHours, weekday)
    if (!hours) continue
    const open = Math.max(0, minutesOf(hours.open) - 60)
    const close = Math.min(24 * 60, minutesOf(hours.close) + 60)
    add(weekday, hhmm(open), hhmm(close), 'Manager', 1, 'Management on site', 'One hour before opening through one hour after closing')
  }

  // Always reserve the first cashier block for store-hours coverage before
  // using the remaining staff capacity for sales-history extras.
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const hours = dayHours(storeHours, weekday)
    if (!hours) continue
    const open = Math.max(0, minutesOf(hours.open) - 30)
    const close = Math.min(24 * 60, minutesOf(hours.close) + 30)
    if (close > open) add(weekday, hhmm(open), hhmm(close), 'Cashier', 1, 'Store-hours baseline', 'At least one cashier during store hours', { open, close })
  }

  const buckets = new Map()
  for (const sale of salesActivity) {
    const date = new Date(sale.soldAt)
    if (Number.isNaN(date.getTime())) continue
    const key = `${date.getDay()}|${date.getHours()}`
    const bucket = buckets.get(key) || { days: new Set(), transactions: new Set() }
    bucket.days.add(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`)
    if (sale.reference) bucket.transactions.add(`${date.toISOString().slice(0, 10)}|${sale.reference}`)
    else bucket.transactions.add(`${date.toISOString()}|${bucket.transactions.size}`)
    buckets.set(key, bucket)
  }
  const salesDays = new Set()
  for (const [key, bucket] of buckets) {
    const [weekday, hour] = key.split('|').map(Number)
    const averageTransactions = bucket.transactions.size / Math.max(bucket.days.size, 1)
    if (!averageTransactions) continue
    const needed = Math.min(4, Math.max(1, Math.ceil(averageTransactions / 8)))
    const start = `${padTime(hour)}:00`
    const end = `${padTime(hour + 1)}:00`
    const hours = dayHours(storeHours, weekday)
    const open = String(hours?.open || '').slice(0, 5)
    const close = String(hours?.close || '').slice(0, 5)
    if (!hours) continue
    const openMinutes = Math.max(0, minutesOf(open) - 30)
    const closeMinutes = Math.min(24 * 60, minutesOf(close) + 30)
    const blockStart = hour * 60 <= minutesOf(open) ? hhmm(openMinutes) : start
    const blockEnd = (hour + 1) * 60 >= minutesOf(close) ? hhmm(closeMinutes) : end
    salesDays.add(weekday)
    add(weekday, blockStart, blockEnd, 'Cashier', needed, 'Sales history', `About ${averageTransactions.toFixed(1)} transactions/hour historically`, {
      open: openMinutes,
      close: minutesOf(close),
    })
  }

  // A new store has no sales history yet. Use a conservative open-hours
  // pattern so the manager gets usable shift blocks immediately: one cashier
  // in the morning and at close, with a second cashier during the midday peak.
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const hours = dayHours(storeHours, weekday)
    if (!hours) continue
    const open = Math.max(0, minutesOf(hours.open) - 30)
    const close = Math.min(24 * 60, minutesOf(hours.close) + 30)
    if (close <= open) continue
    if (salesDays.has(weekday)) continue
    const peakStart = Math.max(open, 11 * 60)
    const peakEnd = Math.min(close, 15 * 60)
    if (peakEnd > peakStart && peakStart > open) {
      add(weekday, hhmm(open), hhmm(peakStart), 'Cashier', 1, 'Store-hours baseline', '30 minutes before opening through the morning')
      add(weekday, hhmm(peakStart), hhmm(peakEnd), 'Cashier', 2, 'Store-hours baseline', 'No sales history yet')
      if (peakEnd < close) add(weekday, hhmm(peakEnd), hhmm(close), 'Cashier', 1, 'Store-hours baseline', 'Afternoon through 30 minutes after closing')
    } else {
      add(weekday, hhmm(open), hhmm(close), 'Cashier', 1, 'Store-hours baseline', '30 minutes before opening through 30 minutes after closing')
    }
  }
  return suggestions
}

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
const minutesIntoDay = (iso, day) => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 0
  const localDay = isoDay(date)
  if (localDay === day) return date.getHours() * 60 + date.getMinutes()
  const next = new Date(`${day}T00:00:00`)
  next.setDate(next.getDate() + 1)
  if (localDay === isoDay(next) && date.getHours() === 0 && date.getMinutes() === 0) return 24 * 60
  return Math.round((date - new Date(`${day}T00:00:00`)) / 60000)
}
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
  const breakMinutes = Number(shift.break_minutes || 0)
  const unpaidBreakMinutes = breakMinutes >= 60 ? 60 : breakMinutes >= 30 ? 30 : 0
  const hours = (preview.end - preview.start) / 60 - unpaidBreakMinutes / 60
  const role = shiftRole(shift, person)
  const breakText = breakMinutes >= 60 ? `lunch around ${clock(Math.round((preview.start + preview.end) / 2 / SNAP) * SNAP)}` : breakMinutes ? `${breakMinutes}m break` : ''

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
      onDoubleClick={(event) => { event.stopPropagation(); onSelect() }}
      title="Drag to move (hold Ctrl or Alt to copy). Drag the edges to change the times. Double-click to edit."
    >
      <span className="sb-edge start" {...handle('start')} />
      <strong>{person?.short_name || person?.name || 'Open shift'}</strong>
      <span className="sb-role">{role}</span>
      <span className="sb-time">{clock(preview.start)} – {clock(preview.end)} · {hoursText(hours)}{breakText ? ` · ${breakText}` : ''}</span>
      {warned ? <AlertTriangle className="sb-warn" size={13} /> : null}
      {unpublished ? <i className="sb-unpublished" title="Not published yet" /> : null}
      <span className="sb-edge end" {...handle('end')} />
    </div>
  )
}

function CoverageNeeds({ storeId, rules = [], roles = [], storeHours = {}, salesActivity = [], weekStart, shifts = [], staff = [], onChanged }) {
  const [form, setForm] = useState({ days: [6], start: '09:00', end: '17:00', role: 'Manager', needed: '1', label: '' })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const suggestions = useMemo(() => coverageSuggestions({ storeHours, salesActivity, rules, staff }), [storeHours, salesActivity, rules, staff])

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

  async function clearBlocks() {
    if (!rules.length) {
      setProblem('There are no saved shift blocks to clear.')
      return
    }
    if (!window.confirm(`Clear all ${rules.length} recurring shift blocks for this store? Scheduled shifts will stay in place.`)) return
    setBusy(true)
    setProblem('')
    try {
      await clearCoverageRules(storeId)
      await onChanged()
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  async function applySuggestions() {
    if (!suggestions.length) return
    setBusy(true)
    setProblem('')
    try {
      for (const suggestion of suggestions) {
        const duration = minutesOf(suggestion.end) - minutesOf(suggestion.start)
        const breakMinutes = breakForShift(duration)
        const shiftDay = new Date(weekStart)
        shiftDay.setDate(shiftDay.getDate() + ((suggestion.weekday + 6) % 7))
        const day = isoDay(shiftDay)
        await saveCoverageRule(storeId, suggestion)
        const existingMatchingShifts = shifts.filter((shift) =>
          isoDay(new Date(shift.starts_at)) === day
          && minutesIntoDay(shift.starts_at, day) === minutesOf(suggestion.start)
          && minutesIntoDay(shift.ends_at, day) === minutesOf(suggestion.end)
          && (shift.employee_id
            ? canFill(suggestion.role, shift, staff.find((person) => person.id === shift.employee_id))
            : String(shift.role || '').toLowerCase() === String(suggestion.role || '').toLowerCase()))
        const remaining = Math.max(0, Number(suggestion.needed || 1) - existingMatchingShifts.length)
        for (let index = 0; index < remaining; index += 1) {
          await saveShift(storeId, {
            employeeId: null,
            startsAt: new Date(`${day}T${suggestion.start}`),
            endsAt: new Date(`${day}T${suggestion.end}`),
            role: suggestion.role,
            breakMinutes,
            note: suggestion.label || 'Open shift block',
          })
        }
      }
      await onChanged()
      setShowSuggestions(false)
    } catch (error) {
      const message = error?.message || String(error)
      setProblem(/employee_id|not-null|null value|open shift/i.test(message)
        ? 'Coverage rules saved, but open shifts could not be created. Run the updated supabase/myhr_schedule_builder.sql migration first.'
        : `Could not apply suggestions: ${message}`)
    } finally {
      setBusy(false)
    }
  }

  const order = [1, 2, 3, 4, 5, 6, 0]
  return (
    <section className="myhr-sap-panel">
      <div className="myhr-sap-head"><span><strong>Shift blocks &amp; coverage</strong><small className="myhr-muted">Saved shift blocks repeat every week</small></span><span className="sb-needs-head-actions">{showSuggestions && suggestions.length ? <button type="button" className="gold-button" onClick={applySuggestions} disabled={busy}><Sparkles size={14} /> {busy ? 'Applying…' : 'Apply suggestions'}</button> : null}<button type="button" onClick={() => setShowSuggestions((open) => !open)}><Sparkles size={14} /> {showSuggestions ? 'Hide suggestions' : 'Suggest needs'}</button><button type="button" className="sb-clear-button" onClick={clearBlocks} disabled={busy || !rules.length} title="Clear all recurring shift blocks"><Trash2 size={14} /> Clear blocks</button></span></div>
      {showSuggestions ? (
        <div className="sb-suggestions">
          <div className="sb-suggestions-head"><strong>Suggested shift blocks from store hours and sales history</strong><small className="myhr-muted">Cashier suggestions use about one cashier per eight historical transactions per hour. Review before applying.</small></div>
          {problem ? <p className="myhr-editor-problem sb-needs-problem">{problem}</p> : null}
          {suggestions.length ? (
            <div className="sb-suggestions-list">
              {suggestions.map((suggestion) => (
                <span className="sb-suggestion" key={suggestion.key}>
                  <i style={{ background: roleColour(suggestion.role) }} />
                  <strong>{DAY_LONG[suggestion.weekday]}</strong>
                  <span>{suggestion.start}–{suggestion.end} · {suggestion.needed} {suggestion.role}</span>
                  <small>{suggestion.reason}</small>
                </span>
              ))}
            </div>
          ) : <small className="myhr-muted">No suggestions yet. Set store hours or complete some store sales first.</small>}
        </div>
      ) : null}
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
        <select value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))} aria-label="Role">
          {COVERAGE_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
        </select>
        <input value={form.label} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} placeholder="Label (e.g. Closing)" />
        <button type="submit" className="gold-button" disabled={busy}><Plus size={14} /> Add shift block</button>
      </form>
      <small className="myhr-muted ts-pad">Set the hours, role, and number of people needed, then drag staff into a day to assign those shift hours. Manager coverage includes Managers, Assistant Managers, and Supervisors.</small>
      {problem ? <p className="myhr-editor-problem ts-pad">{problem}</p> : null}
    </section>
  )
}

function timelineStyle(start, end, rangeStart = 0, rangeEnd = 24 * 60) {
  const span = Math.max(1, rangeEnd - rangeStart)
  const visibleStart = Math.max(rangeStart, Math.min(rangeEnd, start))
  const visibleEnd = Math.max(rangeStart, Math.min(rangeEnd, end))
  return { left: `${((visibleStart - rangeStart) / span) * 100}%`, width: `${Math.max(1, ((visibleEnd - visibleStart) / span) * 100)}%` }
}

function DailyTimeline({ day, shifts, suggestions, storeHours, coverageResult, staffById, warnedShift, unpublishedIds, onDrop, onSelect, onResize, onCreateSuggestion }) {
  const dayShifts = shifts
    .filter((shift) => isoDay(new Date(shift.starts_at)) === day)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
  const daySuggestions = suggestions.filter((suggestion) => suggestion.weekday === new Date(`${day}T00:00:00`).getDay())
  const assignedSuggestions = new Set(dayShifts.filter((shift) => !shift.employee_id).map((shift) => `${minutesIntoDay(shift.starts_at, day)}-${minutesIntoDay(shift.ends_at, day)}-${String(shift.role || '').toLowerCase()}-${shift.note || ''}`))
  const date = new Date(`${day}T00:00:00`)
  const rangeStart = 7 * 60
  const rangeEnd = 23 * 60
  const axisTimes = [rangeStart]
  for (let time = rangeStart + 60; time < rangeEnd; time += 60) axisTimes.push(time)
  if (rangeEnd !== rangeStart && axisTimes[axisTimes.length - 1] !== rangeEnd) axisTimes.push(rangeEnd)
  const timelineRange = { rangeStart, rangeEnd }

  return (
    <section className="sb-daily" data-day={day}>
      <header className="sb-daily-head">
        <div><strong>{DAY_LONG[date.getDay()]}, {date.toLocaleDateString([], { month: 'long', day: 'numeric' })}</strong><small className="myhr-muted">Drag a staff name onto a block to assign that shift</small></div>
        <div className="sb-daily-legend"><span className="suggested">Suggested</span><span className="open">Open</span><span className="assigned">Assigned</span></div>
      </header>
      <div className="sb-daily-coverage">
        {coverageResult?.results?.filter((item) => !item.ok).map((item) => <span key={item.rule.id} className="sb-cov bad">Short {item.rule.role}: {item.gaps.map((gap) => `${clock(gap.from)}–${clock(gap.to)}`).join(', ')}</span>)}
        {coverageResult?.surplus?.map((segment) => <span key={`surplus-${segment.from}`} className="sb-cov over">+{segment.value} over · {clock(segment.from)}–{clock(segment.to)}</span>)}
      </div>
      <div className="sb-timeline-axis">{axisTimes.map((time, index) => <span key={time} className={index === axisTimes.length - 1 ? 'last' : ''} style={{ left: `${((time - rangeStart) / Math.max(1, rangeEnd - rangeStart)) * 100}%` }}>{clock(time).replace(':00', '')}</span>)}</div>
      <div className="sb-timeline" style={{ minHeight: `${Math.max(300, 30 + (daySuggestions.length + dayShifts.length) * 68)}px` }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={(event) => onDrop(event, day)}>
        {axisTimes.map((time) => <i key={time} style={{ left: `${((time - rangeStart) / Math.max(1, rangeEnd - rangeStart)) * 100}%` }} />)}
        {daySuggestions.map((suggestion, index) => {
          const key = `${minutesOf(suggestion.start)}-${minutesOf(suggestion.end)}-${suggestion.role.toLowerCase()}-${suggestion.label || ''}`
          if (assignedSuggestions.has(key)) return null
          return <div key={suggestion.key} className="sb-timeline-suggestion" style={{ ...timelineStyle(minutesOf(suggestion.start), minutesOf(suggestion.end), ...Object.values(timelineRange)), top: `${12 + index * 68}px` }} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy' }} onDrop={(event) => { event.stopPropagation(); onDrop(event, day, null, suggestion) }} onDoubleClick={(event) => { event.stopPropagation(); onCreateSuggestion?.(day, suggestion) }} title="Suggested shift block: double-click to create it as an open shift, or drag a staff name onto it"><strong>{suggestion.role}</strong><small>{suggestion.start}–{suggestion.end} · {suggestion.needed} needed</small></div>
        })}
        {dayShifts.map((shift, index) => {
          const start = minutesIntoDay(shift.starts_at, day)
          const end = minutesIntoDay(shift.ends_at, day)
          const person = staffById[shift.employee_id]
          return <div key={shift.id} className={`sb-timeline-item${shift.employee_id ? ' assigned' : ' open'}`} style={{ ...timelineStyle(start, end, ...Object.values(timelineRange)), top: `${12 + (daySuggestions.length + index) * 68}px` }} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = shift.employee_id ? 'none' : 'copy' }} onDrop={(event) => { event.stopPropagation(); onDrop(event, day, shift.id) }}>
            <ShiftCard shift={shift} person={person} day={day} warned={warnedShift(shift)} unpublished={unpublishedIds.has(shift.id)} selected={false} onSelect={() => onSelect(shift)} onResize={(start, end) => onResize(shift, day, start, end)} />
          </div>
        })}
        {!dayShifts.length && !daySuggestions.length ? <p className="sb-empty-day">No shifts or suggestions for this day</p> : null}
      </div>
    </section>
  )
}

export default function ScheduleBuilder({ storeId }) {
  const [weekStart, setWeekStart] = useState(() => { const next = mondayOf(new Date()); next.setDate(next.getDate() + 7); return next })
  const [staff, setStaff] = useState([])
  const [shifts, setShifts] = useState([])
  const [rules, setRules] = useState([])
  const [leave, setLeave] = useState([])
  const [storeHours, setStoreHours] = useState({})
  const [salesActivity, setSalesActivity] = useState([])
  const [published, setPublished] = useState(null)
  const [selectedId, setSelectedId] = useState('')
  const [editor, setEditor] = useState(null)
  const [highlight, setHighlight] = useState(null)
  const [showWarnings, setShowWarnings] = useState(false)
  const [showNeeds, setShowNeeds] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const [viewMode, setViewMode] = useState('week')
  const [selectedDay, setSelectedDay] = useState('')
  const gridRef = useRef(null)

  const weekKey = isoDay(weekStart)
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 7)
  const days = Array.from({ length: 7 }, (_, index) => { const day = new Date(weekStart); day.setDate(day.getDate() + index); return isoDay(day) })

  useEffect(() => { setSelectedDay(days[0]) }, [weekKey])

  async function reloadShifts() {
    setShifts(await loadStoreSchedule(storeId, weekStart, weekEnd))
  }
  async function reloadRules() {
    setRules(await loadCoverageRules(storeId))
  }
  useEffect(() => {
    let live = true
    setLoading(true)
    Promise.all([loadScheduleStaff(storeId), loadStoreSchedule(storeId, weekStart, weekEnd), loadCoverageRules(storeId), loadStoreLeave(storeId).catch(() => []), loadScheduleWeek(storeId, weekKey), loadStoreOpeningHours(storeId), loadStoreSalesActivity(storeId).catch(() => [])])
      .then(([people, weekShifts, needs, away, publishedWeek, hours, sales]) => {
        if (live) setStoreHours(hours || {})
        if (live) setSalesActivity(sales || [])
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
  const { warnings, coverage } = useMemo(() => weekWarnings({ days, staff, shifts, rules, leave, storeHours }), [weekKey, staff, shifts, rules, leave, storeHours])
  const summary = useMemo(() => weekSummary({ staff, shifts, warnings }), [staff, shifts, warnings])
  const roles = useMemo(() => [...new Set([...DEFAULT_ROLES, ...staff.map((person) => person.schedule_role), ...staff.flatMap((person) => person.can_cover || []), ...rules.map((rule) => rule.role)].filter(Boolean))], [staff, rules])
  const suggestions = useMemo(() => coverageSuggestions({ storeHours, salesActivity, rules, staff }), [storeHours, salesActivity, rules, staff])

  // Draft vs published.
  const publishedById = useMemo(() => Object.fromEntries((published?.shifts || []).map((shift) => [shift.id, shift])), [published])
  const unpublishedIds = new Set(shifts.filter((shift) => !sameShift(shift, publishedById[shift.id])).map((shift) => shift.id))
  const removedSincePublish = (published?.shifts || []).filter((shift) => !shifts.some((draft) => draft.id === shift.id)).length
  const changeCount = unpublishedIds.size + removedSincePublish

  const warnedShift = (shift) => warnings.some((warning) => warning.severity !== 'info' && warning.shiftId === shift.id)
  const personWarnings = (person) => warnings.filter((warning) => warning.employeeId === person.id && (warning.kind === 'hours' || warning.kind === 'days'))

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

  function recommendedTimes(person, day) {
    const gaps = (coverage[day]?.results || [])
      .filter((result) => !result.ok && canFill(result.rule.role, {}, person))
      .flatMap((result) => result.gaps.map((gap) => ({ ...gap, role: result.rule.role })))
      .sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from)
    if (gaps.length) return [gaps[0].from, gaps[0].to]
    return defaultTimes(person, day)
  }

  function minimumShiftWindow(day, start, end) {
    const hours = dayHours(storeHours, new Date(`${day}T00:00:00`).getDay())
    const open = hours ? minutesOf(hours.open) : 0
    const close = hours ? minutesOf(hours.close) : 24 * 60
    if (close - open < MIN_SHIFT_MINUTES) return null
    // Never longer than the store is open (a 5-hour Sunday gets a 4-5 hour shift).
    const duration = Math.min(MAX_SHIFT_MINUTES, close - open, Math.max(MIN_SHIFT_MINUTES, end - start))
    let nextStart = start
    let nextEnd = start + duration
    if (nextStart < open) { nextStart = open; nextEnd = open + duration }
    if (nextEnd > close) { nextEnd = close; nextStart = close - duration }
    if (nextStart < open || nextEnd > close) return null
    return [nextStart, nextEnd]
  }

  // True when giving this person a shift on `day` would make a sixth working day this week.
  function tooManyDays(employeeId, day, ignoreShiftId = null) {
    if (!employeeId) return false
    const worked = new Set(shifts.filter((shift) => shift.employee_id === employeeId && shift.id !== ignoreShiftId).map((shift) => isoDay(new Date(shift.starts_at))))
    return !worked.has(day) && worked.size >= MAX_DAYS_PER_WEEK
  }
  function daysProblem(employeeId) {
    const person = staffById[employeeId]
    setProblem(`${person?.short_name || person?.name || 'This employee'} already works ${MAX_DAYS_PER_WEEK} days this week, the most allowed.`)
  }

  function addShiftFor(person, day, targetShiftId = null, targetSuggestion = null) {
    if (tooManyDays(person.id, day)) { daysProblem(person.id); return }
    const dayOpenShifts = shifts.filter((shift) => !shift.employee_id && isoDay(new Date(shift.starts_at)) === day)
    const openShift = targetShiftId
      ? dayOpenShifts.find((shift) => String(shift.id) === String(targetShiftId))
      : dayOpenShifts
      .filter((shift) => !shift.employee_id && isoDay(new Date(shift.starts_at)) === day && canFill(shift.role, {}, person))
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0]
    const requestedRole = openShift?.role || targetSuggestion?.role
    if (requestedRole && !canFill(requestedRole, {}, person)) {
      setProblem(`${person.short_name || person.name} cannot fill the ${requestedRole} shift.`)
      return
    }
    if (targetShiftId && !openShift) {
      setProblem('That shift is already assigned. Drop staff onto an open or suggested shift block.')
      return
    }
    if (openShift) {
      const start = new Date(openShift.starts_at)
      const end = new Date(openShift.ends_at)
      persist(() => saveShift(storeId, { id: openShift.id, employeeId: person.id, startsAt: start, endsAt: end, role: openShift.role, breakMinutes: openShift.break_minutes, note: openShift.note }),
        `Assigned ${person.short_name || person.name} to the ${clock(minutesIntoDay(openShift.starts_at, day))}–${clock(minutesIntoDay(openShift.ends_at, day))} shift.`)
      return
    }
    if (targetShiftId || targetSuggestion) {
      const start = minutesOf(targetSuggestion.start)
      const end = minutesOf(targetSuggestion.end)
      const breakMinutes = breakForShift(end - start)
      persist(() => saveShift(storeId, { employeeId: person.id, startsAt: at(day, start), endsAt: at(day, end), role: targetSuggestion.role, breakMinutes, note: targetSuggestion.label || 'Suggested shift block' }),
        `Assigned ${person.short_name || person.name} to the ${clock(start)}–${clock(end)} shift.`)
      return
    }
    if (dayOpenShifts.length) {
      setProblem(`${person.short_name || person.name} cannot fill any open shift on this day.`)
      return
    }
    const dayRules = rules.filter((rule) => Number(rule.weekday) === new Date(`${day}T00:00:00`).getDay())
    if (dayRules.length && !dayRules.some((rule) => canFill(rule.role, {}, person))) {
      setProblem(`${person.short_name || person.name} cannot fill the coverage roles needed on this day.`)
      return
    }
    const suggested = recommendedTimes(person, day)
    const window = minimumShiftWindow(day, suggested[0], suggested[1])
    if (!window) { setProblem('This store is open for less than the four-hour shift minimum.'); return }
    const [start, end] = window
    const breakMinutes = breakForShift(end - start)
    persist(() => saveShift(storeId, { employeeId: person.id, startsAt: at(day, start), endsAt: at(day, end), role: '', breakMinutes }),
      `Added ${person.short_name || person.name} on ${DAY_LONG[new Date(`${day}T00:00:00`).getDay()]} (${clock(start)}–${clock(end)}).`)
  }

  function createFromSuggestion(day, suggestion) {
    const start = minutesOf(suggestion.start)
    const end = minutesOf(suggestion.end)
    if (end - start < MIN_SHIFT_MINUTES || end - start > MAX_SHIFT_MINUTES) { setProblem('Shifts must be between 4 and 8 hours.'); return }
    const count = Math.max(1, Number(suggestion.needed || 1))
    persist(async () => {
      for (let index = 0; index < count; index += 1) {
        await saveShift(storeId, { employeeId: null, startsAt: at(day, start), endsAt: at(day, end), role: suggestion.role, breakMinutes: breakForShift(end - start), note: suggestion.label || 'Open shift block' })
      }
    }, `Created ${count} open ${suggestion.role} shift${count === 1 ? '' : 's'} (${clock(start)}–${clock(end)}). Drag staff onto ${count === 1 ? 'it' : 'them'} to assign.`)
  }

  function onDrop(event, day, targetShiftId = null, targetSuggestion = null) {
    event.preventDefault()
    const shiftId = event.dataTransfer.getData('text/x-shift')
    const staffId = event.dataTransfer.getData('text/x-staff')
    if (staffId) { const dragged = staffById[staffId]; if (dragged) addShiftFor(dragged, day, targetShiftId, targetSuggestion); return }
    const shift = shifts.find((entry) => String(entry.id) === shiftId)
    if (!shift) return
    const fromDay = isoDay(new Date(shift.starts_at))
    const start = minutesIntoDay(shift.starts_at, fromDay)
    const length = (new Date(shift.ends_at) - new Date(shift.starts_at)) / 60000
    if (length < MIN_SHIFT_MINUTES || length > MAX_SHIFT_MINUTES) { setProblem('Shifts must be between 4 and 8 hours.'); return }
    const copy = event.ctrlKey || event.altKey
    const moved = { employeeId: shift.employee_id, startsAt: at(day, start), endsAt: at(day, start + length), role: shift.role, breakMinutes: shift.break_minutes, note: shift.note }
    if (!copy && fromDay === day) return
    if (tooManyDays(shift.employee_id, day, copy ? null : shift.id)) { daysProblem(shift.employee_id); return }
    if (!copy) setShifts((current) => current.map((entry) => (entry.id === shift.id ? { ...entry, starts_at: moved.startsAt.toISOString(), ends_at: moved.endsAt.toISOString() } : entry)))
    persist(() => saveShift(storeId, { ...moved, id: copy ? null : shift.id }), copy ? 'Shift copied.' : 'Shift moved.')
  }

  function resize(shift, day, start, end) {
    if (end - start < MIN_SHIFT_MINUTES || end - start > MAX_SHIFT_MINUTES) { setProblem('Shifts must be between 4 and 8 hours.'); return }
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
    if (endMinutes - startMinutes < MIN_SHIFT_MINUTES || endMinutes - startMinutes > MAX_SHIFT_MINUTES) { setProblem('Shifts must be between 4 and 8 hours.'); return }
    if (tooManyDays(editor.employeeId, editor.day, editor.id)) { daysProblem(editor.employeeId); return }
    persist(() => saveShift(storeId, { id: editor.id, employeeId: editor.employeeId, startsAt: at(editor.day, startMinutes), endsAt: at(editor.day, endMinutes), role: editor.role, breakMinutes: editor.breakMinutes, note: editor.note }), 'Shift saved.')
    closeEditor()
  }
  function duplicateEditor() {
    const next = new Date(`${editor.day}T00:00:00`)
    next.setDate(next.getDate() + 1)
    const day = isoDay(next)
    let endMinutes = minutesOf(editor.end)
    if (endMinutes <= minutesOf(editor.start)) endMinutes += 24 * 60
    if (endMinutes - minutesOf(editor.start) < MIN_SHIFT_MINUTES || endMinutes - minutesOf(editor.start) > MAX_SHIFT_MINUTES) { setProblem('Shifts must be between 4 and 8 hours.'); return }
    if (tooManyDays(editor.employeeId, day)) { daysProblem(editor.employeeId); return }
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
      const previousShifts = published?.shifts || []
      const version = await publishSchedule(storeId, weekKey)
      setPublished(await loadScheduleWeek(storeId, weekKey))
      const done = `Published${Number(version) > 1 ? ` (version ${version}; changes are marked for staff)` : ''}. Staff can now see the week of ${weekStart.toLocaleDateString([], { month: 'long', day: 'numeric' })}.`
      setNotice(`${done} Emailing staff their schedules…`)
      try {
        const { sent, skipped, failed } = await emailPublishedSchedule(storeId, weekKey, previousShifts)
        const list = (names) => names.join(', ')
        setNotice([
          done,
          sent.length ? `Emailed ${sent.length === 1 ? sent[0] : `${sent.length} staff (${list(sent)})`}.` : Number(version) > 1 ? "Nobody's shifts changed, so no emails were sent." : 'No emails were sent.',
          skipped.length ? `No contact email for ${list(skipped)}: add it in their personal information.` : '',
          failed.length ? `Couldn't email ${list(failed)}.` : '',
        ].filter(Boolean).join(' '))
      } catch (emailError) {
        setNotice(`${done} The schedule emails weren't sent: ${emailError?.message || emailError}.`)
      }
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  async function clearWeek() {
    if (!shifts.length) {
      setNotice('There are no shifts to clear in this week.')
      return
    }
    const label = weekStart.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })
    if (!window.confirm(`Clear all ${shifts.length} shifts for the week of ${label}? Coverage needs will stay saved.`)) return
    setBusy(true)
    setProblem('')
    setNotice('')
    try {
      await clearSchedule(storeId, weekStart, weekEnd)
      await reloadShifts()
      closeEditor()
      setNotice(`Cleared ${shifts.length} shift${shifts.length === 1 ? '' : 's'} for the week of ${label}.`)
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  function jumpTo(warning) {
    setHighlight({ day: warning.day, employeeId: warning.employeeId })
    const selector = warning.day ? `[data-day="${warning.day}"]` : warning.employeeId ? `[data-staff="${warning.employeeId}"]` : ''
    const target = selector ? gridRef.current?.querySelector(selector) : null
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
        <button type="button" className={`sb-warnings-button${summary.coverageWarnings ? ' has' : ''}`} onClick={() => setShowWarnings((open) => !open)}>
          <AlertTriangle size={15} /> {summary.coverageWarnings ? `${summary.coverageWarnings} Coverage Warning${summary.coverageWarnings === 1 ? '' : 's'}` : 'No coverage warnings'}{summary.total - summary.coverageWarnings ? ` · ${summary.total - summary.coverageWarnings} other` : ''}
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
        <span className="sb-view-toggle" role="group" aria-label="Schedule view">
          <button type="button" className={viewMode === 'week' ? 'active' : ''} onClick={() => setViewMode('week')}><LayoutGrid size={14} /> Weekly</button>
          <button type="button" className={viewMode === 'daily' ? 'active' : ''} onClick={() => setViewMode('daily')}><CalendarDays size={14} /> Daily</button>
        </span>
        {viewMode === 'daily' ? <select className="sb-day-picker" value={selectedDay || days[0]} onChange={(event) => setSelectedDay(event.target.value)} aria-label="Day"><option value="" disabled>Choose day</option>{days.map((day) => <option key={day} value={day}>{DAY_LONG[new Date(`${day}T00:00:00`).getDay()]} {new Date(`${day}T00:00:00`).getDate()}</option>)}</select> : null}
        <button type="button" className="sb-needs-button" aria-expanded={showNeeds} onClick={(event) => { event.stopPropagation(); setShowNeeds((open) => !open) }}><Settings2 size={14} /> Shift blocks</button>
        <button type="button" className="sb-clear-button" onClick={clearWeek} disabled={busy || loading || !shifts.length} title="Clear all shifts in this week"><Trash2 size={14} /> Clear week</button>
      </div>
      {notice ? <p className="myhr-notice">{notice}</p> : null}
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      <div className="sb-needs-wrap" hidden={!showNeeds}><CoverageNeeds storeId={storeId} rules={rules} roles={roles} storeHours={storeHours} salesActivity={salesActivity} weekStart={weekStart} shifts={shifts} staff={staff} onChanged={async () => { await reloadRules(); await reloadShifts() }} /></div>

      <div className="sb-builder" ref={gridRef} onClick={closeEditor}>
        {viewMode === 'daily' ? <DailyTimeline day={selectedDay || days[0]} shifts={shifts} suggestions={suggestions} storeHours={storeHours} coverageResult={coverage[selectedDay || days[0]]} staffById={staffById} warnedShift={warnedShift} unpublishedIds={unpublishedIds} onDrop={onDrop} onSelect={select} onResize={resize} onCreateSuggestion={createFromSuggestion} /> : <div className="sb-days">
          {loading ? <p className="myhr-muted">Loading…</p> : days.map((day) => {
            const date = new Date(`${day}T00:00:00`)
            const result = coverage[day] || { results: [], surplus: [] }
            const dayShifts = shifts
              .filter((shift) => isoDay(new Date(shift.starts_at)) === day)
              .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
            const flash = highlight?.day === day
            return (
              <section
                key={day}
                data-day={day}
                className={`sb-day${day === isoDay(new Date()) ? ' today' : ''}${flash ? ' flash' : ''}`}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = Array.from(event.dataTransfer.types).includes('text/x-staff') || event.ctrlKey || event.altKey ? 'copy' : 'move' }}
                onDrop={(event) => onDrop(event, day)}
              >
                <header className="sb-day-head">
                  <strong>{DAY_LONG[date.getDay()]} <span>{date.getDate()}</span></strong>
                  {Object.keys(storeHours).length ? <small className="sb-hours">{dayHours(storeHours, date.getDay()) ? `${clock(minutesOf(dayHours(storeHours, date.getDay()).open)).replace(':00', '')} – ${clock(minutesOf(dayHours(storeHours, date.getDay()).close)).replace(':00', '')}` : 'Closed'}</small> : null}
                </header>
                <div className="sb-day-coverage">
                  {result.results.filter((item) => !item.ok).map((item) => (
                    <span key={item.rule.id} className={`sb-cov ${item.ok ? 'ok' : 'bad'}`} title={item.rule.label || ''}>
                    <>Short {item.gaps.map((gap) => `${clock(gap.from).replace(':00', '')}–${clock(gap.to).replace(':00', '')} (${gap.value} short)`).join(', ')}</>
                    </span>
                  ))}
                  {!result.results.length ? <small className="myhr-muted">No needs set</small> : null}
                  {result.surplus.map((segment) => <span key={segment.from} className="sb-cov over" title={`Overstaffed by ${segment.value} · +${segment.extraHours} labour hours`}>+{segment.value} over · {clock(segment.from).replace(':00', '')}–{clock(segment.to).replace(':00', '')}</span>)}
                </div>
                <div className="sb-day-shifts">
                  {dayShifts.length ? dayShifts.map((shift) => {
                    const person = staffById[shift.employee_id]
                    return (
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
                    )
                  }) : <p className="sb-empty-day">Drop staff to assign a shift</p>}
                </div>
              </section>
            )
          })}
        </div>}
        <aside className="sb-roster" aria-label="Staff roster">
          <header>
            <strong>Staff</strong>
            <small className="myhr-muted">Drag names into a day</small>
          </header>
          <div className="sb-roster-list">
            {staff.map((person) => {
              const hours = hoursFor(person)
              const target = person.target_hours != null ? Number(person.target_hours) : null
              const flagged = personWarnings(person)
              return (
                <div key={person.id} data-staff={person.id} className={`sb-roster-person${highlight?.employeeId === person.id && !highlight.day ? ' flash' : ''}`}>
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
                </div>
              )
            })}
          </div>
        </aside>
      </div>

      {editor ? (
        <div className="sb-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor() }}>
          <form className="myhr-sap-panel sb-editor" role="dialog" aria-modal="true" aria-labelledby="sb-editor-title" onSubmit={saveEditor} onClick={(event) => event.stopPropagation()}>
            <div className="myhr-sap-head"><strong id="sb-editor-title">Edit shift</strong><button type="button" onClick={closeEditor} aria-label="Close"><X size={14} /></button></div>
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
        </div>
      ) : null}
      <small className="myhr-muted">Drag a shift to another day to move it, hold Ctrl or Alt while dropping to copy it, drag its left or right edge to change the start or end (15-minute steps), or click it to edit. Drag a name from the staff list onto a day to add a shift. Staff only see a week once it's published.</small>
    </div>
  )
}
