import React, { useEffect, useState } from 'react'
import { AlertTriangle, Check, Plus, Trash2, X } from 'lucide-react'
import { ID_FIELDS, adminApproveConfig, adminPawnConfigs, adminSaveConfig } from '../lib/pawnLoans'

// Admin workspace → Pawn Jurisdictions (CollectorsHub platform administrators only).
// One set of pawn terms per province / territory, matching the Nordvik Regions:
// every store uses the configuration for its Region's province. Stores and
// organizations never create or change these.

export const PROVINCES = [['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'], ['NL', 'Newfoundland and Labrador'], ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'], ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec'], ['SK', 'Saskatchewan'], ['YT', 'Yukon']]

const NUMBER_RULES = [
  ['term_days_default', 'Standard loan term (days)'], ['term_days_max', 'Maximum loan term (days)'], ['interest_monthly_pct_max', 'Maximum interest rate (% a month)'],
  ['charges_cap_pct_of_principal', 'Cap on all charges (% of principal, optional)'], ['min_principal', 'Minimum loan ($, optional)'], ['max_principal', 'Maximum loan ($, optional)'],
  ['grace_days', 'Grace period after the due date (days)'], ['forfeiture_wait_days', 'Further wait before forfeiture (days)'], ['forfeiture_notice_days', 'Forfeiture notice at least (days before)'],
  ['max_renewals', 'Maximum renewals (optional)'], ['borrower_min_age', 'Minimum borrower age (optional)'], ['record_retention_years', 'Keep records for (years)'],
]
const BOOL_RULES = [
  ['partial_payments_allowed', 'Partial payments allowed'], ['renewals_allowed', 'Renewals allowed'], ['charges_after_due', 'Interest continues after the due date'],
  ['forfeiture_notice_required', 'A forfeiture notice is required'], ['electronic_signature_allowed', 'Electronic signatures allowed'], ['licence_required', 'A lending licence is required'],
]
// Made-up values for test stores to try the flow. Status "test" is never used by a real store.
const testConfig = (code, name) => ({
  name: `TEST configuration for ${name} (made-up values)`, jurisdiction: `CA-${code}`, status: 'test',
  rules: {
    term_days_default: 30, term_days_max: 90, interest_monthly_pct_max: 3, grace_days: 10, forfeiture_wait_days: 20,
    forfeiture_notice_required: true, forfeiture_notice_days: 10, partial_payments_allowed: true, renewals_allowed: true, max_renewals: 3,
    charges_after_due: false, electronic_signature_allowed: true, licence_required: false, record_retention_years: 7,
    fees: [{ code: 'test_fee', label: 'TEST handling charge', basis: 'flat', amount: 5 }],
    id_fields: ['name', 'date_of_birth', 'address', 'id_type'],
    disclosures: 'TEST DISCLOSURES. These are made-up values for trying CollectorsHub POS at a test store. They are not legal terms and must not be used for real loans.',
    agreement_template: '',
  },
})
const PLACEHOLDERS = '{{loan_number}} {{store_name}} {{store_address}} {{licence_number}} {{customer_name}} {{issue_date}} {{due_date}} {{term_days}} {{principal}} {{interest_rate}} {{interest_for_term}} {{fees}} {{cost_of_borrowing}} {{redemption_at_due}} {{grace_days}} {{collateral_table}} {{disclosures}} {{signature_block}}'
const tone = (status) => (status === 'approved' ? 'active' : status === 'test' ? 'due_soon' : status === 'retired' ? 'cancelled' : 'draft')

