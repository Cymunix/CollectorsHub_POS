import React, { useEffect, useState } from 'react'
import { AlertTriangle, ArrowLeft, Check, Lock, ShieldCheck } from 'lucide-react'
import { PAWN_PERMISSIONS, pawnSettings, saveSettings, setEmployeePermissions } from '../lib/pawnLoans'
import { TermsSummary } from './TermsSummary'

// Pawn settings for one store (Org portal → Stores → Pawn): the lending switch,
// licence, interest rate and who may do what. The legal terms are CollectorsHub's,
// per province: the store uses the ones for its Region (shown read-only here).

export default function PawnSettings({ storeId, onBack, backLabel = 'Close' }) {
  const [data, setData] = useState(null)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const [settings, setSettings] = useState(null)
  async function load() {
    try {
      const result = await pawnSettings(storeId)
      setData(result)
      const s = result.readiness?.settings || {}
      setSettings({ lending_enabled: Boolean(s.lending_enabled), config_id: s.config_id || '', interest_monthly_pct: s.interest_monthly_pct ?? '', licence_number: s.licence_number || '', licence_verified: Boolean(s.licence_verified), due_soon_days: s.due_soon_days || 7 })
      setProblem('')
    } catch (error) { setProblem(error.message) }
  }
  useEffect(() => { load() }, [storeId])
  if (!data) return <section className="cu-page pw-page"><button type="button" className="cs-back" onClick={onBack}><ArrowLeft size={15} /> {backLabel}</button>{problem ? <p className="cs-error">{problem}</p> : <p className="cs-muted">Loading…</p>}</section>
  const boss = Boolean(data.perms?.boss)
  if (!boss) return <section className="cu-page pw-page"><button type="button" className="cs-back" onClick={onBack}><ArrowLeft size={15} /> {backLabel}</button><p className="cu-notice"><Lock size={15} /> Pawn settings are managed by the organization.</p></section>
  const readiness = data.readiness
  const chosen = readiness.config || null
  // Results show at the top of the page, so bring them into view.
  const toTop = () => { const box = document.querySelector('.org-pawn-overlay'); if (box) box.scrollTo({ top: 0, behavior: 'smooth' }); else window.scrollTo({ top: 0, behavior: 'smooth' }) }
  async function act(task, message) { setProblem(''); setNotice(''); try { await task(); setNotice(message); await load() } catch (error) { setProblem(error.message) } finally { toTop() } }

  return (
    <section className="cu-page pw-page">
      <button type="button" className="cs-back" onClick={onBack}><ArrowLeft size={15} /> {backLabel}</button>
      <header className="cu-head"><h1>Pawn settings{data.store_name ? ` · ${data.store_name}` : ''}</h1></header>
      {data.feature_enabled === false ? <p className="cu-notice"><AlertTriangle size={15} /> Pawns &amp; Loans is turned off for this store. Turn it on under Features; until then staff don't see it.</p> : null}
      {notice ? <p className="cu-notice"><Check size={15} /> {notice}</p> : null}
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      <div className={`pw-status ${readiness.ready ? 'ok' : ''}`}>
        {readiness.ready ? <><ShieldCheck size={18} /> {readiness.test_mode ? 'Test store: test loans can be issued.' : 'Pawn lending is live for this store.'}</> : <><Lock size={18} /> Not ready for {readiness.test_mode ? 'test loans' : 'lending'}: {(readiness.reasons || []).join(' ')}</>}
      </div>
      

      <div className="tx-card">
        <h3>This store</h3>
        <div className="cs-form-grid">
          <div className="pw-juris"><span>Jurisdiction</span><strong>{readiness.jurisdiction ? `${readiness.jurisdiction.name} (${readiness.jurisdiction.code})` : 'Not set'}</strong><small>{readiness.jurisdiction ? (readiness.jurisdiction.source === 'region' ? "From the store's Region" : "From the store's address") : 'Set the store\'s Region in Stores'}</small></div>
          <div className="pw-juris"><span>Configuration used</span><strong>{chosen ? `${chosen.name} (${chosen.status})` : 'None yet'}</strong><small>{chosen ? 'Set by CollectorsHub for this province' : readiness.jurisdiction ? `CollectorsHub hasn't set pawn terms for ${readiness.jurisdiction.name} yet` : ''}</small></div>
          <label><span>Store interest rate (% a month){chosen?.rules?.interest_monthly_pct_max != null ? `, max ${chosen.rules.interest_monthly_pct_max}` : ''}</span><input inputMode="decimal" value={settings.interest_monthly_pct} onChange={(event) => setSettings({ ...settings, interest_monthly_pct: event.target.value })} placeholder="Defaults to the maximum" /></label>
          <label><span>Lending licence number</span><input value={settings.licence_number} onChange={(event) => setSettings({ ...settings, licence_number: event.target.value })} /></label>
          <label><span>"Due soon" means within (days)</span><input type="number" min="1" max="60" value={settings.due_soon_days} onChange={(event) => setSettings({ ...settings, due_soon_days: event.target.value })} /></label>
        </div>
        <label className="tx-check"><input type="checkbox" disabled={!boss} checked={settings.licence_verified} onChange={(event) => setSettings({ ...settings, licence_verified: event.target.checked })} /> The store's lending licence / registration has been verified as current.</label>
        <label className="tx-check"><input type="checkbox" disabled={!boss} checked={settings.lending_enabled} onChange={(event) => setSettings({ ...settings, lending_enabled: event.target.checked })} /> <strong>Pawn Lending Enabled</strong> (real loans; off by default)</label>
        <div className="cs-actions left"><button type="button" className="gold-button" onClick={() => act(() => saveSettings(storeId, { ...settings, interest_monthly_pct: settings.interest_monthly_pct === '' ? null : Number(settings.interest_monthly_pct) }), 'Store settings saved.')}>Save store settings</button></div>
      </div>

      {chosen ? <div className="tx-card"><h3>Pawn terms for {readiness.jurisdiction?.name}</h3><TermsSummary config={chosen} /></div> : null}

      <div className="tx-card">
        <h3>Employee permissions</h3>
        <p className="cs-muted">Managers start with everything except forfeiture and inventory transfer; assistant managers and supervisors with the day-to-day tasks; other staff with nothing. Tick or untick to change anyone.</p>
        <div className="tx-table-wrap">
          <table className="cs-table tx-items pw-perms">
            <thead><tr><th>Employee</th>{PAWN_PERMISSIONS.map(([key, label]) => <th key={key} title={label}>{label}</th>)}</tr></thead>
            <tbody>{data.employees.map((employee) => (
              <tr key={employee.id}><td><strong>{employee.name}</strong><small className="tx-sku">{employee.role}</small></td>
                {PAWN_PERMISSIONS.map(([key]) => <td key={key}><input type="checkbox" checked={Boolean(employee.permissions?.[key])} onChange={(event) => act(() => setEmployeePermissions(storeId, employee.id, { ...employee.permissions, [key]: event.target.checked }), `Permissions saved for ${employee.name}.`)} title={employee.defaults?.[key] ? 'On by default for this role' : ''} /></td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      </div>

    </section>
  )
}
