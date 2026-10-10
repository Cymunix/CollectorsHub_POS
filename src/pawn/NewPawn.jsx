import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, Camera, Check, FileSignature, ImagePlus, PackageSearch, Plus, Printer, Search, Trash2, UserRound, X } from 'lucide-react'
import { ensureStoreCustomer, searchDesktopTradeCatalogue } from '../lib/registerBackend'
import { CameraCapture } from '../identity/IdentityWizard'
import { CollectorPicker } from '../scan/collectorParts'
import { createCustomer, listCustomers } from '../lib/customers'
import {
  ID_FIELDS, STORAGE_FIELDS, agreementPreview, approveLoan, collateralPhotoUrls, issueLoan, newRequestId, pawnDetail, quote, saveDraft, signAgreement, soldPriceEstimate, uploadCollateralPhoto,
} from '../lib/pawnLoans'
import { money, printAgreement, printCollateralLabels, printPawnReceipt } from './pawnPrint'

// New Pawn: customer → collateral → valuation → terms → agreement → issue.
// The draft is saved in Supabase as you go, so it survives a restart (reopen it from Drafts).

const STEPS = ['Customer', 'Collateral', 'Valuation', 'Terms', 'Agreement', 'Issue']
const today = () => new Date().toISOString().slice(0, 10)
const blankItem = () => ({ key: Math.random().toString(36).slice(2), name: '', category: '', brand: '', model: '', serial_number: '', condition: '', description: '', quantity: 1, photos: [], estimated_value: '', valuation_source: '', valuation_date: today(), allocated_loan_value: '', storage: {}, notes: '', catalog_item_id: null })

