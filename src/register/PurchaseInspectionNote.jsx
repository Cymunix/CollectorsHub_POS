import React, { useEffect, useState } from 'react'
import { loadInspectionsForInventory, loadListingNotes, saveListingNotes } from '../lib/marketIntelligence'

// Inventory: the item's public listing description (what customers see on
// the website and in online listings; editable here) and, when it was bought
// with a Market Intelligence inspection, what was recorded then. The
// inspection itself is staff-only.
export default function PurchaseInspectionNote({ inventoryId }) {
  const [rows, setRows] = useState([])
  const [listing, setListing] = useState({ saved: '', text: '', loaded: false })
  const [message, setMessage] = useState('')
  const isRecord = /^[0-9a-f-]{36}$/i.test(String(inventoryId || ''))

  useEffect(() => {
    let cancelled = false
    setRows([]); setListing({ saved: '', text: '', loaded: false }); setMessage('')
    if (isRecord) {
      loadInspectionsForInventory(inventoryId).then((data) => { if (!cancelled) setRows(data) })
      loadListingNotes(inventoryId).then((text) => { if (!cancelled) setListing({ saved: text, text, loaded: true }) })
    }
    return () => { cancelled = true }
  }, [inventoryId])

  if (!isRecord) return null
  const inspection = rows[0]
  const figures = Array.isArray(inspection?.minifigs) ? inspection.minifigs : []
  const missing = figures.filter((figure) => Number(figure.missing) > 0)
  const unverified = figures.reduce((sum, figure) => sum + Number(figure.unverified || 0), 0)
  const status = (value) => (value === 'present' ? 'present' : value === 'missing' ? 'missing' : 'not checked')
  async function save() {
    setMessage('')
    try { await saveListingNotes(inventoryId, listing.text); setListing({ ...listing, saved: listing.text.trim() }); setMessage('Saved. Customers see this on the website.') } catch (error) { setMessage(error.message) }
  }
  return (
    <>
      <div className="mi-inventory-note listing">
        <strong>Listing description <small>(customers see this)</small></strong>
        <textarea rows={3} value={listing.text} onChange={(event) => setListing({ ...listing, text: event.target.value })} placeholder="Anything a buyer should know: missing pieces or minifigures, box, instructions, damage." disabled={!listing.loaded} />
        <span className="mi-row">
          <button type="button" onClick={save} disabled={!listing.loaded || listing.text.trim() === listing.saved.trim()}>Save description</button>
          {message ? <small>{message}</small> : null}
        </span>
      </div>
      {inspection ? (
        <div className="mi-inventory-note">
          <strong>Purchase inspection <small>(staff only)</small></strong>
          <span>{inspection.condition || 'No condition'}{figures.length ? ` · ${missing.length ? `missing minifigures: ${missing.map((figure) => `${figure.name}${figure.missing > 1 ? ` ×${figure.missing}` : ''}`).join(', ')}` : 'all minifigures present'}${unverified ? ` (${unverified} unverified)` : ''}` : ''}</span>
          {figures.length || inspection.box || inspection.instructions ? <span>Box {status(inspection.box)} · Instructions {status(inspection.instructions)}</span> : null}
          {inspection.missing_pieces ? <span>Missing or damaged pieces: {inspection.missing_pieces}</span> : null}
          {inspection.missing_accessories ? <span>Missing accessories: {inspection.missing_accessories}</span> : null}
          {inspection.damage ? <span>Damage: {inspection.damage}</span> : null}
          {inspection.notes ? <span>Notes: {inspection.notes}</span> : null}
          <small>Inspected {new Date(inspection.created_at).toLocaleDateString('en-CA')}</small>
        </div>
      ) : null}
    </>
  )
}
