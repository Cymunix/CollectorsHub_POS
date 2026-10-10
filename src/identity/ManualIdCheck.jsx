import { useState } from 'react'
import { AlertTriangle, IdCard, X } from 'lucide-react'
import { MANUAL_CONFIRMATION, recordBuybackIdentification } from '../lib/buybackIdentification'
import { DOCUMENT_TYPES } from './nordvikIdentity'

// Manual identification for one buyback:
//   kind 'manual': a registered, unverified customer (their NORDVIK Identity status doesn't change)
//   kind 'guest':  Guest Buyback Information (no account needed)
// Fields follow this location's rules. The server records the signed-in
// employee, checks the rules again, and links the record to the transaction.

export default function ManualIdCheck({ kind, customer, rules, storeId, locationId, onDone, onCancel }) {
  const accepted = DOCUMENT_TYPES.filter((type) => rules.accepted_id_types.includes(type.id))
  const [form, setForm] = useState({ full_name: kind === 'guest' ? '' : (customer?.fullName || customer?.name || ''), date_of_birth: '', address: '', contact: '', id_number: '', jurisdiction: 'Nova Scotia', idType: accepted[0]?.id || '' })
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const guest = kind === 'guest'

  const ready = confirmed && form.idType
    && (!guest || form.full_name.trim().length > 1)
    && (!rules.require_date_of_birth || form.date_of_birth)
    && (!rules.require_address || form.address.trim().length > 4)
    && (!rules.require_contact || form.contact.trim().length > 4)
    && (!rules.require_id_number || form.id_number.trim().length > 3)

  async function submit(event) {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    setProblem('')
    try {
      const details = {
        ...(guest ? { full_name: form.full_name.trim() } : {}),
        ...(form.date_of_birth ? { date_of_birth: form.date_of_birth } : {}),
        ...(rules.require_address ? { address: form.address.trim() } : {}),
        ...(rules.require_contact ? { contact: form.contact.trim() } : {}),
        ...(rules.require_id_number ? { id_number: form.id_number.trim(), jurisdiction: form.jurisdiction.trim() } : {}),
      }
      const id = await recordBuybackIdentification({
        storeId,
        locationId,
        method: guest ? 'guest_manual_id_check' : 'manual_id_check',
        accountId: guest ? null : (customer?.collectorshub_user_id || customer?.profileId),
        idType: form.idType,
        details,
      })
      onDone({ id, method: guest ? 'guest_manual_id_check' : 'manual_id_check', idType: form.idType, fullName: guest ? form.full_name.trim() : '', at: new Date().toISOString() })
    } catch (error) {
      setProblem(error?.message || String(error))
      setBusy(false)
    }
  }

  return (
    <div className="register-modal nid-modal" role="dialog" aria-modal="true" aria-labelledby="manual-id-title">
      <section>
        <button className="modal-close" type="button" onClick={onCancel} aria-label="Cancel"><X size={18} /></button>
        <div className="nid-head">
          <IdCard size={22} />
          <div>
            <h2 id="manual-id-title">{guest ? 'Guest Buyback Information' : 'Manually check ID'}</h2>
            <p>{guest ? 'Record the seller\'s details for this buyback. They don\'t need an account.' : `${customer?.fullName || customer?.name || 'Customer'}${customer?.username ? ` · @${customer.username}` : ''}: for this transaction only. Their account stays unverified.`}</p>
          </div>
        </div>
        {rules.policy_note ? <p className="nid-banner"><AlertTriangle size={15} /> {rules.policy_note}</p> : null}
        {problem ? <p className="nid-error"><AlertTriangle size={15} /> {problem}</p> : null}
        <form className="nid-step nid-details" onSubmit={submit}>
          {guest ? <label className="wide"><span>Full legal name (as on the ID)</span><input autoFocus value={form.full_name} onChange={set('full_name')} autoComplete="off" /></label> : null}
          <label className={rules.require_date_of_birth ? '' : 'wide'}>
            <span>Government ID inspected</span>
            <select value={form.idType} onChange={set('idType')}>{accepted.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}</select>
          </label>
          {rules.require_date_of_birth ? <label><span>Date of birth{rules.minimum_age ? ` (must be ${rules.minimum_age}+)` : ''}</span><input type="date" value={form.date_of_birth} onChange={set('date_of_birth')} /></label> : null}
          {rules.require_address ? <label className="wide"><span>Residential address</span><input value={form.address} onChange={set('address')} autoComplete="off" /></label> : null}
          {rules.require_contact ? <label className="wide"><span>Phone or email</span><input value={form.contact} onChange={set('contact')} autoComplete="off" /></label> : null}
          {rules.require_id_number ? (
            <>
              <label><span>ID number</span><input value={form.id_number} onChange={set('id_number')} autoComplete="off" /></label>
              <label><span>Issued by</span><input value={form.jurisdiction} onChange={set('jurisdiction')} /></label>
            </>
          ) : null}
          <label className="nid-check wide nid-confirm">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>{MANUAL_CONFIRMATION}</span>
          </label>
          <p className="nid-muted nid-small wide">Recorded with your name, the store, location, date and time, and linked to this transaction. It can't be changed afterwards; a manager can add a correction.</p>
          <div className="nid-actions wide">
            <button type="button" onClick={onCancel}>Cancel</button>
            <button type="submit" className="gold-button" disabled={!ready || busy}>{busy ? 'Recording…' : guest ? 'Record guest details' : 'Confirm ID checked'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}
