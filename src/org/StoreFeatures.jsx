import React, { useEffect, useState } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'
import { STORE_FEATURES, loadOrgStoreFeatures, setOrgStoreFeature } from '../lib/storeFeatures'

// Head office: turn optional features on or off for one store.
export default function StoreFeaturesModal({ orgId, store, onClose }) {
  const [enabled, setEnabled] = useState({})
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    loadOrgStoreFeatures(orgId)
      .then((rows) => setEnabled(Object.fromEntries(rows.filter((row) => row.store_id === store.storeId).map((row) => [row.feature, row.enabled]))))
      .catch((error) => setMessage(error?.message || String(error)))
  }, [orgId, store.storeId])

  async function toggle(feature, value) {
    setBusy(feature)
    setMessage('')
    try {
      await setOrgStoreFeature(orgId, store.storeId, feature, value)
      setEnabled((current) => ({ ...current, [feature]: value }))
      setMessage(`${STORE_FEATURES.find((item) => item.id === feature)?.label} turned ${value ? 'on' : 'off'} for ${store.storeName}. The store's POS picks this up the next time it signs in.`)
    } catch (error) { setMessage(error?.message || String(error)) } finally { setBusy('') }
  }

  return (
    <div className="register-modal nid-modal store-features-modal" role="dialog" aria-modal="true" aria-labelledby="store-features-title">
      <section>
        <button className="modal-close" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <div className="nid-head"><SlidersHorizontal size={22} /><div><h2 id="store-features-title">Features — {store.storeName}</h2><p>Optional features this store offers.</p></div></div>
        <ul className="store-features-list">
          {STORE_FEATURES.map((feature) => (
            <li key={feature.id}>
              <span><strong>{feature.label}</strong><small>{feature.description}</small></span>
              <label className="store-feature-switch">
                <input type="checkbox" checked={Boolean(enabled[feature.id])} disabled={busy === feature.id} onChange={(event) => toggle(feature.id, event.target.checked)} />
                <span>{enabled[feature.id] ? 'On' : 'Off'}</span>
              </label>
            </li>
          ))}
        </ul>
        {message ? <p className="nid-muted">{message}</p> : null}
      </section>
    </div>
  )
}
