import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { TRAVEL_STATUS, owing, loadOrgLineSummary, loadOrgPolicy, loadOrgRecord, loadOrgRecords, orgDecide, recordReimbursement, saveOrgPolicy } from '../lib/travelExpenses'
import TERecordDetail, { TEStatus, teDateTime, teDates, teMoney } from '../TERecordDetail'

// Organization: travel & expense approvals, reimbursement payments, reports and policy.

const TABS = [['approve', 'To approve'], ['all', 'All records'], ['awaiting', 'Awaiting reimbursement'], ['reports', 'Reports'], ['policy', 'Policy']]

function Table({ rows, onOpen, empty }) {
  return (
    <div className="te-table-wrap">
      <table className="te-table clickable">
        <thead><tr><th>Reference</th><th>Type</th><th>Employee</th><th>Store</th><th>Description</th><th>Dates</th><th className="num">Total</th><th>Status</th><th>Last updated</th></tr></thead>
        <tbody>
          {rows.length ? rows.map((row) => (
            <tr key={`${row.kind}-${row.id}`} tabIndex={0} onClick={() => onOpen(row)} onKeyDown={(event) => { if (event.key === 'Enter') onOpen(row) }}>
              <td className="te-ref">{row.reference}</td>
              <td>{row.kind === 'travel' ? 'Travel request' : 'Expense claim'}</td>
              <td>{row.employee_name}</td>
              <td>{row.store_name}</td>
              <td>{row.description}</td>
              <td>{teDates(row.start_date, row.end_date)}</td>
              <td className="num">{teMoney(row.approved_total ?? row.total, row.currency)}</td>
              <td><TEStatus record={row} /></td>
              <td>{teDateTime(row.updated_at)}</td>
            </tr>
          )) : <tr><td colSpan={9} className="te-muted">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

function Summary({ title, rows, columns }) {
  return (
    <section className="te-panel">
      <h4 className="te-h4">{title}</h4>
      <table className="te-table">
        <thead><tr>{columns.map(([label, , num]) => <th key={label} className={num ? 'num' : ''}>{label}</th>)}</tr></thead>
        <tbody>
          {rows.length ? rows.map((row, index) => <tr key={index}>{columns.map(([label, get, num]) => <td key={label} className={num ? 'num' : ''}>{get(row)}</td>)}</tr>)
            : <tr><td colSpan={columns.length} className="te-muted">Nothing in this period.</td></tr>}
        </tbody>
      </table>
    </section>
  )
}

function Reports({ orgId, records }) {
  const yearStart = `${new Date().getFullYear()}-01-01`
  const [from, setFrom] = useState(yearStart)
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10))
  const [lines, setLines] = useState(null)
  const [problem, setProblem] = useState('')
  useEffect(() => { loadOrgLineSummary(orgId, from, to).then(setLines).catch((error) => setProblem(error?.message || String(error))) }, [orgId, from, to])

  const inRange = records.filter((row) => { const day = String(row.start_date || row.updated_at || '').slice(0, 10); return (!from || day >= from) && (!to || day <= to) })
  const claims = inRange.filter((row) => row.kind === 'claim')
  const group = (list, key) => Object.values(list.reduce((acc, row) => {
    const k = key(row)
    acc[k] = acc[k] || { key: k, count: 0, total: 0, approved: 0, paid: 0, awaiting: 0 }
    acc[k].count += 1
    acc[k].total += Number(row.total || 0)
    acc[k].approved += Number(row.approved_total || 0)
    acc[k].paid += Number(row.reimbursed_total || 0)
    acc[k].awaiting += owing(row)
    return acc
  }, {})).sort((a, b) => b.total - a.total)

  return (
    <div className="te-page">
      <div className="te-inline-form">
        <label><span>From</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label><span>To</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      </div>
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      <div className="te-report-grid">
        <Summary title="Travel requests by status" rows={group(inRange.filter((row) => row.kind === 'travel'), (row) => TRAVEL_STATUS[row.status] || row.status)}
          columns={[['Status', (r) => r.key], ['Requests', (r) => r.count, true], ['Estimated', (r) => teMoney(r.total), true]]} />
        <Summary title="Expense claims by employee" rows={group(claims, (row) => row.employee_name)}
          columns={[['Employee', (r) => r.key], ['Claims', (r) => r.count, true], ['Submitted', (r) => teMoney(r.total), true], ['Approved', (r) => teMoney(r.approved), true]]} />
        <Summary title="Approved and outstanding reimbursements" rows={group(claims.filter((row) => row.payment_status !== 'not_due'), (row) => row.employee_name)}
          columns={[['Employee', (r) => r.key], ['Approved', (r) => teMoney(r.approved), true], ['Reimbursed', (r) => teMoney(r.paid), true], ['Outstanding', (r) => teMoney(r.awaiting), true]]} />
        <Summary title="Travel spending by store" rows={group(claims, (row) => row.store_name || '—')}
          columns={[['Store', (r) => r.key], ['Claims', (r) => r.count, true], ['Submitted', (r) => teMoney(r.total), true], ['Approved', (r) => teMoney(r.approved), true]]} />
        <Summary title="Expense category summary" rows={lines?.categories || []}
          columns={[['Category', (r) => r.category], ['Lines', (r) => r.lines, true], ['Claimed', (r) => teMoney(r.claimed), true], ['Approved', (r) => teMoney(r.approved), true]]} />
        <Summary title="Mileage reimbursements" rows={lines?.mileage && Number(lines.mileage.trips) ? [lines.mileage] : []}
          columns={[['Trips', (r) => r.trips, true], ['Kilometres', (r) => Number(r.km).toLocaleString('en-CA'), true], ['Claimed', (r) => teMoney(r.claimed), true], ['Approved', (r) => teMoney(r.approved), true]]} />
      </div>
    </div>
  )
}

function Policy({ orgId }) {
  const [policy, setPolicy] = useState(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => { loadOrgPolicy(orgId).then((p) => setPolicy(Object.fromEntries(Object.entries(p || {}).map(([k, v]) => [k, v == null ? '' : v])))).catch((error) => setProblem(error?.message || String(error))) }, [orgId])
  if (!policy) return problem ? <p className="myhr-editor-problem">{problem}</p> : <p className="myhr-empty">Loading…</p>
  const set = (key) => (event) => setPolicy((current) => ({ ...current, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }))
  async function save(event) {
    event.preventDefault()
    setBusy(true)
    setProblem('')
    setNotice('')
    try { await saveOrgPolicy(orgId, policy); setNotice('Travel policy saved.') } catch (error) { setProblem(error?.message || String(error)) } finally { setBusy(false) }
  }
  return (
    <form className="te-form" onSubmit={save}>
      <section className="te-panel">
        <h4 className="te-h4">Rates and limits</h4>
        <p className="te-muted">Employees see these but can't change them. Leave a limit blank for none. Rates aren't filled in for you: set the ones your organization uses.</p>
        <div className="te-grid">
          <label><span>Currency</span><input value={policy.currency || 'CAD'} onChange={set('currency')} maxLength={3} /></label>
          <label className="te-check"><input type="checkbox" checked={Boolean(policy.mileage_enabled)} onChange={set('mileage_enabled')} /> <span>Allow mileage claims</span></label>
          <label><span>Mileage rate (per business km)</span><input type="number" min="0" step="0.0001" value={policy.mileage_rate} onChange={set('mileage_rate')} /></label>
          <label><span>Meals, per day</span><input type="number" min="0" step="0.01" value={policy.meal_daily_limit} onChange={set('meal_daily_limit')} /></label>
          <label><span>Lodging, per night</span><input type="number" min="0" step="0.01" value={policy.lodging_nightly_limit} onChange={set('lodging_nightly_limit')} /></label>
          <label><span>Receipt required over</span><input type="number" min="0" step="0.01" value={policy.receipt_required_over} onChange={set('receipt_required_over')} /></label>
          <label><span>Store managers can approve up to</span><input type="number" min="0" step="0.01" value={policy.manager_approval_limit} onChange={set('manager_approval_limit')} placeholder="Blank: only the organization" /></label>
          <label className="wide"><span>Policy notes shown to employees</span><textarea rows={2} value={policy.policy_notes} onChange={set('policy_notes')} /></label>
        </div>
      </section>
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      {notice ? <p className="myhr-notice">{notice}</p> : null}
      <div className="te-actions end"><button type="submit" className="gold-button" disabled={busy}>{busy ? 'Saving…' : 'Save policy'}</button></div>
    </form>
  )
}

export default function OrgTravelExpenses({ orgId }) {
  const [tab, setTab] = useState('approve')
  const [records, setRecords] = useState([])
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')

  const reload = () => loadOrgRecords(orgId).then(setRecords).catch((error) => setProblem(error?.message || String(error)))
  useEffect(() => { reload() }, [orgId])

  const waiting = useMemo(() => records.filter((row) => ['submitted', 'under_review'].includes(row.status)), [records])
  const awaiting = useMemo(() => records.filter((row) => ['awaiting', 'partial'].includes(row.payment_status)), [records])

  async function openRecord(row) {
    setProblem('')
    setNotice('')
    try { setOpen(await loadOrgRecord(orgId, row.kind, row.id)) } catch (error) { setProblem(error?.message || String(error)) }
  }
  async function act(action, message) {
    setBusy(true)
    setProblem('')
    try {
      await action()
      setNotice(message)
      await reload()
      setOpen(await loadOrgRecord(orgId, open.kind, open.id))
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="te-org">
      <h1 className="te-org-title">Travel &amp; Expenses</h1>
      {open ? (
        <>
          <button type="button" className="myhr-back" onClick={() => { setOpen(null); setNotice('') }}><ArrowLeft size={16} /> Back</button>
          {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
          {notice ? <p className="myhr-notice">{notice}</p> : null}
          <TERecordDetail
            record={open}
            busy={busy}
            canDecide
            onDecide={(decision, note, lines) => act(() => orgDecide(orgId, open.kind, open.id, decision, note, lines), `${open.reference}: decision saved.`)}
            onRecordPayment={(payment) => { if (window.confirm(`Record that ${teMoney(payment.amount, open.currency)} was paid to ${open.employee_name} by ${payment.method}?`)) act(() => recordReimbursement(orgId, open.id, payment), `${open.reference}: reimbursement recorded.`) }}
          />
        </>
      ) : (
        <>
          <div className="te-tabs" role="tablist">
            {TABS.map(([key, label]) => (
              <button type="button" role="tab" key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
                {label}{key === 'approve' && waiting.length ? ` (${waiting.length})` : key === 'awaiting' && awaiting.length ? ` (${awaiting.length})` : ''}
              </button>
            ))}
          </div>
          {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
          {notice ? <p className="myhr-notice">{notice}</p> : null}
          {tab === 'approve' ? <Table rows={waiting} onOpen={openRecord} empty="Nothing waiting for approval." />
            : tab === 'all' ? <Table rows={records} onOpen={openRecord} empty="No travel requests or expense claims yet." />
              : tab === 'awaiting' ? (
                <>
                  <p className="te-muted">Approved claims stay here until you record the payment with its reference. Approval alone never marks a claim paid.</p>
                  <Table rows={awaiting} onOpen={openRecord} empty="No approved claims waiting for payment." />
                </>
              ) : tab === 'reports' ? <Reports orgId={orgId} records={records} />
                : <Policy orgId={orgId} />}
        </>
      )}
    </div>
  )
}