export default function NewPawn({ session, summary, loanId: initialLoanId = '', onClose, onOpenLoan }) {
  const storeId = session?.storeId
  const perms = summary?.perms || {}
  const readiness = summary?.readiness || {}
  const rules = readiness.config?.rules || {}
  const [step, setStep] = useState(0)
  const [loanId, setLoanId] = useState(initialLoanId)
  const [version, setVersion] = useState(null)
  const [loanNumber, setLoanNumber] = useState('')
  const [status, setStatus] = useState('draft')
  const [customer, setCustomer] = useState(null)
  const [borrower, setBorrower] = useState({ method: 'photo_id_checked', verified: false })
  const [items, setItems] = useState([blankItem()])
  const [termDays, setTermDays] = useState(rules.term_days_default || '')
  const [notes, setNotes] = useState('')
  const [terms, setTerms] = useState(null)
  const [agreementHtml, setAgreementHtml] = useState('')
  const [signed, setSigned] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [loading, setLoading] = useState(Boolean(initialLoanId))
  const principal = useMemo(() => Math.round(items.reduce((sum, item) => sum + Number(item.allocated_loan_value || 0), 0) * 100) / 100, [items])

  // Resume a saved draft.
  useEffect(() => {
    if (!initialLoanId) return
    pawnDetail(storeId, initialLoanId).then((detail) => {
      const l = detail.loan
      setLoanNumber(l.loan_number); setVersion(l.version); setStatus(l.status); setNotes(l.notes || ''); setTermDays(l.term_days || rules.term_days_default || '')
      setCustomer(detail.customer ? { id: detail.customer.id, name: detail.customer.name, username: detail.customer.username, customer_number: detail.customer.customer_number } : null)
      setBorrower({ method: 'photo_id_checked', verified: false, ...(detail.borrower || {}) })
      setItems(detail.collateral.length ? detail.collateral.map((item) => ({ ...blankItem(), ...item, key: item.id, estimated_value: item.estimated_value ?? '', allocated_loan_value: item.allocated_loan_value ?? '', valuation_date: item.valuation_date || today() })) : [blankItem()])
      setSigned(detail.agreements.some((a) => a.kind === 'original' && a.loan_version === l.version))
      if (l.status === 'approved') { setTerms(l.terms); setStep(4) }
    }).catch((error) => setProblem(error.message)).finally(() => setLoading(false))
  }, [initialLoanId])

  const idFields = Array.isArray(rules.id_fields) ? rules.id_fields : ['name', 'id_type']
  const draftPayload = () => ({
    id: loanId || null, version, customer_id: customer?.id, borrower: { ...borrower, checked_at: borrower.verified ? (borrower.checked_at || new Date().toISOString()) : null }, principal, term_days: termDays ? Number(termDays) : null, notes,
    items: items.filter((item) => item.name.trim()).map(({ key, ...item }) => ({ ...item, id: item.id || null, quantity: Number(item.quantity || 1) })),
  })
  async function persist() {
    const saved = await saveDraft(storeId, session.locationId, draftPayload())
    setLoanId(saved.id); setLoanNumber(saved.loan_number); setVersion(saved.version); setStatus('draft'); setTerms(null); setSigned(false)
    // Collateral ids come back from the server so later saves update the same records.
    const detail = await pawnDetail(storeId, saved.id)
    setItems((current) => {
      const named = current.filter((item) => item.name.trim()).map((item, index) => ({ ...item, id: detail.collateral[index]?.id, collateral_code: detail.collateral[index]?.collateral_code }))
      return named.length ? named : [blankItem()]
    })
    return saved
  }
  async function run(task) { setBusy(true); setProblem(''); try { await task() } catch (error) { setProblem(error?.message || String(error)) } finally { setBusy(false) } }

  const stepReady = [
    Boolean(customer?.id) && borrower.verified && idFields.every((field) => String(borrower[field] || '').trim()),
    items.some((item) => item.name.trim()) && items.filter((item) => item.name.trim()).every((item) => Number(item.quantity) > 0),
    principal > 0 && items.filter((item) => item.name.trim()).every((item) => item.estimated_value !== '' && item.valuation_source && Number(item.allocated_loan_value) > 0),
    Boolean(terms),
  ]

  async function next() {
    if (step === 0 || step === 1 || step === 2) {
      await run(async () => { await persist(); if (step === 2) setTerms(await quote(storeId, principal, termDays ? Number(termDays) : null)); setStep(step + 1) })
    } else if (step === 3) {
      await run(async () => {
        if (!perms.pawn_approve) { setStep(4); return }
        const approved = await approveLoan(storeId, loanId, version)
        setTerms(approved.terms); setAgreementHtml(approved.agreement_html); setStatus('approved'); setStep(4)
      })
    }
  }
  useEffect(() => { if (step === 3 && loanId) run(async () => setTerms(await quote(storeId, principal, termDays ? Number(termDays) : null))) }, [termDays])

  if (loading) return <section className="cu-page pw-page"><p className="cs-muted">Loading draft…</p></section>
  return (
    <section className="cu-page pw-page">
      <button type="button" className="cs-back" onClick={onClose}><ArrowLeft size={15} /> Pawn &amp; Loans</button>
      <div className="pw-wizard-head">
        <div><h1>New Pawn{loanNumber ? ` · ${loanNumber}` : ''}</h1>{readiness.test_mode ? <span className="pw-test">Test store: test loan, not a legal agreement</span> : null}</div>
        <ol className="pw-steps">{STEPS.map((label, index) => <li key={label} className={index === step ? 'current' : index < step ? 'done' : ''}><span>{index < step ? <Check size={12} /> : index + 1}</span>{label}</li>)}</ol>
      </div>
      {!readiness.ready ? <p className="cu-notice"><AlertTriangle size={15} /> Loans can be drafted, but not approved or issued yet: {(readiness.reasons || []).join(' ')}</p> : null}
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}

      <div className="pw-card">
        {step === 0 ? <CustomerStep storeId={storeId} session={session} customer={customer} setCustomer={setCustomer} borrower={borrower} setBorrower={setBorrower} idFields={idFields} minAge={rules.borrower_min_age} /> : null}
        {step === 1 ? <CollateralStep storeId={storeId} loanKey={loanId || 'draft'} items={items} setItems={setItems} /> : null}
        {step === 2 ? <ValuationStep items={items} setItems={setItems} principal={principal} /> : null}
        {step === 3 ? <TermsStep terms={terms} termDays={termDays} setTermDays={setTermDays} rules={rules} notes={notes} setNotes={setNotes} /> : null}
        {step === 4 ? <AgreementStep storeId={storeId} loanId={loanId} status={status} terms={terms} perms={perms} rules={rules} html={agreementHtml} setHtml={setAgreementHtml} signed={signed} onSigned={() => setSigned(true)} run={run} busy={busy} /> : null}
        {step === 5 ? <IssueStep storeId={storeId} loanId={loanId} loanNumber={loanNumber} customer={customer} items={items} terms={terms} perms={perms} store={session?.storeName} onIssued={() => onOpenLoan(loanId)} /> : null}
      </div>

      <div className="cs-actions">
        {step > 0 && step < 4 ? <button type="button" onClick={() => setStep(step - 1)}>Back</button> : null}
        {step < 3 ? <button type="button" disabled={busy || !stepReady[step]} onClick={() => run(async () => { await persist(); onClose() })}>Save draft and close</button> : null}
        {step < 4 ? <button type="button" className="gold-button" disabled={busy || !stepReady[step]} onClick={next}>{busy ? 'Saving…' : step === 3 ? (perms.pawn_approve ? 'Approve terms' : 'Continue') : 'Continue'}</button> : null}
        {step === 4 ? <button type="button" className="gold-button" disabled={!signed} onClick={() => setStep(5)}>Continue to issue</button> : null}
      </div>
    </section>
  )
}

