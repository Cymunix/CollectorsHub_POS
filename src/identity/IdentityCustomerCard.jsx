import { useEffect, useState } from 'react'
import { IdCard, UserRound, X } from 'lucide-react'
import IdentityBadge from './IdentityBadge'
import { loadIdentityPhoto } from './nordvikIdentity'

// POS customer card for a CollectorsHub member, laid out for identifying the
// customer at the till: identity photo, client name and username,
// then store credit and XP.
//
// The photo is the NORDVIK Identity photo, never the CollectorsHub profile
// picture (there's deliberately no fallback to it). It's requested from
// NORDVIK Identity for this purpose (each view is logged), fetched without
// caching, kept only in memory, and released when the customer is deselected.

function IdentityPhoto({ storeId, accountId, available, purpose }) {
  const [photo, setPhoto] = useState({ url: '', processed: false, failed: false, loading: false })
  useEffect(() => {
    if (!available || !storeId || !accountId) { setPhoto({ url: '', processed: false, failed: false, loading: false }); return undefined }
    let cancelled = false
    let objectUrl = ''
    setPhoto({ url: '', processed: false, failed: false, loading: true })
    loadIdentityPhoto(storeId, accountId, purpose)
      .then((loaded) => {
        objectUrl = loaded.url
        if (cancelled) { URL.revokeObjectURL(objectUrl); return }
        setPhoto({ url: loaded.url, processed: loaded.processed, failed: false, loading: false })
      })
      .catch((error) => { if (!cancelled) setPhoto({ url: '', processed: false, failed: true, loading: false, reason: error?.message || String(error) }) })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [storeId, accountId, available, purpose])

  if (photo.url) {
    return (
      <figure className="idcard-photo">
        <img src={photo.url} alt="NORDVIK Identity photo" draggable={false} />
        {!photo.processed ? <figcaption>Verification photo (background not yet removed)</figcaption> : null}
      </figure>
    )
  }
  return (
    <figure className="idcard-photo placeholder">
      <UserRound size={96} strokeWidth={1.2} />
      {available && photo.loading ? <figcaption>Loading identity photo…</figcaption> : null}
      {available && photo.failed ? <figcaption className="bad">The identity photo could not be loaded.{photo.reason ? <small className="idcard-photo-reason">{photo.reason}</small> : null}</figcaption> : null}
    </figure>
  )
}

export default function IdentityCustomerCard({ customer, storeId, mode, money, onVerify, onDetails, onRemove, buyback = false, manualCheck = null, onManualCheck = null }) {
  const accountId = customer.collectorshub_user_id || customer.profileId || ''
  const identity = customer.identity || null
  const status = customer.identityStatus || 'unverified'
  const verified = status === 'verified'
  const demo = verified && identity?.demo === true // Demo Verified: test stores only
  const inProgress = ['pending', 'processing', 'manual_review'].includes(status) || identity?.openSession?.status === 'manual_review'
  const name = verified ? (identity?.legalName || customer.fullName || customer.name) : (customer.fullName || customer.name)

  return (
    <div className={`idcard ${demo ? 'demo' : verified ? 'verified' : 'unverified'}`}>
      <button type="button" className="idcard-remove" aria-label="Remove customer" onClick={onRemove}><X size={16} /></button>
      {verified
        ? <IdentityPhoto storeId={storeId} accountId={accountId} available={Boolean(identity?.portraitAvailable)} purpose={mode === 'buy' ? 'buyback_identification' : 'checkout_identification'} />
        : <figure className="idcard-photo placeholder"><UserRound size={96} strokeWidth={1.2} /></figure>}
      {verified && identity && !identity.portraitAvailable ? <p className="idcard-note">No identity photo on file yet.</p> : null}

      <div className="idcard-status"><IdentityBadge status={demo ? 'demo_verified' : status} onClick={onDetails} /></div>
      {demo ? <p className="idcard-demo">Demo record for testing. Not a real identity check.</p> : null}

      <dl className="idcard-fields">
        <div><dt>Client name</dt><dd>{name || '—'}{!verified && name ? <small className="idcard-unverified">unverified</small> : null}</dd></div>
        <div><dt>Username</dt><dd>{customer.username ? `@${customer.username}` : '—'}</dd></div>
      </dl>

      {!verified && buyback && manualCheck ? (
        <div className="idcard-manual">
          <p><IdCard size={15} /> ID checked manually for this transaction</p>
          <small>Not NORDVIK Identity verified. Applies to this buyback only.</small>
        </div>
      ) : null}
      {!verified && !(buyback && manualCheck) ? (
        <div className="idcard-verify">
          <p>Identity verification is required before this customer can sell items to the store.</p>
          {inProgress
            ? <p className="idcard-muted">Verification is waiting for NORDVIK Identity.</p>
            : <button type="button" className="gold-button" onClick={onVerify} disabled={!storeId}><IdCard size={16} /> Verify Customer</button>}
          {buyback && onManualCheck ? <button type="button" className="idcard-secondary" onClick={onManualCheck}>Manually check ID for this transaction</button> : null}
        </div>
      ) : null}
      {customer.identityError ? <p className="idcard-note bad">NORDVIK Identity status unavailable: {customer.identityError}</p> : null}

      <div className="idcard-extras">
        <span>Store Credit <b>{money.format(Number(customer.storeCredit || 0))}</b></span>
        <span>Purchase XP <b>+250 XP</b></span>
      </div>
    </div>
  )
}
