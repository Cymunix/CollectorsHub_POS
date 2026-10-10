import React, { useEffect, useState } from 'react'
import { AlertTriangle, ArrowLeft, Camera, CheckCircle2, ImagePlus, Package, Plus, Printer, Search, Trash2, X } from 'lucide-react'
import { CUSTODY_STATUS, JOB_STATUS, addContainer, cancelJob, createJob, finaliseImport, intakePhotoUrls, listJobs, recordReceipt, recordReturn, setJobStatus, uploadIntakePhotos } from '../lib/collectionScanning'
import { CameraCapture } from '../identity/IdentityWizard'
import { AuthBadge, AuthorisationPanel, CollectorCard, CollectorPicker, ImportDialog, JobScanner, ProgressStrip, ReviewItems, clearImportKey, importKey, useJob } from './collectorParts'
import { printContainerLabels, printIntakeReceipt } from './print'

// Collection Drop-Off: a collector leaves a collection; the store scans it over
// several sessions, adds it to their collection under the job's authorisation,
// and hands it back. Physical custody is tracked separately from scanning.

const CATEGORIES = ['Sports Cards', 'Trading Cards']
const CONTAINER_KINDS = [['box', 'Box'], ['binder', 'Binder'], ['case', 'Case'], ['bag', 'Bag'], ['other', 'Other']]
const when = (value) => (value ? new Date(value).toLocaleString() : '—')
const day = (value) => (value ? new Date(value).toLocaleDateString() : '—')

export default function DropOff({ session, queues, onSaveQueue }) {
  const [view, setView] = useState({ name: 'list' })
  if (view.name === 'new') return <NewIntake session={session} onCancel={() => setView({ name: 'list' })} onOpen={(jobId) => setView({ name: 'job', jobId })} />
  if (view.name === 'job') return <JobWorkspace session={session} jobId={view.jobId} initialTab={view.tab} initialModal={view.modal} queues={queues} onSaveQueue={onSaveQueue} onBack={() => setView({ name: 'list' })} />
  return <Dashboard session={session} onNew={() => setView({ name: 'new' })} onOpen={(jobId, tab, modal) => setView({ name: 'job', jobId, tab, modal })} />
}

// The main action for a job, by status (Resume Scanning first while it's being processed).
function primaryAction(row) {
  if (row.status === 'pending_authorisation') return { label: 'View Intake', tab: 'overview' }
  if (row.status === 'needs_review') return { label: 'Review Items', tab: 'review' }
  if (row.status === 'ready_to_finalise') return { label: 'Finalise Import', tab: 'overview', modal: 'import' }
  if (row.status === 'ready_for_collection') return { label: 'Record Return', tab: 'overview', modal: 'return' }
  if (['received', 'scanning', 'paused', 'awaiting_intake'].includes(row.status) && row.authorisation_status === 'approved') return { label: 'Resume Scanning', tab: 'scanning' }
  return { label: 'View Intake', tab: 'overview' }
}

