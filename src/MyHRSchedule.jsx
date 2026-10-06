import React, { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, MapPin } from 'lucide-react'
import { isoDate, leaveTypeLabel, loadMyLeave, loadMySchedule } from './lib/myhrPay'
import { roleColour } from './lib/scheduleRules'
import ScheduleBuilder from './ScheduleBuilder'

// My Schedule: the employee's published shifts for a week (role, location,
// break, hours, changes since the last publish, time off) and what's coming
// up (availability has its own screen). Managers also get the Schedule Builder tab.

const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const timeText = (value) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const paidHours = (shift) => Math.max(0, (new Date(shift.ends_at) - new Date(shift.starts_at)) / 3600000 - Number(shift.break_minutes || 0) / 60)
const hoursText = (value) => `${Math.round(value * 100) / 100}h`

function mondayOf(date) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7))
  return day
}

function MyShifts({ storeId, storeName }) {
  const [start, setStart] = useState(() => mondayOf(new Date()))
  const [shifts, setShifts] = useState(null)
  const [upcoming, setUpcoming] = useState([])
  const [leave, setLeave] = useState([])
  const [problem, setProblem] = useState('')

  const end = new Date(start)
  end.setDate(end.getDate() + 7)
  const days = Array.from({ length: 7 }, (_, index) => { const day = new Date(start); day.setDate(day.getDate() + index); return day })

  useEffect(() => {
    let live = true
    const now = new Date()
    const soon = new Date()
    soon.setDate(soon.getDate() + 14)
    Promise.all([loadMySchedule(storeId, start, end), loadMySchedule(storeId, now, soon), loadMyLeave(storeId)])
      .then(([week, next, myLeave]) => { if (live) { setShifts(week); setUpcoming(next); setLeave(myLeave); setProblem('') } })
      .catch((error) => { if (live) { setShifts([]); setProblem(error?.message || String(error)) } })
    return () => { live = false }
  }, [storeId, start.getTime()])

  function moveWeek(weeks) {
    const next = new Date(start)
    next.setDate(next.getDate() + weeks * 7)
    setStart(next)
  }

  const offOn = (iso) => leave.find((request) => ['approved', 'pending'].includes(request.status) && request.start_date <= iso && request.end_date >= iso)
  const total = (shifts || []).reduce((sum, shift) => sum + paidHours(shift), 0)
  const changed = (shifts || []).filter((shift) => shift.changed).length

  return (
    <div className="ms-mine">
      <div className="myhr-week-nav">
        <button type="button" onClick={() => moveWeek(-1)} aria-label="Previous week"><ChevronLeft size={18} /></button>
        <strong>Week of {start.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}</strong>
        <button type="button" onClick={() => moveWeek(1)} aria-label="Next week"><ChevronRight size={18} /></button>
        <button type="button" className="myhr-week-today" onClick={() => setStart(mondayOf(new Date()))}>This week</button>
        <span className="ms-total">{hoursText(total)} scheduled{changed ? <b className="ms-changed"> · {changed} changed</b> : null}</span>
      </div>
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      <div className="ms-week">
        {days.map((date) => {
          const iso = isoDate(date)
          const dayShifts = (shifts || []).filter((shift) => isoDate(new Date(shift.starts_at)) === iso)
          const off = offOn(iso)
          return (
            <div key={iso} className={`ms-day${iso === isoDate(new Date()) ? ' today' : ''}`}>
              <strong>{DAY_LONG[date.getDay()].slice(0, 3)} {date.getDate()}</strong>
              {off ? <span className={`ms-off ${off.status}`}>{leaveTypeLabel(off.leave_type)}{off.status === 'pending' ? ' (requested)' : ''}</span> : null}
              {dayShifts.map((shift) => (
                <span key={shift.id} className={`ms-shift${shift.changed ? ' changed' : ''}`} style={{ '--role': roleColour(shift.role || 'Employee') }}>
                  <b>{shift.role || 'Shift'}</b>
                  <span>{timeText(shift.starts_at)} – {timeText(shift.ends_at)} · {hoursText(paidHours(shift))}</span>
                  {Number(shift.break_minutes) ? <small>{shift.break_minutes} min break</small> : null}
                  {shift.note ? <small>{shift.note}</small> : null}
                  <small className="ms-where"><MapPin size={11} /> {storeName}</small>
                  {shift.changed ? <em>Changed</em> : null}
                </span>
              ))}
              {shifts && !dayShifts.length && !off ? <small className="myhr-muted">Off</small> : null}
            </div>
          )
        })}
      </div>
      <section className="myhr-pay-panel">
        <h3>Coming up (next 2 weeks)</h3>
        {upcoming.length ? (
          <ul className="myhr-pay-list compact">
            {upcoming.map((shift) => (
              <li key={shift.id}>
                <span><strong>{new Date(shift.starts_at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</strong> <small>{timeText(shift.starts_at)} – {timeText(shift.ends_at)}{shift.role ? ` · ${shift.role}` : ''}{shift.changed ? ' · changed' : ''}</small></span>
                <b>{hoursText(paidHours(shift))}</b>
              </li>
            ))}
          </ul>
        ) : <p className="myhr-empty">No published shifts in the next two weeks.</p>}
      </section>
    </div>
  )
}

export default function MyHRSchedule({ storeId, isManager, storeName = 'Store' }) {
  const [tab, setTab] = useState('mine')
  return (
    <div className="myhr-schedule">
      <div className="ts-tabs ms-tabs" role="tablist">
        {[['mine', 'My Schedule'], ...(isManager ? [['builder', 'Schedule Builder']] : [])].map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === 'mine' ? <MyShifts storeId={storeId} storeName={storeName} /> : null}
      {tab === 'builder' && isManager ? <ScheduleBuilder storeId={storeId} /> : null}
    </div>
  )
}
