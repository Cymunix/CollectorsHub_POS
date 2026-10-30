import React, { useEffect, useRef, useState } from 'react'
import { ScanLine, Search, X } from 'lucide-react'
import { analyseRecognizedCard, catalogueFrontPhotoUrl } from './lib/adminData'
import { searchDesktopTradeCatalogue } from './lib/registerBackend'
import { sendWishlistAlerts, useWishlistDemand, wantedLabel, wantedTitle } from './lib/wishlistDemand'
import { addScannedCardToStock, COLLECTION_CONDITIONS } from './lib/storeScan'
import { useMtgSetIcons } from './lib/mtgSetIcons'
import { CARD_CONDITIONS, DEFAULT_RAW_CONDITION, GRADED, canonicalRawCondition } from './lib/cardCondition'
import ConditionHint from './ConditionHint'
import SlabCertFields from './SlabCertFields'
import { needsSideCheck, needsUprightCheck, readScannerPref, writeScannerPref } from './lib/scanHelpers'

// Store scan intake (store staff): scan cards on the FastFoto or flatbed, the
// local AI identifies them, each is matched to the catalogue, and matched
// cards are added to this store's stock as Ungraded or Graded (with the
// slab's grading company, grade and cert), with a quantity and price.
// Cards the catalogue doesn't have are never created here - staff can search
// for the right item or skip the card.
//
// The same screen scans into a collector's collection (Scan Centre ->
// Collector Collection): pass a destination, and cards are saved as draft
// entries on the collector's intake job instead of going into stock (no
// prices; unidentified cards can be saved for review). Without a destination
// it's the store stock intake, unchanged.

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

// "Abundant Harvest · #147 · Modern Horizons · 2019 · Foil": the set (Property, or a trading
// card set's Subfranchise) tells apart the same card printed in different releases.
function itemLabel(item = {}) {
  const variant = [item.dynamic_fields?.collection, item.dynamic_fields?.parallel, item.dynamic_fields?.finish].map((value) => String(value || '').trim()).filter(Boolean).join(' ')
  return [item.name || item.subject, item.card_number ? `#${item.card_number}` : '', item.set_name || item._set_name, item.release_year, variant].filter(Boolean).join(' · ')
}

// Matching order: 1. the card's name, 2. its card number, 3. the image. Printings
// that pass both (another collection, parallel or finish of the same card) are told
// apart by comparing the scan's front with each one's catalogue photo.
async function pickVariantByPhoto(frontImage, candidates) {
  const compare = api().compareScanWithPhoto
  if (typeof compare !== 'function' || !frontImage) return null
  const printings = candidates
    .filter((candidate) => candidate.reasons?.includes('Same player/subject') && candidate.reasons?.includes('Same card number'))
    .slice(0, 8)
  if (printings.length < 2) return null
  const similar = []
  for (const candidate of printings) {
    const photoUrl = candidate.item.imageUrl || await catalogueFrontPhotoUrl(candidate.item.item_id).catch(() => '')
    if (!photoUrl) continue
    const check = await compare(frontImage, photoUrl).catch(() => null)
    if (check?.ok && check.similar) similar.push({ candidate, overall: check.overall })
  }
  similar.sort((a, b) => a.overall - b.overall)
  return similar[0]?.candidate || null
}

// Cards that are done with (added to stock or skipped).
const isFinished = (card) => card.status === 'added' || card.status === 'skipped'
const canRecheck = (card) => Boolean(card.frontImage) && ['ready', 'choose', 'unmatched', 'failed'].includes(card.status)

