import React, { useState } from 'react'
import { Check, CornerUpLeft, Eye, FileText, Pencil, Search, X } from 'lucide-react'
import { PAYMENT_STATUS, REIMBURSE_METHODS, TRAVEL_STATUS, owing, receiptUrl, statusTone } from './lib/travelExpenses'

// One travel request or expense claim: details, lines, receipts and approval history.
// Employees edit drafts / returned records and cancel; approvers decide (with partial
// approval per line); the organization records the reimbursement payment.

export const teMoney = (value, currency = 'CAD') => new Intl.NumberFormat('en-CA', { style: 'currency', currency: currency || 'CAD' }).format(Number(value || 0))
export const teDate = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '—')
export const teDateTime = (value) => (value ? new Date(value).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
export const teDates = (start, end) => (!start ? '—' : !end || start === end ? teDate(start) : `${teDate(start)} – ${teDate(end)}`)

export function TEStatus({ record }) {
  const label = record.payment_status === 'paid' ? 'Paid'
    : record.payment_status === 'awaiting' ? `${TRAVEL_STATUS[record.status]} · Awaiting Reimbursement`
      : record.payment_status === 'partial' ? `${TRAVEL_STATUS[record.status]} · Partly Reimbursed`
      : TRAVEL_STATUS[record.status] || record.status
  return <span className={`te-status ${statusTone(record)}`}>{label}</span>
}

function Receipt({ path, name }) {
  const [problem, setProblem] = useState('')
  if (!path) return <span className="te-muted">No receipt</span>
  return (
    <span>
      <button type="button" className="te-link" onClick={async () => { try { window.open(await receiptUrl(path), '_blank', 'noopener') } catch (error) { setProblem(error?.message || String(error)) } }}>
        <Eye size={14} /> {name || 'Receipt'}
      </button>
      {problem ? <small className="te-problem-inline">{problem}</small> : null}
    </span>
  )
}

export default function TERecordDetail({ record, canDecide, onDecide, onEdit, onCancel, onRecordPayment, busy }) {
  const [note, setNote] = useState('')
  const [lineEdits, setLineEdits] = useState({})
  const [payment, setPayment] = useState({ paidOn: new Date().toISOString().slice(0, 10), amount: owing(record).toFixed(2), method: '', reference: '', processedBy: '' })
  const setPay = (key) => (event) => setPayment((current) => ({ ...current, [key]: event.target.value }))
  const isClaim = record.kind === 'claim'
  const editable = record.mine && ['draft', 'returned'].includes(record.status)
  const cancellable = record.mine && ['draft', 'submitted', 'returned'].includes(record.status)
  const deciding = canDecide && ['submitted', 'under_review'].includes(record.status)
  const currency = record.currency || 'CAD'

  const linePayload = () => Object.fromEntries(Object.entries(lineEdits).map(([id, edit]) => [id, { approved_amount: edit.amount, note: edit.note }]))
  const approvedPreview = isClaim ? (record.lines || []).reduce((sum, line) => sum + Number(lineEdits[line.id]?.amount ?? line.amount_claim), 0) : 0

  return (
    <div className="te-detail">
      <div className="te-detail-head">
        <div>
          <span className="te-ref">{record.reference}</span>
          <h3>{isClaim ? (record.description || 'Expense claim') : `${record.destination || 'Travel request'}`}</h3>
          <small>{record.employee_name}{record.store_name ? ` · ${record.store_name}` : ''} · last updated {teDateTime(record.updated_at)}</small>
        </div>
        <TEStatus record={record} />
      </div>

      {record.decision_note && ['rejected', 'returned', 'approved', 'partially_approved'].includes(record.status) ? (
        <p className={`te-callout ${record.status === 'rejected' ? 'bad' : record.status === 'returned' ? 'warn' : ''}`}>
          <strong>{TRAVEL_STATUS[record.status]} by {record.decided_by_name}:</strong> {record.decision_note}
        </p>
      ) : null}

      {!isClaim ? (
        <>
          <dl className="te-facts">
            <div><dt>Purpose</dt><dd>{record.purpose || '—'}</dd></div>
            <div><dt>Dates</dt><dd>{teDates(record.departure_date, record.return_date)}</dd></div>
            <div><dt>Transportation</dt><dd>{record.transport || '—'}</dd></div>
            <div><dt>Accommodation</dt><dd>{record.accommodation || '—'}</dd></div>
            <div><dt>Department</dt><dd>{record.department || '—'}</dd></div>
            <div><dt>Work location</dt><dd>{record.work_location || '—'}</dd></div>
          </dl>
          {record.notes ? <p className="te-notes">{record.notes}</p> : null}
          <table className="te-table">
            <thead><tr><th>Estimated expense</th><th>Description</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {(record.estimate_lines || []).length ? record.estimate_lines.map((line, index) => (
                <tr key={index}><td>{line.category}</td><td>{line.description || '—'}</td><td className="num">{teMoney(line.amount, currency)}</td></tr>
              )) : <tr><td colSpan={3} className="te-muted">No estimates entered.</td></tr>}
            </tbody>
            <tfoot><tr><td colSpan={2}>Estimated total</td><td className="num">{teMoney(record.estimated_total, currency)}</td></tr></tfoot>
          </table>
        </>
      ) : (
        <>
          {record.travel_reference ? <p className="te-muted">For travel request {record.travel_reference}</p> : null}
          <div className="te-table-wrap">
            <table className="te-table">
              <thead>
                <tr><th>Date</th><th>Category</th><th>Details</th><th>Receipt</th><th className="num">Claimed</th><th className="num">Approved</th></tr>
              </thead>
              <tbody>
                {(record.lines || []).map((line) => {
                  const edit = lineEdits[line.id]
                  return (
                    <tr key={line.id}>
                      <td>{teDate(line.expense_date)}</td>
                      <td>{line.category}</td>
                      <td>
                        {line.kind === 'mileage'
                          ? <>{line.from_place} → {line.to_place} · {Number(line.km)} km × {teMoney(line.mileage_rate, currency)}/km</>
                          : <>{line.description || '—'}{line.business_purpose ? <small className="te-sub">Purpose: {line.business_purpose}</small> : null}</>}
                        {line.payment_method ? <small className="te-sub">Paid with {line.payment_method}</small> : null}
                        {line.tax_amount != null ? <small className="te-sub">Tax {teMoney(line.tax_amount, line.currency)}</small> : null}
                        {line.currency !== currency ? <small className="te-sub">{teMoney(line.amount, line.currency)} × {Number(line.exchange_rate)} ({line.rate_source}, {teDate(line.rate_date)})</small> : null}
                        {line.disallowed_note ? <small className="te-sub bad">Not approved in full: {line.disallowed_note}</small> : null}
                      </td>
                      <td>{line.kind === 'mileage' ? <span className="te-muted">—</span> : <Receipt path={line.receipt_path} name={line.receipt_name} />}</td>
                      <td className="num">{teMoney(line.amount_claim, currency)}</td>
                      <td className="num">
                        {deciding ? (
                          <span className="te-partial">
                            <input type="number" min="0" max={line.amount_claim} step="0.01" value={edit?.amount ?? line.amount_claim}
                              onChange={(event) => setLineEdits((current) => ({ ...current, [line.id]: { ...(current[line.id] || {}), amount: event.target.value } }))} aria-label="Approved amount" />
                            {edit && Number(edit.amount) < Number(line.amount_claim) ? (
                              <input placeholder="Why not in full?" value={edit.note || ''} onChange={(event) => setLineEdits((current) => ({ ...current, [line.id]: { ...current[line.id], note: event.target.value } }))} />
                            ) : null}
                          </span>
                        ) : line.approved_amount != null ? teMoney(line.approved_amount, currency) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr><td colSpan={4}>Total submitted</td><td className="num">{teMoney(record.submitted_total, currency)}</td><td className="num">{record.approved_total != null ? teMoney(record.approved_total, currency) : '—'}</td></tr>
                {record.approved_total != null && Number(record.approved_total) < Number(record.submitted_total) ? (
                  <tr><td colSpan={4}>Disallowed</td><td /><td className="num">{teMoney(Number(record.submitted_total) - Number(record.approved_total), currency)}</td></tr>
                ) : null}
              </tfoot>
            </table>
          </div>
          {record.approved_total != null ? (
            <dl className="te-money">
              <div><dt>Submitted</dt><dd>{teMoney(record.submitted_total, currency)}</dd></div>
              <div><dt>Approved</dt><dd>{teMoney(record.approved_total, currency)}</dd></div>
              <div><dt>Disallowed</dt><dd>{teMoney(Math.max(0, Number(record.submitted_total) - Number(record.approved_total)), currency)}</dd></div>
              <div><dt>Reimbursed</dt><dd>{teMoney(record.reimbursed_total, currency)}</dd></div>
              <div className={owing(record) > 0 ? 'owing' : ''}><dt>Outstanding</dt><dd>{teMoney(owing(record), currency)}</dd></div>
            </dl>
          ) : null}
          {(record.payments || []).length ? (
            <table className="te-table">
              <thead><tr><th>Paid on</th><th>Method</th><th>Reference</th><th>Processed by</th><th className="num">Amount</th></tr></thead>
              <tbody>{record.payments.map((pay) => <tr key={pay.id}><td>{teDate(pay.paid_on)}</td><td>{pay.method}</td><td>{pay.reference}</td><td>{pay.processed_by_name}</td><td className="num">{teMoney(pay.amount, currency)}</td></tr>)}</tbody>
            </table>
          ) : null}
          {['awaiting', 'partial'].includes(record.payment_status) ? (
            <p className="te-callout">{PAYMENT_STATUS[record.payment_status]}: {teMoney(owing(record), currency)} still to be paid. A claim is marked paid only when the organization records the payments.</p>
          ) : null}
        </>
      )}

      <h4 className="te-h4">Approval history</h4>
      <ul className="te-history">
        {(record.history || []).map((entry) => (
          <li key={entry.id}><b>{entry.action}</b> · {entry.by_name || '—'} · {teDateTime(entry.at)}{entry.note ? <small> — {entry.note}</small> : null}</li>
        ))}
      </ul>

      <div className="te-actions">
        {editable && onEdit ? <button type="button" className="gold-button" onClick={onEdit} disabled={busy}><Pencil size={15} /> {record.status === 'returned' ? 'Correct and resubmit' : 'Edit draft'}</button> : null}
        {cancellable && onCancel ? <button type="button" className="te-secondary" onClick={onCancel} disabled={busy}><X size={15} /> Cancel {isClaim ? 'claim' : 'request'}</button> : null}
      </div>

      {deciding && onDecide ? (
        <section className="te-decide">
          <h4 className="te-h4">Decision</h4>
          {isClaim ? <p className="te-muted">Lower an approved amount to approve part of a line (a reason is required). Approving to {teMoney(approvedPreview, currency)}.</p> : null}
          <textarea rows={2} placeholder="Note to the employee (required to reject or return)" value={note} onChange={(event) => setNote(event.target.value)} />
          <div className="te-actions">
            <button type="button" className="te-approve" disabled={busy} onClick={() => onDecide('approve', note, isClaim ? linePayload() : null)}><Check size={15} /> Approve</button>
            <button type="button" className="te-secondary" disabled={busy} onClick={() => onDecide('return', note)}><CornerUpLeft size={15} /> Return for correction</button>
            <button type="button" className="te-reject" disabled={busy} onClick={() => onDecide('reject', note)}><X size={15} /> Reject</button>
            {record.status === 'submitted' ? <button type="button" className="te-secondary" disabled={busy} onClick={() => onDecide('review', '')}><Search size={15} /> Mark under review</button> : null}
          </div>
        </section>
      ) : null}

      {isClaim && onRecordPayment && ['awaiting', 'partial'].includes(record.payment_status) ? (
        <section className="te-decide">
          <h4 className="te-h4">Record a reimbursement payment</h4>
          <p className="te-muted">Only once the money has actually been sent. Part payments are allowed; recording a payment can't be undone.</p>
          <div className="te-inline-form">
            <label><span>Paid on</span><input type="date" value={payment.paidOn} onChange={setPay('paidOn')} /></label>
            <label><span>Amount ({currency})</span><input type="number" min="0.01" max={owing(record)} step="0.01" value={payment.amount} onChange={setPay('amount')} /></label>
            <label><span>Method</span><select value={payment.method} onChange={setPay('method')}><option value="">Choose…</option>{REIMBURSE_METHODS.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label className="grow"><span>Payment reference</span><input value={payment.reference} onChange={setPay('reference')} placeholder="e.g. e-transfer or deposit number" /></label>
            <label className="grow"><span>Processed by</span><input value={payment.processedBy} onChange={setPay('processedBy')} placeholder="Who sent the payment" /></label>
            <button type="button" className="gold-button"
              disabled={busy || !payment.reference.trim() || !payment.paidOn || !payment.method || !payment.processedBy.trim() || !(Number(payment.amount) > 0) || Number(payment.amount) > owing(record) + 0.001}
              onClick={() => onRecordPayment(payment)}><FileText size={15} /> Record {teMoney(payment.amount, currency)}</button>
          </div>
        </section>
      ) : null}
    </div>
  )
}
