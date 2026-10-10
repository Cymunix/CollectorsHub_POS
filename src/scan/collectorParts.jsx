import React, { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { AlertTriangle, Ban, CheckCircle2, Clock3, QrCode, RefreshCw, Search, ShieldQuestion, UserRound, X, XCircle } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import StoreScanIntake, { CatalogueSearchDialog } from '../StoreScanIntake'
import { CARD_CONDITIONS } from '../lib/storeScan'
import { approvalLink, importPreview, loadJob, loadJobItems, memberQueryFrom, requestAuthorisation, saveScannedCard, updateItem } from '../lib/collectionScanning'

// Shared pieces of Scan Centre -> Collector Collection.

// Find a collector: username, membership ID, or a membership QR read by a USB
// scanner (it types into the box; a profile link works too). Finding someone
// grants nothing: they still approve on their own account.
export function CollectorPicker({ storeId, onPick }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [qrMode, setQrMode] = useState(false)
  const inputRef = useRef(null)
  const term = memberQueryFrom(query)
  useEffect(() => {
    if (term.length < 2 || !storeId) { setResults([]); return undefined }
    let cancelled = false
    setBusy(true)
    const timer = setTimeout(async () => {
      const { data, error } = await supabase.rpc('search_store_credit_profiles', { p_store_id: storeId, p_query: term })
      if (cancelled) return
      setBusy(false)
      if (error) { setProblem(error.message); setResults([]); return }
      setProblem('')
      const rows = data || []
      setResults(rows)
      // A scanned QR that matches exactly one member picks them straight away (still needs their approval).
      if (qrMode && rows.length === 1) { setQrMode(false); onPick(toCollector(rows[0])) }
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [term, storeId])
  return (
    <div className="cs-picker">
      <div className="cs-picker-bar">
        <label className="cs-search wide"><Search size={16} /><input ref={inputRef} autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Username, membership ID or scan a membership QR" /></label>
        <button type="button" className={qrMode ? 'active' : ''} onClick={() => { setQrMode(true); setQuery(''); inputRef.current?.focus() }} title="Scan the collector's membership QR with the barcode scanner"><QrCode size={16} /> Scan QR</button>
      </div>
      {qrMode ? <p className="cs-hint"><QrCode size={14} /> Ready: scan the membership QR code now.</p> : null}
      {busy ? <p className="cs-muted">Searching…</p> : null}
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      {!busy && term.length >= 2 && !results.length && !problem ? <p className="cs-muted">No CollectorsHub account matches “{term}”.</p> : null}
      {results.length ? (
        <div className="cs-picker-results">
          {results.map((row) => (
            <button type="button" key={row.id} onClick={() => onPick(toCollector(row))}>
              {row.avatar_url ? <img src={row.avatar_url} alt="" /> : <span className="cs-avatar"><UserRound size={18} /></span>}
              <span><strong>{row.display_name || row.username}</strong><small>@{row.username}</small></span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
const toCollector = (row) => ({ id: row.id, username: row.username, name: row.display_name || row.username, avatarUrl: row.avatar_url || '' })

export function CollectorBadge({ collector }) {
  if (!collector) return null
  return (
    <span className="cs-collector">
      {collector.avatarUrl || collector.avatar_url ? <img src={collector.avatarUrl || collector.avatar_url} alt="" /> : <span className="cs-avatar"><UserRound size={18} /></span>}
      <span><strong>{collector.name}</strong><small>@{collector.username}</small></span>
    </span>
  )
}

// Selected collector: who they are and where authorisation stands.
export function CollectorCard({ collector, status = 'not_requested', onChange, children }) {
  return (
    <div className="cs-collector-card">
      {collector.avatarUrl || collector.avatar_url ? <img src={collector.avatarUrl || collector.avatar_url} alt="" /> : <span className="cs-avatar large"><UserRound size={28} /></span>}
      <div className="cs-collector-card-body">
        <strong>{collector.name}</strong>
        <small>@{collector.username} · CollectorsHub member</small>
        <AuthBadge status={status} />
      </div>
      <div className="cs-collector-card-actions">
        {children}
        {onChange ? <button type="button" onClick={onChange}>Change collector</button> : null}
      </div>
    </div>
  )
}

const AUTH = {
  not_requested: { label: 'Not requested', tone: 'neutral', Icon: ShieldQuestion },
  missing: { label: 'Not requested', tone: 'neutral', Icon: ShieldQuestion },
  pending: { label: 'Pending approval', tone: 'amber', Icon: Clock3 },
  approved: { label: 'Authorised', tone: 'green', Icon: CheckCircle2 },
  declined: { label: 'Declined', tone: 'red', Icon: XCircle },
  expired: { label: 'Expired', tone: 'red', Icon: Clock3 },
  revoked: { label: 'Revoked', tone: 'red', Icon: Ban },
  completed: { label: 'Completed', tone: 'neutral', Icon: CheckCircle2 },
  cancelled: { label: 'Cancelled', tone: 'neutral', Icon: X },
}
export function AuthBadge({ status }) {
  const info = AUTH[status] || AUTH.not_requested
  return <span className={`cs-auth-badge ${info.tone}`}><info.Icon size={13} /> {info.label}</span>
}

function useCountdown(until) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (!until) return undefined; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [until])
  if (!until) return ''
  const left = Math.max(0, new Date(until).getTime() - now)
  const days = Math.floor(left / 86400000)
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'} left`
  const minutes = Math.floor(left / 60000)
  const seconds = Math.floor((left % 60000) / 1000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min left` : `${minutes}:${String(seconds).padStart(2, '0')} left`
}

// The collector approves on their own signed-in account. Pending: QR to the
// approval page, refreshing on its own. Authorised: time left.
export function AuthorisationPanel({ jobId, authorisation, kind, onChange }) {
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState(false)
  const status = authorisation?.status || 'missing'
  const link = authorisation?.id ? approvalLink(authorisation.id) : ''
  const left = useCountdown(status === 'approved' ? authorisation?.expires_at : null)
  useEffect(() => { if (link) QRCode.toDataURL(link, { margin: 1, width: 220, color: { dark: '#0B111B', light: '#FFFFFF' } }).then(setQr).catch(() => setQr('')) }, [link])
  useEffect(() => {
    if (status !== 'pending' && status !== 'approved') return undefined
    const timer = setInterval(() => onChange?.(), status === 'pending' ? 3000 : 30000)
    return () => clearInterval(timer)
  }, [status])
  async function askAgain() {
    setBusy(true)
    try { await requestAuthorisation(jobId); await onChange?.() } finally { setBusy(false) }
  }
  if (status === 'approved') {
    return <p className="cs-auth approved"><CheckCircle2 size={16} /> Authorised by the collector <span className="cs-auth-left">{left}</span></p>
  }
  if (status === 'pending') {
    return (
      <div className="cs-auth pending">
        {qr ? <img src={qr} alt="Approval QR code" /> : null}
        <div>
          <p className="cs-auth-title"><Clock3 size={16} /> Pending approval</p>
          <p>The collector scans this code with their phone, signs in to their own CollectorsHub account and approves.</p>
          <ul className="cs-scope">
            <li>The store may scan and identify {kind === 'express' ? 'the items brought in today' : 'the items in this drop-off'}, and add them to their collection.</li>
            <li>It can't change or remove anything already in their collection.</li>
            <li>{kind === 'express' ? 'Lasts 60 minutes.' : 'Lasts 30 days for this intake only; they can extend or revoke it.'} {kind === 'dropoff' ? 'They don\'t need to stay while it\'s scanned.' : ''}</li>
          </ul>
          <p className="cs-link">{link}</p>
        </div>
      </div>
    )
  }
  const info = AUTH[status] || AUTH.missing
  return (
    <div className={`cs-auth stopped ${status}`}>
      <p className="cs-auth-title"><info.Icon size={16} /> {status === 'missing' ? 'Authorisation not requested' : `Authorisation ${info.label.toLowerCase()}`}</p>
      <p className="cs-muted">{status === 'declined' ? 'The collector declined.' : status === 'revoked' ? 'The collector revoked the store\'s access.' : status === 'expired' ? 'The authorisation ran out.' : ''} Nothing more can be saved or added to their collection until they approve again. Work already done is kept.</p>
      {!['completed', 'cancelled'].includes(status) ? <button type="button" className="gold-button" onClick={askAgain} disabled={busy}><RefreshCw size={15} /> Request authorisation</button> : null}
    </div>
  )
}

// Compact progress during scanning (estimates are never treated as counts).
export function ProgressStrip({ counts, estimate = null }) {
  const pct = estimate ? Math.min(100, Math.round((counts.scanned / Math.max(1, estimate)) * 100)) : null
  return (
    <div className="cs-progress">
      <span><b>{counts.scanned}</b> scanned</span>
      <span><b>{counts.recognised}</b> recognised</span>
      <span className={counts.needs_review ? 'look' : ''}><b>{counts.needs_review}</b> need review</span>
      <span className="done"><b>{counts.imported}</b> in collection</span>
      {estimate ? (
        <span className="cs-progress-estimate" title="Progress against the collector's estimate, not a verified count">
          <i style={{ width: `${pct}%` }} /> about {pct}% of the estimated {estimate}
        </span>
      ) : null}
    </div>
  )
}

// The shared scanner, saving cards to a job (optionally into one container).
export function JobScanner({ session, job, containers = [], queues, onSaveQueue, onChanged }) {
  const [containerId, setContainerId] = useState(containers[0]?.id || '')
  const containerRef = useRef(containerId)
  containerRef.current = containerId
  const queueKey = `${job.id}:${containerId || 'all'}`
  const controls = containers.length ? (
    <label>Container
      <select value={containerId} onChange={(event) => setContainerId(event.target.value)}>
        {containers.map((container) => <option key={container.id} value={container.id}>{container.code}{container.description ? ` · ${container.description}` : ''}</option>)}
        <option value="">No container</option>
      </select>
    </label>
  ) : null
  return (
    <StoreScanIntake
      key={queueKey}
      session={session}
      savedQueue={queues?.[queueKey] || []}
      onSaveQueue={(queue) => onSaveQueue(queueKey, queue)}
      destination={{
        kicker: `Collector Collection · ${job.reference}`,
        title: 'Scan Cards into the Collector\'s Collection',
        description: 'Identified cards are saved to this job. They\'re added to the collection only when you choose Add to Collection; store stock is never changed.',
        addedLabel: 'Saved to the job',
        toLabel: `to ${job.reference}`,
        controls,
        add: (card) => saveScannedCard(job.id, containerRef.current || null, card),
        onChanged,
      }}
    />
  )
}

const ITEM_STATUS = { draft: 'Ready', needs_review: 'Needs review', excluded: 'Left out', imported: 'In collection' }

// Draft entries: fix the catalogue match, condition or quantity, or leave one out.
export function ReviewItems({ jobId, containers = [], editable = true, onChanged, initialFilter = 'needs_review' }) {
  const [filter, setFilter] = useState(initialFilter)
  const [items, setItems] = useState(null)
  const [searching, setSearching] = useState(null)
  const [problem, setProblem] = useState('')
  async function load() {
    try { setItems(await loadJobItems(jobId, { status: filter || null, limit: 500 })) } catch (error) { setProblem(error?.message || String(error)); setItems([]) }
  }
  useEffect(() => { setItems(null); load() }, [jobId, filter])
  async function change(item, patch) {
    setProblem('')
    try { await updateItem(item.id, patch); await load(); onChanged?.() } catch (error) { setProblem(error?.message || String(error)) }
  }
  const containerCode = (id) => containers.find((container) => container.id === id)?.code || ''
  return (
    <div className="cs-review">
      <div className="cs-tabs small">
        {[['needs_review', 'Needs review'], ['draft', 'Ready'], ['imported', 'In collection'], ['excluded', 'Left out'], ['', 'All']].map(([value, label]) => (
          <button type="button" key={label} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>
        ))}
      </div>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      {items === null ? <p className="cs-muted">Loading…</p> : !items.length ? (
        <div className="cs-empty small"><CheckCircle2 size={22} /><strong>{filter === 'needs_review' ? 'Nothing needs review' : 'Nothing here'}</strong>{filter === 'needs_review' ? <span>Uncertain matches, wrong identifications and missing details show up here.</span> : null}</div>
      ) : (
        <table className="cs-table">
          <thead><tr><th>Item</th><th>Condition</th><th>Qty</th><th>Container</th><th>Status</th><th /></tr></thead>
          <tbody>
            {items.map((item) => {
              const locked = !editable || item.status === 'imported'
              return (
                <tr key={item.id}>
                  <td><strong>{item.name_snapshot || 'Unidentified card'}</strong>{item.identification?.subject && !item.catalog_item_id ? <small>AI read: {[item.identification.subject, item.identification.number ? `#${item.identification.number}` : '', item.identification.year].filter(Boolean).join(' ')}</small> : null}{item.status === 'draft' && !item.condition ? <small className="cs-warn">Condition missing</small> : null}</td>
                  <td>{locked ? item.condition || '—' : (
                    <select value={item.condition || ''} onChange={(event) => change(item, { condition: event.target.value })}>
                      {!item.condition ? <option value="">Condition…</option> : null}
                      {CARD_CONDITIONS.map((condition) => <option key={condition}>{condition}</option>)}
                      {item.condition && !CARD_CONDITIONS.includes(item.condition) ? <option>{item.condition}</option> : null}
                    </select>
                  )}</td>
                  <td>{locked ? item.quantity : <input type="number" min="1" max="999" defaultValue={item.quantity} onBlur={(event) => { const value = Number(event.target.value); if (value && value !== item.quantity) change(item, { quantity: value }) }} />}</td>
                  <td>{containerCode(item.container_id) || '—'}</td>
                  <td><span className={`cs-pill ${item.status}`}>{ITEM_STATUS[item.status] || item.status}</span></td>
                  <td className="cs-row-actions">
                    {!locked ? <button type="button" onClick={() => setSearching(item)}>{item.catalog_item_id ? 'Change item' : 'Identify'}</button> : null}
                    {!locked && item.status !== 'excluded' ? <button type="button" onClick={() => change(item, { status: 'excluded' })}>Leave out</button> : null}
                    {!locked && item.status === 'excluded' ? <button type="button" onClick={() => change(item, { status: item.catalog_item_id ? 'draft' : 'needs_review' })}>Include</button> : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {searching ? (
        <CatalogueSearchDialog
          initialQuery={searching.identification?.subject || searching.name_snapshot || ''}
          onClose={() => setSearching(null)}
          onPick={(catalogueItem) => { const item = searching; setSearching(null); change(item, { catalog_item_id: catalogueItem.item_id, name: [catalogueItem.name || catalogueItem.subject, catalogueItem.card_number ? `#${catalogueItem.card_number}` : ''].filter(Boolean).join(' ') }) }}
        />
      ) : null}
    </div>
  )
}

// The check before Add to Collection: what goes in, what's still open,
// intentional duplicates, and whether the collector's authorisation still holds.
export function ImportDialog({ jobId, collectorName, onCancel, onConfirm, busy = false, error = '' }) {
  const [preview, setPreview] = useState(null)
  const [problem, setProblem] = useState('')
  const [leaveOut, setLeaveOut] = useState(false)
  const [confirmedDuplicates, setConfirmedDuplicates] = useState(false)
  useEffect(() => { importPreview(jobId).then(setPreview).catch((loadError) => setProblem(loadError?.message || String(loadError))) }, [jobId])
  const duplicates = preview?.duplicates || []
  const blocked = !preview || !preview.authorisation?.valid || !preview.ready_items || (preview.needs_review > 0 && !leaveOut) || (duplicates.length > 0 && !confirmedDuplicates)
  return (
    <div className="register-modal cs-import-modal" role="dialog" aria-modal="true" aria-labelledby="cs-import-title">
      <section>
        <button className="modal-close" type="button" onClick={onCancel} aria-label="Close"><X size={18} /></button>
        <h2 id="cs-import-title">Add to {collectorName}'s collection</h2>
        {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
        {!preview && !problem ? <p className="cs-muted">Checking…</p> : null}
        {preview ? (
          <>
            <div className={`cs-check ${preview.authorisation.valid ? 'ok' : 'bad'}`}>{preview.authorisation.valid ? <CheckCircle2 size={16} /> : <XCircle size={16} />} Collector authorisation: {AUTH[preview.authorisation.status]?.label || preview.authorisation.status}</div>
            <dl className="cs-facts">
              <dt>Items to add</dt><dd><b>{preview.ready_items}</b> from {preview.ready_entries} entr{preview.ready_entries === 1 ? 'y' : 'ies'}</dd>
              <dt>By condition</dt><dd>{Object.entries(preview.by_condition || {}).map(([condition, n]) => `${condition}: ${n}`).join(' · ') || '—'}</dd>
              {preview.already_imported ? <><dt>Already added</dt><dd>{preview.already_imported} (never added twice)</dd></> : null}
              {preview.missing_condition ? <><dt>No condition</dt><dd className="cs-warn">{preview.missing_condition} entr{preview.missing_condition === 1 ? 'y has' : 'ies have'} no condition set</dd></> : null}
            </dl>
            {preview.needs_review ? (
              <label className="cs-check-row"><input type="checkbox" checked={leaveOut} onChange={(event) => setLeaveOut(event.target.checked)} /> {preview.needs_review} entr{preview.needs_review === 1 ? 'y still needs' : 'ies still need'} review. Leave {preview.needs_review === 1 ? 'it' : 'them'} out of this import.</label>
            ) : null}
            {duplicates.length ? (
              <>
                <p className="cs-muted">Several copies of the same item (they're added as separate copies):</p>
                <ul className="cs-dupes">{duplicates.slice(0, 8).map((dupe) => <li key={dupe.catalog_item_id}>{dupe.name || 'Item'} × {dupe.copies}{dupe.conditions?.length ? ` (${dupe.conditions.join(', ')})` : ''}</li>)}{duplicates.length > 8 ? <li>…and {duplicates.length - 8} more</li> : null}</ul>
                <label className="cs-check-row"><input type="checkbox" checked={confirmedDuplicates} onChange={(event) => setConfirmedDuplicates(event.target.checked)} /> These duplicates are intentional (the collector has that many physical copies).</label>
              </>
            ) : null}
            {error ? <p className="cs-error"><AlertTriangle size={14} /> {error}</p> : null}
            <div className="cs-actions">
              <button type="button" onClick={onCancel}>Back</button>
              <button type="button" className="gold-button" disabled={blocked || busy} onClick={() => onConfirm(leaveOut)}>{busy ? 'Adding…' : `Add ${preview.ready_items} to Collection`}</button>
            </div>
          </>
        ) : null}
      </section>
    </div>
  )
}

// A key for the import that survives a crash: retrying reuses it, so the
// import can't run twice.
export function importKey(jobId) {
  const name = `cs-import-key-${jobId}`
  try {
    const saved = window.localStorage.getItem(name)
    if (saved) return saved
    const key = `${jobId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    window.localStorage.setItem(name, key)
    return key
  } catch {
    return `${jobId}-session`
  }
}
export function clearImportKey(jobId) { try { window.localStorage.removeItem(`cs-import-key-${jobId}`) } catch {} }

export function useJob(jobId) {
  const [data, setData] = useState(null)
  const [problem, setProblem] = useState('')
  async function reload() {
    try { setData(await loadJob(jobId)); setProblem('') } catch (error) { setProblem(error?.message || String(error)) }
  }
  useEffect(() => { if (jobId) reload() }, [jobId])
  return { data, problem, reload }
}