function CustomerStep({ storeId, session, customer, setCustomer, borrower, setBorrower, idFields, minAge }) {
  const [mode, setMode] = useState('store')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState([])
  const [creating, setCreating] = useState(null)
  const [problem, setProblem] = useState('')
  useEffect(() => {
    if (mode !== 'store' || search.trim().length < 2) { setRows([]); return undefined }
    const timer = setTimeout(() => listCustomers(storeId, { search: search.trim(), limit: 8 }).then(setRows).catch((error) => setProblem(error.message)), 250)
    return () => clearTimeout(timer)
  }, [search, mode])
  const set = (key) => (event) => setBorrower((current) => ({ ...current, [key]: event.target.value }))
  if (!customer) {
    return (
      <div className="pw-step">
        <h2>Who is borrowing?</h2>
        <p className="cs-muted">A pawn loan needs an identified customer.</p>
        <div className="cs-tabs small"><button type="button" className={mode === 'store' ? 'active' : ''} onClick={() => setMode('store')}>Store customers</button><button type="button" className={mode === 'member' ? 'active' : ''} onClick={() => setMode('member')}>CollectorsHub member</button><button type="button" className={mode === 'new' ? 'active' : ''} onClick={() => { setMode('new'); setCreating({ first_name: '', last_name: '', phone: '', email: '', address: '' }) }}>New customer</button></div>
        {problem ? <p className="cs-error">{problem}</p> : null}
        {mode === 'store' ? (
          <>
            <label className="cu-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, customer ID, email or phone" autoFocus /></label>
            <div className="pw-pick-list">{rows.map((row) => <button type="button" key={row.id} onClick={() => setCustomer({ id: row.id, name: row.name, username: row.username, customer_number: row.customer_number })}><UserRound size={16} /> <strong>{row.name}</strong> <small>{row.username ? `@${row.username} · ` : ''}{row.customer_number}</small></button>)}</div>
          </>
        ) : null}
        {mode === 'member' ? <CollectorPicker storeId={storeId} onPick={async (member) => { try { const id = await ensureStoreCustomer(session, { profileId: member.id, name: member.name }); setCustomer({ id, name: member.name, username: member.username }) } catch (error) { setProblem(error.message) } }} /> : null}
        {mode === 'new' && creating ? (
          <div className="cs-form-grid">
            {[['first_name', 'First name'], ['last_name', 'Last name'], ['phone', 'Phone'], ['email', 'Email']].map(([key, label]) => <label key={key}><span>{label}</span><input value={creating[key]} onChange={(event) => setCreating({ ...creating, [key]: event.target.value })} /></label>)}
            <label className="wide"><span>Address</span><input value={creating.address} onChange={(event) => setCreating({ ...creating, address: event.target.value })} /></label>
            <div className="cs-actions wide"><button type="button" className="gold-button" disabled={!creating.first_name.trim() || !creating.last_name.trim()} onClick={async () => { try { const result = await createCustomer(storeId, creating, true); setCustomer({ id: result.id, name: `${creating.first_name} ${creating.last_name}`, customer_number: result.customer_number }) } catch (error) { setProblem(error.message) } }}>Create customer</button></div>
          </div>
        ) : null}
      </div>
    )
  }
  return (
    <div className="pw-step">
      <h2>Borrower identification</h2>
      <p className="cu-picked"><strong>{customer.name}</strong> {customer.username ? `@${customer.username}` : ''} {customer.customer_number || ''} <button type="button" onClick={() => setCustomer(null)}>Change</button></p>
      <p className="cs-muted">Record what the store's configuration requires. Only these fields are kept; ID photos and numbers aren't stored unless the configuration requires them.{minAge ? ` Borrowers must be at least ${minAge}.` : ''}</p>
      <div className="cs-form-grid">
        {ID_FIELDS.filter(([key]) => idFields.includes(key)).map(([key, label]) => (
          <label key={key} className={key === 'address' ? 'wide' : ''}><span>{label}</span>
            {key === 'id_type' ? <select value={borrower.id_type || ''} onChange={set('id_type')}><option value="">Choose…</option><option value="drivers_licence">Driver's licence</option><option value="passport">Passport</option><option value="provincial_id">Provincial photo ID</option><option value="other_government">Other government photo ID</option></select>
              : <input type={key.includes('date') || key === 'id_expiry' ? 'date' : 'text'} value={borrower[key] || ''} onChange={set(key)} />}
          </label>
        ))}
        <label><span>How it was checked</span><select value={borrower.method} onChange={set('method')}><option value="photo_id_checked">Government photo ID checked in person</option><option value="nordvik_identity">NORDVIK Identity verified account</option></select></label>
      </div>
      <label className="tx-check"><input type="checkbox" checked={Boolean(borrower.verified)} onChange={(event) => setBorrower((current) => ({ ...current, verified: event.target.checked }))} /> I checked this customer's identification as the store's rules require.</label>
    </div>
  )
}

