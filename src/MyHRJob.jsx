import React, { useEffect, useState } from 'react'
import { PAY_PERIODS, loadMyJob, loadOrgStaffJob, payFigures, periodToWeeklyHours, saveOrgStaffJob, weeklyToPeriodHours } from './lib/myhrPay'

// Job Information: the employee's job and pay, read-only in the store (personnel number,
// name, group/subgroup, area, position, who changed it; pay type and rate,
// hours per period, next increase, projected annual pay, and the pay-period
// wage line). Only the organization edits it (OrgJobEditor, from an org sign-in).

const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })
const GROUPS = ['', 'Employee', 'Contractor', 'Student', 'Seasonal']
const SUBGROUPS = ['', 'Full-time hourly', 'Part-time hourly', 'Full-time salaried', 'Part-time salaried', 'Casual']
const periodLabel = (key) => (PAY_PERIODS.find(([value]) => value === key) || [key, key || '—'])[1]
const dateText = (value) => (value ? new Date(String(value).length === 10 ? `${value}T00:00:00` : value).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '—')

function JobView({ job }) {
  const { perPeriod, annual } = payFigures(job)
  const cell = (value, wide) => <span className={`myhr-job-value${wide ? ' wide' : ''}`}>{value || ' '}</span>
  return (
    <div className="myhr-job">
      <div className="myhr-job-grid">
        <span className="myhr-job-label">Personnel Number</span>{cell(job.personnel_number)}
        <span className="myhr-job-label">Name</span>{cell(job.name, true)}
        <span className="myhr-job-label">Employee group</span>{cell(job.employee_group)}
        <span className="myhr-job-label">Personnel area</span>{cell(job.personnel_area, true)}
        <span className="myhr-job-label">Employee subgroup</span>{cell(job.employee_subgroup)}
        <span className="myhr-job-label">Business area</span>{cell(job.business_area, true)}
        <span className="myhr-job-label">Position</span>{cell(job.position_title)}
        <span className="myhr-job-label" /><span />
        <span className="myhr-job-label">Changed By</span>{cell(job.changed_by_name)}
        <span className="myhr-job-label">Changed on</span>{cell(job.changed_by_name ? dateText(job.changed_at) : '')}
      </div>

      <h4 className="myhr-job-heading">Salary</h4>
      <div className="myhr-job-grid">
        <span className="myhr-job-label">Pay type</span>{cell(job.pay_type === 'salary' ? 'Salary' : job.pay_type === 'hourly' ? 'Hourly' : '')}
        <span className="myhr-job-label">Hours</span>{cell(job.hours_per_period != null && job.pay_type !== 'salary' ? `${periodToWeeklyHours(job.hours_per_period, job.pay_period) ?? '?'} / week · ${periodLabel(job.pay_period)} (${Number(job.hours_per_period).toFixed(2)} per pay)` : job.pay_period ? periodLabel(job.pay_period) : '')}
        <span className="myhr-job-label">Pay rate</span>{cell(job.pay_rate != null ? `${money.format(Number(job.pay_rate))} ${job.pay_type === 'salary' ? 'per year' : 'per hour'}` : '')}
        <span className="myhr-job-label">Next increase</span>{cell(job.next_increase ? dateText(job.next_increase) : '')}
        <span className="myhr-job-label" /><span />
        <span className="myhr-job-label">Projected Annual Pay</span>{cell(annual != null ? `${money.format(annual)} CAD` : '')}
      </div>

      <table className="myhr-wage-table">
        <thead><tr><th>Wage type</th><th>Amount</th><th>Number/Unit</th><th>Unit</th></tr></thead>
        <tbody>
          {perPeriod != null ? (
            <tr>
              <td>{job.pay_type === 'salary' ? 'Pay Period Salary' : 'Pay Period Wages'}</td>
              <td className="num">{money.format(perPeriod)}</td>
              <td className="num">{job.pay_type === 'salary' ? '' : Number(job.hours_per_period).toFixed(2)}</td>
              <td>{job.pay_type === 'salary' ? '' : `hours per pay (${periodToWeeklyHours(job.hours_per_period, job.pay_period) ?? '?'} h/week) × ${money.format(Number(job.pay_rate))}`}</td>
            </tr>
          ) : <tr><td colSpan={4} className="myhr-muted">No pay set up yet.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

// A loaded job with its hours per week (hours are stored per pay period).
const withWeekly = (job) => ({ ...(job || {}), hours_per_week: job?.hours_per_period != null ? (periodToWeeklyHours(job.hours_per_period, job.pay_period) ?? '') : '' })

// The organization edits one employee's job and pay.
export function OrgJobEditor({ orgId, employeeId, onSaved }) {
  const [job, setJob] = useState(null)
  const [draft, setDraft] = useState({})
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!employeeId) return
    setNotice('')
    setProblem('')
    loadOrgStaffJob(orgId, employeeId).then((loaded) => { setJob(loaded); setDraft(withWeekly(loaded)) }).catch((error) => setProblem(error?.message || String(error)))
  }, [orgId, employeeId])

  const set = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }))
  // The draft as saved: hours per week turned into hours per pay period.
  const asSaved = (current) => ({ ...current, hours_per_period: current.pay_type === 'salary' ? (current.hours_per_period ?? '') : (weeklyToPeriodHours(current.hours_per_week ?? '', current.pay_period) ?? '') })
  async function save(event) {
    event.preventDefault()
    if (draft.pay_type !== 'salary' && String(draft.hours_per_week ?? '') !== '' && !draft.pay_period) { setProblem('Pick the pay period too, so hours per week can be turned into hours per pay.'); return }
    setSaving(true)
    setProblem('')
    try {
      const keys = ['employee_group', 'employee_subgroup', 'position_title', 'pay_type', 'pay_rate', 'hours_per_period', 'pay_period', 'next_increase']
      const saved = asSaved(draft)
      await saveOrgStaffJob(orgId, employeeId, Object.fromEntries(keys.map((key) => [key, saved[key] ?? ''])))
      const loaded = await loadOrgStaffJob(orgId, employeeId)
      setJob(loaded)
      setDraft(withWeekly(loaded))
      setNotice('Saved.')
      onSaved?.()
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setSaving(false)
    }
  }

  const select = (key, options) => (
    <select value={draft[key] || ''} onChange={set(key)}>
      {options.map((option) => (Array.isArray(option) ? <option key={option[0]} value={option[0]}>{option[1]}</option> : <option key={option} value={option}>{option}</option>))}
    </select>
  )

  return (
    <section className="myhr-pay-panel">
      <h3>Job information{job?.name ? `: ${job.name}` : ''}</h3>
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      {job ? (
        <form className="myhr-job-form" onSubmit={save}>
          <label className="myhr-form-row"><span>Employee group:</span>{select('employee_group', GROUPS)}</label>
          <label className="myhr-form-row"><span>Employee subgroup:</span>{select('employee_subgroup', SUBGROUPS)}</label>
          <label className="myhr-form-row"><span>Position:</span><input value={draft.position_title || ''} onChange={set('position_title')} placeholder="e.g. Sales Associate" /></label>
          <label className="myhr-form-row"><span>Pay type:</span>{select('pay_type', [['', ''], ['hourly', 'Hourly'], ['salary', 'Salary']])}</label>
          <label className="myhr-form-row"><span>{draft.pay_type === 'salary' ? 'Annual salary:' : 'Hourly rate:'}</span><input type="number" min="0" step="0.01" value={draft.pay_rate ?? ''} onChange={set('pay_rate')} /></label>
          <label className="myhr-form-row"><span>Pay period:</span>{select('pay_period', [['', ''], ...PAY_PERIODS.map(([key, label]) => [key, label])])}</label>
          <label className="myhr-form-row"><span>Hours per week:</span><input type="number" min="0" max="80" step="0.25" value={draft.hours_per_week ?? ''} onChange={set('hours_per_week')} placeholder="e.g. 35" disabled={draft.pay_type === 'salary'} /></label>
          <label className="myhr-form-row"><span>Next increase:</span><input type="date" value={draft.next_increase || ''} onChange={set('next_increase')} /></label>
          <div className="myhr-editor-actions">
            {notice ? <span className="myhr-notice">{notice}</span> : null}
            <button type="submit" className="gold-button" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      ) : null}
      {job ? (() => {
        const { perPeriod, annual } = payFigures(asSaved(draft))
        return <p className="myhr-muted">{perPeriod != null ? (draft.pay_type === 'salary' ? `With these settings: ${money.format(perPeriod)} per pay period, ${money.format(annual)} per year.` : `With these settings: ${draft.hours_per_week} h/week × ${money.format(Number(draft.pay_rate))} = ${money.format(Number(draft.hours_per_week) * Number(draft.pay_rate))}/week · ${money.format(perPeriod)} per pay period · ${money.format(Number(draft.hours_per_week) * Number(draft.pay_rate) * 52)} per year.`) : 'Set the pay type, rate, pay period and hours per week to see the pay.'}</p>
      })() : null}
    </section>
  )
}

export default function MyHRJob({ storeId }) {
  const [job, setJob] = useState(null)
  const [problem, setProblem] = useState('')

  useEffect(() => {
    let live = true
    loadMyJob(storeId)
      .then((mine) => { if (live) setJob(mine || {}) })
      .catch((error) => { if (live) { setJob({}); setProblem(error?.message || String(error)) } })
    return () => { live = false }
  }, [storeId])

  if (!job) return <p className="myhr-empty">Loading…</p>
  return (
    <div className="myhr-job-page">
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      <section className="myhr-pay-panel"><JobView job={job} /></section>
      <p className="myhr-muted">Job and pay information is managed by {job.personnel_area || 'your organization'}. Contact them if something here is wrong.</p>
    </div>
  )
}
