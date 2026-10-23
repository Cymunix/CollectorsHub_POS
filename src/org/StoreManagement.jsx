import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import './storeManagement.css'

const STATUSES = ['draft', 'pending_verification', 'approved', 'active', 'suspended']
const NEXT = { draft: ['pending_verification'], pending_verification: ['draft', 'approved'], approved: ['active'], active: ['suspended'], suspended: ['pending_verification'] }
const BUSINESS_LABELS = { legal_name: 'Legal business name', trading_name: 'Operating / trading name', address: 'Business address', contact_name: 'Authorised contact', contact_email: 'Authorised contact email', phone: 'Contact phone', gst_hst_status: 'GST/HST registration status', gst_hst_account_number: 'GST/HST account number' }
const label = value => value.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
const blank = { legal_name: '', trading_name: '', registration_number: '', registration_jurisdiction: '', business_number: '', gst_hst_status: 'not_registered', gst_hst_account_number: '', contact_name: '', contact_email: '', phone: '', owner_name: '', owner_email: '', store_name: '', location_name: 'Primary Location', address: '', city: '', province: '', postal: '', country: 'Canada', subscription_plan: 'store', billing_cycle: 'monthly', modules: {} }

async function manage(action, orgId = null, data = {}) {
  const response = await supabase.rpc('nordvik_manage_store', { p_action: action, p_org_id: orgId, p_data: data })
  if (response.error) throw new Error(response.error.message)
  return response.data
}

function Field({ title, name, value, onChange, required = false, type = 'text', ...rest }) {
  return <label>{title}<input name={name} value={value ?? ''} onChange={onChange} required={required} type={type} {...rest} /></label>
}

