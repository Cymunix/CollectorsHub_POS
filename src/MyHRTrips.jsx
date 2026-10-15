import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Plus } from 'lucide-react'
import { cancelRecord, decideRecord, loadMyRecords, loadRecord, loadStoreToDecide, owing } from './lib/travelExpenses'
import TERecordDetail, { TEStatus, teDateTime, teDates, teMoney } from './TERecordDetail'

// My Trips and Expenses: the employee's own travel requests and expense claims,
// and (for store managers) the ones they may approve.

const FILTERS = [
  ['all', 'All'], ['draft', 'Drafts'], ['pending', 'Pending Approval'], ['approved', 'Approved'], ['rejected', 'Rejected'],
  ['returned', 'Returned for Correction'], ['paid', 'Paid'], ['cancelled', 'Cancelled'],
]
const matches = (record, filter) => {
  if (filter === 'all') return true
  if (filter === 'pending') return ['submitted', 'under_review'].includes(record.status)
  if (filter === 'approved') return ['approved', 'partially_approved'].includes(record.status) && record.payment_status !== 'paid'
  if (filter === 'paid') return record.payment_status === 'paid'
  return record.status === filter
}

export default function MyHRTrips({ storeId, onCreate, onEdit, isManager }) {
  const [records, setRecords] = useState([])
  const [toDecide, setToDecide] = useState([])
  const [tab, setTab] = useState('mine')
  const [filter, setFilter] = useState('all')
  const [open, setOpen] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')

  async function reload() {
    try {
      const [mine, decide] = await Promise.all([loadMyRecords(storeId), isManager ? loadStoreToDecide(storeId) : Promise.resolve([])])
      setRecords(mine)
      setToDecide(decide)
      setProblem('')
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { reload() }, [storeId, isManager])

  async function openRecord(row) {
    setProblem('')
    setNotice('')
    try { setOpen(await loadRecord(storeId, row.kind, row.id)) } catch (error) { setProblem(error?.message || String(error)) }
  }
  async function act(action, message) {
    setBusy(true)
    setProblem('')
    try {
      await action()
      setNotice(message)
      await reload()
      if (open) setOpen(await loadRecord(storeId, open.kind, open.id).catch(() => null))
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  const cards = useMemo(() => ({
    activeTravel: records.filter((r) => r.kind === 'travel' && ['submitted', 'under_review', 'approved'].includes(r.status) && (!r.end_date || r.end_date >= new Date().toISOString().slice(0, 10))).length,
    pendingClaims: records.filter((r) => r.kind === 'claim' && ['submitted', 'under_review'].includes(r.status)).length,
    approved: records.filter((r) => r.kind === 'claim' && ['approved', 'partially_approved'].includes(r.status)).reduce((sum, r) => sum + Number(r.approved_total || 0), 0),
    awaiting: records.filter((r) => r.kind === 'claim' && ['awaiting', 'partial'].includes(r.payment_status)).reduce((sum, r) => sum + owing(r), 0),
  }), [records])
  const shown = (tab === 'mine' ? records.filter((record) => matches(record, filter)) : toDecide)

  if (open) {
    return (
      <div className="te-page">
        <button type="button" className="myhr-back" onClick={() => { setOpen(null); setNotice('') }}><ArrowLeft size={16} /> Back to my trips and expenses</button>
        {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
        {notice ? <p className="myhr-notice">{notice}</p> : null}
        <TERecordDetail
          record={open}
          busy={busy}
          canDecide={open.can_decide}
          onEdit={() => onEdit(open.kind, open.id)}
          onCancel={() => { if (window.confirm(`Cancel ${open.reference}?`)) act(() => cancelRecord(storeId, open.kind, open.id), `${open.reference} cancelled.`) }}
          onDecide={(decision, note, lines) => act(() => decideRecord(storeId, open.kind, open.id, decision, note, lines), `${open.reference}: decision saved.`)}
        />
      </div>
    )
  }

  return (
    <div className="te-page">
      <div className="te-cards">
        <div className="myhr-pay-card"><span className="myhr-pay-card-label">Active Travel Requests</span><strong className="myhr-pay-big">{cards.activeTravel}</strong></div>
        <div className="myhr-pay-card"><span className="myhr-pay-card-label">Pending Expense Claims</span><strong className="myhr-pay-big">{cards.pendingClaims}</strong></div>
        <div className="myhr-pay-card"><span className="myhr-pay-card-label">Approved Reimbursements</span><strong className="myhr-pay-big">{teMoney(cards.approved)}</strong></div>
        <div className="myhr-pay-card"><span className="myhr-pay-card-label">Reimbursements Awaiting Payment</span><strong className="myhr-pay-big">{teMoney(cards.awaiting)}</strong></div>
      </div>

      <div className="te-toolbar">
        {isManager ? (
          <div className="te-tabs" role="tablist">
            <button type="button" role="tab" className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>Mine</button>
            <button type="button" role="tab" className={tab === 'decide' ? 'active' : ''} onClick={() => setTab('decide')}>To approve{toDecide.length ? ` (${toDecide.length})` : ''}</button>
          </div>
        ) : <span />}
        <div className="te-actions">
          <button type="button" className="te-secondary" onClick={() => onCreate('travel')}><Plus size={15} /> Travel request</button>
          <button type="button" className="gold-button" onClick={() => onCreate('claim')}><Plus size={15} /> Expense claim</button>
        </div>
      </div>

      {tab === 'mine' ? (
        <div className="te-filters">
          {FILTERS.map(([key, label]) => <button type="button" key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}
        </div>
      ) : <p className="te-muted">Requests and claims from your store within your organization's manager approval limit. Your own are approved by the organization.</p>}

      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      {notice ? <p className="myhr-notice">{notice}</p> : null}

      <div className="te-table-wrap">
        <table className="te-table clickable">
          <thead>
            <tr>
              <th>Reference</th><th>Type</th>{tab === 'decide' ? <th>Employee</th> : null}<th>Description</th><th>Dates</th>
              <th className="num">Total</th><th>Currency</th><th>Status</th><th>Last updated</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={9} className="te-muted">Loading…</td></tr>
              : shown.length ? shown.map((row) => (
                <tr key={`${row.kind}-${row.id}`} onClick={() => openRecord(row)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') openRecord(row) }}>
                  <td className="te-ref">{row.reference}</td>
                  <td>{row.kind === 'travel' ? 'Travel request' : 'Expense claim'}</td>
                  {tab === 'decide' ? <td>{row.employee_name}</td> : null}
                  <td>{row.description}</td>
                  <td>{teDates(row.start_date, row.end_date)}</td>
                  <td className="num">{teMoney(row.approved_total ?? row.total, row.currency)}</td>
                  <td>{row.currency}</td>
                  <td><TEStatus record={row} /></td>
                  <td>{teDateTime(row.updated_at)}</td>
                </tr>
              )) : (
                <tr><td colSpan={9} className="te-muted">{tab === 'decide' ? 'Nothing waiting for your approval.' : filter === 'all' ? 'No travel requests or expense claims yet.' : 'Nothing with this status.'}</td></tr>
              )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
