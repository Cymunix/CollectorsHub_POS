import React, { useEffect, useState } from 'react'
import { loadOrgPayrollSettings, localIso, payPeriodFor, saveOrgPayrollSettings } from '../lib/travelExpenses'
import { teDate } from '../TERecordDetail'

// Organization payroll settings: employer details and the pay calendar.
// Pay calculation isn't switched on here: it needs the effective-dated CRA rules
// for the organization's province, validated, and a compliance review first.

const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']
const FREQUENCIES = [['weekly', 'Weekly'], ['biweekly', 'Bi-weekly'], ['semimonthly', 'Semi-monthly'], ['monthly', 'Monthly']]

export default function OrgPayroll({ orgId }) {
  const [settings, setSettings] = useState(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    loadOrgPayrollSettings(orgId)
      .then((s) => setSettings(Object.fromEntries(Object.entries(s || {}).map(([k, v]) => [k, v == null ? '' : v]))))
      .catch((error) => { setProblem(error?.message || String(error)); setSettings({}) })
  }, [orgId])

  if (!settings) return <p className="myhr-empty">Loading…</p>
  const set = (key) => (event) => setSettings((current) => ({ ...current, [key]: event.target.value }))
  const period = payPeriodFor(settings)

  async function save(event) {
    event.preventDefault()
    setBusy(true)
    setProblem('')
    setNotice('')
    try { await saveOrgPayrollSettings(orgId, settings); setNotice('Payroll settings saved.') } catch (error) { setProblem(error?.message || String(error)) } finally { setBusy(false) }
  }

  return (
    <div className="te-org">
      <h1 className="te-org-title">Payroll</h1>
      <p className="te-callout warn">
        <strong>Payroll calculation isn't turned on.</strong> Pay and deductions (federal and provincial tax, CPP, CPP2, EI) will be
        calculated by NORDVIK from the official CRA rules for each tax year, starting with one validated province. Live payroll
        stays off until those calculations are checked against CRA's published examples and a compliance review is done.
        Employees' My Pay and Tax Form Reprint only ever show finalised payslips and issued forms.
      </p>
      <form className="te-form" onSubmit={save}>
        <section className="te-panel">
          <h4 className="te-h4">Employer</h4>
          <div className="te-grid">
            <label><span>Legal employer name</span><input value={settings.legal_employer_name} onChange={set('legal_employer_name')} /></label>
            <label><span>Business number (BN)</span><input value={settings.business_number} onChange={set('business_number')} placeholder="9 digits" /></label>
            <label><span>Payroll program account</span><input value={settings.payroll_account} onChange={set('payroll_account')} placeholder="e.g. 123456789RP0001" /></label>
            <label><span>Province or territory</span><select value={settings.province} onChange={set('province')}><option value="">Choose…</option>{PROVINCES.map((code) => <option key={code}>{code}</option>)}</select></label>
          </div>
        </section>
        <section className="te-panel">
          <h4 className="te-h4">Pay calendar</h4>
          <div className="te-grid">
            <label><span>Pay frequency</span><select value={settings.pay_frequency} onChange={set('pay_frequency')}><option value="">Choose…</option>{FREQUENCIES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            {['weekly', 'biweekly'].includes(settings.pay_frequency) ? (
              <label><span>A pay period starts on</span><input type="date" value={settings.first_period_start} onChange={set('first_period_start')} /></label>
            ) : <span />}
            <label><span>Pay date, days after the period ends</span><input type="number" min="0" max="31" value={settings.pay_date_offset_days === '' ? 5 : settings.pay_date_offset_days} onChange={set('pay_date_offset_days')} /></label>
          </div>
          {period ? <p className="te-muted">Current period: {teDate(localIso(period.start))} – {teDate(localIso(period.end))}, paid {teDate(localIso(period.payDate))}.</p> : null}
        </section>
        {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
        {notice ? <p className="myhr-notice">{notice}</p> : null}
        <div className="te-actions end"><button type="submit" className="gold-button" disabled={busy}>{busy ? 'Saving…' : 'Save payroll settings'}</button></div>
      </form>
    </div>
  )
}
