import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { supabase } from './lib/supabaseClient'
import { createCustomer } from './lib/customers'

// The register's "Create Customer": makes a CollectorsHub (NORDVIK) account
// for the customer at the counter and attaches it to the sale. The account is
// created by the create-customer-account Edge Function, which emails the
// customer a link to set their own password.
export const CREATE_CUSTOMER_FUNCTION = 'hyper-worker' // create-customer-account, deployed as hyper-worker
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/

// "Jordan Sample" -> "JordanSample" (a starting suggestion the customer can change).
const suggestUsername = (name) => String(name || '').normalize('NFKD').replace(/[^A-Za-z0-9_ ]/g, '').trim().split(/\s+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('').slice(0, 20)

// Store customer only: a record for this store, no CollectorsHub account.
function StoreCustomerForm({ storeId, onCancel, onCreated, tabs }) {
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '' })
  const [duplicates, setDuplicates] = useState(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))
  async function save(force = false) {
    setSaving(true)
    setNotice('')
    try {
      const result = await createCustomer(storeId, form, force)
      if (result?.duplicates) { setDuplicates(result.duplicates); setSaving(false); return }
      const name = [form.first_name, form.last_name].map((part) => part.trim()).filter(Boolean).join(' ')
      onCreated({ id: result.id, name, email: form.email.trim(), phone: form.phone.trim(), storeCredit: 0, kind: 'customer', customerNumber: result.customer_number }, false, false)
    } catch (error) {
      setNotice(error?.message || String(error))
      setSaving(false)
    }
  }
  return (
    <div className="register-modal" role="dialog" aria-modal="true" aria-labelledby="create-customer-title">
      <section>
        <button className="modal-close" type="button" onClick={onCancel}><X size={18} /></button>
        <h2 id="create-customer-title">Create customer</h2>
        {tabs}
        <p>A customer record for this store only. No CollectorsHub account, so no XP or store credit until they link one.</p>
        <form className="modal-form-grid create-customer-form" onSubmit={(event) => { event.preventDefault(); save(false) }}>
          <label><span>First name</span><input autoFocus value={form.first_name} onChange={set('first_name')} autoComplete="off" /></label>
          <label><span>Last name</span><input value={form.last_name} onChange={set('last_name')} autoComplete="off" /></label>
          <label><span>Email (optional)</span><input type="email" value={form.email} onChange={set('email')} autoComplete="off" /></label>
          <label><span>Phone (optional)</span><input type="tel" value={form.phone} onChange={set('phone')} autoComplete="off" /></label>
          {duplicates ? (
            <div className="new-store-item-error wide">
              This might already be a customer: {duplicates.map((dupe) => `${dupe.name || 'Customer'} (${dupe.customer_number})`).join(', ')}.
              {' '}<button type="button" onClick={() => onCreated({ id: duplicates[0].id, name: duplicates[0].name, email: duplicates[0].email || '', phone: duplicates[0].phone || '', storeCredit: 0, kind: 'customer' }, false, false)}>Use the existing customer</button>
              {' '}<button type="button" onClick={() => save(true)}>Create anyway</button>
            </div>
          ) : null}
          {notice ? <p className="new-store-item-error wide">{notice}</p> : null}
          <div className="modal-actions wide">
            <button type="button" onClick={onCancel}>Cancel</button>
            <button className="gold-button" type="submit" disabled={saving || !(form.first_name.trim() || form.last_name.trim())}>{saving ? 'Creating…' : 'Create customer'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

export default function CreateCustomerModal({ storeId, onCancel, onCreated }) {
  const [mode, setMode] = useState('member')
  const tabs = (
    <div className="cs-tabs small create-customer-mode">
      <button type="button" className={mode === 'member' ? 'active' : ''} onClick={() => setMode('member')}>CollectorsHub account</button>
      <button type="button" className={mode === 'store' ? 'active' : ''} onClick={() => setMode('store')}>Store customer only</button>
    </div>
  )
  if (mode === 'store') return <StoreCustomerForm storeId={storeId} onCancel={onCancel} onCreated={onCreated} tabs={tabs} />
  return <MemberCustomerForm storeId={storeId} onCancel={onCancel} onCreated={onCreated} tabs={tabs} />
}

function MemberCustomerForm({ storeId, onCancel, onCreated, tabs }) {
  const [draft, setDraft] = useState({ name: '', username: '', email: '', phone: '', verifyNow: false })
  const [usernameTouched, setUsernameTouched] = useState(false)
  const [available, setAvailable] = useState(null) // null = not checked yet
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  const set = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value
    setDraft((current) => ({ ...current, [key]: value, ...(key === 'name' && !usernameTouched ? { username: suggestUsername(value) } : {}) }))
    if (key === 'username') setUsernameTouched(true)
    setNotice('')
  }

  // Username availability, checked as it's typed (the same check as website sign-up).
  useEffect(() => {
    const username = draft.username.trim()
    setAvailable(null)
    if (!USERNAME_RE.test(username)) return undefined
    let cancelled = false
    const timer = window.setTimeout(async () => {
      const { data, error } = await supabase.rpc('is_username_available', { p_username: username })
      if (!cancelled && !error) setAvailable(data !== false)
    }, 300)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [draft.username])

  const username = draft.username.trim()
  const usernameProblem = !username ? '' : !USERNAME_RE.test(username) ? '3–20 letters, numbers or underscores.' : available === false ? `@${username} is taken.` : ''
  const ready = !saving && draft.name.trim().length > 1 && USERNAME_RE.test(username) && available !== false && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(draft.email.trim())

  async function submit(event) {
    event.preventDefault()
    if (!ready) return
    setSaving(true)
    setNotice('')
    try {
      const { data, error } = await supabase.functions.invoke(CREATE_CUSTOMER_FUNCTION, {
        body: { storeId, name: draft.name.trim().replace(/\s+/g, ' '), username, email: draft.email.trim(), phone: draft.phone.trim() },
      })
      if (error || data?.error) {
        let message = data?.error || error?.message || 'The customer could not be created.'
        try { const details = await error?.context?.json?.(); if (details?.error) message = details.error } catch {}
        if (error?.context?.status === 404 || /failed to send a request/i.test(message)) message = "Creating customers needs the create-customer-account Edge Function (hyper-worker), which isn't reachable right now."
        throw new Error(message)
      }
      onCreated(data.customer, data.emailed !== false, draft.verifyNow)
    } catch (createError) {
      setNotice(createError?.message || String(createError))
      setSaving(false)
    }
  }

  return (
    <div className="register-modal" role="dialog" aria-modal="true" aria-labelledby="create-customer-title">
      <section>
        <button className="modal-close" type="button" onClick={onCancel}><X size={18} /></button>
        <h2 id="create-customer-title">Create customer</h2>
        {tabs}
        <p>Creates a free CollectorsHub account and adds them to this sale. They'll get an email to set their password.</p>
        <form className="modal-form-grid create-customer-form" onSubmit={submit}>
          <label className="wide">
            <span>Full name (as shown on government-issued ID)</span>
            <input autoFocus value={draft.name} onChange={set('name')} placeholder="Jordan Alex Sample" autoComplete="off" />
          </label>
          <label>
            <span>Username</span>
            <input value={draft.username} onChange={set('username')} placeholder="JordanSample" autoComplete="off" maxLength={20} />
            {usernameProblem ? <small className="create-customer-bad">{usernameProblem}</small> : available ? <small className="create-customer-ok">@{username} is available</small> : <small>They give this at the counter. It can't be changed later.</small>}
          </label>
          <label>
            <span>Email</span>
            <input type="email" value={draft.email} onChange={set('email')} placeholder="jordan@example.com" autoComplete="off" />
          </label>
          <label className="wide">
            <span>Phone (optional)</span>
            <input type="tel" value={draft.phone} onChange={set('phone')} placeholder="902-555-0142" autoComplete="off" />
          </label>
          <label className="wide create-customer-id">
            <input type="checkbox" checked={draft.verifyNow} onChange={set('verifyNow')} />
            <span>Verify this account now</span>
            <small>Identity verification is required before a customer can sell items to the store. You can verify them now or later during a buyback transaction.</small>
          </label>
          {notice ? <p className="new-store-item-error wide">{notice}</p> : null}
          <div className="modal-actions wide">
            <button type="button" onClick={onCancel}>Cancel</button>
            <button className="gold-button" type="submit" disabled={!ready}>{saving ? 'Creating…' : 'Create customer'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}
