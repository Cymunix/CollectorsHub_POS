import { supabase } from './supabaseClient'

// Reports & Analytics (supabase/reports.sql). Every figure comes from the server's
// rpt_facts calculation layer; exports are built from the same data shown on screen.

async function call(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    const message = error.message || ''
    if (/could not find the function/i.test(message)) throw new Error(`Reports aren't installed in Supabase yet: ${name} wasn't found (run supabase/reports.sql).`)
    throw new Error(message)
  }
  return data
}

const base = (storeId, { from, to, locationId }) => ({ p_store_id: storeId, p_from: from, p_to: to, p_location: locationId || null })
export const reportOverview = (storeId, range, compare) => call('rpt_overview', { ...base(storeId, range), p_compare: compare })
export const reportSales = (storeId, range, employeeId) => call('rpt_sales', { ...base(storeId, range), p_employee: employeeId || null })
export const reportInventory = (storeId, range) => call('rpt_inventory', base(storeId, range))
export const reportCustomers = (storeId, range) => call('rpt_customers', base(storeId, range))
export const reportEmployees = (storeId, range, role) => call('rpt_employees', { ...base(storeId, range), p_role: role || null })
export const reportRegisters = (storeId, range) => call('rpt_registers', base(storeId, range))
export const reportTax = (storeId, range) => call('rpt_tax', base(storeId, range))
export const reportAccounting = (storeId, range) => call('rpt_accounting', base(storeId, range))
export const reportPawn = (storeId, range) => call('rpt_pawn', { p_store_id: storeId, p_from: range.from, p_to: range.to })
export const reportDetail = (storeId, range) => call('rpt_transactions_detail', base(storeId, range))
export const logExport = (storeId, report, format, period, filters) => call('rpt_log_export', { p_store_id: storeId, p_report: report, p_format: format, p_period: period, p_filters: filters || {} })
export const reportAccess = (storeId) => call('rpt_access', { p_store_id: storeId })
export const reportStaff = (storeId) => call('rpt_staff', { p_store_id: storeId })
export const setReportAccess = (storeId, employeeId, permissions) => call('rpt_set_staff_access', { p_store_id: storeId, p_employee_id: employeeId, p_permissions: permissions })

export const REPORT_PERMISSIONS = [
  ['rep_basic', 'Basic sales figures'], ['rep_store', 'Store-wide sales'], ['rep_employees', 'Employee performance'], ['rep_customers', 'Customer analytics'],
  ['rep_inventory', 'Inventory & profitability'], ['rep_registers', 'Register reconciliation'], ['rep_tax', 'Tax & accounting'], ['rep_pawn', 'Pawn financials'], ['rep_export', 'Export reports'],
]

// ── Date ranges (store-local calendar days) ──────────────────────────────────
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
export const RANGES = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This Week'], ['last_week', 'Last Week'], ['this_month', 'This Month'], ['last_month', 'Last Month'],
  ['last_30', 'Last 30 Days'], ['this_quarter', 'This Quarter'], ['last_quarter', 'Last Quarter'], ['this_year', 'This Year'], ['last_year', 'Last Year'], ['custom', 'Custom Range'],
]
export function rangeDates(key, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const monday = addDays(today, -((today.getDay() + 6) % 7))
  const q = Math.floor(today.getMonth() / 3)
  switch (key) {
    case 'today': return [today, today]
    case 'yesterday': return [addDays(today, -1), addDays(today, -1)]
    case 'this_week': return [monday, today]
    case 'last_week': return [addDays(monday, -7), addDays(monday, -1)]
    case 'this_month': return [new Date(today.getFullYear(), today.getMonth(), 1), today]
    case 'last_month': return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0)]
    case 'this_quarter': return [new Date(today.getFullYear(), q * 3, 1), today]
    case 'last_quarter': return [new Date(today.getFullYear(), q * 3 - 3, 1), new Date(today.getFullYear(), q * 3, 0)]
    case 'this_year': return [new Date(today.getFullYear(), 0, 1), today]
    case 'last_year': return [new Date(today.getFullYear() - 1, 0, 1), new Date(today.getFullYear() - 1, 11, 31)]
    default: return [addDays(today, -29), today]
  }
}
export const toIso = iso

