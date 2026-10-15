import React, { useEffect, useState } from 'react'
import { Plus, Save, Send, Trash2 } from 'lucide-react'
import { ESTIMATE_CATEGORIES, TRANSPORT, loadContext, loadRecord, saveTravel } from './lib/travelExpenses'
import { teMoney } from './TERecordDetail'

// Create (or correct) a business travel request. Employee and organization details
// fill in from their account; policy comes from the organization and is read-only.

const blankLine = () => ({ category: '', description: '', amount: '' })

export default function MyHRTravelRequest({ storeId, editingId, onDone }) {
  const [context, setContext] = useState(null)
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const ctx = await loadContext(storeId)
        const existing = editingId ? await loadRecord(storeId, 'travel', editingId) : null
        if (!alive) return
        setContext(ctx)
        setForm(existing ? {
          department: existing.department || '', work_location: existing.work_location || '', destination: existing.destination || '',
          purpose: existing.purpose || '', departure_date: existing.departure_date || '', return_date: existing.return_date || '',
          transport: existing.transport || '', accommodation: existing.accommodation || '', notes: existing.notes || '',
          estimate_lines: (existing.estimate_lines || []).length ? existing.estimate_lines.map((line) => ({ ...line, amount: String(line.amount) })) : [blankLine()],
          reference: existing.reference, status: existing.status, decision_note: existing.decision_note,
        } : {
          department: ctx.department || '', work_location: ctx.work_location || '', destination: '', purpose: '', departure_date: '', return_date: '',
          transport: '', accommodation: '', notes: '', estimate_lines: [blankLine()],
        })
      } catch (error) {
        if (alive) setProblem(error?.message || String(error))
      }
    })()
    return () => { alive = false }
  }, [storeId, editingId])

  if (!form) return problem ? <p className="myhr-editor-problem">{problem}</p> : <p className="myhr-empty">Loading…</p>
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const setLine = (index, key, value) => setForm((current) => ({ ...current, estimate_lines: current.estimate_lines.map((line, i) => (i === index ? { ...line, [key]: value } : line)) }))
  const total = form.estimate_lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0)
  const policy = context?.policy || {}
  const currency = policy.currency || 'CAD'

  async function save(submit) {
    setProblem('')
    if (submit && form.return_date && form.departure_date && form.return_date < form.departure_date) { setProblem('The return date has to be on or after the departure date.'); return }
    setBusy(true)
    try {
      const id = await saveTravel(storeId, editingId, form, submit)
      onDone(submit ? 'Travel request submitted for approval.' : 'Draft saved.', id)
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
        <h4 className="te-h4">Traveller</h4>
        <div className="te-grid">
          <label><span>Employee</span><input value={context?.employee_name || ''} readOnly /></label>
          <label><span>Organization</span><input value={context?.organization || ''} readOnly /></label>
          <label><span>Department</span><input value={form.department} onChange={set('department')} placeholder="e.g. Sales" /></label>
          <label><span>Assigned work location</span><input value={form.work_location} onChange={set('work_location')} /></label>
        </div>
      </section>

      <section className="te-panel">
        <h4 className="te-h4">Trip</h4>
        <div className="te-grid">
          <label><span>Destination *</span><input value={form.destination} onChange={set('destination')} placeholder="e.g. Toronto, ON" /></label>
          <label><span>Transportation *</span>
            <select value={form.transport} onChange={set('transport')}><option value="">Choose…</option>{TRANSPORT.map((item) => <option key={item}>{item}</option>)}</select>
          </label>
          <label><span>Departure date *</span><input type="date" value={form.departure_date} onChange={set('departure_date')} /></label>
          <label><span>Return date *</span><input type="date" value={form.return_date} min={form.departure_date || undefined} onChange={set('return_date')} /></label>
          <label className="wide"><span>Purpose of travel *</span><input value={form.purpose} onChange={set('purpose')} placeholder="e.g. Card show booth, supplier meeting" /></label>
          <label className="wide"><span>Accommodation needed</span><input value={form.accommodation} onChange={set('accommodation')} placeholder="e.g. 2 nights, hotel near the venue" /></label>
          <label className="wide"><span>Additional notes</span><textarea rows={2} value={form.notes} onChange={set('notes')} /></label>
        </div>
      </section>

      <section className="te-panel">
        <h4 className="te-h4">Estimated expenses</h4>
        <table className="te-table te-edit">
          <thead><tr><th>Category</th><th>Description</th><th className="num">Amount ({currency})</th><th /></tr></thead>
          <tbody>
            {form.estimate_lines.map((line, index) => (
              <tr key={index}>
                <td><select value={line.category} onChange={(event) => setLine(index, 'category', event.target.value)}><option value="">Choose…</option>{ESTIMATE_CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></td>
                <td><input value={line.description} onChange={(event) => setLine(index, 'description', event.target.value)} /></td>
                <td className="num"><input type="number" min="0" step="0.01" value={line.amount} onChange={(event) => setLine(index, 'amount', event.target.value)} /></td>
                <td><button type="button" className="te-icon" aria-label="Remove line" disabled={form.estimate_lines.length === 1} onClick={() => setForm((current) => ({ ...current, estimate_lines: current.estimate_lines.filter((_, i) => i !== index) }))}><Trash2 size={15} /></button></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={2}><button type="button" className="te-link" onClick={() => setForm((current) => ({ ...current, estimate_lines: [...current.estimate_lines, blankLine()] }))}><Plus size={14} /> Add a line</button></td><td className="num">{teMoney(total, currency)}</td><td /></tr></tfoot>
        </table>
        <PolicyNote policy={policy} />
      </section>

      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      <div className="te-actions end">
        <button type="button" className="te-secondary" disabled={busy} onClick={() => save(false)}><Save size={15} /> Save draft</button>
        <button type="submit" className="gold-button" disabled={busy}><Send size={15} /> {busy ? 'Saving…' : 'Submit for approval'}</button>
      </div>
    </form>
  )
}

// The organization's travel policy, read-only.
export function PolicyNote({ policy }) {
  const currency = policy?.currency || 'CAD'
  const items = [
    policy?.mileage_enabled && policy?.mileage_rate != null ? `Mileage ${teMoney(policy.mileage_rate, currency)} per km` : 'Mileage claims are off',
    policy?.meal_daily_limit != null ? `Meals up to ${teMoney(policy.meal_daily_limit, currency)} a day` : null,
    policy?.lodging_nightly_limit != null ? `Lodging up to ${teMoney(policy.lodging_nightly_limit, currency)} a night` : null,
    policy?.receipt_required_over != null ? `Receipts required over ${teMoney(policy.receipt_required_over, currency)}` : null,
  ].filter(Boolean)
  return (
    <p className="te-policy">
      <b>Your organization's policy:</b> {items.join(' · ')}.{policy?.policy_notes ? ` ${policy.policy_notes}` : ''}
    </p>
  )
}
