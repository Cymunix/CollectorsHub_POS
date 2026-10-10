import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  BriefcaseBusiness,
  CalendarClock,
  Check,
  Clock3,
  HeartHandshake,
  HeartPulse,
  IdCard,
  Link2,
  LogIn,
  LogOut,
  Plane,
  Wallet,
  X,
} from 'lucide-react'
import {
  LEAVE_TYPES,
  amManager,
  clock,
  decideLeave,
  isoDate,
  leaveHours,
  leaveTypeLabel,
  loadMyLeave,
  loadMyTime,
  loadStoreLeave,
  shiftHours,
} from './lib/myhrPay'
import { entryHoursBetween, sundayOf } from './lib/timesheet'
import MyHRDetails from './MyHRDetails'
import MyHRFamily from './MyHRFamily'
import MyHRJob from './MyHRJob'
import { LeaveOverview } from './MyHRLeave'
import MyHRLeaveRequest from './MyHRLeaveRequest'
import MyHRTimesheet from './MyHRTimesheet'
import MyHRSchedule from './MyHRSchedule'
import MyHRAvailability from './MyHRAvailability'
import { EmployeeOnboardingBanner } from './MyHROnboarding'

// My Pay, Vacation & Leaves: an employee self-service directory (personal
// information, job, time, benefits, payment, travel, health & safety). The
// built options open here: personal data, addresses, emergency contact, job
// information, leave information, the time clock (record working time),
// leave requests (managers approve) and the schedule. The rest are greyed
// out until built.

const DIRECTORY = [
  { title: 'Personal Information', icon: IdCard, items: [['personal', 'Personal Data'], ['addresses', 'Addresses'], ['family', 'Family Related Data'], ['emergency', 'Emergency Contact']] },
  { title: 'My Benefits', icon: HeartHandshake, items: [['benefits', 'Display Benefits/Beneficiaries'], ['dental', 'Health and Dental Application'], ['life', 'Employee Optional Life Application'], ['familylife', 'Spouse and Child Optional Life Application'], ['beneficiary', 'Beneficiary Nomination Form']] },
  { title: 'My Job', icon: BriefcaseBusiness, items: [['job', 'Display Job Information']] },
  { title: 'My Payment', icon: Wallet, items: [['payadvice', 'Pay Advice Inquiry'], ['taxform', 'Tax Form Reprint']] },
  { title: 'My Time', icon: CalendarClock, items: [['leaveinfo', 'Display Leave Information'], ['time', 'Record Working Time'], ['leave', 'Vacation Leave Request'], ['schedule', 'My Schedule'], ['availability', 'Availability']] },
  { title: 'Travel and Expenses', icon: Plane, items: [['trips', 'My Trips and Expenses'], ['travelrequest', 'Create Travel Request'], ['expense', 'Create Expense Claim'], ['personnel', 'Unlock Personnel Number']] },
  { title: 'My Resource Links', icon: Link2, items: [['myhr', 'MyHR'], ['acrobat', 'Adobe Acrobat Reader']] },
  { title: 'My Health and Safety', icon: HeartPulse, items: [['incident', 'Report a Safety Incident, Near Miss or Safety Observation'], ['safetysite', 'Workplace Health & Safety Site']] },
]
const BUILT = new Set(['personal', 'addresses', 'family', 'emergency', 'job', 'leaveinfo', 'time', 'leave', 'schedule', 'availability', 'myhr', 'acrobat'])
const TITLES = Object.fromEntries(DIRECTORY.flatMap((group) => group.items))
const ACROBAT_URL = 'https://get.adobe.com/reader/'