function Dashboard({ session, onNew, onOpen }) {
  const [filter, setFilter] = useState('active')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState(null)
  const [problem, setProblem] = useState('')
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      listJobs(session.storeId, { kind: 'dropoff', filter, search })
        .then((data) => { if (!cancelled) { setRows(data || []); setProblem('') } })
        .catch((error) => { if (!cancelled) { setRows([]); setProblem(error?.message || String(error)) } })
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [session.storeId, filter, search])
  const emptyHeading = search ? 'No drop-offs match your search' : { active: 'No active collection drop-offs', pending: 'No drop-offs waiting for approval', completed: 'No completed drop-offs yet', cancelled: 'No cancelled drop-offs', all: 'No collection drop-offs yet' }[filter]
  return (
    <div className="cs-panel">
      <div className="cs-row-between">
        <div><h3>Collection Drop-Off</h3><p className="cs-muted">Manage customer collections received for scanning, from intake to return.</p></div>
        <button type="button" className="gold-button" onClick={onNew}><Plus size={15} /> New Intake</button>
      </div>
      <div className="cs-row-between">
        <div className="cs-tabs small">
          {[['active', 'Active'], ['pending', 'Pending'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([value, label]) => <button type="button" key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        <label className="cs-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Collector or intake reference" /></label>
      </div>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      {rows === null ? <p className="cs-muted">Loading…</p> : !rows.length ? (
        <div className="cs-empty"><Package size={30} /><strong>{emptyHeading}</strong><span>Collections received for scanning will appear here.</span></div>
      ) : (
        <div className="cs-table-wrap">
          <table className="cs-table cs-jobs">
            <thead><tr><th>Reference</th><th>Collector</th><th>Containers</th><th>Estimated</th><th>Scanned</th><th>Review</th><th>Intake date</th><th>Status</th><th>Assigned</th><th>Last activity</th><th /></tr></thead>
            <tbody>
              {rows.map((row) => {
                const action = primaryAction(row)
                return (
                  <tr key={row.id}>
                    <td><button type="button" className="cs-linkish" onClick={() => onOpen(row.id, 'overview')}>{row.reference}</button></td>
                    <td>{row.collector_name}<small>@{row.collector_username}</small></td>
                    <td>{row.container_count ?? '—'}</td>
                    <td>{row.estimated_items != null ? `~${row.estimated_items}` : '—'}</td>
                    <td>{row.scanned}</td>
                    <td>{row.needs_review ? <span className="cs-pill needs_review">{row.needs_review}</span> : '—'}</td>
                    <td>{day(row.received_at || row.created_at)}</td>
                    <td><span className={`cs-pill ${row.status}`}>{JOB_STATUS[row.status] || row.status}</span></td>
                    <td>{row.assigned_employee_name || '—'}</td>
                    <td>{day(row.last_activity_at)}</td>
                    <td className="cs-row-actions"><button type="button" className={action.label === 'Resume Scanning' ? 'gold-button' : ''} onClick={() => onOpen(row.id, action.tab, action.modal)}>{action.label}</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── New Intake (5 steps) ──────────────────────────────────────────────────
const STEPS = ['Collector', 'Collection', 'Authorisation', 'Handover', 'Done']

function NewIntake({ session, onCancel, onOpen }) {
  const [step, setStep] = useState(0)
  const [collector, setCollector] = useState(null)
  const [form, setForm] = useState({ categories: ['Sports Cards'], estimated_items: '', handling_instructions: '', customer_notes: '', contact: '', expected_completion: '', terms: '' })
  const [containers, setContainers] = useState([{ kind: 'box', description: '', condition_notes: '', estimated_items: '' }])
  const [photos, setPhotos] = useState([])
  const [camera, setCamera] = useState(false)
  const [jobId, setJobId] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const { data, reload } = useJob(jobId)
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const setContainer = (index, key, value) => setContainers((current) => current.map((container, at) => (at === index ? { ...container, [key]: value } : container)))
  const containerEstimate = containers.reduce((sum, container) => sum + (Number(container.estimated_items) || 0), 0)

  async function addFiles(files) {
    const read = await Promise.all([...files].slice(0, 12).map((file) => new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(file) })))
    setPhotos((current) => [...current, ...read].slice(0, 12))
  }

  // Step 2 -> 3: create the job (reference, container codes, authorisation request).
  async function createIntake() {
    setBusy(true)
    setProblem('')
    try {
      const created = await createJob(session.storeId, session.locationId, collector.id, 'dropoff', {
        categories: form.categories,
        estimated_items: form.estimated_items === '' ? (containerEstimate || null) : Number(form.estimated_items),
        handling_instructions: form.handling_instructions,
        customer_notes: form.customer_notes,
        contact: form.contact.trim() ? { note: form.contact.trim() } : {},
        expected_completion: form.expected_completion || null,
        terms: form.terms,
        containers: containers.map((container) => ({ ...container, estimated_items: container.estimated_items === '' ? null : Number(container.estimated_items) })),
      })
      if (photos.length) await uploadIntakePhotos(session.storeId, created.job_id, photos).catch((photoError) => setProblem(`Intake created; ${photoError.message}`))
      setJobId(created.job_id)
      setStep(2)
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  const [ack, setAck] = useState('')
  async function confirmHandover() {
    setBusy(true)
    setProblem('')
    try { await recordReceipt(jobId, ack.trim()); await reload(); setStep(4) } catch (error) { setProblem(error?.message || String(error)) } finally { setBusy(false) }
  }

  return (
    <div className="cs-panel">
      <div className="cs-row-between">
        <div><h3>New Intake</h3><p className="cs-muted">{data ? `Intake ${data.job.reference}` : 'Record a collection left with the store for scanning.'}</p></div>
        <button type="button" onClick={onCancel}><ArrowLeft size={15} /> {jobId ? 'Back to drop-offs' : 'Cancel'}</button>
      </div>
      <ol className="cs-steps">{STEPS.map((label, index) => <li key={label} className={index < step ? 'done' : index === step ? 'current' : ''}><span>{index < step ? <CheckCircle2 size={14} /> : index + 1}</span>{label}</li>)}</ol>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}

      {step === 0 ? (
        <div className="cs-step">
          {collector ? (
            <CollectorCard collector={collector} status="not_requested" onChange={() => setCollector(null)}>
              <button type="button" className="gold-button" onClick={() => setStep(1)}>This is the right collector</button>
            </CollectorCard>
          ) : <CollectorPicker storeId={session.storeId} onPick={setCollector} />}
        </div>
      ) : null}

      {step === 1 ? (
        <div className="cs-step">
          <div className="cs-form-grid">
            <fieldset className="cs-checks"><legend>Categories</legend>{CATEGORIES.map((category) => <label key={category}><input type="checkbox" checked={form.categories.includes(category)} onChange={(event) => setForm((current) => ({ ...current, categories: event.target.checked ? [...current.categories, category] : current.categories.filter((item) => item !== category) }))} /> {category}</label>)}</fieldset>
            <label><span>Estimated items (an estimate, not a count)</span><input type="number" min="0" value={form.estimated_items} onChange={set('estimated_items')} placeholder={containerEstimate ? `~${containerEstimate} from containers` : 'e.g. 5000'} /></label>
            <label><span>Expected completion (if agreed)</span><input type="date" value={form.expected_completion} onChange={set('expected_completion')} /></label>
          </div>
          <h4>Containers <small className="cs-muted">each gets its own tracking code</small></h4>
          <div className="cs-containers">
            {containers.map((container, index) => (
              <div className="cs-container-row" key={index}>
                <select value={container.kind} onChange={(event) => setContainer(index, 'kind', event.target.value)}>{CONTAINER_KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                <input value={container.description} onChange={(event) => setContainer(index, 'description', event.target.value)} placeholder="Description (e.g. red shoebox)" />
                <input value={container.condition_notes} onChange={(event) => setContainer(index, 'condition_notes', event.target.value)} placeholder="Container condition" />
                <input type="number" min="0" value={container.estimated_items} onChange={(event) => setContainer(index, 'estimated_items', event.target.value)} placeholder="~items" />
                <button type="button" onClick={() => setContainers((current) => current.filter((_, at) => at !== index))} disabled={containers.length === 1} aria-label="Remove container"><Trash2 size={15} /></button>
              </div>
            ))}
            <button type="button" onClick={() => setContainers((current) => [...current, { kind: 'box', description: '', condition_notes: '', estimated_items: '' }])}><Plus size={15} /> Add container</button>
          </div>
          <div className="cs-form-grid">
            <label className="wide"><span>Handling instructions</span><input value={form.handling_instructions} onChange={set('handling_instructions')} placeholder="e.g. keep binder pages in order" /></label>
            <label className="wide"><span>Customer notes</span><input value={form.customer_notes} onChange={set('customer_notes')} /></label>
            <label className="wide"><span>Contact for this job (only what the collector agrees to)</span><input value={form.contact} onChange={set('contact')} placeholder="e.g. text 902-555-0101 when ready" /></label>
            <label className="wide"><span>Terms and charges (printed on the receipt)</span><textarea rows={2} value={form.terms} onChange={set('terms')} placeholder="Leave blank for the standard wording (no charge unless written here)" /></label>
          </div>
          <h4>Photos <small className="cs-muted">optional, kept with the store's intake record</small></h4>
          <div className="cs-photos">
            {photos.map((photo, index) => <figure key={index}><img src={photo} alt="" /><button type="button" onClick={() => setPhotos((current) => current.filter((_, at) => at !== index))} aria-label="Remove photo"><X size={13} /></button></figure>)}
            <label className="cs-photo-add"><ImagePlus size={18} /> Add photos<input type="file" accept="image/*" multiple hidden onChange={(event) => { addFiles(event.target.files); event.target.value = '' }} /></label>
            <button type="button" className="cs-photo-add" onClick={() => setCamera(true)}><Camera size={18} /> Take photo</button>
          </div>
          {camera ? (
            <div className="register-modal" role="dialog" aria-modal="true"><section className="cs-camera">
              <button className="modal-close" type="button" onClick={() => setCamera(false)} aria-label="Close"><X size={18} /></button>
              <CameraCapture purpose="document" title="Photograph the collection" hint="Show the containers as they were handed over." onConfirm={(shot) => { setPhotos((current) => [...current, shot].slice(0, 12)); setCamera(false) }} />
            </section></div>
          ) : null}
          <div className="cs-actions"><button type="button" onClick={() => setStep(0)}>Back</button><button type="button" className="gold-button" disabled={busy || !form.categories.length} onClick={createIntake}>{busy ? 'Creating…' : 'Create intake and request authorisation'}</button></div>
        </div>
      ) : null}

      {step === 2 && data ? (
        <div className="cs-step">
          <CollectorCard collector={data.collector} status={data.authorisation?.status} />
          <AuthorisationPanel jobId={jobId} authorisation={data.authorisation} kind="dropoff" onChange={reload} />
          <p className="cs-muted">The collector can approve now or later; scanning starts once they do.</p>
          <div className="cs-actions"><button type="button" className="gold-button" onClick={() => setStep(3)}>Continue to handover</button></div>
        </div>
      ) : null}

      {step === 3 && data ? (
        <div className="cs-step">
          <h4>Confirm what's being handed over</h4>
          <table className="cs-table">
            <thead><tr><th>Code</th><th>Container</th><th>Condition</th><th>Items</th></tr></thead>
            <tbody>{data.containers.map((container) => <tr key={container.id}><td><strong>{container.code}</strong></td><td>{container.kind}{container.description ? ` · ${container.description}` : ''}</td><td>{container.condition_notes || '—'}</td><td>{container.estimated_items != null ? `about ${container.estimated_items} (estimate)` : '—'}</td></tr>)}</tbody>
          </table>
          <p className="cs-muted">{data.job.estimated_items != null ? `About ${data.job.estimated_items} items in total, as estimated at drop-off. The verified count comes from scanning.` : 'No item estimate given; the verified count comes from scanning.'} Received by you at {data.location?.name || 'this store'}.</p>
          <label className="cs-field"><span>Collector: type your name to acknowledge the handover</span><input value={ack} onChange={(event) => setAck(event.target.value)} /></label>
          <div className="cs-actions">
            <button type="button" onClick={() => setStep(4)}>Collection not handed over yet</button>
            <button type="button" className="gold-button" disabled={busy || ack.trim().length < 2} onClick={confirmHandover}>{busy ? 'Saving…' : 'Confirm handover'}</button>
          </div>
        </div>
      ) : null}

      {step === 4 && data ? (
        <div className="cs-done">
          <CheckCircle2 size={40} />
          <h3>Intake {data.job.reference} created</h3>
          <p>{data.job.custody_status === 'in_store' ? `Received ${when(data.job.received_at)}.` : 'Waiting for the collection to be handed over.'} It's saved in Collection Drop-Off and stays there after the POS closes.</p>
          <div className="cs-actions center">
            <button type="button" onClick={() => printIntakeReceipt(data)}><Printer size={15} /> Print intake receipt</button>
            <button type="button" onClick={() => printContainerLabels(data)}><Printer size={15} /> Print container labels</button>
            <button type="button" className="gold-button" onClick={() => onOpen(jobId)}>Open the job</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ── Job workspace ─────────────────────────────────────────────────────────
function JobWorkspace({ session, jobId, initialTab = 'overview', initialModal = '', queues, onSaveQueue, onBack }) {
  const { data, problem, reload } = useJob(jobId)
  const [tab, setTab] = useState(initialTab || 'overview')
  const [modal, setModal] = useState(initialModal || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [photoUrls, setPhotoUrls] = useState([])
  useEffect(() => { if (data?.job?.photo_paths?.length) intakePhotoUrls(data.job.photo_paths).then(setPhotoUrls) }, [data?.job?.photo_paths?.length])
  if (!data) return <div className="cs-panel">{problem ? <p className="cs-error">{problem}</p> : <p className="cs-muted">Loading…</p>}</div>
  const { job, collector, authorisation, containers, counts, events } = data
  const approved = authorisation?.status === 'approved'
  const closed = ['completed', 'cancelled'].includes(job.status)
  const canScan = approved && !closed && !['importing', 'ready_for_collection'].includes(job.status)

  async function act(action) {
    setBusy(true)
    setError('')
    try { await action(); await reload(); return true } catch (actionError) { setError(actionError?.message || String(actionError)); return false } finally { setBusy(false) }
  }

  return (
    <div className="cs-panel">
      <div className="cs-job-head">
        <div>
          <button type="button" className="cs-back" onClick={onBack}><ArrowLeft size={15} /> All drop-offs</button>
          <p className="cs-kicker">Collection Drop-Off · {job.reference}</p>
          <CollectorCard collector={collector} status={authorisation?.status || 'missing'} />
        </div>
        <div className="cs-status-block">
          <span className={`cs-pill ${job.status}`}>{JOB_STATUS[job.status]}</span>
          <small>Custody: <b>{CUSTODY_STATUS[job.custody_status]}</b></small>
        </div>
      </div>
      {!approved ? <AuthorisationPanel jobId={job.id} authorisation={authorisation} kind="dropoff" onChange={reload} /> : null}
      {error ? <p className="cs-error"><AlertTriangle size={14} /> {error}</p> : null}

      <div className="cs-tabs">
        {[['overview', 'Overview'], ['scanning', 'Scanning'], ['review', `Needs Review${counts.needs_review ? ` (${counts.needs_review})` : ''}`], ['history', 'History']].map(([value, label]) => <button type="button" key={value} className={tab === value ? 'active' : ''} onClick={() => { setTab(value); reload() }}>{label}</button>)}
      </div>

      {tab === 'overview' ? (
        <div className="cs-overview">
          <ProgressStrip counts={counts} estimate={job.estimated_items} />
          {approved ? <AuthorisationPanel jobId={job.id} authorisation={authorisation} kind="dropoff" onChange={reload} /> : null}
          <div className="cs-actions left">
            {canScan ? <button type="button" className="gold-button" onClick={() => setTab('scanning')}>Resume Scanning</button> : null}
            {job.custody_status === 'not_received' && !closed ? <button type="button" className="gold-button" onClick={() => setModal('receive')}>Confirm handover</button> : null}
            {counts.ready && !closed && approved ? <button type="button" onClick={() => { setError(''); setModal('import') }}>Finalise Import</button> : null}
            {['in_store', 'partially_returned'].includes(job.custody_status) ? <button type="button" onClick={() => setModal('return')}>Record Return</button> : null}
            <button type="button" onClick={() => printIntakeReceipt(data)}><Printer size={15} /> Print Receipt</button>
            <button type="button" onClick={() => printContainerLabels(data)} disabled={!containers.length}><Printer size={15} /> Labels</button>
            {['scanning', 'received'].includes(job.status) ? <button type="button" onClick={() => act(() => setJobStatus(job.id, 'paused'))}>Pause</button> : null}
            {['scanning', 'paused', 'needs_review', 'received'].includes(job.status) ? <button type="button" onClick={() => act(() => setJobStatus(job.id, 'ready_to_finalise'))}>Scanning finished</button> : null}
            {!closed && !['in_store', 'partially_returned'].includes(job.custody_status) ? <button type="button" onClick={() => setModal('cancel')}>Cancel job</button> : null}
          </div>
          <div className="cs-overview-grid">
            <dl className="cs-facts">
              <dt>Intake reference</dt><dd>{job.reference}</dd>
              <dt>Authorisation</dt><dd><AuthBadge status={authorisation?.status || 'missing'} /></dd>
              <dt>Location</dt><dd>{data.location?.name || '—'}</dd>
              <dt>Received</dt><dd>{when(job.received_at)}{job.received_acknowledged_by ? ` · acknowledged by ${job.received_acknowledged_by}` : ''}</dd>
              <dt>Categories</dt><dd>{(job.categories || []).join(', ') || '—'}</dd>
              <dt>Handling</dt><dd>{job.handling_instructions || '—'}</dd>
              <dt>Customer notes</dt><dd>{job.customer_notes || '—'}</dd>
              <dt>Contact</dt><dd>{job.contact?.note || '—'}</dd>
              <dt>Expected completion</dt><dd>{job.expected_completion || '—'}</dd>
            </dl>
            {photoUrls.length ? <div className="cs-photos view">{photoUrls.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer"><img src={url} alt="Drop-off" /></a>)}</div> : null}
          </div>
          <h4>Containers</h4>
          <table className="cs-table">
            <thead><tr><th>Code</th><th>Container</th><th>Condition at drop-off</th><th>Estimate</th><th>Custody</th></tr></thead>
            <tbody>{containers.map((container) => <tr key={container.id}><td><strong>{container.code}</strong></td><td>{container.kind}{container.description ? ` · ${container.description}` : ''}</td><td>{container.condition_notes || '—'}</td><td>{container.estimated_items != null ? `~${container.estimated_items}` : '—'}</td><td>{container.returned_at ? `Returned ${day(container.returned_at)}` : job.custody_status === 'not_received' ? 'Not received' : 'Held by the store'}</td></tr>)}</tbody>
          </table>
          {!closed ? <button type="button" onClick={() => setModal('container')}><Plus size={15} /> Add container</button> : null}
        </div>
      ) : null}

      {tab === 'scanning' ? (
        <>
          <ProgressStrip counts={counts} estimate={job.estimated_items} />
          {canScan
            ? <JobScanner session={session} job={job} containers={containers.filter((container) => !container.returned_at)} queues={queues} onSaveQueue={onSaveQueue} onChanged={reload} />
            : <div className="cs-empty small"><AlertTriangle size={22} /><strong>{approved ? `Scanning isn't open while the job is ${JOB_STATUS[job.status].toLowerCase()}` : 'Scanning needs the collector\'s authorisation'}</strong></div>}
        </>
      ) : null}
      {tab === 'review' ? <ReviewItems jobId={job.id} containers={containers} editable={!closed && job.status !== 'importing'} onChanged={reload} /> : null}
      {tab === 'history' ? (
        <ul className="cs-history">
          {(events || []).map((event) => <li key={event.id}><span>{when(event.created_at)}</span><strong>{event.action.replace(/_/g, ' ')}</strong><small>{event.actor_type === 'collector' ? 'Collector' : event.employee_name || event.actor_type}{event.detail?.reason ? ` · ${event.detail.reason}` : ''}{event.detail?.recipient ? ` · to ${event.detail.recipient}` : ''}{event.detail?.acknowledged_by ? ` · signed ${event.detail.acknowledged_by}` : ''}{event.detail?.discrepancies ? ` · ${event.detail.discrepancies}` : ''}{event.detail?.copies != null ? ` · ${event.detail.copies} items` : ''}</small></li>)}
        </ul>
      ) : null}

      {modal === 'import' ? <ImportDialog jobId={job.id} collectorName={collector.name} busy={busy} error={error} onCancel={() => setModal('')} onConfirm={async (leaveOut) => { const ok = await act(async () => { await finaliseImport(job.id, importKey(job.id), leaveOut); clearImportKey(job.id) }); if (ok) setModal('') }} /> : null}
      {modal === 'receive' ? <ConfirmName title="Confirm handover" text={`Check the ${containers.length} container${containers.length === 1 ? '' : 's'} against the list. The collector types their name to acknowledge; your name, this store and the time are recorded.`} label="Collector's name" action="Confirm handover" onCancel={() => setModal('')} onConfirm={(name) => act(async () => { await recordReceipt(job.id, name); setModal('') })} /> : null}
      {modal === 'return' ? <ReturnDialog containers={containers.filter((container) => !container.returned_at)} onCancel={() => setModal('')} onConfirm={(ids, name, notes) => act(async () => { await recordReturn(job.id, ids, name, notes); setModal('') })} /> : null}
      {modal === 'cancel' ? <ConfirmName title="Cancel this job" text="Records stay; nothing more can be scanned or added." label="Reason" action="Cancel job" onCancel={() => setModal('')} onConfirm={(reason) => act(async () => { await cancelJob(job.id, reason); setModal('') })} /> : null}
      {modal === 'container' ? <AddContainerDialog onCancel={() => setModal('')} onConfirm={(values) => act(async () => { await addContainer(job.id, values); setModal('') })} /> : null}
    </div>
  )
}

function ConfirmName({ title, text, label, action, onCancel, onConfirm }) {
  const [value, setValue] = useState('')
  return (
    <div className="register-modal" role="dialog" aria-modal="true"><section>
      <h2>{title}</h2><p>{text}</p>
      <label className="cs-field"><span>{label}</span><input autoFocus value={value} onChange={(event) => setValue(event.target.value)} /></label>
      <div className="modal-actions"><button type="button" onClick={onCancel}>Back</button><button type="button" className="gold-button" disabled={value.trim().length < 2} onClick={() => onConfirm(value.trim())}>{action}</button></div>
    </section></div>
  )
}

// Return: tick what goes back; anything not ticked stays held. Note missing or damaged containers.
function ReturnDialog({ containers, onCancel, onConfirm }) {
  const [selected, setSelected] = useState(() => containers.map((container) => container.id))
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const kept = containers.filter((container) => !selected.includes(container.id))
  return (
    <div className="register-modal" role="dialog" aria-modal="true"><section>
      <h2>Record Return</h2>
      <p>Tick the containers handed back now. The date and time, and your name, are recorded.</p>
      <div className="cs-checks">{containers.map((container) => <label key={container.id}><input type="checkbox" checked={selected.includes(container.id)} onChange={(event) => setSelected((current) => (event.target.checked ? [...current, container.id] : current.filter((id) => id !== container.id)))} /> {container.code}{container.description ? ` · ${container.description}` : ''}</label>)}</div>
      {kept.length ? <p className="cs-warn">{kept.length} container{kept.length === 1 ? '' : 's'} not ticked will stay with the store, and the job stays open.</p> : null}
      <label className="cs-field"><span>Missing or damaged containers, or other issues (optional)</span><textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      <label className="cs-field"><span>Person collecting: type your name to acknowledge</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <div className="modal-actions"><button type="button" onClick={onCancel}>Back</button><button type="button" className="gold-button" disabled={!selected.length || name.trim().length < 2} onClick={() => onConfirm(selected, name.trim(), notes)}>Record Return</button></div>
    </section></div>
  )
}

function AddContainerDialog({ onCancel, onConfirm }) {
  const [values, setValues] = useState({ kind: 'box', description: '', conditionNotes: '', estimatedItems: '' })
  const set = (key) => (event) => setValues((current) => ({ ...current, [key]: event.target.value }))
  return (
    <div className="register-modal" role="dialog" aria-modal="true"><section>
      <h2>Add container</h2>
      <label className="cs-field"><span>Type</span><select value={values.kind} onChange={set('kind')}>{CONTAINER_KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="cs-field"><span>Description</span><input value={values.description} onChange={set('description')} /></label>
      <label className="cs-field"><span>Condition</span><input value={values.conditionNotes} onChange={set('conditionNotes')} /></label>
      <label className="cs-field"><span>Estimated items</span><input type="number" min="0" value={values.estimatedItems} onChange={set('estimatedItems')} /></label>
      <div className="modal-actions"><button type="button" onClick={onCancel}>Back</button><button type="button" className="gold-button" onClick={() => onConfirm({ ...values, estimatedItems: values.estimatedItems === '' ? null : Number(values.estimatedItems) })}>Add</button></div>
    </section></div>
  )
}
