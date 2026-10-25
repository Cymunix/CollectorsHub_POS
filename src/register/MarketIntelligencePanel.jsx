import React, { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, Minus, Plus, Sparkles, X } from 'lucide-react'
import {
  LEGO_GROUPS, applyPercent, buyPercentFor, formatCents, isLegoCategoryName, legoAdjustment, legoGroupFromCondition, minifigCounts, simpleBaseline, toCents,
} from '../lib/marketMath'
import { historyGroup, lineGroup, loadActiveListings, loadMarketHistory, loadSetContents, loadStoreActivity, publicImageUrl } from '../lib/marketIntelligence'
import { inspectionFacts, templateDescription, writeDescription } from '../lib/listingDescription'
import './marketIntelligence.css'

// Market Intelligence for the Register's Buy / Trade-In items: completed-sale
// history, the store's own activity and buying percentage, active listings
// (asking prices, shown apart) and, for LEGO sets, a two-stage inspection
// (verify the minifigures, then market data and the offer). It only reads
// data and fills the line's Store Offer; the sale itself is completed by the
// normal checkout. Market data failures never block buying.

const CURRENCY = 'CAD'
const fmtDate = (value) => (value ? new Date(value).toLocaleDateString('en-CA') : '—')
const daysAgo = (value) => (value ? Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86400000)) : null)
const centsOf = (value) => (value == null || value === '' ? null : toCents(value))

function groupLabel(key) {
  if (!key) return 'Unknown'
  if (key === 'ungraded') return 'Ungraded'
  if (key === 'all') return 'All sales'
  if (key === 'graded:unknown') return 'Graded (grade not recorded)'
  if (key.startsWith('graded:')) { const [, company, grade] = key.split(':'); return `${company} ${grade}` }
  const lego = LEGO_GROUPS.find(([value]) => value === key)
  if (lego) return lego[1]
  if (key.startsWith('condition:')) return key.slice(10).replace(/\b\w/g, (c) => c.toUpperCase())
  return key
}

export default function MarketIntelligencePanel({ session, policy, lines, activeId, onSelect, onUpdateLine, onClose }) {
  const index = Math.max(0, lines.findIndex((line) => line.localId === activeId))
  const line = lines[index]

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
      if (event.altKey && event.key === 'ArrowRight' && index < lines.length - 1) onSelect(lines[index + 1].localId)
      if (event.altKey && event.key === 'ArrowLeft' && index > 0) onSelect(lines[index - 1].localId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, lines])

  if (!line) return null
  // Rendered on the page body, so no Register container's stacking can put
  // its controls (e.g. the Actions menu) on top of the drawer.
  return createPortal(
    <aside className="mi-drawer" role="dialog" aria-label="Market Intelligence">
      <header className="mi-head">
        <div className="mi-head-item">
          {line.image ? <img src={line.image} alt="" /> : <span className="mi-thumb" />}
          <div>
            <small>Market Intelligence · {line.category || 'Item'}</small>
            <strong>{line.name}</strong>
          </div>
        </div>
        <div className="mi-head-nav">
          {lines.length > 1 ? (
            <>
              <button type="button" onClick={() => onSelect(lines[index - 1].localId)} disabled={index === 0} aria-label="Previous item" title="Previous item (Alt+Left)"><ChevronLeft size={16} /></button>
              <span>{index + 1} of {lines.length}</span>
              <button type="button" onClick={() => onSelect(lines[index + 1].localId)} disabled={index === lines.length - 1} aria-label="Next item" title="Next item (Alt+Right)"><ChevronRight size={16} /></button>
            </>
          ) : null}
          <button type="button" className="mi-close" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc). The sale is kept."><X size={18} /></button>
        </div>
      </header>
      <ItemResearch key={line.localId} session={session} policy={policy} line={line} onUpdate={(patch) => onUpdateLine(line.localId, patch)} />
    </aside>,
    document.body,
  )
}

