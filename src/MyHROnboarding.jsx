import React, { useEffect, useState } from 'react'
import { CheckCircle2, Circle, Sparkles } from 'lucide-react'
import { loadMyOnboarding } from './lib/myhrPay'

// Onboarding: what a new staff member and their organization each still
// need to set up. Each task counts as done from the real data
// (supabase/myhr_onboarding.sql), so nothing is ticked by hand.

export const ORG_TASKS = [
  ['job', 'Job', 'Position and employee group'],
  ['pay', 'Pay', 'Pay type, rate and pay period'],
  ['scheduling', 'Scheduling', 'Scheduling role and weekly hours'],
  ['leave', 'Leave entitlements', 'Vacation, sick and other hours for this leave year'],
]
// [status key, label, what it needs, the MyHR view that does it]
export const EMPLOYEE_TASKS = [
  ['personal', 'Personal Data', 'Name, date of birth and language', 'personal'],
  ['address', 'Address', 'Street, city, province and postal code', 'addresses'],
  ['emergency', 'Emergency Contact', 'Who to call, and their number', 'emergency'],
  ['availability', 'Availability', 'When you can work', 'availability'],
]

export function onboardingCounts(status) {
  if (!status) return null
  const org = ORG_TASKS.filter(([key]) => status[key]).length
  const employee = EMPLOYEE_TASKS.filter(([key]) => status[key]).length
  return { org, employee, orgTotal: ORG_TASKS.length, employeeTotal: EMPLOYEE_TASKS.length, done: org === ORG_TASKS.length && employee === EMPLOYEE_TASKS.length }
}

function Task({ done, label, detail, onClick }) {
  const Icon = done ? CheckCircle2 : Circle
  const body = (
    <>
      <Icon size={18} className={done ? 'ob-done' : 'ob-todo'} />
      <span><strong>{label}</strong><small>{done ? 'Done' : detail}</small></span>
    </>
  )
  return onClick && !done
    ? <button type="button" className="ob-task" onClick={onClick}>{body}<em>Set up</em></button>
    : <div className={`ob-task${done ? ' done' : ''}`}>{body}</div>
}

// For the employee: shown in MyHR until their part is done.
export function EmployeeOnboardingBanner({ storeId, onOpen, refreshKey }) {
  const [status, setStatus] = useState(null)
  useEffect(() => {
    let live = true
    loadMyOnboarding(storeId).then((value) => { if (live) setStatus(value) }).catch(() => { if (live) setStatus(null) })
    return () => { live = false }
  }, [storeId, refreshKey])
  if (!status) return null
  const left = EMPLOYEE_TASKS.filter(([key]) => !status[key])
  if (!left.length) return null
  return (
    <section className="ob-banner">
      <div className="ob-banner-head">
        <Sparkles size={20} />
        <span>
          <strong>Welcome! Finish setting up</strong>
          <small>{EMPLOYEE_TASKS.length - left.length} of {EMPLOYEE_TASKS.length} done. Your organization uses these for pay, emergencies and scheduling.</small>
        </span>
      </div>
      <div className="ob-tasks">
        {EMPLOYEE_TASKS.map(([key, label, detail, view]) => <Task key={key} done={Boolean(status[key])} label={label} detail={detail} onClick={() => onOpen?.(view)} />)}
      </div>
    </section>
  )
}

// For the organization: one employee's whole checklist.
export function OrgOnboardingPanel({ status, name, onJump }) {
  if (!status) return null
  const counts = onboardingCounts(status)
  return (
    <section className={`myhr-pay-panel ob-panel${counts.done ? ' complete' : ''}`}>
      <h3>{counts.done ? `Onboarding complete${name ? `: ${name}` : ''}` : `Onboarding${name ? `: ${name}` : ''}`}</h3>
      <div className="ob-columns">
        <div>
          <h4>Organization ({counts.org}/{counts.orgTotal})</h4>
          <div className="ob-tasks">
            {ORG_TASKS.map(([key, label, detail]) => <Task key={key} done={Boolean(status[key])} label={label} detail={detail} onClick={() => onJump?.(key)} />)}
          </div>
        </div>
        <div>
          <h4>Employee, in their MyHR ({counts.employee}/{counts.employeeTotal})</h4>
          <div className="ob-tasks">
            {EMPLOYEE_TASKS.map(([key, label, detail]) => <Task key={key} done={Boolean(status[key])} label={label} detail={detail} />)}
          </div>
        </div>
      </div>
    </section>
  )
}

export function OnboardingBadge({ status }) {
  const counts = onboardingCounts(status)
  if (!counts) return null
  if (counts.done) return <b className="ob-badge done">Done</b>
  return <b className="ob-badge">Org {counts.org}/{counts.orgTotal} · Employee {counts.employee}/{counts.employeeTotal}</b>
}