export default function PawnJurisdictions() {
  const [configs, setConfigs] = useState(null)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState(null)
  const [approving, setApproving] = useState(null)
  async function load() { try { setConfigs((await adminPawnConfigs()).configs || []); setProblem('') } catch (error) { setProblem(error.message); setConfigs([]) } }
  useEffect(() => { load() }, [])
  async function act(task, message) { setProblem(''); setNotice(''); try { await task(); setNotice(message); await load() } catch (error) { setProblem(error.message) } finally { window.scrollTo({ top: 0, behavior: 'smooth' }) } }
  if (configs === null) return <section className="cu-page pw-page"><p className="cs-muted">Loading…</p></section>

  return (
    <section className="cu-page pw-page">
      <p className="cs-muted">Pawn terms for each province and territory. Every store uses the configuration for its Region's province: approved first, then Test (test stores only), then Draft. Stores and organizations can't create or change these. Values here aren't legal advice; approving one records who reviewed it.</p>
      {notice ? <p className="cu-notice"><Check size={15} /> {notice}</p> : null}
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      <div className="tx-card">
        <table className="cs-table tx-items">
          <thead><tr><th>Province / territory</th><th>Configurations</th><th className="num">Stores</th><th /></tr></thead>
          <tbody>{PROVINCES.map(([code, name]) => {
            const mine = configs.filter((c) => c.jurisdiction === `CA-${code}`)
            return (
              <tr key={code}>
                <td><strong>{name}</strong><small className="tx-sku">CA-{code}</small></td>
                <td>{!mine.length ? <span className="cs-muted">None</span> : mine.map((c) => (
                  <div className="pw-juris-row" key={c.id}>
                    <span className={`pw-pill ${tone(c.status)}`}>{c.status}</span> <strong>{c.name}</strong>
                    {c.reviewed_by ? <small> · reviewed by {c.reviewed_by} ({c.review_reference})</small> : null}
                    {c.missing?.length && c.status !== 'retired' ? <small className="pw-overdue"> Missing: {c.missing.join(', ')}</small> : null}
                    <span className="pw-juris-actions">
                      <button type="button" onClick={() => setEditing(JSON.parse(JSON.stringify(c)))}>Edit</button>
                      {!['approved', 'retired'].includes(c.status) ? <button type="button" disabled={Boolean(c.missing?.length)} title={c.missing?.length ? 'Fill in the missing items first' : ''} onClick={() => setApproving({ id: c.id, name: c.name, reviewedBy: '', reference: '', confirm: false })}>Approve…</button> : null}
                    </span>
                  </div>
                ))}</td>
                <td className="num">{mine[0]?.stores ?? 0}</td>
                <td className="tx-row-action">
                  <button type="button" onClick={() => setEditing({ name: `${name} pawn terms`, jurisdiction: `CA-${code}`, status: 'draft', rules: { fees: [], id_fields: ['name', 'date_of_birth', 'address', 'id_type'] } })}><Plus size={14} /> New</button>
                  {!mine.some((c) => c.status === 'test') ? <button type="button" onClick={() => act(() => adminSaveConfig(testConfig(code, name)), `Test configuration created for ${name}. Test stores there can now try New Pawn.`)}>Add test</button> : null}
                </td>
              </tr>
            )
          })}</tbody>
        </table>
      </div>

      {editing ? <ConfigEditor config={editing} onCancel={() => setEditing(null)} onSave={(config) => act(async () => { await adminSaveConfig(config); setEditing(null) }, 'Configuration saved.')} /> : null}
      {approving ? (
        <div className="register-modal cu-modal" role="dialog" aria-modal="true"><section>
          <button className="modal-close" type="button" onClick={() => setApproving(null)} aria-label="Close"><X size={18} /></button>
          <h2>Approve "{approving.name}"</h2>
          <p className="cs-muted">Approval lets stores in this province use these terms for real loans (once the organization turns lending on and verifies the licence). It records who reviewed it; it isn't proof of compliance. Changing the rules later sends it back to draft. Any earlier approved configuration for the province is retired.</p>
          <label className="tx-field"><span>Reviewed by (lawyer / compliance reviewer)</span><input value={approving.reviewedBy} onChange={(event) => setApproving({ ...approving, reviewedBy: event.target.value })} /></label>
          <label className="tx-field"><span>Reference (opinion, file or date)</span><input value={approving.reference} onChange={(event) => setApproving({ ...approving, reference: event.target.value })} /></label>
          <label className="tx-check"><input type="checkbox" checked={approving.confirm} onChange={(event) => setApproving({ ...approving, confirm: event.target.checked })} /> The values, disclosures and agreement template were reviewed against the applicable law.</label>
          <div className="cs-actions"><button type="button" onClick={() => setApproving(null)}>Cancel</button><button type="button" className="gold-button" disabled={!approving.confirm || !approving.reviewedBy.trim() || !approving.reference.trim()} onClick={() => act(async () => { await adminApproveConfig(approving.id, approving.reviewedBy, approving.reference, approving.confirm); setApproving(null) }, 'Configuration approved.')}>Approve</button></div>
        </section></div>
      ) : null}
    </section>
  )
}