const hoursText = (hours) => `${hours.toFixed(2)} h`
const timeText = (value) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const dayText = (value) => new Date(value).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
const dateText = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
const rangeText = (start, end) => (start === end ? dateText(start) : `${dateText(start)} – ${dateText(end)}`)
const STATUS_TEXT = { pending: 'Waiting for approval', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' }

export default function MyHRPay({ storeId, storeName = 'Store', onClockChange, onMyHRHome, initialView = 'home' }) {
  const [view, setView] = useState(initialView)
  const [now, setNow] = useState(Date.now())
  const [entries, setEntries] = useState([])
  const [requests, setRequests] = useState([])
  const [isManager, setIsManager] = useState(false)
  const [storeRequests, setStoreRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const today = isoDate(new Date())
  // The leave request being edited (null: a new one).
  const [editingLeave, setEditingLeave] = useState(null)

  // Weeks run Sunday to Saturday, like the timesheet.
  const thisWeek = sundayOf(new Date(now))
  const lastWeek = new Date(thisWeek)
  lastWeek.setDate(lastWeek.getDate() - 7)

  async function reload() {
    if (!storeId) return
    try {
      const [time, mine, manager] = await Promise.all([
        loadMyTime(storeId, isoDate(new Date(lastWeek.getTime() - 7 * 86400000))),
        loadMyLeave(storeId),
        amManager(storeId),
      ])
      setEntries(time)
      setRequests(mine)
      setIsManager(manager)
      setStoreRequests(manager ? await loadStoreLeave(storeId) : [])
      setProblem('')
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [storeId])
  // Keeps an open shift's hours ticking.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])

  const open = entries.find((entry) => !entry.clock_out)
  // Only the part of each shift inside the period counts (a shift over midnight on Sunday is split).
  const hoursSince = (from, to = Infinity) => entries.reduce((sum, entry) => sum + entryHoursBetween(entry, from, to, now), 0)
  const weekHours = hoursSince(thisWeek)
  const lastWeekHours = hoursSince(lastWeek, thisWeek)

  const year = new Date(now).getFullYear()
  const yearTotals = useMemo(() => {
    const totals = {}
    for (const request of requests) {
      if (!['approved', 'pending'].includes(request.status) || !String(request.start_date).startsWith(String(year))) continue
      const entry = totals[request.leave_type] || { approved: 0, pending: 0 }
      entry[request.status] += leaveHours(request)
      totals[request.leave_type] = entry
    }
    return totals
  }, [requests, year])
  const pendingApprovals = storeRequests.filter((request) => request.status === 'pending')

  async function run(label, action, done) {
    setBusy(label)
    setProblem('')
    setNotice('')
    try {
      await action()
      if (done) setNotice(done)
      await reload()
      return true
    } catch (error) {
      setProblem(error?.message || String(error))
      return false
    } finally {
      setBusy('')
    }
  }

  const clockAction = (action) => run('clock', async () => {
    await clock(storeId, action)
    onClockChange?.()
  }, action === 'in' ? 'Clocked in.' : 'Clocked out.')

  function openItem(key) {
    if (key === 'myhr') { onMyHRHome?.(); return }
    if (key === 'acrobat') { window.open(ACROBAT_URL, '_blank'); return }
    setNotice('')
    setProblem('')
    setView(key)
  }

  if (loading) return <p className="myhr-empty">Loading your time and leave…</p>

  // ── Pieces ────────────────────────────────────────────────────────────────
  const clockCard = (
    <div className="myhr-pay-card myhr-clock">
      <span className="myhr-pay-card-label"><Clock3 size={16} /> Time clock</span>
      {open ? (
        <>
          <strong>Clocked in since {timeText(open.clock_in)}</strong>
          <small>{hoursText(shiftHours(open, now))} so far</small>
          <button type="button" className="myhr-clock-out" disabled={Boolean(busy)} onClick={() => clockAction('out')}>
            <LogOut size={16} /> {busy === 'clock' ? 'Saving…' : 'Clock out'}
          </button>
        </>
      ) : (
        <>
          <strong>Not clocked in</strong>
          <small>Clock in when your shift starts.</small>
          <button type="button" className="gold-button" disabled={Boolean(busy)} onClick={() => clockAction('in')}>
            <LogIn size={16} /> {busy === 'clock' ? 'Saving…' : 'Clock in'}
          </button>
        </>
      )}
    </div>
  )
  const weekCards = (
    <>
      <div className="myhr-pay-card">
        <span className="myhr-pay-card-label">This week</span>
        <strong className="myhr-pay-big">{hoursText(weekHours)}</strong>
        <small>Since Sunday</small>
      </div>
      <div className="myhr-pay-card">
        <span className="myhr-pay-card-label">Last week</span>
        <strong className="myhr-pay-big">{hoursText(lastWeekHours)}</strong>
        <small>{dateText(isoDate(lastWeek))} – {dateText(isoDate(new Date(thisWeek.getTime() - 86400000)))}</small>
      </div>
    </>
  )
  const leaveYearCard = (
    <div className="myhr-pay-card">
      <span className="myhr-pay-card-label"><CalendarClock size={16} /> Leave in {year}</span>
      {Object.keys(yearTotals).length ? (
        <ul className="myhr-pay-totals">
          {LEAVE_TYPES.filter(([key]) => yearTotals[key]).map(([key, label]) => (
            <li key={key}>
              <span>{label}</span>
              <b>{yearTotals[key].approved} h</b>
              {yearTotals[key].pending ? <small>+{yearTotals[key].pending} h waiting</small> : null}
            </li>
          ))}
        </ul>
      ) : <small>No leave taken or requested yet.</small>}
    </div>
  )
  const approvals = isManager ? (
    <section className="myhr-pay-panel">
      <h3>Leave requests to approve</h3>
      {pendingApprovals.length ? (
        <ul className="myhr-pay-list">
          {pendingApprovals.map((request) => (
            <li key={request.id}>
              <span>
                <strong>{request.employee_name}: {leaveTypeLabel(request.leave_type)}</strong>
                <small>{rangeText(request.start_date, request.end_date)}{request.start_time ? ` · ${String(request.start_time).slice(0, 5)}–${String(request.end_time || '').slice(0, 5)}` : ''} · {leaveHours(request)} hours{request.note ? ` · "${request.note}"` : ''}</small>
              </span>
              <span className="myhr-pay-actions">
                <button type="button" className="myhr-approve" disabled={Boolean(busy)} onClick={() => run(request.id, () => decideLeave(storeId, request.id, true), `Approved ${request.employee_name}'s ${leaveTypeLabel(request.leave_type).toLowerCase()}.`)}><Check size={15} /> Approve</button>
                <button type="button" className="myhr-decline" disabled={Boolean(busy)} onClick={() => run(request.id, () => decideLeave(storeId, request.id, false), `Declined ${request.employee_name}'s request.`)}><X size={15} /> Decline</button>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="myhr-empty">Nothing waiting for approval.</p>}
      {storeRequests.some((request) => request.status === 'approved') ? (
        <>
          <h4>Approved time off coming up</h4>
          <ul className="myhr-pay-list compact">
            {storeRequests.filter((request) => request.status === 'approved').map((request) => (
              <li key={request.id}>
                <span><strong>{request.employee_name}</strong> <small>{leaveTypeLabel(request.leave_type)} · {rangeText(request.start_date, request.end_date)}</small></span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  ) : null

  // ── Views ─────────────────────────────────────────────────────────────────
  let body = null
  if (view === 'home') {
    body = (
      <>
        <div className="myhr-pay-cards">
          {clockCard}
          {weekCards}
          {leaveYearCard}
        </div>
        {isManager && pendingApprovals.length ? (
          <button type="button" className="myhr-approval-alert" onClick={() => openItem('leave')}>
            {pendingApprovals.length} leave request{pendingApprovals.length === 1 ? '' : 's'} waiting for your approval. Review
          </button>
        ) : null}
        <EmployeeOnboardingBanner storeId={storeId} onOpen={openItem} />
        <div className="myhr-directory">
          {DIRECTORY.map((group) => {
            const Icon = group.icon
            return (
              <div className="myhr-directory-group" key={group.title}>
                <span className="myhr-directory-icon" aria-hidden="true"><Icon size={26} /></span>
                <div>
                  <h3>{group.title}</h3>
                  <ul>
                    {group.items.map(([key, label]) => (
                      <li key={key}>
                        <button type="button" className={BUILT.has(key) ? '' : 'not-ready'} disabled={!BUILT.has(key)} title={BUILT.has(key) ? '' : 'Coming soon'} onClick={() => openItem(key)}>
                          {label}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )
          })}
        </div>
      </>
    )
  } else if (view === 'time') {
    body = (
      <>
        <div className="myhr-pay-cards three">
          {clockCard}
          {weekCards}
        </div>
        <MyHRTimesheet storeId={storeId} isManager={isManager} />
      </>
    )
  } else if (view === 'leaveinfo') {
    body = <LeaveOverview storeId={storeId} onNew={() => { setEditingLeave(null); setView('leave') }} onEdit={(request) => { setEditingLeave(request); setView('leave') }} />
  } else if (view === 'leave') {
    body = (
      <>
        <MyHRLeaveRequest
          key={editingLeave?.id || 'new'}
          storeId={storeId}
          editing={editingLeave}
          onEditRequest={(request) => setEditingLeave(request)}
          onDone={(message) => {
            setEditingLeave(null)
            if (message) { setNotice(message); reload() }
            setView('leaveinfo')
          }}
        />
        {approvals}
      </>
    )
  } else if (view === 'schedule') {
    body = <MyHRSchedule storeId={storeId} isManager={isManager} storeName={storeName} />
  } else if (view === 'availability') {
    body = <MyHRAvailability storeId={storeId} />
  } else if (view === 'job') {
    body = <MyHRJob storeId={storeId} />
  } else if (view === 'family') {
    body = <MyHRFamily storeId={storeId} />
  } else if (['personal', 'addresses', 'emergency', 'job'].includes(view)) {
    body = <MyHRDetails storeId={storeId} view={view} onBack={() => setView('home')} />
  }

  return (
    <div className={`myhr-pay${view === 'schedule' ? ' myhr-pay-schedule' : ''}`}>
      {view !== 'home' ? (
        <div className="myhr-subnav">
          <button type="button" className="myhr-back" onClick={() => { setView('home'); setNotice(''); setProblem('') }}><ArrowLeft size={16} /> All options</button>
          <h3>{TITLES[view]}</h3>
        </div>
      ) : null}
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      {notice ? <p className="myhr-notice">{notice}</p> : null}
      {body}
    </div>
  )
}