function ItemResearch({ session, policy, line, onUpdate }) {
  const itemId = line.catalogItemId
  const lego = isLegoCategoryName(line.category)
  const [history, setHistory] = useState({ state: 'loading' })
  const [setInfo, setSetInfo] = useState({ state: lego ? 'loading' : 'none' })
  const [store, setStore] = useState({ state: 'loading' })
  const research = line.research || {}

  useEffect(() => {
    if (!itemId) { setHistory({ state: 'none' }); setStore({ state: 'none' }); setSetInfo({ state: 'none' }); return }
    let cancelled = false
    loadMarketHistory(itemId, CURRENCY).then((data) => { if (!cancelled) setHistory({ state: 'ready', data }) }).catch((error) => { if (!cancelled) setHistory({ state: 'error', error: error.message }) })
    if (session?.storeId) loadStoreActivity(session.storeId, itemId).then((data) => { if (!cancelled) setStore({ state: 'ready', data }) }).catch((error) => { if (!cancelled) setStore({ state: 'error', error: error.message }) })
    else setStore({ state: 'none' })
    if (lego) loadSetContents(itemId, CURRENCY).then((data) => { if (!cancelled) setSetInfo({ state: 'ready', data }) }).catch((error) => { if (!cancelled) setSetInfo({ state: 'error', error: error.message }) })
    return () => { cancelled = true }
  }, [itemId])

  if (!itemId) {
    return <div className="mi-body"><p className="mi-empty">This item isn't linked to a catalogue record, so there is no market data. Enter the Store Offer in the Register.</p></div>
  }
  // A LEGO set with minifigures in the catalogue gets the inspection first.
  const isSetWithFigures = lego && setInfo.state === 'ready' && (setInfo.data?.minifigs || []).length > 0
  const stage = research.stage || (lego ? 'inspect' : 'market')
  return (
    <div className="mi-body">
      {lego && stage === 'inspect' ? (
        <InspectionStage setInfo={setInfo} research={research} onUpdate={onUpdate} line={line} onContinue={() => onUpdate({ research: { ...research, stage: 'market' } })} />
      ) : (
        <>
          {lego ? <InspectionSummary research={research} hasFigures={isSetWithFigures} onEdit={() => onUpdate({ research: { ...research, stage: 'inspect' } })} /> : null}
          <OfferSection line={line} history={history} setInfo={setInfo} policy={policy} lego={lego} onUpdate={onUpdate} />
          <HistorySection history={history} activeKey={lineGroup(line).key} lego={lego} />
          <ListingsSection line={line} />
          <StoreSection store={store} />
        </>
      )}
    </div>
  )
}

