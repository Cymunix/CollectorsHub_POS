import JsBarcode from 'jsbarcode'

// Prints a shelf/price label (2.25" × 1.25", the common Dymo/Zebra size):
// item name, price, and a scannable Code 128 barcode of its barcode or SKU,
// so the register finds it when scanned. Opens the Windows print dialog.

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

function barcodeSvg(code) {
  if (!code) return ''
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  try {
    JsBarcode(svg, code, { format: 'CODE128', displayValue: true, fontSize: 12, height: 34, margin: 0, width: 1.4 })
  } catch {
    return ''
  }
  return svg.outerHTML
}

export function printItemLabel({ name, price, code, detail = '' }) {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  doc.open()
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>Label</title><style>
    @page { size: 2.25in 1.25in; margin: 0; }
    html, body { margin: 0; }
    body { font-family: Arial, sans-serif; color: #000; }
    .label { box-sizing: border-box; width: 2.25in; height: 1.25in; padding: 0.06in 0.08in; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; }
    .top { display: flex; justify-content: space-between; gap: 6px; align-items: flex-start; }
    .name { font-size: 10pt; font-weight: 700; line-height: 1.1; max-height: 2.2em; overflow: hidden; }
    .price { font-size: 14pt; font-weight: 800; white-space: nowrap; }
    .detail { font-size: 7pt; color: #333; }
    .code { text-align: center; }
    .code svg { max-width: 100%; height: auto; }
  </style></head><body><div class="label">
    <div class="top"><div><div class="name">${escapeHtml(name)}</div>${detail ? `<div class="detail">${escapeHtml(detail)}</div>` : ''}</div><div class="price">${escapeHtml(price)}</div></div>
    <div class="code">${barcodeSvg(code) || `<div class="detail">${escapeHtml(code || 'No SKU')}</div>`}</div>
  </div></body></html>`)
  doc.close()
  const cleanup = () => setTimeout(() => frame.remove(), 500)
  frame.contentWindow.addEventListener('afterprint', cleanup)
  setTimeout(() => {
    frame.contentWindow.focus()
    frame.contentWindow.print()
    // Electron's print() returns once the dialog closes.
    cleanup()
  }, 50)
}
