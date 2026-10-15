import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Download, FileText, Printer, Search } from 'lucide-react'
import { loadPayOverview, loadPayslip, loadPayslips, loadTaxDocuments, localIso, payPeriodFor, taxDocumentUrl } from './lib/travelExpenses'
import { teDate, teDates, teMoney } from './TERecordDetail'

// My Pay and Tax Form Reprint: the employee's own FINALISED payroll results only.
// Nothing here calculates pay; amounts come from the organization's finalised payroll records.

const FREQUENCY = { weekly: 'Weekly', biweekly: 'Bi-weekly', semimonthly: 'Semi-monthly', monthly: 'Monthly' }
const PAYMENT = { pending: 'Payment pending', paid: 'Paid', failed: 'Payment failed' }
const iso = (date) => localIso(date)
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

function printPayslip(slip) {
  const row = (item) => `<tr><td>${esc(item.label)}</td><td class="n">${item.hours != null ? Number(item.hours).toFixed(2) : ''}</td><td class="n">${item.rate != null ? teMoney(item.rate) : ''}</td><td class="n">${teMoney(item.amount)}</td><td class="n">${item.ytd != null ? teMoney(item.ytd) : ''}</td></tr>`
  const simple = (item) => `<tr><td>${esc(item.label)}</td><td class="n">${teMoney(item.amount)}</td><td class="n">${item.ytd != null ? teMoney(item.ytd) : ''}</td></tr>`
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Payslip ${esc(slip.pay_date)}</title><style>
    body{font:13px/1.4 system-ui,Segoe UI,Arial,sans-serif;color:#0B111B;margin:28px}h1{font-size:18px;margin:0 0 4px}h2{font-size:13px;margin:18px 0 6px;color:#17253D;text-transform:uppercase;letter-spacing:.04em}
    table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #E3E8EF;padding:5px 6px;text-align:left}.n{text-align:right}th{font-size:11px;color:#596579}
    .head{display:flex;justify-content:space-between;border-bottom:2px solid #D6A632;padding-bottom:10px}.tot td{font-weight:700}</style></head><body>
    <div class="head"><div><h1>${esc(slip.employer)}</h1><div>Payslip · pay date ${teDate(slip.pay_date)}</div></div>
    <div style="text-align:right"><b>${esc(slip.employee_name)}</b><br>Employee ID ${esc(slip.personnel_number || '—')}<br>Period ${teDates(slip.period_start, slip.period_end)}</div></div>
    <h2>Earnings</h2><table><tr><th>Earning</th><th class="n">Hours</th><th class="n">Rate</th><th class="n">Current</th><th class="n">Year to date</th></tr>${(slip.earnings || []).map(row).join('')}
    <tr class="tot"><td>Gross earnings</td><td></td><td></td><td class="n">${teMoney(slip.gross)}</td><td class="n">${slip.ytd?.gross != null ? teMoney(slip.ytd.gross) : ''}</td></tr></table>
    <h2>Deductions</h2><table><tr><th>Deduction</th><th class="n">Current</th><th class="n">Year to date</th></tr>${(slip.deductions || []).map(simple).join('')}
    <tr class="tot"><td>Total deductions</td><td class="n">${teMoney(slip.total_deductions)}</td><td class="n">${slip.ytd?.deductions != null ? teMoney(slip.ytd.deductions) : ''}</td></tr></table>
    <h2>Totals</h2><table><tr><td>Taxable earnings</td><td class="n">${teMoney(slip.taxable)}</td></tr><tr><td>Pensionable earnings</td><td class="n">${teMoney(slip.pensionable)}</td></tr><tr><td>Insurable earnings</td><td class="n">${teMoney(slip.insurable)}</td></tr><tr class="tot"><td>Net pay</td><td class="n">${teMoney(slip.net)}</td></tr></table>
    ${(slip.employer_contributions || []).length ? `<h2>Employer contributions (not deducted from your pay)</h2><table>${slip.employer_contributions.map(simple).join('')}</table>` : ''}
    </body></html>`
  const win = window.open('', '_blank', 'noopener,width=820,height=900')
  if (!win) return
  win.document.write(html)
  win.document.close()
  win.focus()
  setTimeout(() => win.print(), 300)
}

function Lines({ title, items, showHours }) {
  return (
    <table className="te-table">
      <thead><tr><th>{title}</th>{showHours ? <><th className="num">Hours</th><th className="num">Rate</th></> : null}<th className="num">Current</th><th className="num">Year to date</th></tr></thead>
      <tbody>
        {(items || []).length ? items.map((item, index) => (
          <tr key={`${item.code}-${index}`}>
            <td>{item.label}</td>
            {showHours ? <><td className="num">{item.hours != null ? Number(item.hours).toFixed(2) : ''}</td><td className="num">{item.rate != null ? teMoney(item.rate) : ''}</td></> : null}
            <td className="num">{teMoney(item.amount)}</td>
            <td className="num">{item.ytd != null ? teMoney(item.ytd) : ''}</td>
          </tr>
        )) : <tr><td colSpan={showHours ? 5 : 3} className="te-muted">None</td></tr>}
      </tbody>
    </table>
  )
}

export function MyPay({ storeId }) {
  const [overview, setOverview] = useState(null)
  const [slips, setSlips] = useState([])
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(null)
  const [problem, setProblem] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([loadPayOverview(storeId), loadPayslips(storeId)])
      .then(([info, list]) => { setOverview(info); setSlips(list) })
      .catch((error) => setProblem(error?.message || String(error)))
      .finally(() => setLoading(false))
  }, [storeId])

  const period = useMemo(() => (overview ? payPeriodFor(overview) : null), [overview])
  const nextPay = overview?.next_run?.pay_date || (period ? iso(period.payDate) : null)
  const shown = slips.filter((slip) => !search.trim() || `${slip.period_start} ${slip.period_end} ${slip.pay_date} ${teDate(slip.pay_date)}`.toLowerCase().includes(search.trim().toLowerCase()))

  if (loading) return <p className="myhr-empty">Loading your pay…</p>
  if (open) {
    return (
      <div className="te-page">
        <button type="button" className="myhr-back" onClick={() => setOpen(null)}><ArrowLeft size={16} /> All payslips</button>
        <div className="te-detail">
          <div className="te-detail-head">
            <div><span className="te-ref">Pay date {teDate(open.pay_date)}</span><h3>Payslip · {teDates(open.period_start, open.period_end)}</h3><small>{open.employer} · {open.employee_name} · Employee ID {open.personnel_number || '—'}</small></div>
            <div className="te-actions">
              <span className={`te-status ${open.payment_status === 'paid' ? 'paid' : open.payment_status === 'failed' ? 'rejected' : 'submitted'}`}>{PAYMENT[open.payment_status]}</span>
              <button type="button" className="te-secondary" onClick={() => printPayslip(open)}><Printer size={15} /> Print</button>
              <button type="button" className="te-secondary" onClick={() => printPayslip(open)} title="Choose Save as PDF in the print window"><Download size={15} /> Download PDF</button>
            </div>
          </div>
          <Lines title="Earnings" items={open.earnings} showHours />
          <Lines title="Deductions" items={open.deductions} />
          <table className="te-table">
            <tbody>
              <tr><td>Gross earnings</td><td className="num">{teMoney(open.gross)}</td></tr>
              <tr><td>Taxable earnings</td><td className="num">{teMoney(open.taxable)}</td></tr>
              <tr><td>Pensionable earnings</td><td className="num">{teMoney(open.pensionable)}</td></tr>
              <tr><td>Insurable earnings</td><td className="num">{teMoney(open.insurable)}</td></tr>
              <tr><td>Total deductions</td><td className="num">{teMoney(open.total_deductions)}</td></tr>
              <tr className="te-strong"><td>Net pay</td><td className="num">{teMoney(open.net)}</td></tr>
            </tbody>
          </table>
          {(open.employer_contributions || []).length ? <><h4 className="te-h4">Employer contributions (not deducted from your pay)</h4><Lines title="Contribution" items={open.employer_contributions} /></> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="te-page">
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      <div className="te-cards">
        <div className="myhr-pay-card"><span className="myhr-pay-card-label">Pay frequency</span><strong>{FREQUENCY[overview?.pay_frequency] || 'Not set up'}</strong><small>{overview?.organization}</small></div>
        <div className="myhr-pay-card"><span className="myhr-pay-card-label">Current pay period</span><strong>{period ? teDates(iso(period.start), iso(period.end)) : '—'}</strong><small>Next pay date: {nextPay ? teDate(nextPay) : 'not scheduled yet'}</small></div>
        <div className="myhr-pay-card"><span className="myhr-pay-card-label">Most recent pay</span><strong>{overview?.latest ? teMoney(overview.latest.net) : '—'}</strong><small>{overview?.latest ? `Net · gross ${teMoney(overview.latest.gross)} · ${teDate(overview.latest.pay_date)}` : 'No payslips yet'}</small></div>
        <div className="myhr-pay-card"><span className="myhr-pay-card-label">{overview?.year} year to date</span><strong>{teMoney(overview?.ytd_gross)}</strong><small>Gross · deductions {teMoney(overview?.ytd_deductions)}</small></div>
      </div>
      <p className="te-muted">{overview?.employee_name} · Employee ID {overview?.personnel_number || '—'}. Only finalised payroll is shown.</p>

      <div className="te-toolbar">
        <h4 className="te-h4">Payslips</h4>
        <label className="te-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by date" /></label>
      </div>
      <div className="te-table-wrap">
        <table className="te-table clickable">
          <thead><tr><th>Pay period</th><th>Payment date</th><th className="num">Gross</th><th className="num">Deductions</th><th className="num">Net</th><th>Status</th></tr></thead>
          <tbody>
            {shown.length ? shown.map((slip) => (
              <tr key={slip.id} tabIndex={0} onClick={async () => { try { setOpen(await loadPayslip(storeId, slip.id)) } catch (error) { setProblem(error?.message || String(error)) } }}>
                <td>{teDates(slip.period_start, slip.period_end)}{slip.is_reversal ? ' (adjustment)' : ''}</td>
                <td>{teDate(slip.pay_date)}</td>
                <td className="num">{teMoney(slip.gross)}</td>
                <td className="num">{teMoney(slip.total_deductions)}</td>
                <td className="num">{teMoney(slip.net)}</td>
                <td><span className={`te-status ${slip.payment_status === 'paid' ? 'paid' : slip.payment_status === 'failed' ? 'rejected' : 'submitted'}`}>{PAYMENT[slip.payment_status]}</span></td>
              </tr>
            )) : <tr><td colSpan={6} className="te-muted">{slips.length ? 'No payslips match.' : 'No payslips yet. They appear here once your organization finalises a payroll.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const FORM_NAMES = { T4: 'T4 Statement of Remuneration Paid', T4A: 'T4A Statement of Pension, Retirement, Annuity, and Other Income', 'RL-1': 'RL-1 Employment and Other Income (Québec)' }

export function TaxForms({ storeId }) {
  const [docs, setDocs] = useState([])
  const [year, setYear] = useState('')
  const [problem, setProblem] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadTaxDocuments(storeId)
      .then((list) => { setDocs(list); setYear(list[0] ? String(list[0].tax_year) : '') })
      .catch((error) => setProblem(error?.message || String(error)))
      .finally(() => setLoading(false))
  }, [storeId])

  const years = [...new Set(docs.map((doc) => String(doc.tax_year)))]
  const shown = docs.filter((doc) => String(doc.tax_year) === year)
  async function openDoc(doc, print) {
    try {
      const url = await taxDocumentUrl(doc.document_path)
      const win = window.open(url, '_blank', 'noopener')
      if (print && win) setTimeout(() => { try { win.print() } catch { /* the PDF viewer prints itself */ } }, 800)
    } catch (error) {
      setProblem(error?.message || String(error))
    }
  }

  if (loading) return <p className="myhr-empty">Loading your tax forms…</p>
  return (
    <div className="te-page">
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      <p className="te-muted">Official forms your organization has issued to you. They can't be changed; corrections are issued as amended versions and the earlier version stays here.</p>
      {years.length ? (
        <>
          <label className="te-year"><span>Tax year</span><select value={year} onChange={(event) => setYear(event.target.value)}>{years.map((item) => <option key={item}>{item}</option>)}</select></label>
          <div className="te-table-wrap">
            <table className="te-table">
              <thead><tr><th>Form</th><th>Version</th><th>Issued</th><th>Status</th><th /></tr></thead>
              <tbody>
                {shown.map((doc) => (
                  <tr key={doc.id}>
                    <td><FileText size={15} /> {FORM_NAMES[doc.form_type] || doc.form_type}</td>
                    <td>{doc.version}{doc.amends_id ? ' (amended)' : ''}{doc.superseded ? ' · replaced by a newer version' : ''}</td>
                    <td>{teDate(doc.issued_at)}</td>
                    <td><span className={`te-status ${doc.status === 'amended' ? 'returned' : 'approved'}`}>{doc.status === 'amended' ? 'Amended' : 'Issued'}</span></td>
                    <td className="te-row-actions">
                      <button type="button" className="te-link" disabled={!doc.document_path} onClick={() => openDoc(doc, false)}><Download size={14} /> Download</button>
                      <button type="button" className="te-link" disabled={!doc.document_path} onClick={() => openDoc(doc, true)}><Printer size={14} /> Print</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : <p className="myhr-empty">No tax forms have been issued to you yet.</p>}
    </div>
  )
}