function ConfigEditor({ config, onCancel, onSave }) {
  const [c, setC] = useState(config)
  const rules = c.rules || {}
  const setRule = (key, value) => setC({ ...c, rules: { ...rules, [key]: value } })
  const fees = rules.fees || []
  return (
    <div className="register-modal cu-modal wide" role="dialog" aria-modal="true"><section className="pw-config">
      <button className="modal-close" type="button" onClick={onCancel} aria-label="Close"><X size={18} /></button>
      <h2>{c.id ? 'Edit configuration' : 'New configuration'}</h2>
      {c.status === 'approved' ? <p className="cu-notice"><AlertTriangle size={15} /> Changing the rules takes this configuration back to draft until it's approved again.</p> : null}
      <div className="cs-form-grid">
        <label><span>Name</span><input value={c.name} onChange={(event) => setC({ ...c, name: event.target.value })} /></label>
        <label><span>Province / territory</span><select value={c.jurisdiction} onChange={(event) => setC({ ...c, jurisdiction: event.target.value })}><option value="">Choose…</option>{PROVINCES.map(([code, name]) => <option key={code} value={`CA-${code}`}>{name}</option>)}</select></label>
        <label><span>Status</span><select value={c.status === 'approved' ? 'draft' : c.status} onChange={(event) => setC({ ...c, status: event.target.value })}><option value="draft">Draft</option><option value="test">Test (test stores only)</option><option value="retired">Retired</option></select></label>
      </div>
      <h3>Limits and periods</h3>
      <div className="cs-form-grid">{NUMBER_RULES.map(([key, label]) => <label key={key}><span>{label}</span><input inputMode="decimal" value={rules[key] ?? ''} onChange={(event) => setRule(key, event.target.value === '' ? null : Number(event.target.value))} /></label>)}</div>
      <div className="pw-bools">{BOOL_RULES.map(([key, label]) => (
        <label key={key}><span>{label}</span><select value={rules[key] == null ? '' : String(rules[key])} onChange={(event) => setRule(key, event.target.value === '' ? null : event.target.value === 'true')}><option value="">Not set</option><option value="true">Yes</option><option value="false">No</option></select></label>
      ))}</div>
      <h3>Charges at issue</h3>
      {fees.map((fee, index) => (
        <div className="pw-fee" key={index}>
          <input value={fee.label || ''} onChange={(event) => setRule('fees', fees.map((f, i) => (i === index ? { ...f, label: event.target.value, code: f.code || `fee${i + 1}` } : f)))} placeholder="Label (e.g. appraisal fee)" />
          <select value={fee.basis || 'flat'} onChange={(event) => setRule('fees', fees.map((f, i) => (i === index ? { ...f, basis: event.target.value } : f)))}><option value="flat">$ flat</option><option value="percent">% of principal</option></select>
          <input inputMode="decimal" value={fee.amount ?? ''} onChange={(event) => setRule('fees', fees.map((f, i) => (i === index ? { ...f, amount: Number(event.target.value) } : f)))} placeholder="Amount" />
          <input inputMode="decimal" value={fee.max ?? ''} onChange={(event) => setRule('fees', fees.map((f, i) => (i === index ? { ...f, max: event.target.value === '' ? null : Number(event.target.value) } : f)))} placeholder="Max $ (optional)" />
          <button type="button" onClick={() => setRule('fees', fees.filter((_, i) => i !== index))} aria-label="Remove charge"><Trash2 size={14} /></button>
        </div>
      ))}
      <button type="button" onClick={() => setRule('fees', [...fees, { code: `fee${fees.length + 1}`, label: '', basis: 'flat', amount: 0 }])}><Plus size={14} /> Add a charge</button>
      <h3>Identification to record</h3>
      <div className="pw-bools">{ID_FIELDS.map(([key, label]) => <label className="tx-check" key={key}><input type="checkbox" checked={(rules.id_fields || []).includes(key)} onChange={(event) => setRule('id_fields', event.target.checked ? [...(rules.id_fields || []), key] : (rules.id_fields || []).filter((k) => k !== key))} /> {label}</label>)}</div>
      <label className="tx-field"><span>Required disclosures (shown on the agreement)</span><textarea rows={5} value={rules.disclosures || ''} onChange={(event) => setRule('disclosures', event.target.value)} /></label>
      <label className="tx-field"><span>Approved agreement template (HTML). Placeholders: {PLACEHOLDERS}</span><textarea rows={8} className="tx-mono" value={rules.agreement_template || ''} onChange={(event) => setRule('agreement_template', event.target.value)} /></label>
      <div className="cs-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="gold-button" disabled={!c.name.trim() || !c.jurisdiction} onClick={() => onSave(c)}>Save configuration</button></div>
    </section></div>
  )
}
