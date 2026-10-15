import React, { useEffect, useRef, useState } from 'react'
import { Car, Eye, Paperclip, Plus, RefreshCw, Save, Send, Trash2 } from 'lucide-react'
import { CURRENCIES, EXPENSE_CATEGORIES, PAYMENT_METHODS, loadApprovedTravel, loadContext, loadRecord, receiptUrl, removeReceipt, saveClaim, uploadReceipt } from './lib/travelExpenses'
import { PolicyNote } from './MyHRTravelRequest'
import { teDates, teMoney } from './TERecordDetail'

// Create (or correct) an expense claim: expense lines with receipts, and mileage lines
// at the organization's rate. Amounts in another currency keep the original amount, the
// exchange rate, where it came from and its date. Totals are recalculated on the server.

const today = () => new Date().toISOString().slice(0, 10)
const blankExpense = (currency) => ({ kind: 'expense', expense_date: today(), category: '', description: '', business_purpose: '', payment_method: '', amount: '', currency, exchange_rate: '', rate_source: '', rate_date: '', tax_amount: '', receipt_path: '', receipt_name: '' })
const blankMileage = () => ({ kind: 'mileage', expense_date: today(), from_place: '', to_place: '', km: '', business_purpose: '' })

function ReceiptCell({ line, onChange, onProblem }) {
  const input = useRef(null)
  const [busy, setBusy] = useState(false)
  async function pick(file) {
    if (!file) return
    setBusy(true)
    try {
      const uploaded = await uploadReceipt(file)
      // Replacing: the old, not-yet-submitted upload is removed.
      if (line.receipt_path && line.unsaved_receipt) removeReceipt(line.receipt_path).catch(() => {})
      onChange({ receipt_path: uploaded.path, receipt_name: uploaded.name, unsaved_receipt: true })
    } catch (error) {
      onProblem(error?.message || String(error))
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }
  return (
    <div className="te-receipt">
      <input ref={input} type="file" accept="image/*,application/pdf" capture="environment" hidden onChange={(event) => pick(event.target.files?.[0])} />
      {line.receipt_path ? (
        <>
          <button type="button" className="te-link" onClick={async () => { try { window.open(await receiptUrl(line.receipt_path), '_blank', 'noopener') } catch (error) { onProblem(error?.message || String(error)) } }}><Eye size={14} /> {line.receipt_name || 'Receipt'}</button>
          <span className="te-receipt-actions">
            <button type="button" className="te-link" disabled={busy} onClick={() => input.current?.click()}><RefreshCw size={13} /> Replace</button>
            <button type="button" className="te-link bad" disabled={busy} onClick={() => { if (line.unsaved_receipt) removeReceipt(line.receipt_path).catch(() => {}); onChange({ receipt_path: '', receipt_name: '', unsaved_receipt: false }) }}><Trash2 size={13} /> Remove</button>
          </span>
        </>
      ) : (
        <button type="button" className="te-link" disabled={busy} onClick={() => input.current?.click()}><Paperclip size={14} /> {busy ? 'Uploading…' : 'Attach receipt'}</button>
      )}
    </div>
  )
}

export default function MyHRExpenseClaim({ storeId, editingId, onDone }) {
  const [context, setContext] = useState(null)
  const [trips, setTrips] = useState([])
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [ctx, approved] = await Promise.all([loadContext(storeId), loadApprovedTravel(storeId)])
        const existing = editingId ? await loadRecord(storeId, 'claim', editingId) : null
        if (!alive) return
        const currency = ctx.policy?.currency || 'CAD'
        setContext(ctx)
        setTrips(approved)
        setForm(existing ? {
          travel_request_id: existing.travel_request_id || '', description: existing.description || '', reference: existing.reference,
          status: existing.status, decision_note: existing.decision_note,
          lines: (existing.lines || []).map((line) => Object.fromEntries(Object.entries(line).map(([key, value]) => [key, value == null ? '' : String(value)]))),
        } : { travel_request_id: '', description: '', lines: [blankExpense(currency)] })
      } catch (error) {
        if (alive) setProblem(error?.message || String(error))
      }
    })()
    return () => { alive = false }
  }, [storeId, editingId])

  if (!form) return problem ? <p className="myhr-editor-problem">{problem}</p> : <p className="myhr-empty">Loading…</p>
  const policy = context?.policy || {}
  const currency = policy.currency || 'CAD'
  const mileageOn = Boolean(policy.mileage_enabled && policy.mileage_rate != null)
  const setLine = (index, patch) => setForm((current) => ({ ...current, lines: current.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) }))
  const lineTotal = (line) => {
    if (line.kind === 'mileage') return Math.round((Number(line.km) || 0) * Number(policy.mileage_rate || 0) * 100) / 100
    const amount = Number(line.amount) || 0
    if ((line.currency || currency) === currency) return amount
    return Math.round(amount * (Number(line.exchange_rate) || 0) * 100) / 100
  }
  const total = form.lines.reduce((sum, line) => sum + lineTotal(line), 0)

  async function save(submit) {
    setProblem('')
    setBusy(true)
    try {
      const id = await saveClaim(storeId, editingId, form, submit)
      onDone(submit ? 'Expense claim submitted for approval.' : 'Draft saved.', id)
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="te-form" onSubmit={(event) => { event.preventDefault(); save(true) }}>
      {form.status === 'returned' ? <p className="te-callout warn"><strong>Returned for correction:</strong> {form.decision_note}</p> : null}
      <section className="te-panel">
        <h4 className="te-h4">Claim</h4>
        <div className="te-grid">
          <label><span>Employee</span><input value={context?.employee_name || ''} readOnly /></label>
          <label><span>Organization</span><input value={context?.organization || ''} readOnly /></label>
          <label><span>Travel request</span>
            <select value={form.travel_request_id} onChange={(event) => setForm((current) => ({ ...current, travel_request_id: event.target.value }))}>
              <option value="">Not for a trip (business expense)</option>
              {trips.map((trip) => <option key={trip.id} value={trip.id}>{trip.reference} · {trip.description} · {teDates(trip.start_date, trip.end_date)}</option>)}
            </select>
          </label>
          <label><span>Description</span><input value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="e.g. Toronto card show" /></label>
        </div>
      </section>

      <section className="te-panel">
        <h4 className="te-h4">Expenses</h4>
        <div className="te-lines">
          {form.lines.map((line, index) => (
            <div className={`te-line ${line.kind}`} key={index}>
              <div className="te-line-head">
                <b>{line.kind === 'mileage' ? <><Car size={15} /> Mileage</> : `Expense ${index + 1}`}</b>
                <span className="te-line-total">{teMoney(lineTotal(line), currency)}</span>
                <button type="button" className="te-icon" aria-label="Remove expense" onClick={() => { if (line.unsaved_receipt && line.receipt_path) removeReceipt(line.receipt_path).catch(() => {}); setForm((current) => ({ ...current, lines: current.lines.filter((_, i) => i !== index) })) }}><Trash2 size={15} /></button>
              </div>
              {line.kind === 'mileage' ? (
                <div className="te-grid four">
                  <label><span>Travel date *</span><input type="date" value={line.expense_date} onChange={(event) => setLine(index, { expense_date: event.target.value })} /></label>
                  <label><span>Starting location *</span><input value={line.from_place} onChange={(event) => setLine(index, { from_place: event.target.value })} /></label>
                  <label><span>Destination *</span><input value={line.to_place} onChange={(event) => setLine(index, { to_place: event.target.value })} /></label>
                  <label><span>Business km *</span><input type="number" min="0" step="0.1" value={line.km} onChange={(event) => setLine(index, { km: event.target.value })} /></label>
                  <label className="wide"><span>Business purpose</span><input value={line.business_purpose} onChange={(event) => setLine(index, { business_purpose: event.target.value })} /></label>
                  <p className="te-muted wide">{Number(line.km) || 0} km × {teMoney(policy.mileage_rate, currency)}/km (your organization's rate) = {teMoney(lineTotal(line), currency)}</p>
                </div>
              ) : (
                <div className="te-grid four">
                  <label><span>Date *</span><input type="date" value={line.expense_date} onChange={(event) => setLine(index, { expense_date: event.target.value })} /></label>
                  <label><span>Category *</span><select value={line.category} onChange={(event) => setLine(index, { category: event.target.value })}><option value="">Choose…</option>{EXPENSE_CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label>
                  <label><span>Amount *</span><input type="number" min="0" step="0.01" value={line.amount} onChange={(event) => setLine(index, { amount: event.target.value })} /></label>
                  <label><span>Currency</span><select value={line.currency || currency} onChange={(event) => setLine(index, { currency: event.target.value })}>{[...new Set([currency, ...CURRENCIES])].map((item) => <option key={item}>{item}</option>)}</select></label>
                  {(line.currency || currency) !== currency ? (
                    <>
                      <label><span>Rate to {currency} *</span><input type="number" min="0" step="0.000001" value={line.exchange_rate} onChange={(event) => setLine(index, { exchange_rate: event.target.value })} placeholder="e.g. 1.3650" /></label>
                      <label><span>Rate source *</span><input value={line.rate_source} onChange={(event) => setLine(index, { rate_source: event.target.value })} placeholder="e.g. Bank of Canada, card statement" /></label>
                      <label><span>Rate date *</span><input type="date" value={line.rate_date} onChange={(event) => setLine(index, { rate_date: event.target.value })} /></label>
                      <span />
                    </>
                  ) : null}
                  <label><span>Tax included</span><input type="number" min="0" step="0.01" value={line.tax_amount} onChange={(event) => setLine(index, { tax_amount: event.target.value })} placeholder="GST/HST" /></label>
                  <label><span>Paid with</span><select value={line.payment_method} onChange={(event) => setLine(index, { payment_method: event.target.value })}><option value="">Choose…</option>{PAYMENT_METHODS.map((item) => <option key={item}>{item}</option>)}</select></label>
                  <label className="wide"><span>Description</span><input value={line.description} onChange={(event) => setLine(index, { description: event.target.value })} /></label>
                  <label className="wide"><span>Business purpose</span><input value={line.business_purpose} onChange={(event) => setLine(index, { business_purpose: event.target.value })} /></label>
                  <div className="wide"><span className="te-label">Receipt</span><ReceiptCell line={line} onChange={(patch) => setLine(index, patch)} onProblem={setProblem} /></div>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="te-actions">
          <button type="button" className="te-secondary" onClick={() => setForm((current) => ({ ...current, lines: [...current.lines, blankExpense(currency)] }))}><Plus size={15} /> Add expense</button>
          <button type="button" className="te-secondary" disabled={!mileageOn} title={mileageOn ? '' : 'Your organization hasn\'t turned on mileage claims'} onClick={() => setForm((current) => ({ ...current, lines: [...current.lines, blankMileage()] }))}><Car size={15} /> Add mileage</button>
        </div>
        <p className="te-total">Total submitted: <b>{teMoney(total, currency)}</b></p>
        <PolicyNote policy={policy} />
      </section>

      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      <div className="te-actions end">
        <button type="button" className="te-secondary" disabled={busy} onClick={() => save(false)}><Save size={15} /> Save draft</button>
        <button type="submit" className="gold-button" disabled={busy}><Send size={15} /> {busy ? 'Saving…' : 'Submit claim'}</button>
      </div>
    </form>
  )
}