export default function StoreScanIntake({ session, savedQueue = [], onSaveQueue = () => {}, onStockChanged = () => {}, destination = null }) {
  // A destination saves cards somewhere other than stock. destination.stock
  // keeps the store-stock fields (Ungraded/Graded, slab cert, price) - the
  // onboarding queue; otherwise it's a collector's collection.
  const toDestination = Boolean(destination)
  const toCollection = toDestination && !destination.stock
  const statusText = (status) => (toDestination && status === 'ready' ? 'Ready to save' : toDestination && status === 'added' ? (destination.addedLabel || 'Saved') : toDestination && status === 'adding' ? 'Saving…' : STATUS_TEXT[status])
  // Coming back to the screen starts clean: finished cards from last time are
  // cleared; cards still waiting (identifying, ready, need a look) are kept.
  const setIcon = useMtgSetIcons()
  const [startQueue] = useState(() => savedQueue.filter((card) => !isFinished(card)))
  const [cards, setCards] = useState(startQueue)
  const cardsRef = useRef(startQueue)
  useEffect(() => { if (startQueue.length !== savedQueue.length) onSaveQueue(startQueue) }, [])
  const [category, setCategory] = useState(() => readScannerPref('storeCategory', 'Sports Cards'))
  const [defaults, setDefaults] = useState(() => {
    const { condition, ...saved } = readScannerPref('storeDefaults', {})
    return { sellPrice: '', buyPrice: '', ...saved }
  })
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
  // The feeder's listener is set up once, so it reads the batch defaults
  // (sell and buy price) through a ref to get the current ones.
  const defaultsRef = useRef(defaults)
  defaultsRef.current = defaults

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
      // Store stock: Ungraded unless staff mark it Graded. Collection: the
      // batch's condition when one is set, otherwise set by the AI once the card
      // is identified (test stores); staff can change it.
      condition: toCollection ? (defaultsRef.current.collectionCondition || '') : DEFAULT_RAW_CONDITION,
      conditionTouched: toCollection && Boolean(defaultsRef.current.collectionCondition),
      quantity: 1,
      sellPrice: defaultsRef.current.sellPrice,
      buyPrice: defaultsRef.current.buyPrice,
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
          checkSides: card.recheckOrientation ? Boolean(card.backImage) : needsSideCheck(card),
          checkUpright: card.recheckOrientation ? { front: Boolean(card.frontImage), back: Boolean(card.backImage) } : needsUprightCheck(card),
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
          const photoPick = await pickVariantByPhoto(fixed.frontImage || card.frontImage, scanAnalysis.candidates || [])
          const ranked = photoPick ? [photoPick, ...(scanAnalysis.candidates || []).filter((candidate) => candidate !== photoPick)] : scanAnalysis.candidates || []
          const candidates = ranked.slice(0, 8).map((candidate) => ({ item: candidate.item, score: candidate.score, differences: candidate.differences, photoMatch: candidate === photoPick }))
          const preselected = photoPick?.item || best?.item || (scanAnalysis.matchStatus === 'likely' ? scanAnalysis.bestMatch?.item : null)
          patch(card.id, {
            ...fixed,
            recheckOrientation: false,
            result: response.result,
            candidates,
            // A likely or photo-picked match is preselected but still needs a staff check
            // (a photo pick that agrees with the exact match is ready).
            item: preselected ? pickItem(preselected) : null,
            status: best && (!photoPick || photoPick.item.item_id === best.item.item_id) ? 'ready' : candidates.length ? 'choose' : 'unmatched',
          })
          // The AI's suggested condition (test stores only, while it's being
          // tested) for a collector's collection, unless staff already chose
          // one. Store stock is Ungraded/Graded, so it doesn't apply there.
          const suggested = session?.aiCondition && toCollection ? response.result?.suggested_condition : null
          if (suggested) {
            save((list) => list.map((entry) => (entry.id === card.id
              ? { ...entry, conditionSuggestion: { condition: suggested, notes: response.result.condition_notes || [] }, ...(entry.conditionTouched ? {} : { condition: suggested }) }
              : entry)))
          }
          // Scan to Collection: an exact match is saved straight away.
          if (toCollection) await autoSave(card.id)
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
    return { item_id: item.item_id, name: item.name, subject: item.subject, card_number: item.card_number, release_year: item.release_year, set_name: item._set_name || item.set_name || '', dynamic_fields: item.dynamic_fields || null, imageUrl: item.imageUrl || '' }
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

  async function addToStock(card, { forReview = false } = {}) {
    if (!card.condition && !forReview) {
      patch(card.id, { error: session?.aiCondition ? "Pick a condition (the AI didn't suggest one)." : 'Pick a condition.' })
      return false
    }
    if (!toCollection && card.condition === GRADED && !String(card.gradingCompany || '').trim()) {
      patch(card.id, { error: 'Pick the grading company for this slab.' })
      return false
    }
    const previous = card.status
    patch(card.id, { status: 'adding', error: '' })
    if (toDestination) {
      try {
        await destination.add({ ...card, item: forReview ? null : card.item })
        patch(card.id, { status: 'added', addedAt: new Date().toISOString(), savedForReview: forReview })
        return true
      } catch (addError) {
        patch(card.id, { status: previous === 'adding' ? 'ready' : previous, error: addError.message || 'Could not save this card.' })
        return false
      }
    }
    try {
      const outcome = await addScannedCardToStock({ session, item: card.item, condition: card.condition, gradingCompany: card.gradingCompany, grade: card.grade, certNumber: card.certificationNumber, quantity: card.quantity, sellPrice: card.sellPrice, buyPrice: card.buyPrice })
      patch(card.id, { status: 'added', addedAt: new Date().toISOString(), inventoryId: outcome.inventoryId, addedAsNew: outcome.created })
      // Stock in: members with this item on their wishlist get an email (in the background).
      sendWishlistAlerts(session?.storeId)
      return true
    } catch (addError) {
      patch(card.id, { status: 'ready', error: addError.message || 'Could not add this card to stock.' })
      return false
    }
  }

  function recheckCards(cardId = null) {
    if (aiState !== 'ready') return
    let count = 0
    save((list) => list.map((card) => {
      if (!canRecheck(card) || (cardId && card.id !== cardId)) return card
      count += 1
      return { ...card, status: 'queued', result: null, item: null, candidates: [], error: '', recheckOrientation: true }
    }))
    if (!count) return
    setSearching(null)
    setError('')
    setMessage(`Queued ${count} card${count === 1 ? '' : 's'} for another AI look, including orientation checks.`)
    analyseQueued()
  }

  // Scan to Collection saves an exact match without a click, once it has a condition
  // chosen by staff or the batch (an AI-suggested condition still waits for a look).
  async function autoSave(cardId) {
    if (!toCollection) return
    const card = cardsRef.current.find((entry) => entry.id === cardId)
    if (!card || card.status !== 'ready' || !card.condition || !card.conditionTouched) return
    if (await addToStock(card)) destination.onChanged?.()
  }

  // The collection's condition for this batch: given to new cards and to waiting
  // cards nobody has set one on, then any ready card it completes is saved.
  async function setBatchCondition(condition) {
    const previous = defaultsRef.current.collectionCondition || ''
    defaultsRef.current = { ...defaultsRef.current, collectionCondition: condition }
    setDefaults((current) => ({ ...current, collectionCondition: condition }))
    save((list) => list.map((card) => (['added', 'adding', 'skipped'].includes(card.status) || (card.conditionTouched && card.condition !== previous)
      ? card
      : { ...card, condition, conditionTouched: Boolean(condition), error: '' })))
    for (const card of cardsRef.current.filter((entry) => entry.status === 'ready')) await autoSave(card.id)
  }

  async function addAllReady() {
    const ready = cardsRef.current.filter((card) => card.status === 'ready')
    let added = 0
    for (const card of ready) if (await addToStock(card)) added += 1
    setMessage(`${toDestination ? 'Saved' : 'Added'} ${added} card${added === 1 ? '' : 's'} ${toDestination ? (destination.toLabel || 'to the collection draft') : 'to stock'}${added < ready.length ? `; ${ready.length - added} need a look` : ''}.`)
    if (added) (toDestination ? destination.onChanged?.() : onStockChanged())
  }

  function applyDefaultsToWaiting(changes) {
    setDefaults((current) => ({ ...current, ...changes }))
    save((list) => list.map((card) => (['added', 'adding', 'skipped'].includes(card.status) ? card : { ...card, ...changes })))
  }

  // Batch finished (every card added or skipped, by Add all or one at a
  // time): clear it so the next batch starts at 0.
  useEffect(() => {
    if (!cards.length || !cards.every(isFinished)) return
    const added = cards.filter((card) => card.status === 'added').length
    setMessage(`Batch finished: ${added} card${added === 1 ? '' : 's'} ${toDestination ? 'saved' : 'added to stock'}.`)
    save(() => [])
  }, [cards])

  const counts = cards.reduce((acc, card) => ({ ...acc, [card.status]: (acc[card.status] || 0) + 1 }), {})
  const visible = cards.filter((card) => card.status !== 'added' && card.status !== 'skipped')
  // Stock being taken in that members are looking for (store stock only, not a collector's job).
  const wishlistDemand = useWishlistDemand(toDestination ? '' : session?.storeId, visible.map((card) => card.item?.item_id))
  const done = cards.filter((card) => card.status === 'added')
  const feederName = scanner.feederName || ''
  const flatbedReady = Boolean(scanner.scannerName) && ['ready', 'scanning', 'processing'].includes(scanner.state)
  const busy = Boolean(feed?.running)
  const recheckCount = cards.filter(canRecheck).length

  return (
    <section className="store-scan">
      <div className="store-scan-head">
        <div>
          <p className="store-scan-kicker">{toDestination ? destination.kicker : `Store Inventory · ${session?.storeName || 'Store'}`}</p>
          <h2>{toDestination ? destination.title : 'Scan Cards into Store Inventory'}</h2>
          <small>{toDestination ? destination.description : "Cards are identified by the local AI and matched to the catalogue. Matched cards go into this store's stock; cards the catalogue doesn't have are never created here."}</small>
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
        {toCollection ? (
          <>
            {destination.controls || null}
            <label title="Exact matches are saved automatically once they have a condition">Condition for this batch
              <select value={defaults.collectionCondition || ''} onChange={(event) => setBatchCondition(event.target.value)}>
                <option value="">Pick per card</option>
                {COLLECTION_CONDITIONS.map((condition) => <option key={condition}>{condition}</option>)}
              </select>
            </label>
          </>
        ) : (
          <>
            {destination?.controls || null}
            <label>Sell price (each)
              <input inputMode="decimal" value={defaults.sellPrice} onChange={(event) => applyDefaultsToWaiting({ sellPrice: event.target.value })} placeholder="e.g. 0.50" />
            </label>
            <label>Buy price (each)
              <input inputMode="decimal" value={defaults.buyPrice} onChange={(event) => applyDefaultsToWaiting({ buyPrice: event.target.value })} placeholder="optional" />
            </label>
          </>
        )}
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
        <span className="store-scan-counts" aria-live="polite">
          {counts.queued || counts.analysing ? <span className="identifying"><b>{(counts.queued || 0) + (counts.analysing || 0)}</b> identifying</span> : null}
          <span className="ready"><b>{counts.ready || 0}</b> ready</span>
          <span className={(counts.choose || 0) + (counts.unmatched || 0) + (counts.failed || 0) ? 'look' : ''}><b>{(counts.choose || 0) + (counts.unmatched || 0) + (counts.failed || 0)}</b> need a look</span>
          <span className="done"><b>{done.length}</b> {toDestination ? 'saved' : 'added'}</span>
        </span>
        {counts.ready ? <button type="button" className="primary" onClick={addAllReady}>{toDestination ? `Save ${counts.ready} ready` : `Add ${counts.ready} ready to stock`}</button> : null}
        {recheckCount ? <button type="button" onClick={() => recheckCards()} disabled={aiState !== 'ready'} title="Check orientation and identify all unsaved cards again using their existing scans">Recheck {recheckCount} with AI</button> : null}
        {toDestination ? destination.actions || null : null}
      </div>
      {message ? <p className="store-scan-message">{message}</p> : null}
      {error ? <p className="store-scan-error">{error}</p> : null}

      <div className="store-scan-list">
        {!visible.length ? (
          <div className="store-scan-empty">
            <ScanLine size={30} />
            <strong>{done.length ? 'All caught up' : 'No cards scanned yet'}</strong>
            <span>{done.length ? 'Scan the next stack or card when you\'re ready.' : 'Load a stack in the feeder or place a card on the scanner to start. Results appear here as each card is identified.'}</span>
          </div>
        ) : null}
        {visible.map((card) => (
          <div key={card.id} className={`store-scan-card ${card.status}`}>
            {card.frontImage?.url ? <img src={card.frontImage.url} alt="" /> : <span className="store-scan-noimage" />}
            <div className="store-scan-card-body">
              <strong>{card.result ? cardTitle(card.result) : statusText(card.status)}</strong>
              {/* Matched: the catalogue's year and set name (as on the website); otherwise what the AI read.
                  A Magic card also shows its set symbol: the matched item's set, or the code read off the card. */}
              <small>{(() => {
                const code = card.item?.dynamic_fields?.set_code || card.result?.set_code || ''
                return code ? <img key={setIcon(code)} className="store-scan-set-icon" src={setIcon(code)} alt="" title={code.toUpperCase()} onError={(event) => { event.currentTarget.style.display = 'none' }} /> : null
              })()}{card.item?.set_name
                ? [card.item.release_year, card.item.set_name, card.item.dynamic_fields?.parallel].filter(Boolean).join(' · ')
                : card.result ? [card.result.release_year, card.result.property || card.result.subfranchise, card.result.parallel].filter(Boolean).join(' · ') : ''}</small>
              <span className={`store-scan-status ${card.status}`}>{statusText(card.status)}</span>
              {card.item ? <span className="store-scan-match">Catalogue: {itemLabel(card.item)}</span> : null}
              {card.item && wishlistDemand[card.item.item_id] ? <span className="wanted-badge" title={wantedTitle(wishlistDemand[card.item.item_id])}>♥ {wantedLabel(wishlistDemand[card.item.item_id])}</span> : null}
              {card.status === 'choose' ? (
                <select value="" onChange={(event) => { const chosen = card.candidates.find((candidate) => candidate.item.item_id === event.target.value); if (chosen) { patch(card.id, { item: pickItem(chosen.item), status: 'ready' }); autoSave(card.id) } }}>
                  <option value="">Choose the matching item…</option>
                  {card.candidates.map((candidate) => <option key={candidate.item.item_id} value={candidate.item.item_id}>{itemLabel(candidate.item)} ({candidate.score}%{candidate.photoMatch ? ', photo match' : ''})</option>)}
                </select>
              ) : null}
              {['choose', 'unmatched', 'ready'].includes(card.status) ? (
                <button type="button" className="link" onClick={() => setSearching({ cardId: card.id, query: card.result?.subject || '', results: null })}><Search size={13} /> {card.item ? 'Wrong item? Search' : 'Search the catalogue'}</button>
              ) : null}
              {card.error ? <span className="store-scan-error">{card.error}</span> : null}
            </div>
            {['ready', 'choose', 'unmatched'].includes(card.status) ? (
              <div className="store-scan-card-fields">
                {toCollection ? (
                  <span className="store-scan-condition">
                    <select value={card.condition || ''} onChange={(event) => { patch(card.id, { condition: event.target.value, conditionTouched: true, error: '' }); autoSave(card.id) }} title={session?.aiCondition ? 'Condition (set by the AI; change it if needed)' : 'Condition'}>
                      {!card.condition ? <option value="">Condition…</option> : null}
                      {COLLECTION_CONDITIONS.map((condition) => <option key={condition}>{condition}</option>)}
                      {card.condition && !COLLECTION_CONDITIONS.includes(card.condition) ? <option>{card.condition}</option> : null}
                    </select>
                    <ConditionHint suggestion={card.conditionSuggestion} current={card.condition} />
                  </span>
                ) : (
                  <span className="store-scan-condition">
                    <select value={card.condition === GRADED ? GRADED : canonicalRawCondition(card.condition) || DEFAULT_RAW_CONDITION} onChange={(event) => patch(card.id, { condition: event.target.value, error: '' })} title="Condition, or a graded slab">
                      {CARD_CONDITIONS.map((condition) => <option key={condition}>{condition}</option>)}
                    </select>
                  </span>
                )}
                <input type="number" min="1" value={card.quantity} onChange={(event) => patch(card.id, { quantity: event.target.value })} title="Quantity" />
                {toCollection ? null : <input inputMode="decimal" value={card.sellPrice} onChange={(event) => patch(card.id, { sellPrice: event.target.value })} placeholder="Price" title="Sell price" />}
              </div>
            ) : null}
            {!toCollection && card.condition === GRADED && ['ready', 'choose', 'unmatched'].includes(card.status) ? (
              <div className="store-scan-slab">
                <SlabCertFields storeId={session?.storeId} gradingCompany={card.gradingCompany} grade={card.grade} cert={card.certificationNumber} onChange={(fields) => patch(card.id, { ...fields, error: '' })} />
              </div>
            ) : null}
            <div className="store-scan-card-actions">
              {card.status === 'ready' ? <button type="button" className="primary" onClick={async () => { if (await addToStock(card)) (toDestination ? destination.onChanged?.() : onStockChanged()) }}>{toDestination ? 'Save' : 'Add'}</button> : null}
              {toDestination && ['choose', 'unmatched', 'failed'].includes(card.status) ? <button type="button" onClick={async () => { if (await addToStock(card, { forReview: true })) destination.onChanged?.() }} title="Save it on the job for someone to identify later">Save for review</button> : null}
              {canRecheck(card) ? <button type="button" onClick={() => recheckCards(card.id)} disabled={aiState !== 'ready'} title="Check orientation and identify this card again using its existing scans">Recheck with AI</button> : null}
              {!['adding', 'analysing'].includes(card.status) ? <button type="button" onClick={() => patch(card.id, { status: 'skipped' })}>Skip</button> : null}
            </div>
          </div>
        ))}
      </div>

      {done.length ? (
        <details className="store-scan-done">
          <summary>{done.length} {toDestination ? 'saved' : 'added to stock'} this session</summary>
          <ul>{done.slice(0, 200).map((card) => <li key={card.id}>{card.savedForReview ? `${card.result ? cardTitle(card.result) : 'Unidentified card'} · saved for review` : `${itemLabel(card.item)} · ${card.condition === GRADED ? [card.gradingCompany, card.grade].filter(Boolean).join(' ') || GRADED : card.condition} · ×${card.quantity}`}{toCollection ? '' : `${card.sellPrice ? ` · $${card.sellPrice}` : ''}${toDestination || card.addedAsNew ? '' : ' (quantity added to existing stock)'}`}</li>)}</ul>
          <button type="button" onClick={() => save((list) => list.filter((card) => !['added', 'skipped'].includes(card.status)))}>Clear finished</button>
        </details>
      ) : null}

      {searching ? (
        <CatalogueSearchDialog
          initialQuery={searching.query}
          onClose={() => setSearching(null)}
          onPick={(item) => { const cardId = searching.cardId; patch(cardId, { item: pickItem(item), status: 'ready', error: '' }); setSearching(null); autoSave(cardId) }}
        />
      ) : null}
    </section>
  )
}

