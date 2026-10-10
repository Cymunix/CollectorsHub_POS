import React, { useEffect, useMemo, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, RotateCcw, Save, Send, Trash2, X } from 'lucide-react'
import { decideTimesheet, loadMyLeave, loadMySchedule, loadMyTime, loadMyTimesheets, loadStoreTimesheets, saveTimesheet } from './lib/myhrPay'
import { TIMESHEET_ROWS, applyOverrides, autoWeek, entryHoursByDay, isoDay, rowLabel, sundayOf, weekDays } from './lib/timesheet'

// Record Working Times: a calendar of weeks (approval required / rejected /
// approved) and the weekly or daily timesheet. Each week starts automatic
// (clock in/out, overtime over 7 hours a day, approved paid leave) and the
// employee can change any cell, add or remove rows, then Save and send it
// for approval. Managers approve or reject sent weeks below.

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAY_LETTERS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const STATUS_TEXT = { draft: 'Not sent', submitted: 'Approval required', approved: 'Approved', rejected: 'Rejected' }
const hoursText = (value) => Number(value || 0).toFixed(2)
const dayHeader = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: '2-digit' })
const dateText = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
const timeText = (value) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

// ISO week number of a date.
function weekNumber(date) {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dow = day.getUTCDay() || 7
  day.setUTCDate(day.getUTCDate() + 4 - dow)
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1))
  return Math.ceil(((day - yearStart) / 86400000 + 1) / 7)
}

