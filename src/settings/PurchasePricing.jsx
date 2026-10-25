import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { loadPurchasePolicy, savePurchasePolicy, setActivePurchasePolicy } from '../lib/marketIntelligence'
import { DEFAULT_BUY_PERCENT, LEGO_GROUPS } from '../lib/marketMath'
import '../register/marketIntelligence.css'

// Store settings: the buying percentages behind Market Intelligence's
// calculated purchase baseline. A baseline is only a starting point: staff
// can always offer more or less, under the store's existing approval rules.

const pct = (value) => (value === '' || value == null ? null : Number(value))
const valid = (value) => value === '' || value == null || (Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 200)

export default function PurchasePricing({ session }) {
  const storeId = session?.storeId
  const [form, setForm] = useState(null)
  const [categories, setCategories] = useState([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!storeId) return
    Promise.all([loadPurchasePolicy(storeId), supabase.from('categories').select('name').order('name')])
      .then(([policy, { data }]) => {
        setCategories((data || []).map((row) => row.name))
        setForm({
          default_percent: policy?.default_percent ?? DEFAULT_BUY_PERCENT,
          category_percents: Object.fromEntries(Object.entries(policy?.category_percents || {}).map(([key, value]) => [key, String(value)])),
          lego_percents: Object.fromEntries(Object.entries(policy?.lego_percents || {}).map(([key, value]) => [key, String(value)])),
          box_required_for_complete: Boolean(policy?.box_required_for_complete),
          instructions_required_for_complete: Boolean(policy?.instructions_required_for_complete),
        })
      })
      .catch((loadError) => setError(loadError.message))
  }, [storeId])

  if (!form) return null
  const set = (patch) => { setForm((current) => ({ ...current, ...patch })); setMessage('') }
  const allValid = valid(form.default_percent) && Object.values(form.category_percents).every(valid) && Object.values(form.lego_percents).every(valid)

  async function save() {
    setBusy(true); setError(''); setMessage('')
    const policy = {
      default_percent: pct(form.default_percent) ?? DEFAULT_BUY_PERCENT,
      category_percents: Object.fromEntries(Object.entries(form.category_percents).filter(([, value]) => value !== '').map(([key, value]) => [key, Number(value)])),
      lego_percents: Object.fromEntries(Object.entries(form.lego_percents).filter(([, value]) => value !== '').map(([key, value]) => [key, Number(value)])),
      box_required_for_complete: form.box_required_for_complete,
      instructions_required_for_complete: form.instructions_required_for_complete,
    }
    try {
      await savePurchasePolicy(storeId, policy)
      setActivePurchasePolicy(policy)
      setMessage('Purchase pricing saved. New buy items use these percentages.')
    } catch (saveError) { setError(saveError.message) } finally { setBusy(false) }
  }

  return (
    <div className="tx-card ps-card purchase-pricing">
      <h2>Purchase Pricing</h2>
      <p className="cs-muted">The percentage of the completed-sale median that Market Intelligence uses for a buy item's calculated baseline. It is a starting point only: staff can offer more or less. Only people with store settings access can change this.</p>
      <div className="purchase-pricing-grid">
        <label>Default buying percentage
          <span className="purchase-pricing-input"><input inputMode="decimal" value={form.default_percent} onChange={(event) => set({ default_percent: event.target.value })} />%</span>
        </label>
      </div>
      <h3>By category <small>(leave blank to use the default)</small></h3>
      <div className="purchase-pricing-grid">
        {categories.map((name) => (
          <label key={name}>{name}
            <span className="purchase-pricing-input"><input inputMode="decimal" value={form.category_percents[name] ?? ''} onChange={(event) => set({ category_percents: { ...form.category_percents, [name]: event.target.value } })} placeholder={String(form.default_percent)} />%</span>
          </label>
        ))}
      </div>
      <h3>Building Blocks <small>(LEGO sets by pricing group)</small></h3>
      <div className="purchase-pricing-grid">
        {LEGO_GROUPS.map(([key, label]) => (
          <label key={key}>{label}
            <span className="purchase-pricing-input"><input inputMode="decimal" value={form.lego_percents[key] ?? ''} onChange={(event) => set({ lego_percents: { ...form.lego_percents, [key]: event.target.value } })} placeholder={form.category_percents['Building Blocks'] || String(form.default_percent)} />%</span>
          </label>
        ))}
      </div>
      <label className="purchase-pricing-check"><input type="checkbox" checked={form.box_required_for_complete} onChange={(event) => set({ box_required_for_complete: event.target.checked })} /> A set without its original box counts as Used Incomplete</label>
      <label className="purchase-pricing-check"><input type="checkbox" checked={form.instructions_required_for_complete} onChange={(event) => set({ instructions_required_for_complete: event.target.checked })} /> A set without its instructions counts as Used Incomplete</label>
      {!allValid ? <p className="cs-error">Percentages must be numbers from 0 to 200.</p> : null}
      {error ? <p className="cs-error">{error}</p> : null}
      {message ? <p className="purchase-pricing-saved">{message}</p> : null}
      <div><button type="button" className="gold-button" onClick={save} disabled={busy || !allValid}>{busy ? 'Saving…' : 'Save purchase pricing'}</button></div>
    </div>
  )
}