function CatalogueSearchResult({ item, onPick }) {
  const [imageFailed, setImageFailed] = useState(false)
  const fields = item.dynamic_fields || {}
  const collection = fields.collection || ''
  const setName = item.setName || fields.set_name || ''
  const details = [...new Set([
    fields.parallel,
    fields.finish,
  ].filter(Boolean))].join(' · ')

  return (
    <button type="button" className="store-scan-search-result" onClick={() => onPick(item)}>
      <span className="store-scan-search-photo">
        {item.imageUrl && !imageFailed
          ? <img src={item.imageUrl} alt={item.name || item.subject || 'Catalogue item'} loading="lazy" onError={() => setImageFailed(true)} />
          : <span>No image</span>}
      </span>
      <span className="store-scan-search-info">
        <strong>{item.name || item.subject}</strong>
        <small>{[item.card_number ? `#${item.card_number}` : '', item.release_year].filter(Boolean).join(' · ')}</small>
        <span className="store-scan-search-collection">Set: {setName || 'Not specified'}</span>
        <span className="store-scan-search-collection">Collection: {collection || 'Not specified'}</span>
        {details ? <small>{details}</small> : null}
      </span>
    </button>
  )
}

// Manual catalogue search for a card the AI couldn't match.
export function CatalogueSearchDialog({ initialQuery, onClose, onPick }) {
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState(null)
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    try {
      // The register search returns register candidates (catalogItemId, number, releaseYear);
      // callers here work with catalogue rows (item_id, card_number, release_year).
      const found = await searchDesktopTradeCatalogue(query, { allMatches: true })
      setResults(found.map((row) => ({
        ...row,
        item_id: row.item_id || row.catalogItemId || row.catalogueItemId,
        subject: row.subject || row.name,
        card_number: row.card_number || row.number || '',
        release_year: row.release_year || row.releaseYear || '',
        dynamic_fields: row.dynamic_fields || row.dynamicFields || {},
        imageUrl: row.imageUrl || row.image || '',
      })).filter((row) => row.item_id))
    } catch { setResults([]) } finally { setBusy(false) }
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
            <CatalogueSearchResult key={`${item.item_id}:${item.imageUrl}`} item={item} onPick={onPick} />
          ))}
        </div>
      </section>
    </div>
  )
}
