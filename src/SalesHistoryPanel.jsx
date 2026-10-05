import React, { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { loadAllSalesHistory, loadStoreSalesHistory, summariseSales } from './lib/salesHistory'

const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })
const formatDate = (value) => (value ? new Date(value).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : '—')

// Sales history for the selected card: this store's sales, or every
// CollectorsHub sale (all stores, plus imported market sales).
export default function SalesHistoryPanel({ storeId, catalogItemId, name }) {
  const [tab, setTab] = useState('store')
  const [rows, setRows] = useState({ store: null, all: null })
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    setRows({ store: null, all: null })
    setError('')
  }, [catalogItemId])

  useEffect(() => {
    if (!catalogItemId || rows[tab]) return undefined
    let cancelled = false
    const load = tab === 'store' ? loadStoreSalesHistory(storeId, catalogItemId) : loadAllSalesHistory(catalogItemId)
    load
      .then((next) => { if (!cancelled) setRows((current) => ({ ...current, [tab]: next })) })
      .catch((loadError) => { if (!cancelled) { setError(loadError?.message || 'Could not load sales history.'); setRows((current) => ({ ...current, [tab]: [] })) } })
    return () => { cancelled = true }
  }, [catalogItemId, storeId, tab, rows])

  if (!catalogItemId) return <section className="sales-history"><p className="sales-history-empty">Sales history needs a catalogue item.</p></section>
  const list = rows[tab]
  const summary = summariseSales(list || [])

  const table = (items) => (
    <div className="sales-history-table">
      <div className="sales-history-row sales-history-header"><span>Date</span><span>Condition</span><span>Qty</span><span>Price</span><span>{tab === 'store' ? 'Receipt' : 'Source'}</span></div>
      {items.map((row, index) => (
        <div className="sales-history-row" key={`${row.soldAt}-${index}`}>
          <span>{formatDate(row.soldAt)}</span>
          <span>{row.condition || '—'}</span>
          <span>{row.quantity}</span>
          <span>{row.price ? money.format(row.price) : '—'}</span>
          <span>{tab === 'store' ? row.reference || '—' : row.source}</span>
        </div>
      ))}
    </div>
  )

  return (
    <section className="sales-history">
      <div className="sales-history-head">
        <strong>Sales history</strong>
        <span className="sales-history-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'store'} className={tab === 'store' ? 'active' : ''} onClick={() => setTab('store')}>This store</button>
          <button type="button" role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>All CollectorsHub</button>
        </span>
      </div>
      {!list ? <p className="sales-history-empty">Loading…</p> : null}
      {error ? <p className="sales-history-empty">{error}</p> : null}
      {list && !list.length && !error ? <p className="sales-history-empty">{tab === 'store' ? 'No sales of this card at this store yet.' : 'No recorded sales of this card yet.'}</p> : null}
      {list && list.length ? (
        <>
          <div className="sales-history-summary">
            <span><b>{summary.units}</b> sold</span>
            <span>Average <b>{summary.average ? money.format(summary.average) : '—'}</b></span>
            <span>Last <b>{summary.last ? `${money.format(summary.last.price)} · ${formatDate(summary.last.soldAt)}` : '—'}</b></span>
          </div>
          {table(list.slice(0, 6))}
          <button type="button" className="sales-history-more" onClick={() => setShowAll(true)}>View all {list.length} sale{list.length === 1 ? '' : 's'}</button>
        </>
      ) : null}
      {showAll && list ? (
        <div className="register-modal sales-history-modal" role="dialog" aria-modal="true" onClick={(event) => { if (event.target === event.currentTarget) setShowAll(false) }}>
          <section>
            <div className="sales-history-modal-head">
              <span>
                <h2>{name || 'Item'}: sales history</h2>
                <small>{tab === 'store' ? 'This store' : 'All CollectorsHub sales'} · {summary.units} sold · average {summary.average ? money.format(summary.average) : '—'}</small>
              </span>
              <button type="button" className="modal-close" onClick={() => setShowAll(false)} aria-label="Close"><X size={18} /></button>
            </div>
            {table(list)}
          </section>
        </div>
      ) : null}
    </section>
  )
}
