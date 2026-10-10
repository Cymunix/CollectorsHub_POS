import QRCode from 'qrcode'
import { STATE, storageText } from '../lib/pawnLoans'

// Pawn agreements, receipts and collateral labels, printed through a hidden frame
// (same approach as the Collection Drop-Off receipts).

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const money = (value) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(Number(value || 0))
const qr = (text) => QRCode.toDataURL(String(text), { margin: 1, width: 160, color: { dark: '#0B111B', light: '#FFFFFF' } })

function printHtml(title, body) {
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  doc.open()
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body{font-family:Arial,Helvetica,sans-serif;color:#17253d;margin:24px;font-size:13px}
    h1{font-size:20px;margin:0 0 6px} h2{font-size:15px;margin:18px 0 6px}
    table{border-collapse:collapse;width:100%;font-size:12px} td,th{border:1px solid #c8d2e0;padding:5px;text-align:left;vertical-align:top}
    .muted{color:#5b6b82;font-size:11px} .pa-test,.pa-warning{border:2px solid #b42318;color:#b42318;font-weight:bold;padding:8px;text-align:center}
    .pa-kind{font-weight:bold;color:#5b6b82} .sign{margin-top:30px;display:flex;gap:40px} .sign div{flex:1;border-top:1px solid #17253d;padding-top:4px;font-size:11px}
    .labels{display:grid;grid-template-columns:repeat(2,1fr);gap:12px} .label{border:2px dashed #17253d;padding:10px;display:flex;gap:10px;align-items:center;page-break-inside:avoid}
    .label strong{font-size:16px;display:block} .footer{margin-top:16px;font-size:10px;color:#5b6b82;word-break:break-all}
  </style></head><body>${body}</body></html>`)
  doc.close()
  frame.contentWindow.focus()
  setTimeout(() => { frame.contentWindow.print(); setTimeout(() => frame.remove(), 1500) }, 300)
}

// The agreement exactly as the server stored it (executed copy) or rendered it (for paper signing).
export function printAgreement(html, { title = 'Pawn agreement', sha256 = '', signature = '', signedAt = '' } = {}) {
  printHtml(title, `${html}
    ${signature ? `<p><b>Signed:</b> ${esc(signature)}${signedAt ? ` · ${esc(new Date(signedAt).toLocaleString())}` : ''}</p>` : '<div class="sign"><div>Borrower signature</div><div>Date</div><div>Employee</div></div>'}
    ${sha256 ? `<p class="footer">Executed copy · SHA-256 ${esc(sha256)}</p>` : '<p class="footer">Copy for signing. The executed agreement is the one stored in CollectorsHub POS.</p>'}`)
}

export function printPawnReceipt({ title, loan, customer, store, lines = [], note = '' }) {
  printHtml(title, `
    ${loan.is_test ? '<p class="pa-test">TEST LOAN: not a real transaction</p>' : ''}
    <h1>${esc(title)}</h1>
    <div class="muted">${esc(store || '')} · ${esc(new Date().toLocaleString())}</div>
    <h2>Loan ${esc(loan.loan_number)}</h2>
    <table><tbody>
      <tr><td>Customer</td><td>${esc(customer?.name || '')}${customer?.customer_number ? ` (${esc(customer.customer_number)})` : ''}</td></tr>
      ${lines.map(([label, value]) => `<tr><td>${esc(label)}</td><td>${esc(value)}</td></tr>`).join('')}
      <tr><td>Status</td><td>${esc(STATE[loan.state || loan.status] || loan.status)}</td></tr>
      ${loan.due_date ? `<tr><td>Due date</td><td>${esc(loan.due_date)}</td></tr>` : ''}
    </tbody></table>
    ${note ? `<p>${esc(note)}</p>` : ''}
    <div class="sign"><div>Customer</div><div>Employee</div></div>`)
}

export async function printCollateralLabels(loan, items) {
  const labels = await Promise.all(items.map(async (item) => `<div class="label"><img src="${await qr(item.collateral_code)}" width="110" height="110" alt="">
    <div><strong>${esc(item.collateral_code)}</strong>${esc(item.name)}<br><span class="muted">Loan ${esc(loan.loan_number)} · due ${esc(loan.due_date || '—')}</span><br><span class="muted">${esc(storageText(item.storage) || 'Storage not set')}</span><br><b>PAWN COLLATERAL: NOT FOR SALE</b></div></div>`))
  printHtml(`Collateral labels ${loan.loan_number}`, `<div class="labels">${labels.join('')}</div>`)
}

export { money }
