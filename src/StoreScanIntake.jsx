import React, { useEffect, useRef, useState } from 'react'
import { ScanLine, Search, X } from 'lucide-react'
import { analyseRecognizedCard } from './lib/adminData'
import { searchDesktopTradeCatalogue } from './lib/registerBackend'
import { addScannedCardToStock, CARD_CONDITIONS } from './lib/storeScan'
import ConditionHint from './ConditionHint'
import { readScannerPref, writeScannerPref } from './AdminWorkspace'

// Store scan intake (store staff): scan cards on the FastFoto or flatbed, the
// local AI identifies them, each is matched to the catalogue, and matched
// cards are added to this store's stock with a condition, quantity and price.
// Cards the catalogue doesn't have are never created here - staff can search
// for the right item or skip the card.

const STATUS_TEXT = {
  queued: 'Waiting for the AI',
  analysing: 'Identifying…',
  ready: 'Ready to add',
  choose: 'Pick the right item',
  unmatched: 'Not in the catalogue',
  failed: 'Couldn\'t identify',
  adding: 'Adding…',
  added: 'Added to stock',
  skipped: 'Skipped',
}

function api() {
  return window.nordvikDesktop || {}
}

function newId() {
  return `scan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function cardTitle(result = {}) {
  return [result.subject, result.id_number ? `#${String(result.id_number).replace(/^(no\.?|#)\s*/i, '')}` : ''].filter(Boolean).join(' ') || 'Unidentified card'
}

function itemLabel(item = {}) {
  return [item.name || item.subject, item.card_number ? `#${item.card_number}` : '', item.release_year].filter(Boolean).join(' · ')
}