const OTHER_CATEGORIES = ['Jewellery & watches', 'Electronics', 'Tools', 'Musical instruments', 'Sporting goods', 'Video games & consoles', 'Cameras', 'Other']

function CollateralStep({ storeId, loanKey, items, setItems }) {
  const [cameraFor, setCameraFor] = useState('')
  const [urls, setUrls] = useState({})
  const [problem, setProblem] = useState('')
  const paths = items.flatMap((item) => item.photos || [])
  useEffect(() => { collateralPhotoUrls(paths.filter((path) => !urls[path])).then((found) => setUrls((current) => ({ ...current, ...found }))).catch(() => {}) }, [paths.join('|')])
  const update = (key, patch) => setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  async function addPhoto(key, shot) { try { const blob = typeof shot === 'string' ? await (await fetch(shot)).blob() : shot; const path = await uploadCollateralPhoto(storeId, loanKey, blob); update(key, { photos: [...(items.find((item) => item.key === key)?.photos || []), path] }) } catch (error) { setProblem(error.message) } }
  return (
    <div className="pw-step">
      <h2>Collateral</h2>
      <p className="cs-muted">Search CollectorsHub for collectables, or record any other item (jewellery, electronics, tools…). Each item is its own collateral record and never goes into the store's inventory while it's pledged.</p>
      {problem ? <p className="cs-error">{problem}</p> : null}
      {items.map((item, index) => {
        const mode = item.mode || (item.catalog_item_id ? 'catalogue' : item.name ? 'other' : 'catalogue')
        return (
          <div className="pw-item" key={item.key}>
            <div className="pw-item-head">
              <strong>Item {index + 1}{item.collateral_code ? ` · ${item.collateral_code}` : ''}</strong>
              <span>
                <span className="cs-tabs small">
                  <button type="button" className={mode === 'catalogue' ? 'active' : ''} onClick={() => update(item.key, { mode: 'catalogue' })}>CollectorsHub item</button>
                  <button type="button" className={mode === 'other' ? 'active' : ''} onClick={() => update(item.key, { mode: 'other', catalog_item_id: null, image_url: '' })}>Not a collectable</button>
                </span>
                {items.length > 1 ? <button type="button" onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))} aria-label="Remove item"><Trash2 size={14} /></button> : null}
              </span>
            </div>

            {mode === 'catalogue' && !item.catalog_item_id ? (
              <CatalogueSearch onPick={(found) => update(item.key, {
                catalog_item_id: found.catalogItemId, name: [found.name, found.number ? `#${found.number}` : '', found.releaseYear].filter(Boolean).join(' '), category: found.category || item.category,
                image_url: found.imageUrl || '', mode: 'catalogue',
                ...(Number(found.marketValue) > 0 ? { estimated_value: Number(found.marketValue).toFixed(2), valuation_source: `CollectorsHub: ${found.marketValueSource}`, valuation_date: today() } : {}),
              })} />
            ) : null}
            {mode === 'catalogue' && item.catalog_item_id ? (
              <div className="pw-picked">
                {item.image_url ? <img src={item.image_url} alt="" /> : <span className="pw-picked-noimg"><PackageSearch size={20} /></span>}
                <div><strong>{item.name}</strong><small>{[item.category, `Catalogue ${String(item.catalog_item_id).slice(0, 8)}`, item.estimated_value ? `Sold-price estimate ${money(item.estimated_value)}` : ''].filter(Boolean).join(' · ')}</small></div>
                <button type="button" onClick={() => update(item.key, { catalog_item_id: null, name: '', image_url: '' })}>Change</button>
              </div>
            ) : null}

            {mode === 'other' || item.catalog_item_id ? (
              <div className="cs-form-grid pw-grid">
                {mode === 'other' ? <label className="wide"><span>Item</span><input value={item.name} onChange={(event) => update(item.key, { name: event.target.value })} placeholder="e.g. 14k gold chain, 20 inch / DeWalt 20V drill kit" /></label> : null}
                {mode === 'other' ? <label><span>Category</span><select value={item.category || ''} onChange={(event) => update(item.key, { category: event.target.value })}><option value="">Choose…</option>{OTHER_CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label> : null}
                {mode === 'other' ? <label><span>Brand / manufacturer</span><input value={item.brand || ''} onChange={(event) => update(item.key, { brand: event.target.value })} /></label> : null}
                {mode === 'other' ? <label><span>Model</span><input value={item.model || ''} onChange={(event) => update(item.key, { model: event.target.value })} /></label> : null}
                <label><span>Serial number{mode === 'catalogue' ? ' (if any)' : ''}</span><input value={item.serial_number || ''} onChange={(event) => update(item.key, { serial_number: event.target.value })} /></label>
                <label><span>Condition</span><input value={item.condition || ''} onChange={(event) => update(item.key, { condition: event.target.value })} placeholder={mode === 'catalogue' ? 'e.g. Near Mint, PSA 9, Sealed' : 'e.g. Good, light scratches'} /></label>
                <label><span>Quantity</span><input type="number" min="1" value={item.quantity} onChange={(event) => update(item.key, { quantity: event.target.value })} /></label>
                <label className="wide"><span>Description</span><textarea rows={2} value={item.description || ''} onChange={(event) => update(item.key, { description: event.target.value })} placeholder="Marks, flaws, engravings, accessories, anything that identifies it" /></label>
              </div>
            ) : null}

            {mode === 'other' || item.catalog_item_id ? (
              <>
                <div className="pw-storage">{STORAGE_FIELDS.map(([key, label]) => <label key={key}><span>{label}</span><input value={item.storage?.[key] || ''} onChange={(event) => update(item.key, { storage: { ...item.storage, [key]: event.target.value } })} /></label>)}</div>
                <div className="cs-photos">
                  {(item.photos || []).map((path) => <figure key={path}>{urls[path] ? <img src={urls[path]} alt="" /> : null}<button type="button" onClick={() => update(item.key, { photos: item.photos.filter((p) => p !== path) })} aria-label="Remove photo"><X size={13} /></button></figure>)}
                  <button type="button" className="cs-photo-add" onClick={() => setCameraFor(item.key)}><Camera size={18} /> Take photo</button>
                  <label className="cs-photo-add"><ImagePlus size={18} /> Add photos<input type="file" accept="image/*" multiple hidden onChange={(event) => { [...event.target.files].forEach((file) => addPhoto(item.key, file)); event.target.value = '' }} /></label>
                </div>
              </>
            ) : null}
          </div>
        )
      })}
      <button type="button" onClick={() => setItems((current) => [...current, blankItem()])}><Plus size={15} /> Add another item</button>
      {cameraFor ? (
        <div className="register-modal cu-modal" role="dialog" aria-modal="true"><section>
          <button className="modal-close" type="button" onClick={() => setCameraFor('')} aria-label="Close"><X size={18} /></button>
          <CameraCapture purpose="document" title="Photograph the item" hint="Show any serial number or identifying marks." onConfirm={async (shot) => { await addPhoto(cameraFor, shot); setCameraFor('') }} />
        </section></div>
      ) : null}
    </div>
  )
}

