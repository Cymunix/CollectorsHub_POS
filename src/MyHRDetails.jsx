import React, { useEffect, useState } from 'react'
import { Save, Undo2, X } from 'lucide-react'
import { loadMyDetails, saveMyDetails } from './lib/myhrPay'

// Personal Information (Personal Data, Addresses, Emergency Contact) and My Job
// (Display Job Information) for the signed-in employee. Each screen has
// Save and Back / Save / Cancel; fields marked * are required. The personnel
// number is assigned by the system; username and role are managed by the store
// owner. Phone and email are employee-owned contact details for updates.

const PROVINCES = ['Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland and Labrador', 'Northwest Territories', 'Nova Scotia', 'Nunavut', 'Ontario', 'Prince Edward Island', 'Quebec', 'Saskatchewan', 'Yukon']
const OPTIONS = {
  form_of_address: ['', 'Mr', 'Ms', 'Mrs', 'Mx', 'Dr'],
  marital_status: ['', 'Single', 'Married', 'Common-law', 'Separated', 'Divorced', 'Widowed', 'Prefer not to say'],
  gender: ['', 'Male', 'Female', 'Non-binary', 'Another gender', 'Prefer not to say'],
  language: ['', 'English', 'French', 'Other'],
  country: ['Canada', 'United States', 'Other'],
}

// Screen layouts: sections of [key, label, kind, required].
const SCREENS = {
  personal: {
    title: 'Personal Data',
    columns: [
      [
        ['Name', [['form_of_address', 'Form of Address', 'select'], ['first_name', 'First Name', 'text', true], ['last_name', 'Last Name', 'text', true], ['middle_name', 'Middle Name'], ['initials', 'Initials'], ['known_as', 'Known as']]],
        ['Contact Information', [['phone', 'Telephone Number', 'phone'], ['email', 'Email', 'email']]],
      ],
      [
        ['Birth Data', [['date_of_birth', 'Date of Birth', 'date', true], ['gender', 'Gender', 'select']]],
        ['Other Personal Data', [['language', 'Language', 'select', true], ['nationality', 'Nationality'], ['personnel_number', 'Personnel Number', 'readonly']]],
        ['Marital Status', [['marital_status', 'Marital Status', 'select'], ['marital_since', 'Since', 'date']]],
      ],
    ],
  },
  addresses: {
    title: 'Addresses',
    columns: [[
      ['', [['country', 'Country', 'select', true]]],
      ['Address', [['care_of', 'c/o'], ['address_line1', 'Street and House Number', 'text', true], ['address_line2', 'Address Line 2'], ['city', 'City', 'text', true], ['province', 'Province', 'province', true], ['postal_code', 'Postal code', 'text', true]]],
    ]],
  },
  emergency: {
    title: 'Emergency Contact',
    columns: [[
      ['Name', [['emergency_first_name', 'First name', 'text', true], ['emergency_last_name', 'Last name', 'text', true], ['emergency_phone', 'Telephone Number', 'phone', false, 'emergency_phone_area']]],
    ]],
  },
}

const roleText = (role) => String(role || '').replace(/_/g, ' ')
const screenSections = (screen) => screen.sections || screen.columns.flat()
const editableKeys = (screen) => screenSections(screen).flatMap(([, fields]) => fields)
  .filter(([, , kind]) => kind !== 'readonly')
  .flatMap(([key, , kind, , areaKey]) => (kind === 'phone' ? [areaKey || 'phone_area', key] : [key]))

