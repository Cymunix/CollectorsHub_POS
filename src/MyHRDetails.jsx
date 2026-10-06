import React, { useEffect, useState } from 'react'
import { loadMyDetails, saveMyDetails } from './lib/myhrPay'

// Personal Information (Personal Data, Addresses, Emergency Contact) and My Job
// (Display Job Information) for the signed-in employee. Name, email and role
// come from the store's employee record (the owner manages those); phone,
// address and emergency contact are the employee's to keep up to date.

const FIELDS = {
  personal: [['phone', 'Phone']],
  addresses: [['address_line1', 'Street address'], ['address_line2', 'Unit / apartment'], ['city', 'City / town'], ['province', 'Province'], ['postal_code', 'Postal code']],
  emergency: [['emergency_name', 'Contact name'], ['emergency_relationship', 'Relationship'], ['emergency_phone', 'Contact phone']],
}
const TITLES = { personal: 'Personal Data', addresses: 'Addresses', emergency: 'Emergency Contact', job: 'Job Information' }
const roleText = (role) => String(role || '').replace(/_/g, ' ')

export default function MyHRDetails({ storeId, view }) {
  const [details, setDetails] = useState(null)
  const [draft, setDraft] = useState({})
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    loadMyDetails(storeId)
      .then((loaded) => { if (live) { setDetails(loaded || {}); setDraft(loaded || {}) } })
      .catch((error) => { if (live) { setDetails({}); setProblem(error?.message || String(error)) } })
    return () => { live = false }
  }, [storeId])

  if (!details) return <p className="myhr-empty">Loading…</p>
  const fields = FIELDS[view] || []

  async function save(event) {
    event.preventDefault()
    setSaving(true)
    setProblem('')
    setNotice('')
    try {
      const changes = Object.fromEntries(fields.map(([key]) => [key, draft[key] || '']))
      await saveMyDetails(storeId, changes)
      setDetails((current) => ({ ...current, ...changes }))
      setNotice('Saved.')
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setSaving(false)
    }
  }

  const name = [details.first_name, details.last_name].filter(Boolean).join(' ') || details.username || ''

  return (
    <section className="myhr-pay-panel myhr-details">
      <h3>{TITLES[view]}</h3>
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}

      {view === 'personal' || view === 'job' ? (
        <dl className="myhr-facts">
          {view === 'personal' ? (
            <>
              <dt>Name</dt><dd>{name || '—'}</dd>
              <dt>Email</dt><dd>{details.email || '—'}</dd>
              <dt>Username</dt><dd>{details.username || '—'}</dd>
            </>
          ) : (
            <>
              <dt>Store</dt><dd>{details.store_name || '—'}</dd>
              <dt>Role</dt><dd className="capitalize">{roleText(details.role) || '—'}</dd>
              <dt>Status</dt><dd className="capitalize">{details.status || '—'}</dd>
              <dt>Employee since</dt><dd>{details.employee_since ? new Date(details.employee_since).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}</dd>
            </>
          )}
        </dl>
      ) : null}
      {view === 'personal' ? <small className="myhr-muted">Name, email and role are managed by the store owner.</small> : null}

      {fields.length ? (
        <form className="myhr-details-form" onSubmit={save}>
          {fields.map(([key, label]) => (
            <label key={key}>
              {label}
              <input value={draft[key] || ''} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} />
            </label>
          ))}
          <div className="myhr-editor-actions">
            {notice ? <span className="myhr-notice">{notice}</span> : null}
            <button type="submit" className="gold-button" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      ) : null}
    </section>
  )
}
