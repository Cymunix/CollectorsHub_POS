import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ClipboardCheck, Search, Upload, X } from 'lucide-react'
import {
  STAGES, STAGE_LABEL, NEXT_STAGE, MARKETPLACE_LABEL, ONBOARDING_PERMISSIONS, IMPORT_FIELDS, PROJECT_STATUSES, ITEM_PAGE,
  onboardingAccess, loadProject, projectSummary, projectEvents, loadItems, loadBatches, loadLabour, logHours, onboardingStaff, setStaffPermissions,
  updateItem, advanceItems, assignItems, qaCheck, setException, sampleForQa, parseDelimited, guessMapping, rowsToItems, matchBarcodes, importRows,
  catalogueNames, money,
} from '../lib/onboarding'
import { CARD_CONDITIONS, GRADED, isCardCategory } from '../lib/cardCondition'
import { CatalogueSearchDialog } from '../StoreScanIntake'
import './onboarding.css'

const TABS = ['Dashboard', 'Queue', 'Import', 'Labour', 'Staff', 'History']
const fmt = (value) => Number(value || 0).toLocaleString()
const when = (value) => (value ? new Date(value).toLocaleString() : '')

// One retailer's onboarding project: progress, the stage queue, imports,
// labour, staff permissions and the audit history. Store staff and NORDVIK
// administrators share it; each sees the actions their role allows.
export default function OnboardingWorkspace({ session, projectId, onBack = null }) {
  const access = onboardingAccess(session)
  const [project, setProject] = useState(null)
  const [summary, setSummary] = useState(null)
  const [tab, setTab] = useState('Dashboard')
  const [staff, setStaff] = useState([])
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const refresh = () => setReload((value) => value + 1)

  useEffect(() => {
    let cancelled = false
    Promise.all([loadProject(projectId), projectSummary(projectId)])
      .then(([row, numbers]) => { if (!cancelled) { setProject(row); setSummary(numbers); setError('') } })
      .catch((err) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [projectId, reload])

  useEffect(() => {
    if (!project?.store_id) return
    onboardingStaff(project.store_id).then(setStaff).catch(() => setStaff([]))
  }, [project?.store_id, reload])

  if (error && !project) return <section className="ob"><p className="ob-error">{error}</p></section>
  if (!project) return <section className="ob"><p className="ob-muted">Loading the onboarding project…</p></section>

  return (
    <section className="ob">
      <header className="ob-head">
        <div>
          {onBack ? <button type="button" className="ob-link" onClick={onBack}>← All onboarding projects</button> : null}
          <p className="ob-kicker">Inventory onboarding · {PROJECT_STATUSES.find(([key]) => key === project.status)?.[1] || project.status}</p>
          <h1>{project.name}</h1>
        </div>
        <nav className="ob-tabs">
          {TABS.map((name) => <button key={name} type="button" className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}
        </nav>
      </header>
      {error ? <p className="ob-error">{error}</p> : null}
      {tab === 'Dashboard' ? <Dashboard project={project} summary={summary} access={access} onChanged={refresh} onOpenQueue={() => setTab('Queue')} /> : null}
      {tab === 'Queue' ? <Queue project={project} session={session} access={access} staff={staff} summary={summary} onChanged={refresh} /> : null}
      {tab === 'Import' ? <ImportPanel project={project} access={access} onImported={() => { refresh(); setTab('Queue') }} /> : null}
      {tab === 'Labour' ? <LabourPanel project={project} summary={summary} onChanged={refresh} /> : null}
      {tab === 'Staff' ? <StaffPanel project={project} staff={staff} onChanged={refresh} /> : null}
      {tab === 'History' ? <HistoryPanel project={project} /> : null}
    </section>
  )
}

// ── Dashboard (supervisor view) ─────────────────────────────────────────────
function Dashboard({ project, summary, access, onChanged, onOpenQueue }) {
  const stages = summary?.stages || {}
  const units = summary?.units || {}
  const total = Number(summary?.items || 0) - Number(stages.excluded || 0)
  const ready = Number(stages.ready_for_sale || 0)
  const percent = total ? Math.round((ready / total) * 100) : 0
  const [sample, setSample] = useState(null)
  return (
    <div className="ob-stack">
      <div className="ob-progress">
        <div className="ob-progress-bar"><span style={{ width: `${percent}%` }} /></div>
        <strong>{percent}% ready for sale</strong>
        <small>{fmt(ready)} of {fmt(total)} item records · {fmt(units.ready_for_sale)} units in stock{project.approx_quantity ? ` · about ${fmt(project.approx_quantity)} expected` : ''}</small>
      </div>
      <div className="ob-pipeline">
        {STAGES.map(([key, label]) => (
          <div key={key} className={`ob-stage ${key}`}>
            <span>{label}</span>
            <strong>{fmt(stages[key])}</strong>
            <small>{fmt(units[key])} units</small>
          </div>
        ))}
      </div>
      <div className="ob-cards">
        <Stat label="Missing prices" value={summary?.missing_prices} warn />
        <Stat label="Exceptions" value={summary?.exceptions} warn />
        <Stat label="Unassigned" value={summary?.unassigned} />
        <Stat label="QA passed / failed" value={`${fmt(summary?.qa?.passed)} / ${fmt(summary?.qa?.failed)}`} />
        <Stat label="Hours: actual / expected" value={`${Number(summary?.actual_hours || 0).toFixed(1)} / ${project.expected_hours != null ? Number(project.expected_hours).toFixed(1) : '—'}`} />
        <Stat label="Batches" value={summary?.batches} />
        <Stat label="Excluded" value={stages.excluded} />
      </div>
      <div className="ob-card">
        <h3>Assessment</h3>
        <dl className="ob-dl">
          <dt>Categories</dt><dd>{project.categories?.join(', ') || '—'}</dd>
          <dt>Data sources</dt><dd>{project.data_sources?.join(', ') || '—'}</dd>
          <dt>Existing POS</dt><dd>{project.existing_pos || '—'}</dd>
          <dt>Pricing today</dt><dd>{project.pricing_methods || '—'}</dd>
          <dt>Retailer price approval</dt><dd>{project.require_price_approval ? 'Required before stock goes on sale' : 'Not required (priced items go straight on sale)'}</dd>
          {project.notes ? <><dt>Notes</dt><dd>{project.notes}</dd></> : null}
        </dl>
      </div>
      {access.oversee ? (
        <div className="ob-card">
          <h3>Sample checks</h3>
          <p className="ob-muted">Pick unchecked items at random and check their identity, quantity and price against the real stock.</p>
          <div className="ob-row">
            <button type="button" onClick={async () => setSample(await sampleForQa(project.id, { stage: 'ready_for_sale' }))}>Sample 10 ready for sale</button>
            <button type="button" onClick={async () => setSample(await sampleForQa(project.id, { stage: 'awaiting_approval' }))}>Sample 10 awaiting approval</button>
            {(summary?.exceptions || summary?.missing_prices) ? <button type="button" onClick={onOpenQueue}>Open the queue</button> : null}
          </div>
          {sample ? <QaSample items={sample} onDone={() => { setSample(null); onChanged() }} /> : null}
        </div>
      ) : null}
    </div>
  )
}

function Stat({ label, value, warn = false }) {
  const number = typeof value === 'number' ? value : Number(value)
  return <div className={`ob-stat ${warn && number > 0 ? 'warn' : ''}`}><span>{label}</span><strong>{typeof value === 'number' || value == null ? fmt(value) : value}</strong></div>
}

function QaSample({ items, onDone }) {
  const [results, setResults] = useState({})
  const [error, setError] = useState('')
  const [names, setNames] = useState({})
  useEffect(() => { catalogueNames(items.map((item) => item.catalog_item_id)).then(setNames).catch(() => {}) }, [items])
  if (!items.length) return <p className="ob-muted">Nothing unchecked at that stage.</p>
  async function save(item, passed) {
    const result = results[item.id] || {}
    setError('')
    try {
      await qaCheck(item.id, passed, { identity: result.identity !== false, quantity: result.quantity !== false, price: result.price !== false }, result.note || '')
      setResults((current) => ({ ...current, [item.id]: { ...result, saved: passed ? 'passed' : 'failed' } }))
    } catch (err) { setError(err.message) }
  }
  return (
    <div className="ob-qa">
      {error ? <p className="ob-error">{error}</p> : null}
      <table className="ob-table">
        <thead><tr><th>Item</th><th>Qty</th><th>Prices</th><th>Checks</th><th>Note</th><th /></tr></thead>
        <tbody>{items.map((item) => {
          const result = results[item.id] || {}
          const set = (patch) => setResults((current) => ({ ...current, [item.id]: { ...current[item.id], ...patch } }))
          return (
            <tr key={item.id}>
              <td><strong>{item.name || '—'}</strong><small>{[item.item_number, names[item.catalog_item_id]].filter(Boolean).join(' · ')}</small></td>
              <td>{item.quantity}</td>
              <td>{money(item.in_store_price) || '—'} / {money(item.online_price) || '—'}</td>
              <td className="ob-checks">
                {['identity', 'quantity', 'price'].map((key) => <label key={key}><input type="checkbox" checked={result[key] !== false} onChange={(event) => set({ [key]: event.target.checked })} disabled={Boolean(result.saved)} /> {key}</label>)}
              </td>
              <td><input value={result.note || ''} onChange={(event) => set({ note: event.target.value })} placeholder="What was wrong?" disabled={Boolean(result.saved)} /></td>
              <td>{result.saved ? <span className={`ob-pill ${result.saved}`}>{result.saved}</span> : (
                <span className="ob-row">
                  <button type="button" onClick={() => save(item, true)} disabled={['identity', 'quantity', 'price'].some((key) => result[key] === false)}>Pass</button>
                  <button type="button" className="danger" onClick={() => save(item, false)}>Fail</button>
                </span>
              )}</td>
            </tr>
          )
        })}</tbody>
      </table>
      <button type="button" onClick={onDone}>Done</button>
    </div>
  )
}

// ── Queue ───────────────────────────────────────────────────────────────────
function Queue({ project, session, access, staff, summary, onChanged }) {
  const [stage, setStage] = useState('awaiting_verification')
  const [flag, setFlag] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [data, setData] = useState({ items: [], total: 0 })
  const [names, setNames] = useState({})
  const [checked, setChecked] = useState(new Set())
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const staffName = useMemo(() => Object.fromEntries(staff.map((person) => [person.id, person.name])), [staff])

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      loadItems(project.id, { stage, flag, search, page })
        .then(async (next) => {
          if (cancelled) return
          setData(next)
          setNames(await catalogueNames(next.items.map((item) => item.catalog_item_id)).catch(() => ({})))
        })
        .catch((err) => { if (!cancelled) setError(err.message) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [project.id, stage, flag, search, page, reload])
  useEffect(() => { setChecked(new Set()); setPage(0) }, [stage, flag, search])

  const changed = () => { setReload((value) => value + 1); onChanged() }
  const selected = data.items.filter((item) => checked.has(item.id))
  const next = NEXT_STAGE[stage]
  const canMove = {
    awaiting_verification: access.scan, awaiting_pricing: access.verify,
    awaiting_approval: access.price, ready_for_sale: project.require_price_approval ? access.approve : access.price,
  }[next]

  async function run(action, label) {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await action()
      const skipped = result?.skipped || []
      setMessage(`${label}: ${fmt(result?.moved ?? result)}${skipped.length ? `. Not moved: ${skipped.slice(0, 5).map((row) => `${row.name || 'item'} (${row.reason})`).join('; ')}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ''}` : ''}.`)
      setChecked(new Set())
      changed()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const moveTo = (to, note = '') => run(() => advanceItems([...checked], to, { note, locationId: session?.locationId || null }), `Moved to ${STAGE_LABEL[to]}`)
  const sendBack = () => {
    const index = STAGES.findIndex(([key]) => key === stage)
    if (index < 1) return
    const note = window.prompt(`Why are these going back to ${STAGES[index - 1][1]}?`)
    if (note) moveTo(STAGES[index - 1][0], note)
  }
  const exclude = () => {
    const note = window.prompt('Why are these being excluded from onboarding? (They stay in the history.)')
    if (note) run(() => advanceItems([...checked], 'excluded', { note }), 'Excluded')
  }

  return (
    <div className="ob-stack">
      <div className="ob-stage-tabs">
        {[...STAGES, ['excluded', 'Excluded']].map(([key, label]) => (
          <button key={key} type="button" className={stage === key ? 'active' : ''} onClick={() => setStage(key)}>{label} <b>{fmt(summary?.stages?.[key])}</b></button>
        ))}
      </div>
      <div className="ob-row ob-filters">
        <label className="ob-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, number, barcode or cert…" /></label>
        <select value={flag} onChange={(event) => setFlag(event.target.value)}>
          <option value="">All items</option>
          <option value="missing_price">Missing a price</option>
          <option value="exception">With an exception</option>
          <option value="qa_failed">Failed a QA check</option>
          <option value="unassigned">Unassigned</option>
        </select>
        <span className="ob-muted">{fmt(data.total)} item{data.total === 1 ? '' : 's'}</span>
      </div>
      {checked.size ? (
        <div className="ob-bulk">
          <span>{checked.size} selected</span>
          {next && canMove ? <button type="button" className="primary" disabled={busy} onClick={() => moveTo(next)}>{next === 'ready_for_sale' ? 'Approve: put on sale' : `Send to ${STAGE_LABEL[next]}`}</button> : null}
          {stage !== 'captured' && stage !== 'ready_for_sale' && stage !== 'excluded' ? <button type="button" disabled={busy} onClick={sendBack}>Send back</button> : null}
          {stage !== 'ready_for_sale' && stage !== 'excluded' && (access.verify || access.approve) ? <button type="button" disabled={busy} onClick={exclude}>Exclude</button> : null}
          {access.oversee && staff.length ? (
            <select value="" disabled={busy} onChange={(event) => run(() => assignItems([...checked], event.target.value === 'none' ? null : event.target.value), 'Assigned')}>
              <option value="">Assign to…</option>
              <option value="none">Nobody</option>
              {staff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          ) : null}
        </div>
      ) : null}
      {next === 'ready_for_sale' && checked.size && !session?.locationId && canMove ? <p className="ob-error">This register has no store location, so stock can't be received here.</p> : null}
      {message ? <p className="ob-message">{message}</p> : null}
      {error ? <p className="ob-error">{error}</p> : null}
      <table className="ob-table">
        <thead><tr>
          <th className="ob-check"><input type="checkbox" checked={data.items.length > 0 && data.items.every((item) => checked.has(item.id))} onChange={(event) => setChecked(event.target.checked ? new Set(data.items.map((item) => item.id)) : new Set())} aria-label="Select this page" /></th>
          <th>Item</th><th>Category</th><th>Condition</th><th>Qty</th><th>In-store</th><th>Online</th><th>Assigned</th><th>Flags</th>
        </tr></thead>
        <tbody>
          {data.items.map((item) => (
            <tr key={item.id} className={checked.has(item.id) ? 'checked' : ''} onClick={() => setOpen(item)}>
              <td className="ob-check" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={checked.has(item.id)} onChange={() => setChecked((current) => { const nextSet = new Set(current); if (nextSet.has(item.id)) nextSet.delete(item.id); else nextSet.add(item.id); return nextSet })} /></td>
              <td><strong>{item.name || '—'}</strong><small>{[item.item_number, item.barcode, names[item.catalog_item_id] ? `Catalogue: ${names[item.catalog_item_id]}` : 'Not matched to the catalogue'].filter(Boolean).join(' · ')}</small></td>
              <td>{item.category_name || '—'}</td>
              <td>{item.condition === GRADED ? [item.grading_company, item.grade].filter(Boolean).join(' ') || GRADED : item.condition || '—'}</td>
              <td>{item.quantity}</td>
              <td>{money(item.in_store_price) || '—'}</td>
              <td>{money(item.online_price) || '—'}</td>
              <td>{staffName[item.assigned_employee_id] || '—'}</td>
              <td className="ob-flags">
                {item.price_missing ? <span className="ob-pill warn">No price</span> : null}
                {item.exception ? <span className="ob-pill bad" title={item.exception}>Exception</span> : null}
                {item.qa_status !== 'unchecked' ? <span className={`ob-pill ${item.qa_status}`}>QA {item.qa_status}</span> : null}
                {item.marketplace_status !== 'not_listed' ? <span className="ob-pill">eBay: {MARKETPLACE_LABEL[item.marketplace_status]}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!data.items.length ? <p className="ob-muted">Nothing here.</p> : null}
      {data.total > ITEM_PAGE ? (
        <div className="ob-row">
          <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="ob-muted">Page {page + 1} of {Math.ceil(data.total / ITEM_PAGE)}</span>
          <button type="button" disabled={(page + 1) * ITEM_PAGE >= data.total} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      ) : null}
      {open ? <ItemPanel item={open} project={project} access={access} catalogueName={names[open.catalog_item_id]} onClose={() => setOpen(null)} onChanged={(updated) => { changed(); if (updated) setOpen(updated) }} /> : null}
    </div>
  )
}

// One staged item: its fields (editable as the stage and role allow), its
// catalogue match, exceptions and history.
function ItemPanel({ item, project, access, catalogueName, onClose, onChanged }) {
  const editableStage = !['ready_for_sale', 'excluded'].includes(item.stage)
  const canIdentity = editableStage && (access.verify || (item.stage === 'captured' && access.scan))
  const canPrice = editableStage && (access.price || (item.stage === 'awaiting_approval' && access.approve))
  const [values, setValues] = useState(() => ({ ...item }))
  const [catalogue, setCatalogue] = useState({ id: item.catalog_item_id, name: catalogueName })
  const [searching, setSearching] = useState(false)
  const [events, setEvents] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [exceptionText, setExceptionText] = useState('')

  useEffect(() => { projectEvents(project.id, { itemId: item.id, limit: 100 }).then(setEvents).catch(() => setEvents([])) }, [item.id, item.updated_at])

  const identityKeys = ['name', 'item_number', 'barcode', 'category_name', 'condition', 'grading_company', 'grade', 'cert_number', 'quantity']
  const priceKeys = ['in_store_price', 'online_price', 'cost']
  const changes = {}
  ;[...(canIdentity ? identityKeys : []), ...(canPrice ? priceKeys : [])].forEach((key) => {
    if (String(values[key] ?? '') !== String(item[key] ?? '')) changes[key] = values[key] ?? ''
  })
  if (canIdentity && (catalogue.id || null) !== (item.catalog_item_id || null)) changes.catalog_item_id = catalogue.id || ''

  async function act(action) {
    setBusy(true); setError('')
    try { await action(); onChanged(null); onClose() } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  const field = (key, label, { type = 'text', can = canIdentity } = {}) => (
    <label>{label}<input type={type} value={values[key] ?? ''} onChange={(event) => setValues({ ...values, [key]: event.target.value })} disabled={!can || busy} /></label>
  )
  const card = isCardCategory(values.category_name)

  return (
    <div className="register-modal ob-panel" role="dialog" aria-modal="true">
      <section>
        <div className="ob-panel-head">
          <div>
            <p className="ob-kicker">{STAGE_LABEL[item.stage]} · {item.source}{item.source_ref ? ` · ${item.source_ref}` : ''}</p>
            <h2>{item.name || 'Unnamed item'}</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        {item.exception ? <p className="ob-error"><AlertTriangle size={14} /> {item.exception}</p> : null}
        <div className="ob-grid">
          <div className="ob-catalogue">
            <span>Catalogue match</span>
            <strong>{catalogue.id ? catalogue.name || 'Linked catalogue item' : 'Not matched (stays a store item)'}</strong>
            {canIdentity ? <span className="ob-row"><button type="button" onClick={() => setSearching(true)} disabled={busy}>{catalogue.id ? 'Change' : 'Find in catalogue'}</button>{catalogue.id ? <button type="button" onClick={() => setCatalogue({ id: null, name: '' })} disabled={busy}>Unlink</button> : null}</span> : null}
          </div>
          {field('name', 'Name')}
          {field('item_number', 'Item / card number')}
          {field('barcode', 'Barcode')}
          {field('category_name', 'Category')}
          {card ? (
            <label>Condition
              <select value={values.condition === GRADED ? GRADED : 'Ungraded'} onChange={(event) => setValues({ ...values, condition: event.target.value })} disabled={!canIdentity || busy}>
                {CARD_CONDITIONS.map((condition) => <option key={condition}>{condition}</option>)}
              </select>
            </label>
          ) : field('condition', 'Condition')}
          {card && values.condition === GRADED ? <>{field('grading_company', 'Grading company')}{field('grade', 'Grade')}{field('cert_number', 'Cert number')}</> : null}
          {field('quantity', 'Quantity', { type: 'number' })}
          {field('in_store_price', 'In-store price', { can: canPrice })}
          {field('online_price', 'Online price', { can: canPrice })}
          {field('cost', 'Cost', { can: canPrice })}
        </div>
        <p className="ob-muted">Prices are the retailer's own: {item.price_source ? item.price_source.replace('_', ' ') : 'none yet'}{item.price_missing ? ' (missing)' : ''}{item.price_approved_at ? ` · approved ${when(item.price_approved_at)}` : ''}. Market values are never filled in for them.</p>
        {item.source_row ? <details className="ob-source"><summary>Original row</summary><dl className="ob-dl">{Object.entries(item.source_row).map(([key, value]) => <React.Fragment key={key}><dt>{key}</dt><dd>{String(value)}</dd></React.Fragment>)}</dl></details> : null}
        {Object.keys(changes).length ? (
          <div className="ob-row">
            <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Note for the history (optional)" />
            <button type="button" className="primary" disabled={busy} onClick={() => act(() => updateItem(item.id, changes, note))}>Save {Object.keys(changes).length} change{Object.keys(changes).length === 1 ? '' : 's'}</button>
          </div>
        ) : null}
        <div className="ob-row">
          {item.exception ? (
            access.oversee ? <><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="How was it resolved?" /><button type="button" disabled={busy || !note.trim()} onClick={() => act(() => setException(item.id, null, note))}><CheckCircle2 size={14} /> Resolve exception</button></> : null
          ) : (
            <><input value={exceptionText} onChange={(event) => setExceptionText(event.target.value)} placeholder="Raise an exception (e.g. quantity doesn't match the shelf)" /><button type="button" disabled={busy || !exceptionText.trim()} onClick={() => act(() => setException(item.id, exceptionText))}><AlertTriangle size={14} /> Raise</button></>
          )}
        </div>
        {error ? <p className="ob-error">{error}</p> : null}
        <h3>History</h3>
        <ul className="ob-history">{events.map((event) => <li key={event.id}><HistoryLine event={event} /></li>)}</ul>
        {searching ? <CatalogueSearchDialog initialQuery={values.name || ''} onClose={() => setSearching(false)} onPick={(picked) => { setCatalogue({ id: picked.item_id, name: [picked.name || picked.subject, picked.card_number ? `#${picked.card_number}` : '', picked.release_year].filter(Boolean).join(' · ') }); setSearching(false) }} /> : null}
      </section>
    </div>
  )
}

function HistoryLine({ event, showItem = false }) {
  const changes = event.changes && typeof event.changes === 'object' ? Object.entries(event.changes).filter(([, value]) => value && typeof value === 'object' && 'to' in value) : []
  const text = {
    captured: `Captured${event.to_stage ? ` (${STAGE_LABEL[event.to_stage]})` : ''}`,
    stage_change: `${STAGE_LABEL[event.from_stage] || event.from_stage} → ${STAGE_LABEL[event.to_stage] || event.to_stage}`,
    edit: 'Edited', price_change: 'Price changed', assigned: 'Assigned', qa_check: `QA check: ${event.changes?.passed ? 'passed' : 'failed'}`,
    exception: `Exception raised: ${event.changes?.exception || ''}`, exception_resolved: 'Exception resolved', batch_imported: `Batch added (${event.changes?.items ?? 0} items, ${event.changes?.source || ''})`,
    project_created: 'Project created', project_updated: 'Project updated', labour: `Logged ${event.changes?.hours} h${event.changes?.stage ? ` (${event.changes.stage})` : ''}`,
  }[event.event] || event.event
  return (
    <>
      <span className="ob-when">{when(event.created_at)}</span> <strong>{event.actor}</strong> · {showItem && event.item_name ? `${event.item_name}: ` : ''}{text}
      {changes.length ? <small> {changes.map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value.from ?? '—'} → ${value.to ?? '—'}`).join('; ')}</small> : null}
      {event.note ? <small> “{event.note}”</small> : null}
    </>
  )
}

// ── Import ──────────────────────────────────────────────────────────────────
function ImportPanel({ project, access, onImported }) {
  const [source, setSource] = useState('spreadsheet')
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState(null)
  const [mapping, setMapping] = useState({})
  const [label, setLabel] = useState('')
  const [defaultCategory, setDefaultCategory] = useState(project.categories?.length === 1 ? project.categories[0] : '')
  const [submit, setSubmit] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  function load(text, name = '') {
    const next = parseDelimited(text)
    if (!next.headers.length || !next.rows.length) { setError('That file has no rows under a header row.'); return }
    setError('')
    setParsed(next)
    setMapping(guessMapping(next.headers))
    setFileName(name)
  }
  const converted = useMemo(() => (parsed ? rowsToItems(parsed.headers, parsed.rows, mapping, { defaultCategory }) : { items: [], errors: [] }), [parsed, mapping, defaultCategory])
  const missingPrices = converted.items.filter((item) => !item.in_store_price && !item.online_price).length

  async function run() {
    setBusy('Matching barcodes to the catalogue…'); setError('')
    try {
      const items = await matchBarcodes(converted.items)
      await importRows({ projectId: project.id, source, label, fileName, rows: items, submit, onProgress: (done, total) => setBusy(`Importing ${fmt(done)} of ${fmt(total)}…`) })
      onImported()
    } catch (err) { setError(err.message); setBusy('') }
  }

  if (!access.scan) return <p className="ob-muted">Importing needs the onboarding scanning permission.</p>
  return (
    <div className="ob-stack">
      <div className="ob-card">
        <h3><Upload size={16} /> Import a spreadsheet or POS export</h3>
        <p className="ob-muted">Save the sheet as CSV (any spreadsheet app can), or copy the rows including the header row and paste them below. Every category can be imported. Prices are copied exactly as the retailer has them; rows without a price are flagged, never filled in.</p>
        <div className="ob-row">
          <label>Source
            <select value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="spreadsheet">Spreadsheet</option>
              <option value="pos_export">Existing POS export</option>
              <option value="manual">Manual list</option>
            </select>
          </label>
          <label>File <input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) load(await file.text(), file.name) }} /></label>
          <label>Batch name <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Back room shelf A" /></label>
        </div>
        {!parsed ? <textarea rows={6} placeholder="…or paste rows here (with the header row)" onPaste={(event) => { const text = event.clipboardData.getData('text'); if (text) { event.preventDefault(); load(text, 'Pasted rows') } }} /> : null}
      </div>
      {parsed ? (
        <div className="ob-card">
          <h3>{fileName || 'Rows'}: {fmt(parsed.rows.length)} rows</h3>
          <p className="ob-muted">Match each field to a column. Fields left on "Not in the file" stay empty.</p>
          <div className="ob-mapping">
            {IMPORT_FIELDS.map(([key, name]) => (
              <label key={key}>{name}
                <select value={mapping[key] ?? ''} onChange={(event) => setMapping({ ...mapping, [key]: event.target.value === '' ? undefined : Number(event.target.value) })}>
                  <option value="">Not in the file</option>
                  {parsed.headers.map((header, index) => <option key={index} value={index}>{header || `Column ${index + 1}`}</option>)}
                </select>
              </label>
            ))}
            <label>Category for rows without one <input value={defaultCategory} onChange={(event) => setDefaultCategory(event.target.value)} placeholder="e.g. Sports Cards" /></label>
          </div>
          <p>
            <strong>{fmt(converted.items.length)}</strong> items to import
            {missingPrices ? <> · <span className="ob-warn">{fmt(missingPrices)} without a price (flagged)</span></> : null}
            {converted.errors.length ? <> · <span className="ob-warn">{fmt(converted.errors.length)} rows skipped</span></> : null}
          </p>
          {converted.errors.length ? <p className="ob-muted">Skipped: {converted.errors.slice(0, 5).map((row) => `row ${row.row} (${row.reason})`).join('; ')}</p> : null}
          <table className="ob-table">
            <thead><tr><th>Name</th><th>Number</th><th>Barcode</th><th>Category</th><th>Condition</th><th>Qty</th><th>In-store</th><th>Online</th><th>Cost</th></tr></thead>
            <tbody>{converted.items.slice(0, 15).map((item) => (
              <tr key={item.source_ref}><td>{item.name}</td><td>{item.item_number}</td><td>{item.barcode}</td><td>{item.category_name}</td><td>{item.condition}</td><td>{item.quantity}</td><td>{item.in_store_price}</td><td>{item.online_price}</td><td>{item.cost}</td></tr>
            ))}</tbody>
          </table>
          <label className="ob-check-line"><input type="checkbox" checked={submit} onChange={(event) => setSubmit(event.target.checked)} /> Send straight to verification (otherwise they wait in Captured)</label>
          {error ? <p className="ob-error">{error}</p> : null}
          <div className="ob-row">
            <button type="button" onClick={() => { setParsed(null); setFileName('') }} disabled={Boolean(busy)}>Start again</button>
            <button type="button" className="primary" onClick={run} disabled={Boolean(busy) || !converted.items.length || mapping.name == null && mapping.item_number == null}>{busy || `Import ${fmt(converted.items.length)} items`}</button>
          </div>
        </div>
      ) : error ? <p className="ob-error">{error}</p> : null}
    </div>
  )
}

// ── Labour ──────────────────────────────────────────────────────────────────
function LabourPanel({ project, summary, onChanged }) {
  const [rows, setRows] = useState([])
  const [form, setForm] = useState({ hours: '', workDate: new Date().toISOString().slice(0, 10), stage: '', note: '' })
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => { loadLabour(project.id).then(setRows).catch((err) => setError(err.message)) }, [project.id, reload])
  async function add() {
    setError('')
    try { await logHours(project.id, form); setForm({ ...form, hours: '', note: '' }); setReload((value) => value + 1); onChanged() } catch (err) { setError(err.message) }
  }
  return (
    <div className="ob-stack">
      <div className="ob-cards">
        <Stat label="Actual hours" value={Number(summary?.actual_hours || 0).toFixed(1)} />
        <Stat label="Expected hours" value={project.expected_hours != null ? Number(project.expected_hours).toFixed(1) : '—'} />
      </div>
      <div className="ob-card">
        <h3>Log hours</h3>
        <div className="ob-row">
          <label>Date <input type="date" value={form.workDate} onChange={(event) => setForm({ ...form, workDate: event.target.value })} /></label>
          <label>Hours <input type="number" min="0.25" step="0.25" value={form.hours} onChange={(event) => setForm({ ...form, hours: event.target.value })} /></label>
          <label>Work
            <select value={form.stage} onChange={(event) => setForm({ ...form, stage: event.target.value })}>
              <option value="">General</option>
              <option value="assessment">Assessment</option><option value="scanning">Scanning</option><option value="verification">Verification</option><option value="pricing">Pricing</option><option value="approval">Approval</option><option value="qa">Quality checks</option>
            </select>
          </label>
          <label>Note <input value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label>
          <button type="button" className="primary" onClick={add} disabled={!(Number(form.hours) > 0)}>Add</button>
        </div>
        {error ? <p className="ob-error">{error}</p> : null}
      </div>
      <table className="ob-table">
        <thead><tr><th>Date</th><th>Hours</th><th>Work</th><th>Note</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}><td>{row.work_date}</td><td>{Number(row.hours).toFixed(2)}</td><td>{row.stage || 'General'}</td><td>{row.note || ''}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

// ── Staff permissions ───────────────────────────────────────────────────────
function StaffPanel({ project, staff, onChanged }) {
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  async function toggle(person, key, value) {
    setError(''); setMessage('')
    try { await setStaffPermissions(project.store_id, person.id, { ...person.permissions, [key]: value }); setMessage(`Saved for ${person.name}.`); onChanged() } catch (err) { setError(err.message) }
  }
  return (
    <div className="ob-card">
      <h3>Who can do what</h3>
      <p className="ob-muted">Owners and managers can do every step. Other staff need the step turned on. Only people with employee management can change this. NORDVIK oversees the project, but stock only goes on sale when the retailer approves it.</p>
      {error ? <p className="ob-error">{error}</p> : null}
      {message ? <p className="ob-message">{message}</p> : null}
      <table className="ob-table">
        <thead><tr><th>Employee</th>{ONBOARDING_PERMISSIONS.map(([key, name, help]) => <th key={key} title={help}>{name}</th>)}</tr></thead>
        <tbody>{staff.map((person) => {
          const boss = ['owner', 'manager'].includes(String(person.role || '').toLowerCase())
          return (
            <tr key={person.id}><td><strong>{person.name}</strong><small>{person.role}</small></td>
              {ONBOARDING_PERMISSIONS.map(([key]) => <td key={key}><input type="checkbox" checked={Boolean(person.permissions?.[key])} disabled={boss} title={boss ? 'Owners and managers can always do this' : ''} onChange={(event) => toggle(person, key, event.target.checked)} /></td>)}
            </tr>
          )
        })}</tbody>
      </table>
      {!staff.length ? <p className="ob-muted">No active staff found for this store.</p> : null}
    </div>
  )
}

// ── History ─────────────────────────────────────────────────────────────────
function HistoryPanel({ project }) {
  const [events, setEvents] = useState(null)
  const [batches, setBatches] = useState([])
  useEffect(() => {
    projectEvents(project.id, { limit: 500 }).then(setEvents).catch(() => setEvents([]))
    loadBatches(project.id).then(setBatches).catch(() => setBatches([]))
  }, [project.id])
  return (
    <div className="ob-stack">
      <div className="ob-card">
        <h3><ClipboardCheck size={16} /> Batches</h3>
        <table className="ob-table">
          <thead><tr><th>Batch</th><th>Source</th><th>Items</th><th>Added</th></tr></thead>
          <tbody>{batches.map((batch) => <tr key={batch.id}><td>{batch.label || batch.file_name || 'Batch'}</td><td>{batch.source}</td><td>{fmt(batch.item_count)}</td><td>{when(batch.created_at)}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="ob-card">
        <h3>Audit history</h3>
        {events === null ? <p className="ob-muted">Loading…</p> : <ul className="ob-history">{events.map((event) => <li key={event.id}><HistoryLine event={event} showItem /></li>)}</ul>}
      </div>
    </div>
  )
}
