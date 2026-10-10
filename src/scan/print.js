import QRCode from 'qrcode'
import { CUSTODY_STATUS } from '../lib/collectionScanning'

// Intake receipts and container labels for Collection Drop-Off, printed
// through a hidden frame (no extra window).

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const qr = (text) => QRCode.toDataURL(String(text), { margin: 1, width: 180, color: { dark: '#0B111B', light: '#FFFFFF' } })
const when = (value) => (value ? new Date(value).toLocaleString() : '—')
const KIND = { box: 'Box', binder: 'Binder', case: 'Case', bag: 'Bag', other: 'Container' }

function printHtml(title, body) {
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  doc.open()
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body{font-family:Arial,Helvetica,sans-serif;color:#17253d;margin:24px}
    h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:18px 0 6px}
    table{border-collapse:collapse;width:100%;font-size:13px} td,th{border:1px solid #c8d2e0;padding:6px;text-align:left;vertical-align:top}
    .muted{color:#5b6b82;font-size:12px} .head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
    .sign{margin-top:28px;display:flex;gap:40px} .sign div{flex:1;border-top:1px solid #17253d;padding-top:4px;font-size:12px}
    .labels{display:grid;grid-template-columns:repeat(2,1fr);gap:12px} .label{border:2px dashed #17253d;padding:10px;display:flex;gap:10px;align-items:center;page-break-inside:avoid}
    .label strong{font-size:18px;display:block} .note{border:1px solid #d6a632;background:#fff7e8;padding:8px;font-size:12px;margin-top:10px}
  </style></head><body>${body}</body></html>`)
  doc.close()
  frame.contentWindow.focus()
  setTimeout(() => { frame.contentWindow.print(); setTimeout(() => frame.remove(), 1500) }, 300)
}

export async function printIntakeReceipt(data) {
  const { job, collector, store, location, containers = [] } = data
  const code = await qr(job.reference)
  const rows = containers.map((container) => `<tr><td>${esc(container.code)}</td><td>${esc(KIND[container.kind] || container.kind)}${container.description ? `: ${esc(container.description)}` : ''}</td><td>${esc(container.condition_notes || '—')}</td><td>${container.estimated_items != null ? `about ${esc(container.estimated_items)} (estimate)` : '—'}</td><td>${container.returned_at ? `Returned ${esc(when(container.returned_at))}` : 'Held by the store'}</td></tr>`).join('')
  printHtml(`Intake receipt ${job.reference}`, `
    <div class="head">
      <div>
        <h1>Collection intake receipt</h1>
        <div class="muted">${esc(store?.name || '')}${location?.name ? ` · ${esc(location.name)}` : ''}${location?.address ? `<br>${esc(location.address)}` : ''}</div>
      </div>
      <div style="text-align:center"><img src="${code}" width="120" height="120" alt=""><div><strong>${esc(job.reference)}</strong></div></div>
    </div>
    <h2>Collector</h2>
    <table><tr><td>Name</td><td>${esc(collector?.name || '')}</td></tr><tr><td>CollectorsHub account</td><td>@${esc(collector?.username || '')}</td></tr></table>
    <h2>Collection</h2>
    <table>
      <tr><td>Received</td><td>${esc(when(job.received_at))}</td></tr>
      <tr><td>Categories</td><td>${esc((job.categories || []).join(', ') || '—')}</td></tr>
      <tr><td>Estimated items</td><td>${job.estimated_items != null ? `about ${esc(job.estimated_items)} (an estimate, not a verified count)` : 'Not estimated'}</td></tr>
      <tr><td>Handling instructions</td><td>${esc(job.handling_instructions || '—')}</td></tr>
      <tr><td>Customer notes</td><td>${esc(job.customer_notes || '—')}</td></tr>
      <tr><td>Expected completion</td><td>${esc(job.expected_completion || 'Not agreed')}</td></tr>
      <tr><td>Custody</td><td>${esc(CUSTODY_STATUS[job.custody_status] || job.custody_status)}</td></tr>
    </table>
    <h2>Containers</h2>
    <table><tr><th>Code</th><th>Container</th><th>Condition at drop-off</th><th>Items</th><th>Status</th></tr>${rows || '<tr><td colspan="5">None recorded</td></tr>'}</table>
    <h2>Terms and charges</h2>
    <p style="font-size:13px">${esc(job.terms || 'The store scans and identifies the items in this collection and adds them to your CollectorsHub collection under your authorisation. The store holds the containers listed above until you collect them. No charge has been agreed unless written here.')}</p>
    <div class="note">To collect: bring this receipt (or quote ${esc(job.reference)}) to ${esc(store?.name || 'the store')}. Your scanning progress and this receipt are also in your CollectorsHub account.</div>
    <div class="sign"><div>Collector: ${esc(job.received_acknowledged_by || '')}</div><div>Store employee</div><div>Date</div></div>
  `)
}

export async function printContainerLabels(data) {
  const { job, collector, containers = [] } = data
  const labels = await Promise.all(containers.map(async (container) => `
    <div class="label"><img src="${await qr(container.code)}" width="90" height="90" alt="">
      <div><strong>${esc(container.code)}</strong>${esc(KIND[container.kind] || container.kind)}${container.description ? ` · ${esc(container.description)}` : ''}<br>
      <span class="muted">${esc(collector?.name || '')} (@${esc(collector?.username || '')}) · ${esc(job.reference)}</span></div>
    </div>`))
  printHtml(`Labels ${job.reference}`, `<h1>Container labels · ${esc(job.reference)}</h1><div class="labels">${labels.join('') || '<p>No containers recorded.</p>'}</div>`)
}