// ── Stage one: verify the set's contents ────────────────────────────────────
function InspectionStage({ setInfo, research, onUpdate, line, onContinue }) {
  const set = setInfo.data?.set
  const figures = setInfo.data?.minifigs || []
  const counts = research.minifigs || {}
  const patch = (changes) => onUpdate({ research: { ...research, ...changes } })
  const setFigure = (figure, changes) => {
    const current = { present: 0, missing: 0, ...(counts[figure.item_id] || {}) }
    // Marking one missing takes it from "present" (and the other way round)
    // when every copy is already accounted for.
    const merged = { ...current, ...changes }
    if ('missing' in changes) merged.present = Math.min(merged.present, figure.required - merged.missing)
    if ('present' in changes) merged.missing = Math.min(merged.missing, figure.required - merged.present)
    const next = minifigCounts({ required: figure.required, ...merged })
    patch({ minifigs: { ...counts, [figure.item_id]: { present: next.present, missing: next.missing } } })
  }
  const unverified = figures.reduce((sum, figure) => sum + minifigCounts({ required: figure.required, ...(counts[figure.item_id] || {}) }).unverified, 0)

  if (setInfo.state === 'loading') return <p className="mi-muted">Loading the set and its minifigures…</p>
  return (
    <section className="mi-section">
      <h3>Step 1 · Verify set contents</h3>
      {set ? (
        <div className="mi-set">
          {set.image_path ? <img src={publicImageUrl(set.image_path)} alt="" /> : <span className="mi-thumb large" />}
          <dl>
            <dt>Set</dt><dd>{set.name}</dd>
            <dt>Number</dt><dd>{set.set_number || '—'}</dd>
            <dt>Pieces</dt><dd>{set.piece_count ?? '—'}</dd>
            <dt>Released</dt><dd>{set.release_year ?? '—'}</dd>
          </dl>
        </div>
      ) : null}
      {setInfo.state === 'error' ? <p className="mi-error">Set contents could not be loaded: {setInfo.error}</p> : null}
      {setInfo.state === 'ready' && !figures.length ? <p className="mi-note">No minifigures are linked to this set in the catalogue. Check the contents yourself; nothing is deducted automatically.</p> : null}
      {figures.length ? (
        <>
          <div className="mi-row mi-spread">
            <strong>Minifigures ({figures.reduce((sum, figure) => sum + figure.required, 0)})</strong>
            <span className="mi-row">
              <button type="button" onClick={() => patch({ minifigs: Object.fromEntries(figures.map((figure) => [figure.item_id, { present: figure.required, missing: 0 }])) })}>All present</button>
              <button type="button" onClick={() => patch({ minifigs: {} })}>Reset</button>
            </span>
          </div>
          <ul className="mi-figs">
            {figures.map((figure) => {
              const c = minifigCounts({ required: figure.required, ...(counts[figure.item_id] || {}) })
              return (
                <li key={figure.item_id} className={c.missing ? 'missing' : c.unverified ? 'unverified' : 'present'}>
                  {figure.image_path ? <img src={publicImageUrl(figure.image_path)} alt="" /> : <span className="mi-thumb" />}
                  <div className="mi-fig-text">
                    <strong>{figure.name}</strong>
                    <small>{[figure.code, `×${figure.required} in set`, figure.price != null ? `${formatCents(toCents(figure.price))} (${figure.price_sales} sale${figure.price_sales === 1 ? '' : 's'}, ${figure.price_window})` : 'No price recorded'].filter(Boolean).join(' · ')}</small>
                    {!figure.verified ? <small className="mi-warn">Relationship unverified</small> : null}
                  </div>
                  <div className="mi-fig-counts">
                    <Stepper label="Present" value={c.present} onChange={(value) => setFigure(figure, { present: value })} max={figure.required} />
                    <Stepper label="Missing" value={c.missing} onChange={(value) => setFigure(figure, { missing: value })} max={figure.required} />
                    <span className={`mi-pill ${c.unverified ? 'warn' : ''}`}>{c.unverified ? `${c.unverified} unverified` : c.missing ? 'Checked' : 'Present'}</span>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      ) : null}
      <div className="mi-grid">
        <label>Missing or damaged pieces<input value={research.missing_pieces || ''} onChange={(event) => patch({ missing_pieces: event.target.value })} placeholder="e.g. 2 tan 1x2 bricks" /></label>
        <label>Missing accessories<input value={research.missing_accessories || ''} onChange={(event) => patch({ missing_accessories: event.target.value })} placeholder="e.g. Anubis staff" /></label>
        <label>Instructions<TriState value={research.instructions} onChange={(value) => patch({ instructions: value })} /></label>
        <label>Original box<TriState value={research.box} onChange={(value) => patch({ box: value })} /></label>
        <label>Significant damage<input value={research.damage || ''} onChange={(event) => patch({ damage: event.target.value })} placeholder="e.g. sun-faded white bricks" /></label>
        <label>Inspection notes<input value={research.notes || ''} onChange={(event) => patch({ notes: event.target.value })} /></label>
      </div>
      {unverified ? <p className="mi-note">{unverified} minifigure{unverified === 1 ? ' is' : 's are'} still unverified. Unverified minifigures are not deducted.</p> : null}
      <ListingDescription research={research} patch={patch} facts={inspectionFacts({
        name: set?.name || line.name,
        setNumber: set?.set_number,
        condition: figures.some((figure) => minifigCounts({ required: figure.required, ...(counts[figure.item_id] || {}) }).missing) && !research.conditionCorrected ? 'Used Incomplete' : line.condition,
        figures: figures.map((figure) => ({ name: figure.name, ...minifigCounts({ required: figure.required, ...(counts[figure.item_id] || {}) }) })),
        research,
      })} />
      <div className="mi-row mi-end">
        <span className="mi-muted">{figures.some((figure) => minifigCounts({ required: figure.required, ...(counts[figure.item_id] || {}) }).missing)
          ? 'Minifigures are missing: the set will be Used Incomplete unless you keep your own condition.'
          : line.condition ? `Condition: ${line.condition}` : ''}</span>
        <button type="button" className="mi-primary" onClick={onContinue}>Continue to market data & offer</button>
      </div>
    </section>
  )
}

// What customers will read about the item's condition and contents: written
// by the local AI (or plainly) from the answers above, then edited by staff.
// Saved on the new stock record at checkout; the private inspection notes
// and anything about prices never go into it.
function ListingDescription({ research, patch, facts }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const basis = JSON.stringify(facts)
  const stale = research.listing_description && research.listing_basis && research.listing_basis !== basis
  async function run(useAi) {
    setBusy(true); setNote('')
    const result = useAi ? await writeDescription(facts) : { text: templateDescription(facts), source: 'template' }
    patch({ listing_description: result.text, listing_basis: basis })
    setNote(result.note || (result.source === 'ai' ? 'Written by the local AI from your answers. Check it before saving.' : ''))
    setBusy(false)
  }
  return (
    <div className="mi-listing">
      <label>Listing description <small>(customers see this on the website and in online listings)</small>
        <textarea rows={3} value={research.listing_description || ''} onChange={(event) => patch({ listing_description: event.target.value })} placeholder="What a buyer should know: missing minifigures, pieces, box, instructions, damage." />
      </label>
      <div className="mi-row">
        <button type="button" onClick={() => run(true)} disabled={busy}><Sparkles size={13} /> {busy ? 'Writing…' : 'Write with AI'}</button>
        <button type="button" onClick={() => run(false)} disabled={busy}>Write from answers</button>
        {stale ? <span className="mi-warn"><AlertTriangle size={13} /> The answers changed since this was written.</span> : null}
      </div>
      {note ? <p className="mi-muted">{note}</p> : null}
      <p className="mi-muted">Your inspection notes stay private to the store.</p>
    </div>
  )
}

function Stepper({ label, value, onChange, max }) {
  return (
    <span className="mi-stepper" aria-label={label}>
      <small>{label}</small>
      <button type="button" onClick={() => onChange(Math.max(0, value - 1))} disabled={value <= 0} aria-label={`${label} minus one`}><Minus size={12} /></button>
      <b>{value}</b>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={`${label} plus one`}><Plus size={12} /></button>
    </span>
  )
}

function TriState({ value, onChange }) {
  return (
    <select value={value || 'unknown'} onChange={(event) => onChange(event.target.value)}>
      <option value="unknown">Not checked</option>
      <option value="present">Present</option>
      <option value="missing">Missing</option>
    </select>
  )
}

function InspectionSummary({ research, hasFigures, onEdit }) {
  const figs = Object.values(research.minifigs || {})
  const missing = figs.reduce((sum, figure) => sum + (figure.missing || 0), 0)
  const notes = [research.missing_pieces && `Pieces: ${research.missing_pieces}`, research.missing_accessories && `Accessories: ${research.missing_accessories}`,
    research.instructions && research.instructions !== 'unknown' && `Instructions ${research.instructions}`, research.box && research.box !== 'unknown' && `Box ${research.box}`,
    research.damage && `Damage: ${research.damage}`].filter(Boolean)
  const listing = String(research.listing_description || '').trim()
  return (
    <section className="mi-section mi-summary">
      <div className="mi-row mi-spread">
        <h3>Inspection</h3>
        <button type="button" onClick={onEdit}>Edit inspection</button>
      </div>
      {listing ? <p className="mi-listing-preview"><b>Listing description:</b> {listing}</p> : <p className="mi-muted">No listing description yet. Add one under Edit inspection so customers know what's missing.</p>}
      <p>{hasFigures ? (missing ? `${missing} minifigure${missing === 1 ? '' : 's'} missing.` : 'No minifigures marked missing.') : 'No minifigures linked in the catalogue.'} {notes.join(' · ')}</p>
    </section>
  )
}

// ── Purchase baseline and offer ─────────────────────────────────────────────
function OfferSection({ line, history, setInfo, policy, lego, onUpdate }) {
  const research = line.research || {}
  const group = lineGroup(line)
  const data = history.state === 'ready' ? history.data : null
  const figures = setInfo.data?.minifigs || []

  // LEGO: the Used Complete median less the missing minifigures.
  const completeGroup = lego ? historyGroup(data, 'used_complete') : null
  const legoGroup = lego ? legoGroupFromCondition(line.condition) : null
  const adjustment = useMemo(() => (lego ? legoAdjustment({
    referenceCents: centsOf(completeGroup?.median),
    buyPercent: buyPercentFor(policy, { category: line.category, legoGroup: 'used_complete' }).percent,
    minifigs: figures.map((figure) => ({ ...figure, ...(research.minifigs?.[figure.item_id] || {}), priceCents: centsOf(figure.price) })),
  }) : null), [lego, completeGroup?.median, figures, research.minifigs, policy, line.category])

  // Box and instructions only decide completeness when the store's policy says so.
  const policyIncomplete = lego && ((policy?.box_required_for_complete && research.box === 'missing') || (policy?.instructions_required_for_complete && research.instructions === 'missing'))
  const incomplete = lego && (Boolean(adjustment?.missing.length) || policyIncomplete)
  // The reference and percentage behind the baseline.
  const own = historyGroup(data, group.key)
  const buy = buyPercentFor(policy, { category: line.category, legoGroup: lego ? (incomplete ? 'used_incomplete' : legoGroup) : null })
  const legoMode = lego && (legoGroup === 'used_complete' || legoGroup === 'used_incomplete' || incomplete)
  const referenceCents = legoMode ? adjustment?.adjustedCents ?? null : centsOf(own?.median)
  const baselineCents = legoMode
    ? (referenceCents == null ? null : applyPercent(referenceCents, buy.percent))
    : simpleBaseline({ referenceCents, buyPercent: buy.percent })
  const referenceSource = legoMode ? completeGroup : own

  // Missing minifigures (or a missing box/instructions, when the store's policy
  // requires them) make the set Used Incomplete unless the store corrects it.
  // A change made automatically is undone automatically when the inspection no
  // longer finds anything missing; a condition staff chose is left alone.
  useEffect(() => {
    if (!lego || research.conditionCorrected) return
    // (The flag is its own field on the line, so the research snapshot can't overwrite it.)
    if (incomplete && legoGroup !== 'used_incomplete') onUpdate({ condition: 'Used Incomplete', miAutoIncomplete: true })
    else if (!incomplete && line.miAutoIncomplete && legoGroup === 'used_incomplete') onUpdate({ condition: 'Used Complete', miAutoIncomplete: false })
  }, [incomplete])

  // Keep what's needed to save with the purchase on the line.
  const snapshot = {
    pricing_group: legoMode ? (incomplete ? 'used_incomplete' : 'used_complete') : group.key,
    market_reference: referenceSource?.median ?? null,
    market_reference_label: referenceSource ? `${groupLabel(referenceSource.key)} median of ${referenceSource.records} completed sale${referenceSource.records === 1 ? '' : 's'}` : null,
    market_currency: CURRENCY,
    market_sales_count: referenceSource?.records ?? null,
    market_data_at: referenceSource?.last_sale ?? null,
    deductions: legoMode ? (adjustment.deductionCents / 100) : null,
    deduction_complete: legoMode ? adjustment.deductionComplete : null,
    adjusted_reference: legoMode && adjustment.adjustedCents != null ? adjustment.adjustedCents / 100 : null,
    buy_percent: buy.percent,
    buy_rule: buy.rule,
    baseline: baselineCents == null ? null : baselineCents / 100,
    minifig_list: lego ? figures.map((figure) => ({ item_id: figure.item_id, name: figure.name, code: figure.code, ...minifigCounts({ required: figure.required, ...(research.minifigs?.[figure.item_id] || {}) }), price: figure.price, price_source: figure.price_window ? `median, ${figure.price_window}` : null })) : null,
  }
  useEffect(() => {
    if (history.state !== 'ready') return
    const next = { ...research, ...snapshot }
    if (JSON.stringify(next) !== JSON.stringify(research)) onUpdate({ research: next })
  }, [JSON.stringify(snapshot), history.state])

  const offerCents = centsOf(line.storeOffer)
  return (
    <section className="mi-section mi-offer">
      <h3>{lego ? 'Step 2 · Purchase offer' : 'Purchase offer'}</h3>
      {history.state === 'loading' ? <p className="mi-muted">Loading market data…</p> : null}
      {history.state === 'error' ? <p className="mi-error">Market data could not be loaded ({history.error}). You can still enter an offer.</p> : null}
      {lego ? (
        <table className="mi-calc">
          <tbody>
            <tr><th>Used Complete median</th><td>{completeGroup ? `${formatCents(centsOf(completeGroup.median))} (${completeGroup.records} sale${completeGroup.records === 1 ? '' : 's'})` : 'Insufficient data'}</td></tr>
            {(adjustment?.missing || []).map((figure) => (
              <tr key={figure.item_id} className="mi-deduct">
                <th>Missing: {figure.name}{figure.missing > 1 ? ` ×${figure.missing}` : ''}</th>
                <td>{figure.deductionCents == null ? <span className="mi-warn">No price</span> : `− ${formatCents(figure.deductionCents)}`}</td>
              </tr>
            ))}
            {adjustment?.missing.length ? <tr><th>Total minifigure deductions</th><td>− {formatCents(adjustment.deductionCents)}{adjustment.deductionComplete ? '' : ' (incomplete)'}</td></tr> : null}
            <tr className="mi-strong"><th>Adjusted reference value</th><td>{adjustment?.adjustedCents == null ? 'N/A' : formatCents(adjustment.adjustedCents)}</td></tr>
            <tr><th>Used Incomplete sales (shown separately)</th><td>{historyGroup(data, 'used_incomplete') ? `median ${formatCents(centsOf(historyGroup(data, 'used_incomplete').median))} (${historyGroup(data, 'used_incomplete').records} sales)` : 'None recorded'}</td></tr>
            {historyGroup(data, 'sealed') ? <tr><th>Sealed median</th><td>{formatCents(centsOf(historyGroup(data, 'sealed').median))} ({historyGroup(data, 'sealed').records} sales)</td></tr> : null}
            <tr><th>Store buying percentage</th><td>{buy.percent}% <small>({buy.rule})</small></td></tr>
            <tr className="mi-strong"><th>Calculated purchase baseline</th><td>{baselineCents == null ? 'N/A' : formatCents(baselineCents)}</td></tr>
          </tbody>
        </table>
      ) : (
        <table className="mi-calc">
          <tbody>
            <tr><th>Pricing group</th><td>{group.label}</td></tr>
            <tr><th>Completed-sale median</th><td>{own ? `${formatCents(centsOf(own.median))} (${own.records} sale${own.records === 1 ? '' : 's'})` : group.key ? 'Insufficient data' : 'Choose the grade first'}</td></tr>
            <tr><th>Store buying percentage</th><td>{buy.percent}% <small>({buy.rule})</small></td></tr>
            <tr className="mi-strong"><th>Calculated purchase baseline</th><td>{baselineCents == null ? 'N/A' : formatCents(baselineCents)}</td></tr>
          </tbody>
        </table>
      )}
      {lego && adjustment && !adjustment.deductionComplete ? <p className="mi-warn"><AlertTriangle size={13} /> {adjustment.unpriced.length} missing minifigure{adjustment.unpriced.length === 1 ? ' has' : 's have'} no recorded price, so the adjustment is incomplete.</p> : null}
      {policyIncomplete ? <p className="mi-muted">The store's policy counts a set without its {policy?.box_required_for_complete && research.box === 'missing' ? 'box' : 'instructions'} as Used Incomplete.</p> : null}
      {lego && adjustment?.missing.length ? <p className="mi-muted">The adjusted reference value is a calculated purchasing reference, not a market value for an incomplete set.</p> : null}
      {baselineCents == null && history.state === 'ready' ? <p className="mi-muted">No baseline without completed sales for this group. Enter your own offer.</p> : null}
      {lego ? (
        <label className="mi-check">
          <input type="checkbox" checked={Boolean(research.conditionCorrected)} onChange={(event) => onUpdate({ research: { ...research, conditionCorrected: event.target.checked } })} />
          Keep the condition I choose (don't set Used Incomplete for missing minifigures)
        </label>
      ) : null}
      <div className="mi-offer-row">
        <label>Final offer (each)
          <input inputMode="decimal" value={line.storeOffer ?? ''} onChange={(event) => onUpdate({ storeOffer: event.target.value })} />
        </label>
        <button type="button" className="mi-primary" disabled={baselineCents == null} onClick={() => onUpdate({ storeOffer: (baselineCents / 100).toFixed(2) })}>Use baseline {baselineCents == null ? '' : formatCents(baselineCents)}</button>
        {offerCents != null && baselineCents != null && offerCents !== baselineCents ? <span className="mi-muted">{offerCents > baselineCents ? 'Above' : 'Below'} baseline by {formatCents(Math.abs(offerCents - baselineCents))}</span> : null}
      </div>
      <p className="mi-muted">The offer goes into the Register's Store Offer. You decide the condition and the final price.</p>
    </section>
  )
}

// ── Completed sales ─────────────────────────────────────────────────────────
function HistorySection({ history, activeKey, lego }) {
  const [viewKey, setViewKey] = useState(null)
  if (history.state !== 'ready') return null
  const data = history.data || {}
  const groups = data.groups || []
  const key = viewKey || (historyGroup(data, activeKey) ? activeKey : lego && historyGroup(data, 'used_complete') ? 'used_complete' : groups[0]?.key)
  const group = historyGroup(data, key)
  const recent = (data.recent || []).filter((sale) => !key || sale.group_key === key)
  return (
    <section className="mi-section">
      <h3>Completed sales</h3>
      {!groups.length ? <p className="mi-empty">Insufficient data: no completed sales are recorded for this item{data.other_currency_sales ? ` in ${data.currency} (${data.other_currency_sales} in other currencies)` : ''}.</p> : (
        <>
          <div className="mi-chips">
            {groups.map((g) => <button key={g.key} type="button" className={g.key === key ? 'active' : ''} onClick={() => setViewKey(g.key)}>{groupLabel(g.key)} <b>{g.records}</b></button>)}
          </div>
          {group ? (
            <div className="mi-stats">
              <Stat label="Median" value={formatCents(centsOf(group.median))} />
              <Stat label="Average" value={formatCents(centsOf(group.average))} />
              <Stat label="Range" value={`${formatCents(centsOf(group.low))} – ${formatCents(centsOf(group.high))}`} />
              <Stat label="Sold, 30 days" value={group.units_30} />
              <Stat label="Sold, 90 days" value={group.units_90} />
              <Stat label="Sold, 365 days" value={group.units_365} />
              <Stat label="Sales a month" value={group.per_month ?? 'Insufficient data'} hint={`Over the last ${data.observation_days} day${data.observation_days === 1 ? '' : 's'} of records`} />
              <Stat label="Last sale" value={fmtDate(group.last_sale)} />
            </div>
          ) : null}
          {group?.months?.length ? <PriceChart months={group.months} /> : null}
          <p className="mi-muted">Sell-through and average time to sell need complete listing history, which isn't recorded yet.</p>
          <table className="mi-table">
            <thead><tr><th>Date</th><th>Source</th><th>Group</th><th>Price</th></tr></thead>
            <tbody>{recent.slice(0, 15).map((sale, i) => (
              <tr key={i}>
                <td>{fmtDate(sale.sold_at)}</td>
                <td>{sale.source_url ? <a href={sale.source_url} target="_blank" rel="noreferrer">{sale.source} <ExternalLink size={11} /></a> : sale.source}</td>
                <td>{[groupLabel(sale.group_key), sale.condition && !/^graded$/i.test(sale.condition) ? sale.condition : '', sale.grade_display].filter(Boolean).join(' · ')}</td>
                <td>{formatCents(centsOf(sale.price))}{sale.quantity > 1 ? <small> each ×{sale.quantity}</small> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        </>
      )}
      <p className="mi-source">Sources: {(data.sources || []).map((source) => `${source.source} (${source.records})`).join(', ') || 'none'} · Prices in {data.currency} · Updated {fmtDate(data.last_updated)}</p>
    </section>
  )
}

function Stat({ label, value, hint }) {
  return <div className="mi-stat" title={hint || ''}><span>{label}</span><strong>{value ?? 'N/A'}</strong></div>
}

// Monthly median (line) and units sold (bars) for the last 24 months of records.
function PriceChart({ months }) {
  const width = 520
  const height = 120
  const pad = 22
  const prices = months.map((m) => Number(m.median))
  const max = Math.max(...prices) || 1
  const min = Math.min(...prices)
  const maxUnits = Math.max(...months.map((m) => m.units)) || 1
  const x = (i) => pad + (months.length === 1 ? (width - pad * 2) / 2 : (i * (width - pad * 2)) / (months.length - 1))
  const y = (price) => height - pad - ((price - min) / (max - min || 1)) * (height - pad * 2)
  return (
    <svg className="mi-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Monthly median completed-sale price">
      {months.map((m, i) => <rect key={`b${i}`} x={x(i) - 5} width={10} y={height - pad - (m.units / maxUnits) * 30} height={(m.units / maxUnits) * 30} className="mi-chart-bar" />)}
      <polyline points={months.map((m, i) => `${x(i)},${y(Number(m.median))}`).join(' ')} className="mi-chart-line" />
      {months.map((m, i) => <circle key={`p${i}`} cx={x(i)} cy={y(Number(m.median))} r={3} className="mi-chart-dot"><title>{`${new Date(m.month).toLocaleDateString('en-CA', { year: 'numeric', month: 'short' })}: median ${formatCents(centsOf(m.median))}, ${m.units} sold`}</title></circle>)}
      <text x={pad} y={12} className="mi-chart-label">{formatCents(centsOf(max))}</text>
      <text x={pad} y={height - 6} className="mi-chart-label">{new Date(months[0].month).toLocaleDateString('en-CA', { year: 'numeric', month: 'short' })}</text>
      <text x={width - pad} y={height - 6} textAnchor="end" className="mi-chart-label">{new Date(months[months.length - 1].month).toLocaleDateString('en-CA', { year: 'numeric', month: 'short' })}</text>
    </svg>
  )
}

// ── Active listings: asking prices, kept apart from sales ───────────────────
function ListingsSection({ line }) {
  const [state, setState] = useState(null)
  const query = [line.name, line.number || line.cardNumber].filter(Boolean).join(' ')
  useEffect(() => { setState(null) }, [line.localId])
  const prices = (state?.listings || []).map((row) => toCents(row.price)).filter((value) => value != null).sort((a, b) => a - b)
  return (
    <section className="mi-section mi-listings">
      <div className="mi-row mi-spread">
        <h3>Active listings <small>(asking prices, not sales)</small></h3>
        {!state ? <button type="button" onClick={async () => { setState({ loading: true }); setState(await loadActiveListings(query)) }}>Check eBay listings</button> : null}
      </div>
      {state?.loading ? <p className="mi-muted">Loading listings…</p> : null}
      {state && !state.loading && !state.available ? <p className="mi-muted">Not available: {state.reason}</p> : null}
      {state?.available ? (
        <>
          <p>{prices.length ? `${prices.length} listing${prices.length === 1 ? '' : 's'} asking ${formatCents(prices[0])} – ${formatCents(prices[prices.length - 1])}` : 'No listings found.'} <small className="mi-muted">Search: "{query}" · {state.marketplace} · {fmtDate(state.fetchedAt)}. Never used in the baseline.</small></p>
          <table className="mi-table">
            <tbody>{state.listings.slice(0, 8).map((row) => (
              <tr key={row.id}><td>{row.sourceUrl ? <a href={row.sourceUrl} target="_blank" rel="noreferrer">{row.title}</a> : row.title}</td><td>{row.rawCondition || ''}</td><td>{formatCents(toCents(row.price))}</td></tr>
            ))}</tbody>
          </table>
        </>
      ) : null}
    </section>
  )
}

// ── The store's own stock and sales ─────────────────────────────────────────
function StoreSection({ store }) {
  if (store.state === 'none') return null
  const data = store.data || {}
  return (
    <section className="mi-section">
      <h3>This store</h3>
      {store.state === 'loading' ? <p className="mi-muted">Loading…</p> : null}
      {store.state === 'error' ? <p className="mi-error">Store activity could not be loaded: {store.error}</p> : null}
      {store.state === 'ready' ? (
        <div className="mi-stats">
          <Stat label="In stock" value={data.on_hand} />
          <Stat label="Oldest unsold" value={data.oldest_unsold_days == null ? '—' : `${data.oldest_unsold_days} days`} />
          <Stat label="Sold by the store" value={data.units_sold} />
          <Stat label="Last sold" value={fmtDate(data.last_sold)} />
          <Stat label="Median store sale" value={formatCents(centsOf(data.median_sold_price))} />
          <Stat label="Bought in" value={data.units_bought} />
        </div>
      ) : null}
      {(data.stock || []).length ? <p className="mi-muted">{data.stock.map((row) => `${row.on_hand} × ${row.condition || 'no condition'} at ${formatCents(centsOf(row.price))} (${row.age_days} days)`).join(' · ')}</p> : null}
    </section>
  )
}
