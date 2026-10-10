import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, XCircle } from 'lucide-react'
import { DISCREPANCY_TEXT, decideReview, documentLabel, listReviews, reviewEvidence, revokeVerification } from './nordvikIdentity'

// NORDVIK Identity manual review (authorised reviewers only; the API refuses
// everyone else). Evidence opens through 2-minute links and every view is
// audited. A reviewer can't decide a verification they started.
const KIND_LABEL = { document_front: 'ID front', document_back: 'ID back', live_photo: 'Live photo' }

export default function IdentityReviews() {
  const [reviews, setReviews] = useState(null)
  const [selected, setSelected] = useState(null)
  const [evidence, setEvidence] = useState(null)
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const [revoke, setRevoke] = useState({ accountId: '', reason: '' })

  async function load() {
    setProblem('')
    try { setReviews(await listReviews()) } catch (error) { setProblem(error?.message || String(error)); setReviews([]) }
  }
  useEffect(() => { load() }, [])

  async function open(review) {
    setSelected(review)
    setEvidence(null)
    setNote('')
    try { setEvidence((await reviewEvidence(review.id)).urls || {}) } catch (error) { setProblem(error?.message || String(error)) }
  }
  async function decide(decision) {
    setBusy(true)
    setProblem('')
    try {
      await decideReview(selected.id, decision, note)
      setSelected(null)
      setEvidence(null)
      await load()
    } catch (error) { setProblem(error?.message || String(error)) } finally { setBusy(false) }
  }
  async function submitRevoke(event) {
    event.preventDefault()
    setBusy(true)
    setProblem('')
    try { await revokeVerification(revoke.accountId.trim(), revoke.reason.trim()); setRevoke({ accountId: '', reason: '' }); setProblem('Verification revoked.') } catch (error) { setProblem(error?.message || String(error)) } finally { setBusy(false) }
  }

  return (
    <section className="admin-panel nid-reviews">
      <header className="nid-reviews-head">
        <div><h2><ShieldCheck size={20} /> NORDVIK Identity reviews</h2><p className="nid-muted">Decide verifications that need a person: no automated provider, inconclusive results, discrepancies, or the in-person alternative.</p></div>
        <button type="button" onClick={load}><RefreshCw size={15} /> Refresh</button>
      </header>
      {problem ? <p className="nid-error"><AlertTriangle size={15} /> {problem}</p> : null}
      {reviews === null ? <p className="nid-muted">Loading…</p> : null}
      {reviews?.length === 0 && !problem ? <p className="nid-muted">Nothing waiting for review.</p> : null}
      <div className="nid-review-grid">
        <ul className="nid-review-list">
          {(reviews || []).map((review) => (
            <li key={review.id}>
              <button type="button" className={selected?.id === review.id ? 'active' : ''} onClick={() => open(review)}>
                <strong>{review.details?.full_name || review.accountName || 'Customer'}</strong>
                <small>{review.username ? `@${review.username} · ` : ''}{review.storeName}</small>
                <small>{documentLabel(review.documentType)} · {review.biometricConsent === false ? 'in-person check' : review.captureMethod === 'mobile' ? 'phone photo' : 'webcam photo'} · {new Date(review.createdAt).toLocaleString()}</small>
                {review.discrepancies?.length ? <span className="nid-badge amber"><AlertTriangle size={12} /> {review.discrepancies.length} flagged</span> : null}
              </button>
            </li>
          ))}
        </ul>
        {selected ? (
          <div className="nid-review-detail">
            <h3>{selected.details?.full_name}</h3>
            <dl className="nid-facts">
              <dt>Account name</dt><dd>{selected.accountName || '—'}{selected.username ? ` (@${selected.username})` : ''}</dd>
              <dt>ID</dt><dd>{documentLabel(selected.documentType)}, issued by {selected.details?.jurisdiction}</dd>
              <dt>Date of birth</dt><dd>{selected.details?.date_of_birth}</dd>
              <dt>Expiry</dt><dd>{selected.details?.expiry_date}</dd>
              <dt>Details from</dt><dd>{selected.details?.source === 'manual_entry' ? 'Typed by the store employee' : selected.details?.source}</dd>
              <dt>Store</dt><dd>{selected.storeName}</dd>
            </dl>
            {selected.discrepancies?.length ? <div className="nid-discrepancies"><strong><AlertTriangle size={15} /> Flagged</strong><ul>{selected.discrepancies.map((code) => <li key={code}>{DISCREPANCY_TEXT[code] || code}</li>)}</ul></div> : null}
            <div className="nid-evidence">
              {evidence === null ? <p className="nid-muted">Loading evidence…</p>
                : Object.keys(evidence).length === 0 ? <p className="nid-muted">No images (in-person check). Decide from the details and the employee's attestation.</p>
                  : Object.entries(evidence).map(([kind, src]) => <figure key={kind}><img src={src} alt={KIND_LABEL[kind]} /><figcaption>{KIND_LABEL[kind]}</figcaption></figure>)}
            </div>
            <label className="nid-review-note"><span>Decision note (required to fail)</span><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></label>
            {selected.startedByMe ? <p className="nid-error"><AlertTriangle size={15} /> You started this verification, so another reviewer must decide it.</p> : null}
            <div className="nid-actions">
              <button type="button" disabled={busy || selected.startedByMe || !note.trim()} onClick={() => decide('failed')}><XCircle size={15} /> Fail</button>
              <button type="button" className="gold-button" disabled={busy || selected.startedByMe} onClick={() => decide('verified')}><CheckCircle2 size={15} /> Verify</button>
            </div>
          </div>
        ) : <div className="nid-review-detail nid-muted">Choose a review.</div>}
      </div>
      <form className="nid-revoke" onSubmit={submitRevoke}>
        <h3>Revoke a verification</h3>
        <input placeholder="Account ID" value={revoke.accountId} onChange={(event) => setRevoke((current) => ({ ...current, accountId: event.target.value }))} />
        <input placeholder="Reason" value={revoke.reason} onChange={(event) => setRevoke((current) => ({ ...current, reason: event.target.value }))} />
        <button type="submit" disabled={busy || !revoke.accountId.trim() || !revoke.reason.trim()}>Revoke</button>
      </form>
    </section>
  )
}