function MonthCalendar({ year, month, statusOf, selectedWeek, onPick }) {
  // The weeks (Sundays) that have a day in this month.
  const last = new Date(year, month + 1, 0)
  const rows = []
  for (const week = sundayOf(new Date(year, month, 1)); week <= last; week.setDate(week.getDate() + 7)) rows.push(new Date(week))
  const today = isoDay(new Date())
  return (
    <div className="ts-month">
      <strong>{MONTH_NAMES[month]} {year}</strong>
      <table>
        <thead><tr><th />{DAY_LETTERS.map((letter) => <th key={letter}>{letter}</th>)}</tr></thead>
        <tbody>
          {rows.map((weekStart) => {
            const sunday = isoDay(weekStart)
            const status = statusOf(sunday)
            return (
              <tr key={sunday} className={sunday === selectedWeek ? 'selected' : ''}>
                <td className="ts-weekno"><button type="button" onClick={() => onPick(weekStart)}>{weekNumber(weekStart)}</button></td>
                {weekDays(weekStart).map((day) => {
                  const date = new Date(`${day}T00:00:00`)
                  const outside = date.getMonth() !== month
                  return (
                    <td key={day} className={`ts-day${outside ? ' outside' : ''}${status ? ` ${status}` : ''}${day === today ? ' today' : ''}`}>
                      <button type="button" onClick={() => onPick(date)}>{date.getDate()}</button>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TimesheetApprovals({ storeId }) {
  const [weeks, setWeeks] = useState(null)
  const [open, setOpen] = useState('')
  const [notes, setNotes] = useState({})
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)

  async function reload() {
    try {
      setWeeks(await loadStoreTimesheets(storeId))
      setProblem('')
    } catch (error) {
      setWeeks([])
      setProblem(error?.message || String(error))
    }
  }
  useEffect(() => { reload() }, [storeId])

  async function decide(week, approve) {
    if (!approve && !String(notes[week.id] || '').trim()) { setProblem('Add a remark saying why it’s rejected.'); setOpen(week.id); return }
    setBusy(true)
    try {
      await decideTimesheet(storeId, week.id, approve, notes[week.id])
      await reload()
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="myhr-sap-panel">
      <div className="myhr-sap-head"><strong>Timesheets to approve</strong></div>
      {problem ? <p className="myhr-editor-problem ts-pad">{problem}</p> : null}
      {weeks === null ? <p className="myhr-empty ts-pad">Loading…</p> : weeks.length ? (
        <ul className="myhr-pay-list ts-pad">
          {weeks.map((week) => {
            const days = weekDays(new Date(`${week.week_start}T00:00:00`))
            return (
              <li key={week.id} className="ts-approval">
                <span className="ts-approval-head">
                  <button type="button" className="ts-link" onClick={() => setOpen(open === week.id ? '' : week.id)}>
                    <strong>{week.employee_name}</strong> <small>week of {dateText(week.week_start)} · {hoursText(week.total_hours)} h{Number(week.overtime_hours) ? ` · ${hoursText(week.overtime_hours)} h overtime` : ''}</small>
                  </button>
                  <span className="myhr-pay-actions">
                    <button type="button" className="myhr-approve" disabled={busy} onClick={() => decide(week, true)}><Check size={15} /> Approve</button>
                    <button type="button" className="myhr-decline" disabled={busy} onClick={() => decide(week, false)}><X size={15} /> Reject</button>
                  </span>
                </span>
                {open === week.id ? (
                  <>
                    <table className="myhr-wage-table ts-table compact">
                      <thead><tr><th>Type</th>{days.map((day) => <th key={day} className="num">{dayHeader(day)}</th>)}<th className="num">Total</th></tr></thead>
                      <tbody>
                        {(week.submitted_lines || []).map((line) => (
                          <tr key={line.row}><td>{line.label || rowLabel(line.row)}</td>{days.map((day) => <td key={day} className="num">{hoursText(line.days?.[day])}</td>)}<td className="num"><b>{hoursText(line.total)}</b></td></tr>
                        ))}
                      </tbody>
                    </table>
                    <input className="ts-remark" value={notes[week.id] || ''} onChange={(event) => setNotes((current) => ({ ...current, [week.id]: event.target.value }))} placeholder="Remark (required to reject)" />
                  </>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : <p className="myhr-empty ts-pad">No timesheets waiting for approval.</p>}
    </section>
  )
}

export default function MyHRTimesheet({ storeId, isManager }) {
  const [weekStart, setWeekStart] = useState(() => sundayOf(new Date()))
  const [weekInput, setWeekInput] = useState(() => isoDay(sundayOf(new Date())))
  const [anchor, setAnchor] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1) })
  const [tab, setTab] = useState('weekly')
  const [selectedDay, setSelectedDay] = useState(() => isoDay(new Date()))
  const [entries, setEntries] = useState([])
  const [leave, setLeave] = useState([])
  const [shifts, setShifts] = useState([])
  const [weeks, setWeeks] = useState({})
  const [draft, setDraft] = useState({})
  const [addRow, setAddRow] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')

  const weekKey = isoDay(weekStart)
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 7)
  const calFrom = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1)
  const calTo = new Date(anchor.getFullYear(), anchor.getMonth() + 2, 0)

  async function loadWeeks() {
    const rows = await loadMyTimesheets(storeId, isoDay(sundayOf(calFrom)), isoDay(calTo))
    setWeeks((current) => ({ ...current, ...Object.fromEntries(rows.map((row) => [row.week_start, row])) }))
    return rows
  }

  useEffect(() => { loadWeeks().catch((error) => setProblem(error?.message || String(error))) }, [storeId, anchor.getTime()])

  useEffect(() => {
    let live = true
    setLoading(true)
    Promise.all([
      loadMyTime(storeId, isoDay(new Date(weekStart.getTime() - 86400000))),
      loadMyLeave(storeId),
      loadMySchedule(storeId, weekStart, weekEnd),
      loadMyTimesheets(storeId, weekKey, weekKey),
    ]).then(([time, myLeave, myShifts, thisWeek]) => {
      if (!live) return
      setEntries(time)
      setLeave(myLeave)
      setShifts(myShifts)
      const row = thisWeek[0]
      if (row) setWeeks((current) => ({ ...current, [row.week_start]: row }))
      setDraft(row?.overrides || {})
      setProblem('')
    }).catch((error) => { if (live) setProblem(error?.message || String(error)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [storeId, weekKey])

  const saved = weeks[weekKey]
  const locked = saved?.status === 'approved'
  const auto = useMemo(() => autoWeek({ weekStart, entries, leave, shifts }), [weekKey, entries, leave, shifts])
  const live = useMemo(() => applyOverrides(auto, draft), [auto, draft])
  // An approved week shows what was approved.
  const view = locked && saved?.submitted_lines ? {
    ...live,
    lines: saved.submitted_lines.map((line) => ({ ...line, edited: {} })),
    actual: Object.fromEntries(live.days.map((day) => [day, saved.submitted_lines.reduce((sum, line) => sum + Number(line.days?.[day] || 0), 0)])),
  } : live

  function pickWeek(date) {
    const sunday = sundayOf(date)
    setWeekStart(sunday)
    setWeekInput(isoDay(sunday))
    setSelectedDay(isoDay(date))
    setNotice('')
  }
  function moveWeek(weeksBy) {
    const next = new Date(weekStart)
    next.setDate(next.getDate() + weeksBy * 7)
    pickWeek(next)
    if (next < calFrom || next > calTo) setAnchor(new Date(next.getFullYear(), next.getMonth(), 1))
  }

  function setCell(row, day, value) {
    setDraft((current) => {
      const cells = { ...(current.cells || {}) }
      const rowCells = { ...(cells[row] || {}) }
      if (value === '') delete rowCells[day]
      else rowCells[day] = value
      cells[row] = rowCells
      return { ...current, cells }
    })
  }
  function removeRow(line) {
    setDraft((current) => {
      const cells = { ...(current.cells || {}) }
      delete cells[line.row]
      const extraRows = (current.extraRows || []).filter((row) => row !== line.row)
      // Attendance and overtime always stay (removing just resets them).
      const hiddenRows = line.auto && !['attendance', 'overtime'].includes(line.row) ? [...new Set([...(current.hiddenRows || []), line.row])] : (current.hiddenRows || [])
      return { ...current, cells, extraRows, hiddenRows }
    })
  }
  function insertRow() {
    if (!addRow) return
    setDraft((current) => ({
      ...current,
      extraRows: [...new Set([...(current.extraRows || []), addRow])],
      hiddenRows: (current.hiddenRows || []).filter((row) => row !== addRow),
    }))
    setAddRow('')
  }

  async function save(submit) {
    setBusy(true)
    setProblem('')
    setNotice('')
    try {
      const lines = view.lines.map(({ row, label, days, total }) => ({ row, label, days, total }))
      const status = await saveTimesheet(storeId, { weekStart: weekKey, overrides: draft, lines, total: view.total, overtime: view.overtime, submit })
      await loadWeeks()
      const [row] = await loadMyTimesheets(storeId, weekKey, weekKey)
      if (row) setWeeks((current) => ({ ...current, [weekKey]: row }))
      setNotice(submit ? `Week of ${dateText(weekKey)} sent for approval (${hoursText(view.total)} hours).` : `Saved (${STATUS_TEXT[status] || status}).`)
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  const statusOf = (sunday) => {
    const status = weeks[sunday]?.status
    return status === 'submitted' ? 'pending' : status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : ''
  }
  const months = [-1, 0, 1].map((offset) => new Date(anchor.getFullYear(), anchor.getMonth() + offset, 1))
  const shownRows = new Set(view.lines.map((line) => line.row))
  // Every shift that worked part of the selected day (including one that started the day before).
  const dayEntries = entries.filter((entry) => entryHoursByDay(entry).some((part) => part.day === selectedDay))
  const daysShown = tab === 'daily' ? [view.days.includes(selectedDay) ? selectedDay : view.days[0]] : view.days

  const cell = (line, day) => {
    if (locked) return <td key={day} className="num">{hoursText(line.days[day])}</td>
    const override = draft.cells?.[line.row]?.[day]
    return (
      <td key={day} className={`num ts-cell${line.edited?.[day] ? ' edited' : ''}`}>
        <input
          type="number"
          min="0"
          step="0.25"
          value={override ?? (line.days[day] ? String(line.days[day]) : '')}
          placeholder="0"
          onChange={(event) => setCell(line.row, day, event.target.value)}
          title={line.edited?.[day] ? 'Changed by you. Clear it to go back to the automatic hours.' : 'Automatic. Type to change it.'}
        />
      </td>
    )
  }

  return (
    <div className="ts-page">
      <div className="myhr-form-toolbar ts-toolbar">
        <button type="button" onClick={() => save(true)} disabled={busy || locked || loading}><Send size={15} /> Save and send</button>
        <button type="button" onClick={() => save(false)} disabled={busy || locked || loading}><Save size={15} /> Save</button>
        {notice ? <span className="myhr-notice">{notice}</span> : null}
      </div>
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}

      <section className="myhr-sap-panel">
        <div className="myhr-sap-head"><strong>Calendar</strong></div>
        <div className="ts-calendar-row">
          <div className="ts-calendar">
            <button type="button" className="ts-cal-nav" onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))} aria-label="Earlier months"><ChevronLeft size={16} /></button>
            {months.map((month) => (
              <MonthCalendar key={month.toISOString()} year={month.getFullYear()} month={month.getMonth()} statusOf={statusOf} selectedWeek={weekKey} onPick={pickWeek} />
            ))}
            <button type="button" className="ts-cal-nav" onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))} aria-label="Later months"><ChevronRight size={16} /></button>
          </div>
          <div className="ts-status">
            <div><span>Completion Status</span><strong>{STATUS_TEXT[saved?.status || 'draft']}{saved?.processor && ['approved', 'rejected'].includes(saved.status) ? ` · ${saved.processor}` : ''}</strong></div>
            <div><span>Remark</span><strong>{saved?.decision_note || '—'}</strong></div>
            <div><span>Week total</span><strong>{hoursText(view.total)} h{view.overtime ? ` (${hoursText(view.overtime)} overtime)` : ''}</strong></div>
          </div>
        </div>
        <div className="ts-legend">
          <span className="pending">Approval Required</span>
          <span className="rejected">Rejected</span>
          <span className="approved">Approved</span>
          <span className="today">Today</span>
        </div>
      </section>

      <section className="myhr-sap-panel">
        <div className="myhr-sap-head"><strong>Timesheet</strong></div>
        <div className="ts-tabs" role="tablist">
          {[['weekly', 'Weekly'], ['daily', 'Daily']].map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>
        <div className="myhr-sap-filter ts-filter">
          <button type="button" onClick={() => moveWeek(-1)}><ChevronLeft size={14} /> Previous Period</button>
          <button type="button" onClick={() => moveWeek(1)}>Next Period <ChevronRight size={14} /></button>
          <label>Week From: <input type="date" value={weekInput} onChange={(event) => setWeekInput(event.target.value)} /></label>
          <button type="button" onClick={() => weekInput && pickWeek(new Date(`${weekInput}T00:00:00`))}>Apply</button>
          {tab === 'daily' ? (
            <label>Day:
              <select value={daysShown[0]} onChange={(event) => setSelectedDay(event.target.value)}>
                {view.days.map((day) => <option key={day} value={day}>{dayHeader(day)}</option>)}
              </select>
            </label>
          ) : null}
          {!locked ? (
            <span className="ts-insert">
              <select value={addRow} onChange={(event) => setAddRow(event.target.value)}>
                <option value="">Add a row…</option>
                {TIMESHEET_ROWS.filter(([key]) => !shownRows.has(key)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
              <button type="button" onClick={insertRow} disabled={!addRow}>Insert Row</button>
            </span>
          ) : null}
        </div>
        <div className="myhr-sap-table-wrap ts-wrap">
          <table className="myhr-wage-table ts-table">
            <thead>
              <tr>
                <th className="icon">{locked ? '' : 'Del.'}</th>
                <th>Att./Abs. type</th>
                {daysShown.map((day) => <th key={day} className={`num${day === isoDay(new Date()) ? ' today' : ''}`}>{dayHeader(day)}</th>)}
                {tab === 'weekly' ? <th className="num">Total</th> : null}
              </tr>
            </thead>
            <tbody>
              <tr className="ts-info"><td /><td>Planned</td>{daysShown.map((day) => <td key={day} className="num">{view.planned[day] ? hoursText(view.planned[day]) : ''}</td>)}{tab === 'weekly' ? <td className="num">{hoursText(Object.values(view.planned).reduce((sum, value) => sum + value, 0))}</td> : null}</tr>
              <tr className="ts-info"><td /><td>Actual</td>{daysShown.map((day) => <td key={day} className="num">{hoursText(view.actual[day])}</td>)}{tab === 'weekly' ? <td className="num"><b>{hoursText(view.total)}</b></td> : null}</tr>
              {loading ? <tr><td colSpan={10} className="myhr-muted">Loading…</td></tr> : view.lines.map((line) => (
                <tr key={line.row}>
                  <td className="icon">
                    {!locked ? (
                      <button type="button" onClick={() => removeRow(line)} title={['attendance', 'overtime'].includes(line.row) ? 'Reset to the automatic hours' : 'Remove this row'}>
                        {['attendance', 'overtime'].includes(line.row) ? <RotateCcw size={14} /> : <Trash2 size={14} />}
                      </button>
                    ) : null}
                  </td>
                  <td>{line.label}{line.auto ? <small className="myhr-muted"> auto</small> : null}</td>
                  {daysShown.map((day) => cell(line, day))}
                  {tab === 'weekly' ? <td className="num"><b>{hoursText(line.total)}</b></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {tab === 'daily' ? (
          <div className="ts-pad">
            <h4 className="ts-subhead">Clock in / out on {dayHeader(daysShown[0])}</h4>
            {dayEntries.length ? (
              <ul className="myhr-pay-list compact">
                {dayEntries.map((entry) => <li key={entry.id}><span><strong>{timeText(entry.clock_in)} – {entry.clock_out ? timeText(entry.clock_out) : 'now'}</strong></span></li>)}
              </ul>
            ) : <p className="myhr-empty">No clock-ins that day.</p>}
          </div>
        ) : null}
        <small className="myhr-muted ts-pad">Automatic from your clock in/out: over 7 hours in a day counts as overtime, and approved paid leave is added. Change any number if it's wrong; highlighted numbers are your changes. {locked ? 'This week is approved and can no longer be changed.' : ''}</small>
      </section>

      {isManager ? <TimesheetApprovals storeId={storeId} /> : null}
    </div>
  )
}