// ── Exports ─────────────────────────────────────────────────────────────────
// A report export is a list of sections: { title, columns: [[key, label, 'money'|'number'|'pct'|'text']], rows: [{...}] }.
export function exportCsv(meta, sections) {
  const esc = (value) => { const s = value == null ? '' : String(value); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const lines = [[meta.title], [meta.store], [`Period: ${meta.period}`], [`Generated: ${meta.generated}`], [`Filters: ${meta.filters}`], ['Currency: CAD'], []]
  for (const section of sections) {
    lines.push([section.title])
    lines.push(section.columns.map((c) => c[1]))
    for (const row of section.rows) lines.push(section.columns.map(([key]) => row[key]))
    lines.push([])
  }
  download(`${meta.fileName}.csv`, new Blob(['﻿' + lines.map((line) => line.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }))
}

// A real .xlsx (Office Open XML) with numbers kept as numbers, one sheet per section.
export function exportXlsx(meta, sections) {
  const x = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  const col = (n) => { let s = ''; n += 1; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }
  const cell = (r, c, value, style = 0) => {
    const ref = `${col(c)}${r}`
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${value}</v></c>`
    if (value == null || value === '') return ''
    return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${x(value)}</t></is></c>`
  }
  const sheets = sections.map((section) => {
    const rows = []
    let r = 1
    const head = [meta.title, meta.store, `Period: ${meta.period}`, `Generated: ${meta.generated}`, `Filters: ${meta.filters}`, 'Currency: CAD', section.title]
    head.forEach((text, i) => { rows.push(`<row r="${r}">${cell(r, 0, text, i === 0 || i === head.length - 1 ? 1 : 0)}</row>`); r += 1 })
    rows.push(`<row r="${r}">${section.columns.map((c, i) => cell(r, i, c[1], 1)).join('')}</row>`); r += 1
    for (const row of section.rows) {
      rows.push(`<row r="${r}">${section.columns.map(([key, , type], i) => {
        const v = row[key]
        const num = typeof v === 'number' ? v : (v !== null && v !== '' && !Number.isNaN(Number(v)) && ['money', 'number', 'pct'].includes(type) ? Number(v) : v)
        return cell(r, i, num, type === 'money' && typeof num === 'number' ? 2 : type === 'pct' && typeof num === 'number' ? 3 : 0)
      }).join('')}</row>`)
      r += 1
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${section.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 0 ? 34 : 16}" customWidth="1"/>`).join('')}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`
  })
  const names = sections.map((s, i) => x(String(s.title || `Sheet ${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31)))
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00;[Red]\\-&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="0.0&quot;%&quot;"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf/><xf fontId="1" applyFont="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="165" applyNumberFormat="1"/></cellXfs></styleSheet>',
  }
  sheets.forEach((sheet, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheet })
  download(`${meta.fileName}.xlsx`, new Blob([zip(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
}

// PDF: a formatted page printed through the system dialog ("Save as PDF").
export function exportPdf(meta, sections) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const fmt = (v, type) => (v == null || v === '' ? '—' : type === 'money' ? new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(Number(v)) : type === 'pct' ? `${Number(v).toFixed(1)}%` : type === 'number' ? Number(v).toLocaleString('en-CA') : String(v))
  const body = `<header><div><h1>${esc(meta.title)}</h1><p>${esc(meta.store)}</p></div><div class="meta">Period: ${esc(meta.period)}<br>Generated: ${esc(meta.generated)}<br>Filters: ${esc(meta.filters)}<br>Currency: CAD</div></header>
    ${sections.map((s) => `<h2>${esc(s.title)}</h2><table><thead><tr>${s.columns.map((c) => `<th class="${c[2] === 'text' ? '' : 'n'}">${esc(c[1])}</th>`).join('')}</tr></thead><tbody>${s.rows.length ? s.rows.map((row) => `<tr>${s.columns.map(([key, , type]) => `<td class="${type === 'text' ? '' : 'n'}">${esc(fmt(row[key], type))}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${s.columns.length}">No data for this period.</td></tr>`}</tbody></table>`).join('')}
    <footer>CollectorsHub POS · Reports & Analytics</footer>`
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  doc.open()
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(meta.fileName)}</title><style>
    @page{size:Letter;margin:0.5in} body{font-family:Arial,Helvetica,sans-serif;color:#17253d;font-size:10pt}
    header{display:flex;justify-content:space-between;border-bottom:3px solid #d6a632;padding-bottom:8px;margin-bottom:12px}
    h1{font-size:18pt;margin:0} header p{margin:2px 0;color:#526176} .meta{font-size:9pt;color:#526176;text-align:right}
    h2{font-size:12pt;margin:16px 0 6px;color:#17253d} table{width:100%;border-collapse:collapse;page-break-inside:auto} tr{page-break-inside:avoid}
    th{background:#17253d;color:#fff;text-align:left;padding:5px 6px;font-size:9pt} td{border-bottom:1px solid #e3e8ef;padding:4px 6px;font-size:9pt} .n{text-align:right}
    footer{margin-top:18px;font-size:8pt;color:#9aa8bb;text-align:center}
  </style></head><body>${body}</body></html>`)
  doc.close()
  frame.contentWindow.focus()
  setTimeout(() => { frame.contentWindow.print(); setTimeout(() => frame.remove(), 1500) }, 300)
}

function download(name, blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 1000)
}

// Minimal ZIP (stored, no compression) for the .xlsx package.
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
function zip(files) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name)
    const data = enc.encode(content)
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true)
    local.setUint16(10, 0, true); local.setUint16(12, 0x21, true); local.setUint32(14, crc, true); local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true); local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true)
    parts.push(new Uint8Array(local.buffer), nameBytes, data)
    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true)
    cd.setUint16(12, 0, true); cd.setUint16(14, 0x21, true); cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true)
    cd.setUint16(28, nameBytes.length, true); cd.setUint16(30, 0, true); cd.setUint16(32, 0, true); cd.setUint16(34, 0, true); cd.setUint16(36, 0, true)
    cd.setUint32(38, 0, true); cd.setUint32(42, offset, true)
    central.push(new Uint8Array(cd.buffer), nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, Object.keys(files).length, true); end.setUint16(10, Object.keys(files).length, true)
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0))
  let pos = 0
  for (const part of all) { out.set(part, pos); pos += part.length }
  return out
}
