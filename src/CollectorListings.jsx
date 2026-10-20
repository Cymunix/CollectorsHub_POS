import React, { useEffect, useState } from 'react'
import { RefreshCw, Search, Tag } from 'lucide-react'
import { loadCollectorListings } from './lib/collectorListings'

const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })

const listedDate = (value) => {
  if (!value) return ''
  try { return new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) } catch { return '' }
}

// Copies collectors have listed for sale on CollectorsHub, marked with how many of this store's
// customers are looking for the item: buying opportunities for the store.
export default function CollectorListings({ session }) {
  const storeId = session?.storeId
  const [filter, setFilter] = useState('wanted')
  const [search, setSearch] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!storeId) return undefined
    let cancelled = false
    const timer = window.setTimeout(() => {
      setLoading(true)
      loadCollectorListings(storeId, { filter, search })
        .then((next) => { if (!cancelled) { setResult(next); setError('') } })
        .catch((loadError) => { if (!cancelled) setError(loadError?.message || 'Could not load collector listings.') })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [storeId, filter, search, reload])

  const rows = result?.rows || []
  return (
    <section className="cl-page">
      <header className="cl-head">
        <div>
          <p className="cl-kicker">Buying opportunities</p>
          <h1>Collector Listings</h1>
          <p className="cl-intro">Items collectors have listed for sale on CollectorsHub. Items your customers are looking for are marked, with the average price they'd pay.</p>
        </div>
        <button type="button" className="cl-refresh" onClick={() => setReload((n) => n + 1)} disabled={loading}><RefreshCw size={15} /> Refresh</button>
      </header>

      <div className="cl-filters">
        <div className="cl-tabs">
          <button type="button" className={filter === 'wanted' ? 'active' : ''} onClick={() => setFilter('wanted')}>Customers looking</button>
          <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All listings</button>
        </div>
        <label className="cl-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search item name or card number" /></label>
        <span className="cl-count">{loading ? 'Loading…' : result ? `${rows.length} shown · ${result.totalListed} listed on CollectorsHub` : ''}</span>
      </div>

      {error ? <p className="cl-error">{error}</p> : null}

      {result && !rows.length && !error ? (
        <div className="cl-empty">
          <Tag size={26} />
          <strong>{filter === 'wanted' ? 'No listings your customers are looking for' : 'No collector listings'}</strong>
          <span>{filter === 'wanted' ? 'When a collector lists an item that one of your customers has on their wishlist, it shows up here.' : 'Nothing is listed for sale on CollectorsHub right now.'}</span>
        </div>
      ) : null}

      {rows.length ? (
        <div className="cl-list">
          {rows.map((row) => {
            const photo = row.frontImageUrl || row.itemImageUrl
            const grade = [row.grading_company, row.grade].filter(Boolean).join(' ')
            return (
              <article key={row.copy_id} className={`cl-card${row.wanted_members ? ' wanted' : ''}`}>
                {photo ? <img src={photo} alt="" /> : <span className="cl-noimage" />}
                <div className="cl-body">
                  <strong>{[row.name || 'Catalogue item', row.card_number ? `#${row.card_number}` : '', row.release_year ? `(${row.release_year})` : ''].filter(Boolean).join(' ')}</strong>
                  <small>{[row.category, grade || row.condition].filter(Boolean).join(' · ')}</small>
                  {row.wanted_members ? (
                    <span className="wanted-badge" title={row.wanted_priced ? `Average of the prices ${row.wanted_priced} of ${row.wanted_members} customer${row.wanted_members === 1 ? '' : 's'} said they'd pay.` : "None of them has set a price they'd pay yet."}>
                      ♥ {row.wanted_members} customer{row.wanted_members === 1 ? '' : 's'} looking{row.wanted_priced && row.wanted_average_price != null ? ` · avg ${money.format(Number(row.wanted_average_price))}` : ''}
                    </span>
                  ) : null}
                  <small className="cl-seller">Listed by {row.seller_username ? `@${row.seller_username}` : 'a CollectorsHub member'}{row.seller_area ? ` · ${row.seller_area}` : ''}{row.listed_at ? ` · ${listedDate(row.listed_at)}` : ''}</small>
                </div>
                <div className="cl-price">
                  <span>Asking</span>
                  <strong>{row.asking_price != null ? money.format(Number(row.asking_price)) : '—'}</strong>
                  <small>{row.store_in_stock ? `You have ${row.store_in_stock} in stock` : 'Not in your stock'}</small>
                </div>
              </article>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
