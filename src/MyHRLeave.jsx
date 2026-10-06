import React, { useEffect, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import {
  TIME_ACCOUNTS,
  cancelLeave,
  isoDate,
  leaveHours,
  leaveTypeLabel,
  loadMyLeave,
  loadOrgEmployeeAccounts,
  loadOrgLeaveYear,
  loadMyTimeAccounts,
  setOrgEntitlement,
  setOrgLeaveYear,
} from './lib/myhrPay'

// Leave Overview (Display Leave Information): the employee's leave from a
// date on (type, start/end date and time, who processed it, status, hours),
// with New / Edit (while waiting) / Cancel, and their time accounts on a key
// date (leave year, entitlement and remainder, set by the organization).
// New requests are booked on the Leave Request screen (MyHRLeaveRequest).

const dateText = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' }) : '')
const timeText = (value) => (value ? String(value).slice(0, 5) : '')
const hoursText = (value) => `${Number(value || 0).toFixed(2)}`
const STATUS_TEXT = { pending: 'Waiting', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' }
const monthsAgo = (count) => { const date = new Date(); date.setMonth(date.getMonth() - count); return isoDate(date) }

export function LeaveOverview({ storeId, onNew, onEdit, only = '' }) {
  const [showFrom, setShowFrom] = useState(() => monthsAgo(1))
  const [appliedFrom, setAppliedFrom] = useState(showFrom)
  const [keyDate, setKeyDate] = useState(() => isoDate(new Date()))
  const [appliedKey, setAppliedKey] = useState(keyDate)
  const [requests, setRequests] = useState(null)
  const [accounts, setAccounts] = useState(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)

  async function reload() {
    try {
      const [mine, accs] = await Promise.all([loadMyLeave(storeId), loadMyTimeAccounts(storeId, appliedKey)])
      setRequests(mine)
      setAccounts(accs)
      setProblem('')
    } catch (error) {
      setRequests([])
      setAccounts([])
      setProblem(error?.message || String(error))
    }
  }
  useEffect(() => { reload() }, [storeId, appliedKey])

  async function cancel(request) {
    if (!window.confirm(`Cancel your ${leaveTypeLabel(request.leave_type).toLowerCase()} on ${dateText(request.start_date)}?`)) return
    window.nordvikDesktop?.refocusWindow?.()
    setBusy(true)
    try {
      await cancelLeave(storeId, request.id)
      await reload()
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  const today = isoDate(new Date())
  const shown = (requests || []).filter((request) => request.end_date >= appliedFrom && request.status !== 'cancelled')
  const accountsByKey = Object.fromEntries((accounts || []).map((row) => [row.account, row]))

  return (
    <div className="myhr-leave-overview">
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}

      {only !== 'accounts' ? <section className="myhr-sap-panel">
        <div className="myhr-sap-head">
          <strong>Leave Data Overview</strong>
          {onNew ? <button type="button" onClick={onNew}><Plus size={15} /> New</button> : null}
        </div>
        <div className="myhr-sap-filter">
          <label>Show from: <input type="date" value={showFrom} onChange={(event) => setShowFrom(event.target.value)} /></label>
          <button type="button" onClick={() => setAppliedFrom(showFrom)}>Apply</button>
        </div>
        <div className="myhr-sap-table-wrap">
          <table className="myhr-wage-table myhr-sap-table">
            <thead>
              <tr><th>Edit</th><th>Cancel</th><th>Type of Leave</th><th>Start Date</th><th>Start time</th><th>End Date</th><th>End time</th><th>Processor</th><th>Status</th><th className="num">Absence hours</th><th className="num">Used</th></tr>
            </thead>
            <tbody>
              {requests === null ? <tr><td colSpan={11} className="myhr-muted">Loading…</td></tr> : shown.length ? shown.map((request) => {
                const canEdit = request.status === 'pending'
                const canCancel = request.status === 'pending' || (request.status === 'approved' && request.start_date > today)
                const hours = leaveHours(request)
                return (
                  <tr key={request.id}>
                    <td className="icon">{canEdit ? <button type="button" onClick={() => onEdit(request)} aria-label="Edit" disabled={busy}><Pencil size={15} /></button> : null}</td>
                    <td className="icon">{canCancel ? <button type="button" onClick={() => cancel(request)} aria-label="Cancel" disabled={busy}><Trash2 size={15} /></button> : null}</td>
                    <td>{leaveTypeLabel(request.leave_type)}</td>
                    <td>{dateText(request.start_date)}</td>
                    <td>{timeText(request.start_time)}</td>
                    <td>{dateText(request.end_date)}</td>
                    <td>{timeText(request.end_time)}</td>
                    <td>{request.processor || ''}</td>
                    <td><b className={`myhr-status ${request.status}`}>{STATUS_TEXT[request.status] || request.status}</b></td>
                    <td className="num">{hoursText(hours)}</td>
                    <td className="num">{request.status === 'approved' ? `${hoursText(hours)} Hours` : ''}</td>
                  </tr>
                )
              }) : <tr><td colSpan={11} className="myhr-muted">No leave from {dateText(appliedFrom)} on.</td></tr>}
            </tbody>
          </table>
        </div>
      </section> : null}

      {only !== 'requests' ? <section className="myhr-sap-panel">
        <div className="myhr-sap-head"><strong>Time Accounts Overview</strong></div>
        <div className="myhr-sap-filter">
          <label>Key Date: <input type="date" value={keyDate} onChange={(event) => setKeyDate(event.target.value)} /></label>
          <button type="button" onClick={() => setAppliedKey(keyDate)}>Apply</button>
        </div>
        <div className="myhr-sap-table-wrap">
          <table className="myhr-wage-table myhr-sap-table">
            <thead><tr><th>Time Account</th><th>Deduction from</th><th>Deduction to</th><th className="num">Entitlement</th><th className="num">Remainder</th></tr></thead>
            <tbody>
              {accounts === null ? <tr><td colSpan={5} className="myhr-muted">Loading…</td></tr> : TIME_ACCOUNTS.map(([key, label]) => {
                const row = accountsByKey[key]
                return (
                  <tr key={key}>
                    <td>{label}</td>
                    <td>{row ? dateText(row.year_start) : ''}</td>
                    <td>{row ? dateText(row.year_end) : ''}</td>
                    <td className="num">{row ? `${hoursText(row.entitlement_hours)} Hours` : ''}</td>
                    <td className={`num${row && Number(row.remainder_hours) < 0 ? ' negative' : ''}`}>{row ? `${hoursText(row.remainder_hours)} Hours` : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <small className="myhr-muted">Entitlements are set by your organization. The remainder counts approved leave in this leave year.</small>
      </section> : null}
    </div>
  )
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// The organization: its leave year (for every store) and one employee's
// entitlements per time account for the current leave year.
export function OrgLeaveEntitlements({ orgId, employeeId }) {
  const [startMonth, setStartMonth] = useState(null)
  const [accounts, setAccounts] = useState(null)
  const [draft, setDraft] = useState({})
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const keyDate = isoDate(new Date())

  async function reload() {
    try {
      const [month, rows] = await Promise.all([loadOrgLeaveYear(orgId), loadOrgEmployeeAccounts(orgId, employeeId, keyDate)])
      setStartMonth(month)
      setAccounts(rows)
      setDraft(Object.fromEntries(rows.map((row) => [row.account, String(Number(row.entitlement_hours || 0))])))
      setProblem('')
    } catch (error) {
      setAccounts([])
      setProblem(error?.message || String(error))
    }
  }
  useEffect(() => { setNotice(''); reload() }, [orgId, employeeId])

  async function changeYear(month) {
    setSaving(true)
    try {
      await setOrgLeaveYear(orgId, month)
      await reload()
      setNotice(`Leave year now starts on ${MONTHS[month - 1]} 1 for every store.`)
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setSaving(false)
    }
  }

  async function save(event) {
    event.preventDefault()
    const yearStart = accounts?.[0]?.year_start
    if (!yearStart) return
    setSaving(true)
    setProblem('')
    try {
      for (const [key] of TIME_ACCOUNTS) {
        const before = Number((accounts.find((row) => row.account === key) || {}).entitlement_hours || 0)
        const after = Number(draft[key] || 0)
        if (after !== before) await setOrgEntitlement(orgId, employeeId, key, yearStart, after)
      }
      await reload()
      setNotice('Entitlements saved.')
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setSaving(false)
    }
  }

  const byKey = Object.fromEntries((accounts || []).map((row) => [row.account, row]))
  const year = accounts?.[0]

  return (
    <section className="myhr-pay-panel">
      <h3>Leave entitlements</h3>
      <label className="myhr-form-row"><span>Leave year starts:</span>
        <select value={startMonth || 1} onChange={(event) => changeYear(Number(event.target.value))} disabled={saving || startMonth === null}>
          {MONTHS.map((month, index) => <option key={month} value={index + 1}>{month} 1</option>)}
        </select>
      </label>
      {year ? <small className="myhr-muted">This leave year: {dateText(year.year_start)} – {dateText(year.year_end)} (applies to the whole organization).</small> : null}
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      {accounts ? (
        <form onSubmit={save}>
          <table className="myhr-wage-table myhr-sap-table">
            <thead><tr><th>Time Account</th><th className="num">Entitlement (hours)</th><th className="num">Used</th><th className="num">Remainder</th></tr></thead>
            <tbody>
              {TIME_ACCOUNTS.map(([key, label]) => (
                <tr key={key}>
                  <td>{label}</td>
                  <td className="num"><input className="myhr-hours-input" type="number" min="0" step="0.25" value={draft[key] ?? '0'} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} /></td>
                  <td className="num">{hoursText(byKey[key]?.used_hours)}</td>
                  <td className={`num${Number(byKey[key]?.remainder_hours) < 0 ? ' negative' : ''}`}>{hoursText(byKey[key]?.remainder_hours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="myhr-editor-actions">
            {notice ? <span className="myhr-notice">{notice}</span> : null}
            <button type="submit" className="gold-button" disabled={saving}>{saving ? 'Saving…' : 'Save entitlements'}</button>
          </div>
        </form>
      ) : <p className="myhr-empty">Loading…</p>}
    </section>
  )
}