export default function StoreScanIntake({ session, savedQueue = [], onSaveQueue = () => {}, onStockChanged = () => {} }) {
  const [cards, setCards] = useState(savedQueue)
  const cardsRef = useRef(savedQueue)
  const [category, setCategory] = useState(() => readScannerPref('storeCategory', 'Sports Cards'))
  const [defaults, setDefaults] = useState(() => ({ condition: 'Near Mint', sellPrice: '', buyPrice: '', ...readScannerPref('storeDefaults', {}) }))
  const [scanner, setScanner] = useState({ state: 'connecting' })
  const [feed, setFeed] = useState(null)
  const [canonSide, setCanonSide] = useState(null)
  const [aiState, setAiState] = useState('checking')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [searching, setSearching] = useState(null)
  const analysingRef = useRef(false)
  const categoryRef = useRef(category)
  categoryRef.current = category

  useEffect(() => { writeScannerPref('storeCategory', category) }, [category])
  useEffect(() => { writeScannerPref('storeDefaults', defaults) }, [defaults])

  // The queue survives leaving the page and restarting the app.
  function save(update) {
    const next = update(cardsRef.current)
    cardsRef.current = next
    setCards(next)
    onSaveQueue(next)
  }
  const patch = (id, changes) => save((list) => list.map((card) => (card.id === id ? { ...card, ...changes } : card)))

  useEffect(() => {
    const desktop = api()
    desktop.getAiStatus?.().then((status) => setAiState(status?.state || 'error')).catch(() => setAiState('error'))
    const offStatus = desktop.onScannerStatus?.((status) => setScanner(status))
    desktop.openScannerSession?.()
      .then((status) => { if (status?.state) setScanner(status) })
      .catch(() => setScanner({ state: 'unavailable' }))
      // The FastFoto is looked for separately (it may be the only scanner).
      .finally(() => checkFeeder())
    const offCard = desktop.onFeedCard?.((card) => {
      addCard({ frontImage: card.frontImage, backImage: card.backImage, feed: card.feed })
      setFeed((current) => (current ? { ...current, cards: (current.cards || 0) + 1 } : current))
    })
    const offProgress = desktop.onFeedProgress?.((progress) => setFeed((current) => (current ? { ...current, pages: progress.pages } : current)))
    // Cards left mid-analysis go back in the line.
    save((list) => list.map((card) => (card.status === 'analysing' ? { ...card, status: 'queued' } : card)))
    return () => { offStatus?.(); offCard?.(); offProgress?.(); desktop.closeScannerSession?.() }
  }, [])

  useEffect(() => { if (aiState === 'ready') analyseQueued() }, [aiState])

  async function checkFeeder() {
    const status = await api().refreshFeeder?.().catch(() => null)
    if (status) setScanner((current) => ({ ...current, ...status }))
    return status
  }

  function addCard({ frontImage, backImage = null, feed: feedInfo = null }) {
    const card = {
      id: newId(),
      createdAt: new Date().toISOString(),
      status: 'queued',
      frontImage,
      backImage,
      feed: feedInfo,
      category: categoryRef.current,
      condition: defaults.condition,
      quantity: 1,
      sellPrice: defaults.sellPrice,
      buyPrice: defaults.buyPrice,
    }
    save((list) => [card, ...list])
    analyseQueued()
  }

  // One card at a time (the GPU runs one vision request at a time).
  async function analyseQueued() {
    if (analysingRef.current) return
    analysingRef.current = true
    try {
      for (;;) {
        const card = [...cardsRef.current].reverse().find((entry) => entry.status === 'queued')
        if (!card) break
        patch(card.id, { status: 'analysing', error: '' })
        const response = await api().recognizeCard({
          jobId: card.id,
          front: card.frontImage || null,
          back: card.backImage || null,
          // Quick identify: name, number, set and year to find the card in
          // the catalogue (stores never create catalogue items).
          mode: 'identify',
          category: card.category,
        }).catch((recognizeError) => ({ ok: false, message: recognizeError.message }))
        if (!response?.ok) {
          patch(card.id, { status: 'failed', error: response?.message || 'The local AI could not read this card.' })
          if (['OLLAMA_UNAVAILABLE', 'MODEL_MISSING'].includes(response?.code)) { setAiState('error'); break }
          continue
        }
        const images = response.orientation?.images
        const fixed = images ? { frontImage: images.front, backImage: images.back } : {}
        try {
          const { scanAnalysis } = await analyseRecognizedCard(response.result, card.category)
          const best = scanAnalysis.matchStatus === 'exact' ? scanAnalysis.bestMatch : null
          const candidates = (scanAnalysis.candidates || []).slice(0, 8).map((candidate) => ({ item: candidate.item, score: candidate.score, differences: candidate.differences }))
          patch(card.id, {
            ...fixed,
            result: response.result,
            candidates,
            // A likely match is preselected but still needs a staff check.
            item: best?.item ? pickItem(best.item) : scanAnalysis.matchStatus === 'likely' && scanAnalysis.bestMatch?.item ? pickItem(scanAnalysis.bestMatch.item) : null,
            status: best ? 'ready' : candidates.length ? 'choose' : 'unmatched',
          })
          // The AI's suggested condition, unless staff already chose one.
          const suggested = response.result?.suggested_condition
          if (suggested) {
            save((list) => list.map((entry) => (entry.id === card.id
              ? { ...entry, conditionSuggestion: { condition: suggested, notes: response.result.condition_notes || [] }, ...(entry.conditionTouched ? {} : { condition: suggested }) }
              : entry)))
          }
        } catch (matchError) {
          patch(card.id, { ...fixed, result: response.result, status: 'unmatched', error: `Catalogue lookup failed: ${matchError.message}` })
        }
      }
    } finally {
      analysingRef.current = false
    }
  }

  // Only what stock needs from a catalogue item (kept small in the saved queue).
  function pickItem(item) {
    return { item_id: item.item_id, name: item.name, subject: item.subject, card_number: item.card_number, release_year: item.release_year, imageUrl: item.imageUrl || '' }
  }

  async function scanStack() {
    setError('')
    setMessage('')
    setFeed({ running: true, pages: 0, cards: 0 })
    if (aiState === 'ready') api().warmUpAi?.()
    try {
      const result = await api().feedStack({ loadFaceDown: readScannerPref('feedFaceDown', true), category: categoryRef.current })
      setFeed((current) => ({ ...current, running: false }))
      if (!result.ok) setError(result.message || 'The FastFoto scan failed.')
      else if (result.code) setError(`${result.cards} card${result.cards === 1 ? '' : 's'} scanned, then: ${result.message}`)
      else setMessage(`${result.cards} card${result.cards === 1 ? '' : 's'} scanned.`)
    } catch (feedError) {
      setFeed((current) => ({ ...current, running: false }))
      setError(feedError.message || 'The FastFoto scan failed.')
    }
  }

  // Flatbed: front, then back.
  async function scanCanon(side) {
    setError('')
    try {
      const image = await api().scanImage({ scanMode: 'card', cardPosition: readScannerPref('cardPosition', 'top-left'), customPosition: readScannerPref('customPosition', { x: 0, y: 0 }) })
      if (!image || image.canceled || image.needsSelection) return
      if (side === 'front') {
        setCanonSide({ frontImage: image })
        setMessage('Front scanned. Turn the card over and scan the back.')
      } else {
        addCard({ frontImage: canonSide.frontImage, backImage: image })
        setCanonSide(null)
        setMessage('Card scanned.')
      }
    } catch (scanError) {
      setError(scanError.message || 'The scanner failed.')
    }
  }

  async function addToStock(card) {
    patch(card.id, { status: 'adding', error: '' })
    try {
      const outcome = await addScannedCardToStock({ session, item: card.item, condition: card.condition, quantity: card.quantity, sellPrice: card.sellPrice, buyPrice: card.buyPrice })
      patch(card.id, { status: 'added', addedAt: new Date().toISOString(), inventoryId: outcome.inventoryId, addedAsNew: outcome.created })
      return true
    } catch (addError) {
      patch(card.id, { status: 'ready', error: addError.message || 'Could not add this card to stock.' })
      return false
    }
  }

  async function addAllReady() {
    const ready = cardsRef.current.filter((card) => card.status === 'ready')
    let added = 0
    for (const card of ready) if (await addToStock(card)) added += 1
    setMessage(`Added ${added} card${added === 1 ? '' : 's'} to stock${added < ready.length ? `; ${ready.length - added} need a look` : ''}.`)
    if (added) onStockChanged()
  }

  function applyDefaultsToWaiting(changes) {
    setDefaults((current) => ({ ...current, ...changes }))
    // A condition chosen for the batch is staff's call: the AI's suggestion
    // no longer replaces it.
    const touched = 'condition' in changes ? { conditionTouched: true } : {}
    save((list) => list.map((card) => (['added', 'adding', 'skipped'].includes(card.status) ? card : { ...card, ...changes, ...touched })))
  }

  const counts = cards.reduce((acc, card) => ({ ...acc, [card.status]: (acc[card.status] || 0) + 1 }), {})
  const visible = cards.filter((card) => card.status !== 'added' && card.status !== 'skipped')
  const done = cards.filter((card) => card.status === 'added')
  const feederName = scanner.feederName || ''
  const flatbedReady = Boolean(scanner.scannerName) && ['ready', 'scanning', 'processing'].includes(scanner.state)
  const busy = Boolean(feed?.running)

  return (
    <section className="store-scan">
      <div className="store-scan-head">
        <div>
          <p className="store-scan-kicker">Scan to inventory · {session?.storeName || 'Store'}</p>
          <h2>Scan cards into stock</h2>
          <small>Cards are identified by the local AI and matched to the catalogue. Matched cards go into this store's stock; cards the catalogue doesn't have are never created here.</small>
        </div>
        <span className={`store-scan-ai ${aiState}`}>{aiState === 'ready' ? 'AI ready' : aiState === 'checking' ? 'Checking AI…' : 'AI unavailable'}</span>
      </div>

      <div className="store-scan-controls">
        <label>Category
          <select value={category} onChange={(event) => setCategory(event.target.value)} disabled={busy}>
            <option>Sports Cards</option>
            <option>Trading Cards</option>
          </select>
        </label>
        <label>Condition
          <select value={defaults.condition} onChange={(event) => applyDefaultsToWaiting({ condition: event.target.value })}>
            {CARD_CONDITIONS.map((condition) => <option key={condition}>{condition}</option>)}
          </select>
        </label>
        <label>Sell price (each)
          <input inputMode="decimal" value={defaults.sellPrice} onChange={(event) => applyDefaultsToWaiting({ sellPrice: event.target.value })} placeholder="e.g. 0.50" />
        </label>
        <label>Buy price (each)
          <input inputMode="decimal" value={defaults.buyPrice} onChange={(event) => applyDefaultsToWaiting({ buyPrice: event.target.value })} placeholder="optional" />
        </label>
      </div>

      <div className="store-scan-actions">
        {feederName ? (
          busy
            ? <button type="button" onClick={() => api().cancelFeed?.()}>Stop after this card ({Math.floor((feed?.pages || 0) / 2)} scanned)</button>
            : <button type="button" className="primary" onClick={scanStack}><ScanLine size={16} /> Scan stack ({feederName})</button>
        ) : null}
        {/* The flatbed only when one is connected; the FastFoto is the main scanner. */}
        {flatbedReady ? (
          <button type="button" className={feederName ? '' : 'primary'} onClick={() => scanCanon(canonSide ? 'back' : 'front')} disabled={busy}>{canonSide ? 'Scan back (flatbed)' : `Scan front (${scanner.scannerName || 'flatbed'})`}</button>
        ) : null}
        {canonSide ? <button type="button" onClick={() => setCanonSide(null)}>Cancel card</button> : null}
        {!feederName && !flatbedReady ? (
          <>
            <span className="store-scan-error">{scanner.state === 'connecting' ? 'Looking for the scanner…' : 'No scanner found. Connect and turn on the FastFoto.'}</span>
            <button type="button" onClick={checkFeeder} disabled={scanner.state === 'connecting'}>Check again</button>
          </>
        ) : null}
        <span className="store-scan-counts">
          {counts.queued || counts.analysing ? `${(counts.queued || 0) + (counts.analysing || 0)} identifying · ` : ''}
          {counts.ready || 0} ready · {(counts.choose || 0) + (counts.unmatched || 0) + (counts.failed || 0)} need a look · {done.length} added
        </span>
        {counts.ready ? <button type="button" className="primary" onClick={addAllReady}>Add {counts.ready} ready to stock</button> : null}
      </div>
      {message ? <p className="store-scan-message">{message}</p> : null}
      {error ? <p className="store-scan-error">{error}</p> : null}

      <div className="store-scan-list">
        {!visible.length ? <p className="store-scan-empty">Scan a stack or a single card to start.</p> : null}
        {visible.map((card) => (
          <div key={card.id} className={`store-scan-card ${card.status}`}>
            {card.frontImage?.url ? <img src={card.frontImage.url} alt="" /> : <span className="store-scan-noimage" />}
            <div className="store-scan-card-body">
              <strong>{card.result ? cardTitle(card.result) : STATUS_TEXT[card.status]}</strong>
              <small>{card.result ? [card.result.release_year, card.result.property || card.result.subfranchise, card.result.parallel].filter(Boolean).join(' · ') : ''}</small>
              <span className={`store-scan-status ${card.status}`}>{STATUS_TEXT[card.status]}</span>
              {card.item ? <span className="store-scan-match">Catalogue: {itemLabel(card.item)}</span> : null}
              {card.status === 'choose' ? (
                <select value="" onChange={(event) => { const chosen = card.candidates.find((candidate) => candidate.item.item_id === event.target.value); if (chosen) patch(card.id, { item: pickItem(chosen.item), status: 'ready' }) }}>
                  <option value="">Choose the matching item…</option>
                  {card.candidates.map((candidate) => <option key={candidate.item.item_id} value={candidate.item.item_id}>{itemLabel(candidate.item)} ({candidate.score}%)</option>)}
                </select>
              ) : null}
              {['choose', 'unmatched', 'ready'].includes(card.status) ? (
                <button type="button" className="link" onClick={() => setSearching({ cardId: card.id, query: card.result?.subject || '', results: null })}><Search size={13} /> {card.item ? 'Wrong item? Search' : 'Search the catalogue'}</button>
              ) : null}
              {card.error ? <span className="store-scan-error">{card.error}</span> : null}
            </div>
            {['ready', 'choose', 'unmatched'].includes(card.status) ? (
              <div className="store-scan-card-fields">
                <span className="store-scan-condition">
                  <select value={card.condition} onChange={(event) => patch(card.id, { condition: event.target.value, conditionTouched: true })}>
                    {CARD_CONDITIONS.map((condition) => <option key={condition}>{condition}</option>)}
                  </select>
                  <ConditionHint suggestion={card.conditionSuggestion} current={card.condition} />
                </span>
                <input type="number" min="1" value={card.quantity} onChange={(event) => patch(card.id, { quantity: event.target.value })} title="Quantity" />
                <input inputMode="decimal" value={card.sellPrice} onChange={(event) => patch(card.id, { sellPrice: event.target.value })} placeholder="Price" title="Sell price" />
              </div>
            ) : null}
            <div className="store-scan-card-actions">
              {card.status === 'ready' ? <button type="button" className="primary" onClick={async () => { if (await addToStock(card)) onStockChanged() }}>Add</button> : null}
              {card.status === 'failed' ? <button type="button" onClick={() => { patch(card.id, { status: 'queued', error: '' }); analyseQueued() }}>Retry</button> : null}
              {!['adding', 'analysing'].includes(card.status) ? <button type="button" onClick={() => patch(card.id, { status: 'skipped' })}>Skip</button> : null}
            </div>
          </div>
        ))}
      </div>

      {done.length ? (
        <details className="store-scan-done">
          <summary>{done.length} added to stock this session</summary>
          <ul>{done.slice(0, 200).map((card) => <li key={card.id}>{itemLabel(card.item)} · {card.condition} · ×{card.quantity}{card.sellPrice ? ` · $${card.sellPrice}` : ''}{card.addedAsNew ? '' : ' (quantity added to existing stock)'}</li>)}</ul>
          <button type="button" onClick={() => save((list) => list.filter((card) => !['added', 'skipped'].includes(card.status)))}>Clear finished</button>
        </details>
      ) : null}

      {searching ? (
        <CatalogueSearchDialog
          initialQuery={searching.query}
          onClose={() => setSearching(null)}
          onPick={(item) => { patch(searching.cardId, { item: pickItem(item), status: 'ready', error: '' }); setSearching(null) }}
        />
      ) : null}
    </section>
  )
}

// Manual catalogue search for a card the AI couldn't match.
function CatalogueSearchDialog({ initialQuery, onClose, onPick }) {
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState(null)
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    try { setResults(await searchDesktopTradeCatalogue(query)) } catch { setResults([]) } finally { setBusy(false) }
  }
  useEffect(() => { if (initialQuery && initialQuery.length >= 2) run() }, [])

  return (
    <div className="register-modal store-scan-search" role="dialog" aria-modal="true">
      <section>
        <div className="store-scan-head">
          <h2>Find the catalogue item</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); run() }} className="store-scan-search-form">
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, card number, set…" />
          <button type="submit" disabled={busy || query.trim().length < 2}>{busy ? 'Searching…' : 'Search'}</button>
        </form>
        <div className="store-scan-search-results">
          {results && !results.length ? <p>No catalogue items found. Cards the catalogue doesn't have can't be added here; skip it for now.</p> : null}
          {(results || []).map((item) => (
            <button type="button" key={item.item_id} onClick={() => onPick(item)}>
              <strong>{item.name || item.subject}</strong>
              <small>{[item.card_number ? `#${item.card_number}` : '', item.release_year].filter(Boolean).join(' · ')}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
