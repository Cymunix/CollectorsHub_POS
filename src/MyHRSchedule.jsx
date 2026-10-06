import React, { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { addShift, deleteShift, isoDate, loadMySchedule, loadStoreSchedule, loadStoreStaff, weekStart } from './lib/myhrPay'

// My Schedule: the employee's shifts for a week (this week by default, with
// previous/next). Managers also see and build the whole store's week: pick
// a staff member, day and times, add; remove a shift with the bin.

const timeText = (value) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const dayLabel = (date) => date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
const hours = (shift) => (new Date(shift.ends_at) - new Date(shift.starts_at)) / 3600000

export default function MyHRSchedule({ storeId, isManager }) {
  const [start, setStart] = useState(() => weekStart(new Date()))
  const [mine, setMine] = useState([])
  const [store, setStore] = useState([])
  const [staff, setStaff] = useState([])
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ employeeId: '', day: isoDate(new Date()), from: '10:00', to: '18:00', note: '' })

  const end = new Date(start)
  end.setDate(end.getDate() + 7)
  const days = Array.from({ length: 7 }, (_, index) => { const day = new Date(start); day.setDate(day.getDate() + index); return day })

  async function reload() {
    try {
      const [myShifts, storeShifts, people] = await Promise.all([
        loadMySchedule(storeId, start, end),
        isManager ? loadStoreSchedule(storeId, start, end) : Promise.resolve([]),
        isManager && !staff.length ? loadStoreStaff(storeId) : Promise.resolve(null),
      ])
      setMine(myShifts)
      setStore(storeShifts)
      if (people) {
        setStaff(people)
        setForm((current) => ({ ...current, employeeId: current.employeeId || people[0]?.id || '' }))
      }
      setProblem('')
    } catch (error) {
      setProblem(error?.message || String(error))
    }
  }
  useEffect(() => { reload() }, [storeId, start.getTime(), isManager])

  function moveWeek(weeks) {
    const next = new Date(start)
    next.setDate(next.getDate() + weeks * 7)
    setStart(next)
  }

  async function submit(event) {
    event.preventDefault()
    const startsAt = new Date(`${form.day}T${form.from}:00`)
    let endsAt = new Date(`${form.day}T${form.to}:00`)
    if (endsAt <= startsAt) endsAt = new Date(endsAt.getTime() + 86400000) // overnight shift
    if (!form.employeeId) { setProblem('Pick who the shift is for.'); return }
    setBusy(true)
    try {
      await addShift(storeId, { employeeId: form.employeeId, startsAt, endsAt, note: form.note })
      setForm((current) => ({ ...current, note: '' }))
      await reload()
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  async function remove(shiftId) {
    setBusy(true)
    try {
      await deleteShift(storeId, shiftId)
      await reload()
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  const onDay = (list, day) => list.filter((shift) => isoDate(new Date(shift.starts_at)) === isoDate(day))
  const myHours = mine.reduce((sum, shift) => sum + hours(shift), 0)

  return (
    <div className="myhr-schedule">
      <div className="myhr-week-nav">
        <button type="button" onClick={() => moveWeek(-1)} aria-label="Previous week"><ChevronLeft size={18} /></button>
        <strong>Week of {start.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}</strong>
        <button type="button" onClick={() => moveWeek(1)} aria-label="Next week"><ChevronRight size={18} /></button>
        <button type="button" className="myhr-week-today" onClick={() => setStart(weekStart(new Date()))}>This week</button>
      </div>
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}

      <section className="myhr-pay-panel">
        <h3>My shifts <small className="myhr-muted">{myHours ? `${myHours.toFixed(1)} h scheduled` : ''}</small></h3>
        {mine.length ? (
          <ul className="myhr-pay-list compact">
            {mine.map((shift) => (
              <li key={shift.id}>
                <span><strong>{dayLabel(new Date(shift.starts_at))}</strong> <small>{timeText(shift.starts_at)} – {timeText(shift.ends_at)}{shift.note ? ` · ${shift.note}` : ''}</small></span>
                <b>{hours(shift).toFixed(1)} h</b>
              </li>
            ))}
          </ul>
        ) : <p className="myhr-empty">No shifts scheduled for you this week.</p>}
      </section>

      {isManager ? (
        <section className="myhr-pay-panel">
          <h3>Store schedule</h3>
          <form className="myhr-shift-form" onSubmit={submit}>
            <label>Staff
              <select value={form.employeeId} onChange={(event) => setForm((current) => ({ ...current, employeeId: event.target.value }))}>
                {staff.map((person) => <option key={person.id} value={person.id}>{person.name}{person.role ? ` (${String(person.role).replace(/_/g, ' ')})` : ''}</option>)}
              </select>
            </label>
            <label>Day
              <input type="date" value={form.day} onChange={(event) => setForm((current) => ({ ...current, day: event.target.value }))} />
            </label>
            <label>From
              <input type="time" value={form.from} onChange={(event) => setForm((current) => ({ ...current, from: event.target.value }))} />
            </label>
            <label>To
              <input type="time" value={form.to} onChange={(event) => setForm((current) => ({ ...current, to: event.target.value }))} />
            </label>
            <label className="wide">Note (optional)
              <input value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} placeholder="e.g. opening, card show" />
            </label>
            <button type="submit" className="gold-button" disabled={busy}><Plus size={15} /> Add shift</button>
          </form>

          <div className="myhr-week-grid">
            {days.map((day) => (
              <div key={day.toISOString()} className={`myhr-week-day${isoDate(day) === isoDate(new Date()) ? ' today' : ''}`}>
                <strong>{day.toLocaleDateString([], { weekday: 'short', day: 'numeric' })}</strong>
                {onDay(store, day).map((shift) => (
                  <span key={shift.id} className="myhr-week-shift" title={shift.note || ''}>
                    <b>{shift.employee_name}</b>
                    <small>{timeText(shift.starts_at)} – {timeText(shift.ends_at)}</small>
                    <button type="button" onClick={() => remove(shift.id)} disabled={busy} aria-label={`Remove ${shift.employee_name}'s shift`}><Trash2 size={13} /></button>
                  </span>
                ))}
                {!onDay(store, day).length ? <small className="myhr-muted">No one</small> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
