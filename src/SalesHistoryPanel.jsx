import React, { useEffect, useState } from 'react'
import { loadAllSalesHistory, loadStoreSalesHistory, summariseSales } from './lib/salesHistory'

const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })
const formatDate = (value) => (value ? new Date(value).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : '—')

// A card's sales history, full width on the item screen. scope: 'store'
// (this store's sales) or 'all' (every CollectorsHub sale, all stores plus
// imported market sales).
export default function SalesHistoryList({ storeId, catalogItemId, scope = 'store' }) {
  const [state, setState] = useState({ key: '', rows: null, error: '' })
  const key = `${scope}:${catalogItemId}`

  useEffect(() => {
    if (!catalogItemId) return undefined
    let cancelled = false
    setState({ key, rows: null, error: '' })
    const load = scope === 'store' ? loadStoreSalesHistory(storeId, catalogItemId) : loadAllSalesHistory(catalogItemId)
    load
      .then((rows) => { if (!cancelled) setState({ key, rows, error: '' }) })
      .catch((error) => { if (!cancelled) setState({ key, rows: [], error: error?.message || 'Could not load sales history.' }) })
    return () => { cancelled = true }
  }, [key, storeId])

  if (!catalogItemId) return <p className="sales-history-empty">Sales history needs a catalogue item.</p>
  const rows = state.key === key ? state.rows : null
  if (!rows) return <p className="sales-history-empty">Loading sales…</p>
  if (state.error) return <p className="sales-history-empty">{state.error}</p>
  if (!rows.length) return <p className="sales-history-empty">{scope === 'store' ? 'No sales of this card at this store yet.' : 'No recorded sales of this card yet.'}</p>
  const summary = summariseSales(rows)

  return (
    <section className="sales-history">
      <div className="sales-history-summary">
        <span><b>{summary.units}</b> sold</span>
        <span>Average <b>{summary.average ? money.format(summary.average) : '—'}</b></span>
        <span>Last <b>{summary.last ? `${money.format(summary.last.price)} · ${formatDate(summary.last.soldAt)}` : '—'}</b></span>
      </div>
      <div className="sales-history-table">
        <div className="sales-history-row sales-history-header"><span>Date</span><span>Condition</span><span>Qty</span><span>Price</span><span>{scope === 'store' ? 'Receipt' : 'Source'}</span></div>
        {rows.map((row, index) => (
          <div className="sales-history-row" key={`${row.soldAt}-${index}`}>
            <span>{formatDate(row.soldAt)}</span>
            <span>{row.condition || '—'}</span>
            <span>{row.quantity}</span>
            <span>{row.price ? money.format(row.price) : '—'}</span>
            <span>{scope === 'store' ? row.reference || '—' : row.source}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