export default function StoreManagement() {
  const [rows, setRows] = useState([])
  const [applications, setApplications] = useState([])
  const [applicationFilter, setApplicationFilter] = useState('pending')
  const [applicationNotes, setApplicationNotes] = useState({})
  const [selectedId, setSelectedId] = useState('')
  const [details, setDetails] = useState(null)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(blank)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadedRequest, setLoadedRequest] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const [reason, setReason] = useState('')
  const [rate, setRate] = useState('0')
  const [taxLabel, setTaxLabel] = useState('')
  const [taxLocationId, setTaxLocationId] = useState('')
  const [location, setLocation] = useState({ store_id: '', name: '', address: '', city: '', province: '', postal: '' })
  const requestKey = `${selectedId}:${revision}`
  const loading = loadedRequest !== requestKey

  useEffect(() => {
    let cancelled = false
    Promise.all([manage('list'), selectedId ? manage('details', selectedId) : Promise.resolve(null), supabase.rpc('nordvik_store_applications'), supabase.rpc('nordvik_test_organization_ids')])
      .then(([list, detail, queue, testOrgs]) => { if (queue.error || testOrgs.error) throw new Error((queue.error || testOrgs.error).message); if (!cancelled) { setRows(list.map(row => ({ ...row, isTest: (testOrgs.data || []).includes(row.id) }))); setDetails(detail); setApplications(queue.data || []) } })
      .catch(e => { if (!cancelled) { setError(e.message); setDetails(null) } })
      .finally(() => { if (!cancelled) setLoadedRequest(requestKey) })
    return () => { cancelled = true }
  }, [selectedId, requestKey])

  async function run(operation, success) {
    setBusy(true); setError(''); setNotice('')
    try { await operation(); setNotice(success); setRevision(v => v + 1) }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const patch = e => setForm(current => ({ ...current, [e.target.name]: e.target.value }))
  const org = details?.organization
  const isTest = details?.stores?.length > 0 && details.stores.every(store => store.is_test_store === true)
  const visible = rows.filter(r => (filter === 'all' || r.onboarding_status === filter) && `${r.name} ${r.org_code} ${r.designated_owner_email || ''}`.toLowerCase().includes(search.toLowerCase()))
  const fields = (items) => items.map(([name, title, required, type]) => <Field key={name} name={name} title={title} required={required} type={type} value={form[name]} onChange={patch} />)
  const reviewApplication = (application, decision) => run(async () => {
    const { data, error: failure } = await supabase.rpc('nordvik_review_store_application', { p_application_id: application.id, p_decision: decision, p_note: applicationNotes[application.id] || '' })
    if (failure) throw new Error(failure.message)
    if (data.organization_id) setSelectedId(data.organization_id)
  }, decision === 'approved' ? 'Application approved. Review taxes and invite the owner before activating the store.' : 'Application rejected. Review notes are available to the applicant.')
  const viewDocument = path => run(async () => {
    const { data, error: failure } = await supabase.storage.from('support-documents').createSignedUrl(path, 120)
    if (failure) throw new Error(failure.message)
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }, 'Supporting document opened with temporary access.')

  return <section className="store-management">
    <header className="sm-heading"><div><h2>Store Management</h2><p>NORDVIK retailer onboarding, approval and activation.</p></div><button disabled={busy} onClick={() => { setCreating(true); setEditingId(null); setForm(blank); setError('') }}>Create Store</button></header>
    <p>Stores require administrative approval, an invited account owner and a tax review before activation. Suspended accounts retain their records.</p>
    {error ? <p className="sm-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <section className="sm-panel" aria-label="Store applications"><div className="sm-heading"><h3>Store applications ({applications.filter(a => a.status === 'pending').length} pending)</h3><label>Application status<select value={applicationFilter} onChange={e => setApplicationFilter(e.target.value)}>{['pending','approved','rejected','all'].map(status => <option key={status} value={status}>{label(status)}</option>)}</select></label></div>
      <p>Applications submitted through Choose Store on the NORDVIK website. Approval creates the retailer organisation and store; activation remains a separate administrative decision.</p>
      {applications.filter(a => applicationFilter === 'all' || a.status === applicationFilter).map(application => <details key={application.id} className="sm-application"><summary><strong>{application.name}</strong> · {label(application.status)} · {new Date(application.created_at).toLocaleString()}</summary>
        <p>Applicant account: {application.applicant_user_id}</p>
        <dl className="sm-application-details">{Object.entries(application.business_details || {}).filter(([key]) => !['certificate_scan_path','proof_of_address_path'].includes(key)).map(([key,value]) => <div key={key}><dt>{BUSINESS_LABELS[key] || label(key)}</dt><dd>{typeof value === 'object' ? Object.entries(value || {}).filter(([,enabled]) => enabled).map(([name]) => label(name)).join(', ') || 'None requested' : String(value || '—')}</dd></div>)}</dl>
        {application.details ? <p>{application.details}</p> : null}
        <div className="sm-actions">{[['certificate_scan_path','View certificate'],['proof_of_address_path','View proof of address']].map(([key,title]) => application.business_details?.[key] ? <button key={key} type="button" disabled={busy} onClick={() => viewDocument(application.business_details[key])}>{title}</button> : null)}</div>
        {application.status === 'pending' ? <><Field title="Administrative application review note" value={applicationNotes[application.id] || ''} onChange={e => setApplicationNotes(v => ({ ...v, [application.id]: e.target.value }))} /><div className="sm-actions"><button disabled={busy || !applicationNotes[application.id]?.trim() || application.application_source !== 'store_subscription'} onClick={() => reviewApplication(application,'approved')}>Approve Application and Create Store</button><button disabled={busy || !applicationNotes[application.id]?.trim()} onClick={() => reviewApplication(application,'rejected')}>Reject Application</button></div>{application.application_source !== 'store_subscription' ? <p>This legacy application needs a completed Store form before approval.</p> : null}</> : <p>Reviewed {application.reviewed_at ? new Date(application.reviewed_at).toLocaleString() : ''} · {application.review_notes}</p>}
        {application.organization_id ? <button disabled={busy} onClick={() => { setDetails(null); setSelectedId(application.organization_id); setReason(''); setTaxLocationId('') }}>Manage Approved Organisation</button> : null}
      </details>)}
      {!loading && !applications.some(a => applicationFilter === 'all' || a.status === applicationFilter) ? <p>No applications in this view.</p> : null}
    </section>
    {creating ? <form className="sm-panel" onSubmit={e => { e.preventDefault(); run(async () => { const row = await manage(editingId ? 'configure' : 'create', editingId, form); setCreating(false); setSelectedId(row.id) }, editingId ? 'Draft onboarding details saved.' : 'Draft store created. Tax collection remains disabled.') }}>
      <h3>{editingId ? 'Configure Onboarding' : 'Create Store'} · Draft</h3>
      <fieldset disabled={busy}><legend>Business verification — identification and registration</legend><div className="sm-grid">{fields([['legal_name', 'Legal business name', true], ['trading_name', 'Operating / trading name (if different)'], ['registration_number', 'Business registration number', true], ['registration_jurisdiction', 'Registration jurisdiction'], ['business_number', 'Business number']])}</div></fieldset>
      <fieldset disabled={busy}><legend>GST/HST registration</legend><div className="sm-grid"><label>Registration status<select name="gst_hst_status" value={form.gst_hst_status} onChange={e => setForm(v => ({ ...v, gst_hst_status: e.target.value, gst_hst_account_number: '' }))}><option value="registered">Registered</option><option value="not_registered">Not registered</option><option value="not_required">Not required to register</option></select></label>{form.gst_hst_status === 'registered' ? <Field title="GST/HST account number" name="gst_hst_account_number" required pattern="[0-9]{9}RT[0-9]{4}" placeholder="123456789RT0001" value={form.gst_hst_account_number} onChange={patch} /> : null}</div><p>Registration is recorded here. Tax collection requires a separate review and configuration.</p></fieldset>
      <fieldset disabled={busy}><legend>Authorised contact and account owner</legend><div className="sm-grid">{fields([['contact_name', 'Authorised contact name', true], ['contact_email', 'Authorised contact email', true, 'email'], ['phone', 'Phone'], ['owner_name', 'Designated owner name', true], ['owner_email', 'Designated owner email', true, 'email']])}</div></fieldset>
      {!editingId ? <fieldset disabled={busy}><legend>Store and primary location</legend><div className="sm-grid">{fields([['store_name', 'Store name', true], ['location_name', 'Location name', true], ['address', 'Street address', true], ['city', 'City', true], ['province', 'Province / state', true], ['postal', 'Postal / ZIP code', true], ['country', 'Country', true]])}</div></fieldset> : <p>Existing store and location records are retained. This form updates onboarding details and enabled modules.</p>}
      <fieldset disabled={busy}><legend>Subscription and enabled modules</legend><div className="sm-grid"><label>Retailer plan<select name="subscription_plan" value={form.subscription_plan} onChange={patch}><option value="store">Store</option></select></label><label>Billing cycle<select name="billing_cycle" value={form.billing_cycle} onChange={patch}><option value="monthly">Monthly</option><option value="annual">Annual</option></select></label></div>{[['pawns_loans', 'Pawns & Loans'], ['collector_scanning', 'Collector scanning']].map(([key, title]) => <label className="sm-check" key={key}><input type="checkbox" checked={Boolean(form.modules[key])} onChange={e => setForm(v => ({ ...v, modules: { ...v.modules, [key]: e.target.checked } }))} />{title}</label>)}</fieldset>
      <div className="sm-actions"><button disabled={busy} type="submit">{busy ? 'Saving…' : editingId ? 'Save Draft Details' : 'Create Draft Store'}</button><button disabled={busy} type="button" onClick={() => setCreating(false)}>Cancel</button></div>
    </form> : null}
    <div className="sm-actions"><input aria-label="Search stores" type="search" placeholder="Search organisations, codes or owners" value={search} onChange={e => setSearch(e.target.value)} /><select aria-label="Filter by status" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All statuses</option>{STATUSES.map(s => <option key={s} value={s}>{label(s)}</option>)}</select><button disabled={busy || loading} onClick={() => setRevision(v => v + 1)}>Refresh</button></div>
    {loading ? <p role="status">Loading store management…</p> : <div className="sm-table"><table><thead><tr><th>Organisation</th><th>Code</th><th>Status</th><th>Account owner</th><th>Plan</th><th /></tr></thead><tbody>{visible.map(r => <tr key={r.id}><td>{r.name}{r.isTest ? <small className="sm-test-badge">Test organisation</small> : null}</td><td>{r.org_code}</td><td>{label(r.onboarding_status)}</td><td>{r.designated_owner_email || (r.isTest ? 'Existing test account' : 'Review required')}</td><td>{r.subscription_plan || (r.isTest ? 'Test environment' : 'Review required')}</td><td><button disabled={busy} onClick={() => { setDetails(null); setSelectedId(r.id); setReason(''); setLocation({ store_id: '', name: '', address: '', city: '', province: '', postal: '' }) }}>Manage</button></td></tr>)}</tbody></table>{visible.length === 0 ? <p>No organisations match.</p> : null}</div>}
    {org && !loading ? <section className="sm-panel" aria-label="Organisation details"><h3>{org.name} · {label(org.onboarding_status)}{isTest ? <small className="sm-test-badge">Test organisation</small> : null}</h3>{isTest ? <p>Internal test environment. Its existing owner and tax settings are retained; commercial onboarding approval is not implied.</p> : null}<p>{org.org_code} · GST/HST: {label(org.gst_hst_status)} {org.gst_hst_account_number || ''}</p><p>Owner: {org.designated_owner_email || (isTest ? 'Existing test account' : 'Not designated')} · {isTest ? 'Internal testing' : org.owner_linked ? 'Invited and linked' : 'Invitation required'} · Tax review: {org.tax_reviewed_at ? new Date(org.tax_reviewed_at).toLocaleString() : isTest ? 'Not recorded (test environment)' : 'Required'}</p>
      <details><summary>Business and onboarding details</summary><pre>{JSON.stringify(org.business_details, null, 2)}</pre></details>
      {org.onboarding_status === 'draft' ? <button disabled={busy} onClick={() => { setEditingId(org.id); setForm({ ...blank, ...org.business_details, legal_name: org.name, gst_hst_status: org.gst_hst_status, gst_hst_account_number: org.gst_hst_account_number || '', owner_email: org.designated_owner_email || org.business_details.owner_email || '' }); setCreating(true) }}>Configure Draft Onboarding</button> : null}
      <Field title="Administrative decision / review note" value={reason} onChange={e => setReason(e.target.value)} />
      <div className="sm-actions">{(NEXT[org.onboarding_status] || []).map(status => <button key={status} disabled={busy || !reason.trim()} onClick={() => run(() => manage('status', org.id, { status, reason }), `Organisation ${label(status)}.`)}>{status === 'approved' ? 'Explicitly Approve' : status === 'active' ? 'Activate Store' : label(status)}</button>)}
        <button disabled={busy || !['approved', 'active'].includes(org.onboarding_status)} onClick={() => run(async () => { const { data, error: failure } = await supabase.functions.invoke('nordvik-store-owner-invite', { body: { organizationId: org.id } }); if (failure || data?.error) { let message = data?.error || failure.message; try { message = (await failure?.context?.json())?.error || message } catch { message = message || 'Owner invitation failed.' } throw new Error(message) } }, 'Owner invitation linked. Existing accounts can sign in with their current credentials.')}>{org.owner_linked ? 'Check Owner Invitation' : 'Invite Account Owner'}</button></div>
      <form onSubmit={e => { e.preventDefault(); run(() => manage('tax_review', org.id, { location_id: taxLocationId, rate: Number(rate) / 100, label: taxLabel, reason }), 'Location tax settings reviewed and saved.') }}><fieldset disabled={busy}><legend>Review GST/HST tax collection by location</legend><p>Review every location before activation. Enter a reviewed rate explicitly. Use 0% for businesses that are not registered. Other applicable taxes require separate review.</p><div className="sm-grid"><label>Location<select required value={taxLocationId} onChange={e => { setTaxLocationId(e.target.value); const loc = details.locations.find(l => l.id === e.target.value); setRate(String(Number(loc?.tax_rate_1 || 0) * 100)); setTaxLabel(loc?.tax_label_1 || '') }}><option value="">Select location</option>{details.locations.map(l => <option key={l.id} value={l.id}>{l.location_name} · {l.province} · {l.nordvik_tax_reviewed_at ? 'Reviewed' : 'Review required'}</option>)}</select></label><Field title="GST/HST rate (%)" type="number" min="0" max="100" step="0.01" required value={rate} onChange={e => setRate(e.target.value)} /><Field title="Tax label" value={taxLabel} onChange={e => setTaxLabel(e.target.value)} /></div><button disabled={!reason.trim()}>Save Tax Review</button></fieldset></form>
      <h4>Locations</h4><ul>{details.locations.map(l => <li key={l.id}>{l.location_name} · {[l.street_address, l.city, l.province].filter(Boolean).join(', ')} · GST/HST {Number(l.tax_rate_1 || 0) * 100}%</li>)}</ul>
      <form onSubmit={e => { e.preventDefault(); run(() => manage('add_location', org.id, { ...location, reason }), 'Additional location approved and created with zero tax. Review its tax configuration.') }}><fieldset disabled={busy}><legend>Approve an additional location</legend><div className="sm-grid"><label>Store<select required value={location.store_id} onChange={e => setLocation(v => ({ ...v, store_id: e.target.value }))}><option value="">Select store</option>{details.stores.map(s => <option key={s.id} value={s.id}>{s.store_name}</option>)}</select></label>{[['name', 'Location name'], ['address', 'Street address'], ['city', 'City'], ['province', 'Province / state'], ['postal', 'Postal / ZIP code']].map(([name, title]) => <Field key={name} title={title} required value={location[name]} onChange={e => setLocation(v => ({ ...v, [name]: e.target.value }))} />)}</div><button disabled={!reason.trim()}>Approve and Create Location</button></fieldset></form>
      <h4>Administrative audit history ({details.audit.length})</h4><div className="sm-audit">{details.audit.map(a => <details key={a.id}><summary>{new Date(a.created_at).toLocaleString()} · {label(a.action)} · {a.actor_user_id || 'Server'}</summary><pre>{JSON.stringify({ before: a.before_data, after: a.after_data }, null, 2)}</pre></details>)}</div>
    </section> : null}
  </section>
}