// Search the CollectorsHub catalogue (same search as the Register's Buy / Trade-In).
function CatalogueSearch({ onPick }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const term = query.trim()
    if (term.length < 2) { setResults(null); return undefined }
    let cancelled = false
    const timer = setTimeout(async () => {
      setBusy(true)
      try { const found = await searchDesktopTradeCatalogue(term); if (!cancelled) setResults(found) } catch { if (!cancelled) setResults([]) } finally { if (!cancelled) setBusy(false) }
    }, 350)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query])
  return (
    <div className="pw-catalogue">
      <label className="cu-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search CollectorsHub: name, card number, set number, UPC…" autoFocus /></label>
      {busy ? <p className="cs-muted">Searching…</p> : null}
      {results && !results.length && !busy ? <p className="cs-muted">Nothing found in CollectorsHub. If it isn't a collectable, choose "Not a collectable".</p> : null}
      {results?.length ? (
        <div className="pw-results">
          {results.map((found) => (
            <button type="button" key={found.catalogItemId} onClick={() => onPick(found)}>
              {found.imageUrl ? <img src={found.imageUrl} alt="" loading="lazy" /> : <span className="pw-picked-noimg"><PackageSearch size={18} /></span>}
              <span><strong>{found.name}</strong><small>{[found.number ? `#${found.number}` : '', found.releaseYear, found.category].filter(Boolean).join(' · ')}</small>{Number(found.marketValue) > 0 ? <small className="pw-value">{money(found.marketValue)} · {found.marketValueSource}</small> : null}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ValuationStep({ items, setItems, principal }) {
  const [busy, setBusy] = useState('')
  const update = (key, patch) => setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  async function estimate(item) {
    setBusy(item.key)
    try {
      const found = await soldPriceEstimate(item.catalog_item_id)
      if (found?.value) update(item.key, { estimated_value: found.value.toFixed(2), valuation_source: `CollectorsHub sold prices (${found.sales} sales, ${found.condition})`, valuation_date: today() })
      else update(item.key, { valuation_source: item.valuation_source || 'No sold-price data; staff appraisal' })
    } finally { setBusy('') }
  }
  const named = items.filter((item) => item.name.trim())
  const totalValue = named.reduce((sum, item) => sum + Number(item.estimated_value || 0) * Number(item.quantity || 1), 0)
  return (
    <div className="pw-step">
      <h2>Valuation</h2>
      <p className="cs-muted">Estimated values come from sold prices where available; they aren't a guaranteed resale value. Record where each value came from. The loan amount is the total of the loan values.</p>
      <table className="cs-table pw-val">
        <thead><tr><th>Collateral</th><th>Estimated value (each)</th><th>Source</th><th>Date</th><th className="num">Loan value</th></tr></thead>
        <tbody>
          {named.map((item) => (
            <tr key={item.key}>
              <td><strong>{item.name}</strong>{Number(item.quantity) > 1 ? <small> × {item.quantity}</small> : null}</td>
              <td><input inputMode="decimal" value={item.estimated_value} onChange={(event) => update(item.key, { estimated_value: event.target.value })} placeholder="0.00" />{item.catalog_item_id ? <button type="button" className="tx-link" disabled={busy === item.key} onClick={() => estimate(item)}>{busy === item.key ? 'Looking…' : 'Sold-price estimate'}</button> : null}</td>
              <td><input value={item.valuation_source} onChange={(event) => update(item.key, { valuation_source: event.target.value })} placeholder="e.g. staff appraisal, recent sold listings" /></td>
              <td><input type="date" value={item.valuation_date || ''} onChange={(event) => update(item.key, { valuation_date: event.target.value })} /></td>
              <td className="num"><input inputMode="decimal" value={item.allocated_loan_value} onChange={(event) => update(item.key, { allocated_loan_value: event.target.value })} placeholder="0.00" /></td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><th>Total</th><th>{money(totalValue)}</th><th /><th /><th className="num">{money(principal)}</th></tr></tfoot>
      </table>
    </div>
  )
}

function TermsStep({ terms, termDays, setTermDays, rules, notes, setNotes }) {
  return (
    <div className="pw-step">
      <h2>Loan terms</h2>
      <p className="cs-muted">Worked out from the store's {rules ? 'jurisdiction configuration' : 'configuration'}; rates, charges and limits can't be changed here.</p>
      <div className="cs-form-grid">
        <label><span>Term (days{rules.term_days_max ? `, up to ${rules.term_days_max}` : ''})</span><input type="number" min="1" max={rules.term_days_max || undefined} value={termDays} onChange={(event) => setTermDays(event.target.value)} /></label>
        <label className="wide"><span>Notes (internal)</span><input value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      </div>
      {terms ? <TermsTable terms={terms} /> : <p className="cs-muted">Working out the terms…</p>}
    </div>
  )
}

export function TermsTable({ terms }) {
  return (
    <ul className="tx-mini-list pw-terms">
      <li><span>Principal</span><strong>{money(terms.principal)}</strong></li>
      <li><span>Issue date</span><strong>{terms.issue_date}</strong></li>
      <li><span>Due date ({terms.term_days} days)</span><strong>{terms.due_date}</strong></li>
      <li><span>Interest</span><strong>{terms.interest_monthly_pct}% a month · {money(terms.interest_for_term)} for the term</strong></li>
      {(terms.fees || []).map((fee) => <li key={fee.code || fee.label}><span>{fee.label}</span><strong>{money(fee.amount)}</strong></li>)}
      <li><span>Total cost of borrowing</span><strong>{money(terms.cost_of_borrowing)}</strong></li>
      <li className="tx-total"><span>To redeem on the due date</span><strong>{money(terms.redemption_at_due)}</strong></li>
      <li><span>Grace period · forfeiture wait</span><strong>{terms.grace_days ?? '—'} days · {terms.forfeiture_wait_days ?? '—'} days</strong></li>
      <li><span>Partial payments · renewals</span><strong>{terms.partial_payments_allowed ? 'Allowed' : 'Not allowed'} · {terms.renewals_allowed ? `Allowed${terms.max_renewals ? ` (up to ${terms.max_renewals})` : ''}` : 'Not allowed'}</strong></li>
      <li><span>Configuration</span><strong>{terms.config_name} ({terms.jurisdiction}, {terms.config_status})</strong></li>
    </ul>
  )
}

function AgreementStep({ storeId, loanId, status, terms, perms, rules, html, setHtml, signed, onSigned, run, busy }) {
  const [method, setMethod] = useState(rules.electronic_signature_allowed ? 'electronic' : 'paper')
  const [signature, setSignature] = useState('')
  const [reviewed, setReviewed] = useState(false)
  useEffect(() => { if (status === 'approved' && !html) run(async () => setHtml(await agreementPreview(storeId, loanId))) }, [status])
  if (status !== 'approved') return <div className="pw-step"><h2>Agreement</h2><p className="cu-notice"><AlertTriangle size={15} /> The draft is saved. Someone with the <strong>Approve loans</strong> permission needs to approve the terms before the agreement can be signed. Open it from Drafts.</p></div>
  return (
    <div className="pw-step">
      <h2>Review and sign the agreement</h2>
      {terms ? <TermsTable terms={terms} /> : null}
      <div className="pw-agreement" dangerouslySetInnerHTML={{ __html: html || '<p>Loading…</p>' }} />
      {signed ? <p className="cu-notice"><Check size={15} /> The agreement is signed and stored.</p> : (
        <>
          <div className="cs-tabs small">
            <button type="button" className={method === 'electronic' ? 'active' : ''} disabled={!rules.electronic_signature_allowed} onClick={() => setMethod('electronic')} title={rules.electronic_signature_allowed ? '' : 'Not enabled in the configuration'}>Sign electronically</button>
            <button type="button" className={method === 'paper' ? 'active' : ''} onClick={() => setMethod('paper')}>Print and sign on paper</button>
          </div>
          {method === 'electronic' ? <label className="tx-field"><span>Customer types their full name to sign</span><input value={signature} onChange={(event) => setSignature(event.target.value)} /></label>
            : <button type="button" onClick={() => printAgreement(html, { title: 'Pawn agreement for signing' })}><Printer size={15} /> Print for signing</button>}
          <label className="tx-check"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} /> The customer reviewed the agreement{method === 'paper' ? ' and signed the printed copy' : ''}.</label>
          <div className="cs-actions left"><button type="button" className="gold-button" disabled={busy || !reviewed || (method === 'electronic' && signature.trim().length < 3) || !perms.pawn_create} onClick={() => run(async () => { await signAgreement(storeId, loanId, method, signature, reviewed); onSigned() })}><FileSignature size={15} /> Record signed agreement</button></div>
        </>
      )}
    </div>
  )
}

function IssueStep({ storeId, loanId, loanNumber, customer, items, terms, perms, store, onIssued }) {
  const [requestId] = useState(newRequestId)
  const [method, setMethod] = useState('cash')
  const [reference, setReference] = useState('')
  const [confirm, setConfirm] = useState({ id_verified: false, collateral_received: false, funds_handed_over: false })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [done, setDone] = useState(null)
  const offline = typeof navigator !== 'undefined' && !navigator.onLine
  async function issue() {
    setBusy(true); setProblem('')
    try {
      const result = await issueLoan(storeId, loanId, requestId, method, reference, confirm)
      setDone(result)
    } catch (error) { setProblem(error.message) } finally { setBusy(false) }
  }
  if (done) {
    const loan = { loan_number: loanNumber, due_date: done.due_date, status: 'active' }
    return (
      <div className="pw-step pw-done">
        <Check size={34} /><h2>Loan {loanNumber} issued</h2>
        <p>{money(terms?.principal)} paid out by {method}. Due {done.due_date}.</p>
        <div className="cs-actions">
          <button type="button" onClick={() => printPawnReceipt({ title: 'Pawn loan receipt', loan, customer, store, lines: [['Loan amount', money(terms?.principal)], ['Paid out by', method], ['To redeem on the due date', money(terms?.redemption_at_due)]] })}><Printer size={15} /> Print receipt</button>
          <button type="button" onClick={() => printCollateralLabels(loan, items.filter((item) => item.name.trim()))}><Printer size={15} /> Print collateral labels</button>
          <button type="button" className="gold-button" onClick={onIssued}>Open the loan</button>
        </div>
      </div>
    )
  }
  return (
    <div className="pw-step">
      <h2>Issue the loan</h2>
      {!perms.pawn_disburse ? <p className="cu-notice"><AlertTriangle size={15} /> You don't have the <strong>Disburse funds</strong> permission. Someone who does can issue it from the loan.</p> : null}
      {offline ? <p className="cs-error"><AlertTriangle size={14} /> Offline: loans can't be issued until the connection is back.</p> : null}
      <div className="cs-form-grid">
        <label><span>Pay out by</span><select value={method} onChange={(event) => setMethod(event.target.value)}><option value="cash">Cash (from the register)</option><option value="cheque">Cheque</option><option value="e_transfer">E-transfer</option><option value="other">Other</option></select></label>
        {method !== 'cash' ? <label><span>Reference</span><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Cheque or transfer number" /></label> : null}
      </div>
      {[['id_verified', "The customer's identification was checked."], ['collateral_received', 'All the collateral is in the store and labelled.'], ['funds_handed_over', `${money(terms?.principal)} was handed over to the customer.`]].map(([key, label]) => (
        <label className="tx-check pw-confirm" key={key}><input type="checkbox" checked={confirm[key]} onChange={(event) => setConfirm({ ...confirm, [key]: event.target.checked })} /> {label}</label>
      ))}
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      <div className="cs-actions left"><button type="button" className="gold-button" disabled={busy || offline || !perms.pawn_disburse || !Object.values(confirm).every(Boolean) || (method !== 'cash' && !reference.trim())} onClick={issue}>{busy ? 'Issuing…' : `Issue loan · ${money(terms?.principal)}`}</button></div>
    </div>
  )
}
