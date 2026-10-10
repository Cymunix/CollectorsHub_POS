import React, { useEffect, useState } from 'react'
import { AlertTriangle, IdCard, X } from 'lucide-react'
import { loadOrgLocationHours } from '../lib/storeHours'
import { DEFAULT_RULES, correctBuybackIdentification, loadBuybackIdLog, loadOrgBuybackRules, saveOrgBuybackRules } from '../lib/buybackIdentification'

// Head office: what a store must record when it buys from a customer (per
// location, or a store-wide default), and the store's identification log.
// Requirements differ by jurisdiction and merchandise: set these to match the
// store's second-hand dealer obligations.

const ID_TYPES = [['drivers_licence', "Driver's Licence"], ['passport', 'Passport'], ['provincial_id', 'Provincial/State Photo ID']]
const METHOD_LABEL = { nordvik_identity: 'NORDVIK Identity verified', manual_id_check: 'Manual ID check', guest_manual_id_check: 'Guest, manual ID check' }

function RulesTab({ orgId, store }) {
  const [locations, setLocations] = useState([])
  const [allRules, setAllRules] = useState([])
  const [scope, setScope] = useState('') // '' = store default, else location id
  const [rules, setRules] = useState(DEFAULT_RULES)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function load() {
    const [hours, saved] = await Promise.all([loadOrgLocationHours(orgId).catch(() => []), loadOrgBuybackRules(orgId).catch((error) => { setMessage(error.message); return [] })])
    setLocations(hours.filter((row) => row.store_id === store.storeId))
    setAllRules(saved.filter((row) => row.store_id === store.storeId))
  }
  useEffect(() => { load() }, [orgId, store.storeId])
  useEffect(() => {
    const own = allRules.find((row) => (row.location_id || '') === scope)
    const fallback = allRules.find((row) => !row.location_id)
    setRules({ ...DEFAULT_RULES, ...(fallback || {}), ...(own || {}) })
  }, [scope, allRules])

  const set = (key, value) => setRules((current) => ({ ...current, [key]: value }))
  async function save() {
    setBusy(true)
    setMessage('')
    try {
      await saveOrgBuybackRules(orgId, store.storeId, scope || null, rules)
      await load()
      setMessage('Saved.')
    } catch (error) { setMessage(error?.message || String(error)) } finally { setBusy(false) }
  }
  const usingDefault = scope && !allRules.some((row) => row.location_id === scope)

  return (
    <div className="nid-step">
      <label className="buyback-rules-scope">
        <span>Applies to</span>
        <select value={scope} onChange={(event) => setScope(event.target.value)}>
          <option value="">All locations (store default)</option>
          {locations.map((location) => <option key={location.location_id} value={location.location_id}>{location.location_name}</option>)}
        </select>
      </label>
      {usingDefault ? <p className="nid-muted nid-small">This location uses the store default until you save rules for it.</p> : null}
      <div className="buyback-rules-grid">
        <fieldset>
          <legend>Accepted government photo ID</legend>
          {ID_TYPES.map(([id, label]) => (
            <label key={id} className="nid-check"><input type="checkbox" checked={rules.accepted_id_types.includes(id)} onChange={(event) => set('accepted_id_types', event.target.checked ? [...rules.accepted_id_types, id] : rules.accepted_id_types.filter((type) => type !== id))} /><span>{label}</span></label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Record for manual and guest checks</legend>
          <label className="nid-check"><input type="checkbox" checked={rules.require_date_of_birth} onChange={(event) => set('require_date_of_birth', event.target.checked)} /><span>Date of birth</span></label>
          <label className="nid-check"><input type="checkbox" checked={rules.require_address} onChange={(event) => set('require_address', event.target.checked)} /><span>Residential address</span></label>
          <label className="nid-check"><input type="checkbox" checked={rules.require_contact} onChange={(event) => set('require_contact', event.target.checked)} /><span>Phone or email</span></label>
          <label className="nid-check"><input type="checkbox" checked={rules.require_id_number} onChange={(event) => set('require_id_number', event.target.checked)} /><span>ID number and issuer (only where the law requires it)</span></label>
          <label className="buyback-rules-age"><span>Minimum age</span><input type="number" min="0" max="99" value={rules.minimum_age} onChange={(event) => set('minimum_age', Number(event.target.value))} /></label>
        </fieldset>
        <fieldset>
          <legend>Allowed methods</legend>
          <label className="nid-check"><input type="checkbox" checked disabled /><span>NORDVIK Identity verified customers</span></label>
          <label className="nid-check"><input type="checkbox" checked={rules.allow_manual_check} onChange={(event) => set('allow_manual_check', event.target.checked)} /><span>Manual ID check for registered, unverified customers</span></label>
          <label className="nid-check"><input type="checkbox" checked={rules.allow_guest_buyback} onChange={(event) => set('allow_guest_buyback', event.target.checked)} /><span>Guest buybacks (no account)</span></label>
        </fieldset>
      </div>
      <label className="buyback-rules-note"><span>Requirement or policy these rules follow</span><textarea rows={2} value={rules.policy_note || ''} onChange={(event) => set('policy_note', event.target.value)} placeholder="e.g. Halifax second-hand dealer bylaw: record name, address, DOB and ID type" /></label>
      <p className="nid-muted nid-small"><AlertTriangle size={13} /> Check your local second-hand dealer and recordkeeping requirements. Recording a name and a confirmation doesn't satisfy every jurisdiction.</p>
      {message ? <p className="nid-muted">{message}</p> : null}
      <div className="nid-actions"><button type="button" className="gold-button" onClick={save} disabled={busy || !rules.accepted_id_types.length}>{busy ? 'Saving…' : 'Save rules'}</button></div>
    </div>
  )
}

function LogTab({ store }) {
  const [rows, setRows] = useState(null)
  const [days, setDays] = useState(30)
  const [message, setMessage] = useState('')
  async function load() {
    setMessage('')
    try {
      const to = new Date(Date.now() + 60000)
      const from = new Date(Date.now() - days * 86400000)
      setRows(await loadBuybackIdLog(store.storeId, from.toISOString(), to.toISOString()))
    } catch (error) { setMessage(error?.message || String(error)); setRows([]) }
  }
  useEffect(() => { load() }, [store.storeId, days])
  async function correct(row) {
    const reason = window.prompt('Reason for the correction (the original record is kept):')
    if (!reason) return
    try { await correctBuybackIdentification(row.id, reason, null, null); await load() } catch (error) { setMessage(error?.message || String(error)) }
  }
  return (
    <div className="nid-step">
      <label className="buyback-rules-scope"><span>Period</span><select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option></select></label>
      {message ? <p className="nid-error"><AlertTriangle size={15} /> {message}</p> : null}
      {rows === null ? <p className="nid-muted">Loading…</p> : rows.length === 0 ? <p className="nid-muted">No buyback identifications in this period.</p> : (
        <div className="buyback-log">
          <table>
            <thead><tr><th>When</th><th>Method</th><th>Seller</th><th>ID</th><th>Checked by</th><th>Transaction</th><th /></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={row.corrects_id ? 'correction' : ''}>
                  <td>{new Date(row.created_at).toLocaleString()}</td>
                  <td>{METHOD_LABEL[row.method] || row.method}{row.corrects_id ? <small>Correction: {row.correction_reason}</small> : null}</td>
                  <td>{row.customer_name || '—'}{row.username ? <small>@{row.username}</small> : null}{row.guest_details?.date_of_birth ? <small>DOB {row.guest_details.date_of_birth}</small> : null}</td>
                  <td>{ID_TYPES.find(([id]) => id === row.id_type)?.[1] || (row.method === 'nordvik_identity' ? 'NORDVIK Identity' : row.id_type || '—')}</td>
                  <td>{row.employee_name}</td>
                  <td>{row.transaction_number || <span className="nid-muted">Not used</span>}</td>
                  <td>{!row.corrects_id ? <button type="button" onClick={() => correct(row)}>Correct</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function BuybackRulesModal({ orgId, store, onClose }) {
  const [tab, setTab] = useState('rules')
  return (
    <div className="register-modal nid-modal buyback-rules-modal" role="dialog" aria-modal="true" aria-labelledby="buyback-rules-title">
      <section>
        <button className="modal-close" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <div className="nid-head"><IdCard size={22} /><div><h2 id="buyback-rules-title">Buyback identification — {store.storeName}</h2><p>What staff must check and record when buying from customers.</p></div></div>
        <div className="buyback-tabs">
          <button type="button" className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>Rules</button>
          <button type="button" className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>Identification log</button>
        </div>
        {tab === 'rules' ? <RulesTab orgId={orgId} store={store} /> : <LogTab store={store} />}
      </section>
    </div>
  )
}