export default function MyHRDetails({ storeId, view, onBack }) {
  const [details, setDetails] = useState(null)
  const [draft, setDraft] = useState({})
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    loadMyDetails(storeId)
      .then((loaded) => {
        if (!live) return
        const base = { ...(loaded || {}) }
        if (!base.country) base.country = 'Canada'
        // An emergency contact saved before first/last name were separate.
        if (!base.emergency_first_name && !base.emergency_last_name && base.emergency_name) {
          const [first, ...rest] = String(base.emergency_name).trim().split(' ')
          base.emergency_first_name = first
          base.emergency_last_name = rest.join(' ')
        }
        setDetails(base)
        setDraft(base)
      })
      .catch((error) => { if (live) { setDetails({}); setProblem(error?.message || String(error)) } })
    return () => { live = false }
  }, [storeId])

  if (!details) return <p className="myhr-empty">Loading…</p>

  if (view === 'job') {
    return (
      <section className="myhr-pay-panel myhr-details">
        <dl className="myhr-facts">
          <dt>Store</dt><dd>{details.store_name || '—'}</dd>
          <dt>Role</dt><dd className="capitalize">{roleText(details.role) || '—'}</dd>
          <dt>Status</dt><dd className="capitalize">{details.status || '—'}</dd>
          <dt>Employee since</dt><dd>{details.employee_since ? new Date(details.employee_since).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}</dd>
          <dt>Personnel Number</dt><dd>{details.personnel_number || '—'}</dd>
        </dl>
        {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      </section>
    )
  }

  const screen = SCREENS[view]
  if (!screen) return null
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }))

  async function save(andBack) {
    const missing = screenSections(screen).flatMap(([, fields]) => fields)
      .filter(([key, , , required]) => required && !String(draft[key] || '').trim())
      .map(([, label]) => label)
    if (missing.length) { setProblem(`Fill in: ${missing.join(', ')}.`); setNotice(''); return }
    setSaving(true)
    setProblem('')
    setNotice('')
    try {
      const changes = Object.fromEntries(editableKeys(screen).map((key) => [key, draft[key] ?? '']))
      await saveMyDetails(storeId, changes)
      setDetails((current) => ({ ...current, ...changes }))
      if (andBack) onBack?.()
      else setNotice('Saved.')
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    setDraft(details)
    onBack?.()
  }

  const field = ([key, label, kind = 'text', required, areaKey = 'phone_area']) => {
    let input
    if (kind === 'readonly') {
      input = <input value={draft[key] || ''} readOnly className="readonly" tabIndex={-1} />
    } else if (kind === 'select') {
      const options = OPTIONS[key] || ['']
      const value = draft[key] || ''
      input = (
        <select value={value} onChange={(event) => set(key, event.target.value)}>
          {options.map((option) => <option key={option} value={option}>{option}</option>)}
          {value && !options.includes(value) ? <option value={value}>{value}</option> : null}
        </select>
      )
    } else if (kind === 'province') {
      input = (draft.country || 'Canada') === 'Canada' ? (
        <select value={draft[key] || ''} onChange={(event) => set(key, event.target.value)}>
          <option value="" />
          {PROVINCES.map((province) => <option key={province}>{province}</option>)}
          {draft[key] && !PROVINCES.includes(draft[key]) ? <option>{draft[key]}</option> : null}
        </select>
      ) : <input value={draft[key] || ''} onChange={(event) => set(key, event.target.value)} />
    } else if (kind === 'phone') {
      input = (
        <span className="myhr-phone">
          <input value={draft[areaKey] || ''} onChange={(event) => set(areaKey, event.target.value)} placeholder="Area" inputMode="tel" aria-label="Area code" />
          <input value={draft[key] || ''} onChange={(event) => set(key, event.target.value)} placeholder="Number" inputMode="tel" aria-label="Phone number" />
        </span>
      )
    } else {
      input = <input type={kind === 'date' ? 'date' : kind === 'email' ? 'email' : 'text'} value={draft[key] || ''} onChange={(event) => set(key, event.target.value)} />
    }
    return (
      <label key={key} className="myhr-form-row">
        <span>{required ? <b className="myhr-required">*</b> : null}{label}:</span>
        {input}
      </label>
    )
  }

  return (
    <section className="myhr-form">
      <div className="myhr-form-toolbar">
        <button type="button" onClick={() => save(true)} disabled={saving}><Undo2 size={15} /> Save and Back</button>
        <button type="button" onClick={() => save(false)} disabled={saving}><Save size={15} /> {saving ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={cancel} disabled={saving}><X size={15} /> Cancel</button>
        {notice ? <span className="myhr-notice">{notice}</span> : null}
      </div>
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      {screen.sections ? (
        <div className={`myhr-form-sections layout-${screen.layout || 'grid'}`}>
          {screen.sections.map(([heading, fields, area]) => (
            <fieldset key={heading || fields[0][0]} className={`myhr-form-section ${area ? `area-${area}` : ''}`}>
              {heading ? <legend>{heading}</legend> : null}
              {fields.map(field)}
            </fieldset>
          ))}
        </div>
      ) : (
        <div className={`myhr-form-columns cols-${screen.columns.length}`}>
          {screen.columns.map((column, index) => (
            <div key={index} className="myhr-form-column">
              {column.map(([heading, fields]) => (
              <fieldset key={heading || fields[0][0]} className="myhr-form-section">
                {heading ? <legend>{heading}</legend> : null}
                {fields.map(field)}
              </fieldset>
              ))}
            </div>
          ))}
        </div>
      )}
      {view === 'personal' ? <small className="myhr-muted">Phone and email are used for schedule updates and store contact. Username and role are managed by the store owner.</small> : null}
    </section>
  )
}
