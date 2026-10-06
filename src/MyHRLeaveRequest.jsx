import React, { useEffect, useMemo, useState } from 'react'
import { Send, SendHorizontal } from 'lucide-react'
import {
  LEAVE_DESCRIPTIONS,
  LEAVE_TYPES,
  hoursBetween,
  isoDate,
  leaveHours,
  leaveTypeLabel,
  loadStoreApprovers,
  loadTeamAbsences,
  loadTeamMembers,
  loadTeamShiftDays,
  requestLeave,
  updateLeave,
} from './lib/myhrPay'
import { novaScotiaHolidays } from './lib/holidays'
import { LeaveOverview } from './MyHRLeave'

// Leave Request: New. Tabs for the employee's own calendar, the Team
// Calendar (who at the store is off, sent or approved; never the type of
// someone else's leave), time accounts and leave requests; then the leave
// details (type, dates and times, duration, approver, comments) with Send /
// Send and New.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (number) => String(number).padStart(2, '0')
const dayIso = (year, month, day) => `${year}-${pad(month + 1)}-${pad(day)}`
const dateText = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })

function MonthGrid({ year, month, members, absences, shiftDays, holidays, sortAsc }) {
  const count = new Date(year, month + 1, 0).getDate()
  const days = Array.from({ length: count }, (_, index) => dayIso(year, month, index + 1))
  const today = isoDate(new Date())
  const hasSchedule = shiftDays.length > 0
  const scheduled = useMemo(() => new Set(shiftDays.map((row) => `${row.employee_id}|${String(row.day).slice(0, 10)}`)), [shiftDays])
  const sorted = [...members].sort((a, b) => (sortAsc ? 1 : -1) * String(a.last_name || a.name).localeCompare(String(b.last_name || b.name)))

  const absenceOn = (employeeId, day) => {
    const hits = absences.filter((row) => row.employee_id === employeeId && row.start_date <= day && row.end_date >= day)
    if (!hits.length) return null
    if (hits.length > 1) return { kind: 'multiple', title: 'Multiple entries' }
    const hit = hits[0]
    const type = hit.leave_type ? `${leaveTypeLabel(hit.leave_type)}: ` : ''
    return hit.status === 'approved' ? { kind: 'absent', title: `${type}Absent` } : { kind: 'sent', title: `${type}Sent (waiting for approval)` }
  }

  return (
    <div className="lr-grid-wrap">
      <table className="lr-grid">
        <thead>
          <tr><th className="lr-name" /><th colSpan={count} className="lr-month">{year} {MONTHS[month]}</th></tr>
          <tr>
            <th className="lr-name" />
            {days.map((day) => <th key={day} className={day === today ? 'today' : ''}>{DAY_SHORT[new Date(`${day}T00:00:00`).getDay()]}<br />{Number(day.slice(8))}</th>)}
          </tr>
        </thead>
        <tbody>
          {sorted.map((member) => (
            <tr key={member.id} className={member.is_me ? 'me' : ''}>
              <th className="lr-name">{member.name}</th>
              {days.map((day) => {
                const absence = absenceOn(member.id, day)
                const holiday = holidays[day]
                const nonWorking = hasSchedule && !scheduled.has(`${member.id}|${day}`)
                const kind = absence?.kind || (holiday ? 'holiday' : nonWorking ? 'off' : '')
                const title = [absence?.title, holiday, !absence && nonWorking ? 'Not scheduled' : ''].filter(Boolean).join(' · ')
                return <td key={day} className={`${kind}${day === today ? ' today' : ''}`} title={title} />
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function MyHRLeaveRequest({ storeId, editing = null, onDone, onEditRequest }) {
  const now = new Date()
  const today = isoDate(now)
  const [tab, setTab] = useState('team')
  const [month, setMonth] = useState(now.getMonth())
  const [year, setYear] = useState(now.getFullYear())
  const [sortAsc, setSortAsc] = useState(true)
  const [members, setMembers] = useState([])
  const [absences, setAbsences] = useState([])
  const [shiftDays, setShiftDays] = useState([])
  const [approvers, setApprovers] = useState([])
  const [refreshedAt, setRefreshedAt] = useState(null)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const blank = { type: 'vacation', start: '', end: '', startTime: '09:00', endTime: '17:00', hours: '', comments: '' }
  const [form, setForm] = useState(() => (editing ? {
    type: editing.leave_type,
    start: editing.start_date,
    end: editing.end_date,
    startTime: String(editing.start_time || '09:00').slice(0, 5),
    endTime: String(editing.end_time || '17:00').slice(0, 5),
    hours: String(leaveHours(editing)),
    comments: editing.note || '',
  } : blank))
  const [hoursTouched, setHoursTouched] = useState(Boolean(editing))

  const from = dayIso(year, month, 1)
  const to = dayIso(year, month, new Date(year, month + 1, 0).getDate())
  const holidays = useMemo(() => novaScotiaHolidays(year), [year])

  async function refresh() {
    try {
      const [team, away, shifts, names] = await Promise.all([
        loadTeamMembers(storeId), loadTeamAbsences(storeId, from, to), loadTeamShiftDays(storeId, from, to), loadStoreApprovers(storeId),
      ])
      setMembers(team)
      setAbsences(away)
      setShiftDays(shifts)
      setApprovers(names)
      setRefreshedAt(new Date())
      setProblem('')
    } catch (error) {
      setProblem(error?.message || String(error))
    }
  }
  useEffect(() => { refresh() }, [storeId, from])

  // Duration: the daily hours (end − start time) on each day of the range.
  function update(changes) {
    setForm((current) => {
      const next = { ...current, ...changes }
      if (next.start && (!next.end || next.end < next.start)) next.end = next.start
      if (!hoursTouched && next.start && next.end) {
        const days = Math.round((new Date(`${next.end}T00:00:00`) - new Date(`${next.start}T00:00:00`)) / 86400000) + 1
        next.hours = String(Math.round(hoursBetween(next.startTime, next.endTime) * Math.max(1, days) * 100) / 100)
      }
      return next
    })
  }

  async function send(andNew) {
    const hours = Number(form.hours)
    if (!form.start || !form.end) { setProblem('Enter the start and end date.'); return }
    if (!(hours > 0)) { setProblem('Enter the duration in hours.'); return }
    if (form.start === form.end && form.endTime <= form.startTime) { setProblem('The end time has to be after the start time.'); return }
    setSaving(true)
    setProblem('')
    try {
      const request = { type: form.type, start: form.start, end: form.end, startTime: form.startTime, endTime: form.endTime, hours, note: form.comments }
      if (editing) await updateLeave(storeId, editing.id, request)
      else await requestLeave(storeId, request)
      const message = `${leaveTypeLabel(form.type)} ${editing ? 'updated' : 'sent'}: ${dateText(form.start)}${form.end !== form.start ? ` – ${dateText(form.end)}` : ''}, ${hours} hours.`
      if (andNew && !editing) {
        setForm(blank)
        setHoursTouched(false)
        setNotice(message)
        refresh()
      } else {
        onDone?.(message)
      }
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setSaving(false)
    }
  }

  const myAbsences = absences.filter((row) => members.find((member) => member.id === row.employee_id)?.is_me)
  const me = members.filter((member) => member.is_me)

  return (
    <div className="lr-page">
      <div className="myhr-form-toolbar ts-toolbar">
        <button type="button" onClick={() => send(false)} disabled={saving}><Send size={15} /> {editing ? 'Save' : 'Send'}</button>
        {!editing ? <button type="button" onClick={() => send(true)} disabled={saving}><SendHorizontal size={15} /> Send and New</button> : null}
        <button type="button" onClick={() => onDone?.('')} disabled={saving}>Cancel</button>
        {notice ? <span className="myhr-notice">{notice}</span> : null}
      </div>
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}

      <section className="myhr-sap-panel">
        <div className="ts-tabs lr-tabs" role="tablist">
          {[['calendar', 'Calendar'], ['team', 'Team Calendar'], ['accounts', 'Time Accounts'], ['requests', 'Leave Requests']].map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>

        {tab === 'calendar' || tab === 'team' ? (
          <>
            <div className="myhr-sap-filter lr-filter">
              <label>View:
                <select value={month} onChange={(event) => setMonth(Number(event.target.value))}>
                  {MONTHS.map((name, index) => <option key={name} value={index}>{name}</option>)}
                </select>
                <select value={year} onChange={(event) => setYear(Number(event.target.value))}>
                  {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              {tab === 'team' ? (
                <label>Sort by:
                  <select value={sortAsc ? 'asc' : 'desc'} onChange={(event) => setSortAsc(event.target.value === 'asc')}>
                    <option value="asc">Names Ascending</option>
                    <option value="desc">Names Descending</option>
                  </select>
                </label>
              ) : null}
              <span className="lr-refresh"><button type="button" className="ts-link" onClick={refresh}>Refresh</button> {refreshedAt ? `Data from: ${refreshedAt.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ''}</span>
            </div>
            <MonthGrid
              year={year}
              month={month}
              members={tab === 'team' ? members : me}
              absences={tab === 'team' ? absences : myAbsences}
              shiftDays={shiftDays}
              holidays={holidays}
              sortAsc={sortAsc}
            />
            <div className="ts-legend lr-legend">
              <span className="sent">Sent</span>
              <span className="absent">Absent</span>
              <span className="off">Non-Working Day</span>
              <span className="holiday">Holiday</span>
              <span className="multiple">Multiple Entries</span>
            </div>
            {tab === 'team' ? <small className="myhr-muted ts-pad">You can see when coworkers are off, not why. Hover a day for details.</small> : null}
          </>
        ) : null}
        {tab === 'accounts' ? <div className="ts-pad"><LeaveOverview storeId={storeId} only="accounts" /></div> : null}
        {tab === 'requests' ? <div className="ts-pad"><LeaveOverview storeId={storeId} only="requests" onEdit={(request) => onEditRequest?.(request)} /></div> : null}
      </section>

      <section className="myhr-sap-panel">
        <div className="myhr-sap-head"><strong>Leave Details</strong></div>
        <div className="myhr-form-columns cols-1 lr-details">
          <fieldset className="myhr-form-section">
            <legend>Type of Leave</legend>
            <label className="myhr-form-row"><span><b className="myhr-required">*</b>Type of Leave:</span>
              <select value={form.type} onChange={(event) => update({ type: event.target.value })}>
                {LEAVE_TYPES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            <div className="myhr-form-row"><span>Description:</span><span className="lr-description">{LEAVE_DESCRIPTIONS[form.type] || ''}</span></div>
          </fieldset>
          <fieldset className="myhr-form-section">
            <legend>General Data</legend>
            <label className="myhr-form-row"><span><b className="myhr-required">*</b>Start Date:</span>
              <span className="lr-pair"><input type="date" value={form.start} min={editing ? undefined : today} onChange={(event) => update({ start: event.target.value })} /><input type="time" value={form.startTime} onChange={(event) => update({ startTime: event.target.value })} aria-label="Start time" /></span>
            </label>
            <label className="myhr-form-row"><span><b className="myhr-required">*</b>End Date:</span>
              <span className="lr-pair"><input type="date" value={form.end} min={form.start || undefined} onChange={(event) => update({ end: event.target.value })} /><input type="time" value={form.endTime} onChange={(event) => update({ endTime: event.target.value })} aria-label="End time" /></span>
            </label>
            <label className="myhr-form-row"><span>Duration (hours):</span>
              <input type="number" min="0.25" step="0.25" value={form.hours} placeholder="0.00" onChange={(event) => { setHoursTouched(true); setForm((current) => ({ ...current, hours: event.target.value })) }} />
            </label>
            <div className="myhr-form-row"><span>Approver:</span><input className="readonly" readOnly tabIndex={-1} value={approvers.join(', ') || 'Your store manager'} /></div>
            <label className="myhr-form-row lr-comments"><span>Comments:</span>
              <textarea rows={4} value={form.comments} onChange={(event) => setForm((current) => ({ ...current, comments: event.target.value }))} />
            </label>
          </fieldset>
        </div>
      </section>
    </div>
  )
}
