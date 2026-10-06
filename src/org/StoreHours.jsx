import React, { useEffect, useState } from 'react'
import { WEEK_ORDER, loadOrgLocationHours, saveLocationHours, summarizeHours } from '../lib/storeHours'

// The organization sets a store's opening hours, per location: open and
// close times for each day, or closed.

const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DEFAULT_DAY = { open: '10:00', close: '18:00' }

function LocationWeek({ orgId, location, onSaved }) {
  const [hours, setHours] = useState(() => ({ ...(location.opening_hours || {}) }))
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState('')

  const setDay = (weekday, value) => setHours((current) => ({ ...current, [String(weekday)]: value }))
  const copyMondayToWeekdays = () => setHours((current) => {
    const monday = current['1'] === undefined ? DEFAULT_DAY : current['1']
    return { ...current, 2: monday, 3: monday, 4: monday, 5: monday }
  })

  async function save() {
    for (const weekday of WEEK_ORDER) {
      const day = hours[String(weekday)]
      if (day && (!day.open || !day.close || day.close <= day.open)) { setProblem(`${DAY_LONG[weekday]}: closing has to be after opening.`); return }
    }
    // Every day saved explicitly (a day never touched counts as closed).
    const complete = Object.fromEntries(WEEK_ORDER.map((weekday) => [String(weekday), hours[String(weekday)] ?? null]))
    setSaving(true)
    setProblem('')
    try {
      await saveLocationHours(orgId, location.location_id, complete)
      setHours(complete)
      setNotice(`Saved: ${summarizeHours(complete)}`)
      onSaved?.()
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="sh-location">
      <div className="sh-location-head">
        <strong>{location.location_name || 'Location'}</strong>
        <button type="button" className="sh-link" onClick={copyMondayToWeekdays}>Copy Monday to all weekdays</button>
      </div>
      <div className="sh-week">
        {WEEK_ORDER.map((weekday) => {
          const day = hours[String(weekday)]
          const open = Boolean(day)
          return (
            <div key={weekday} className={`sh-day${open ? '' : ' closed'}`}>
              <span>{DAY_LONG[weekday]}</span>
              <label className="sh-open">
                <input type="checkbox" checked={open} onChange={(event) => setDay(weekday, event.target.checked ? (day || DEFAULT_DAY) : null)} /> Open
              </label>
              {open ? (
                <span className="sh-times">
                  <input type="time" value={day.open} onChange={(event) => setDay(weekday, { ...day, open: event.target.value })} aria-label={`${DAY_LONG[weekday]} opens`} />
                  <span>to</span>
                  <input type="time" value={day.close} onChange={(event) => setDay(weekday, { ...day, close: event.target.value })} aria-label={`${DAY_LONG[weekday]} closes`} />
                </span>
              ) : <span className="sh-closed">Closed</span>}
            </div>
          )
        })}
      </div>
      {problem ? <p className="sh-problem">{problem}</p> : null}
      <div className="sh-actions">
        {notice ? <span className="sh-notice">{notice}</span> : null}
        <button type="button" className="sh-save" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save hours'}</button>
      </div>
    </div>
  )
}

export default function StoreHoursModal({ orgId, store, onClose }) {
  const [locations, setLocations] = useState(null)
  const [problem, setProblem] = useState('')
  useEffect(() => {
    loadOrgLocationHours(orgId)
      .then((rows) => setLocations(rows.filter((row) => row.store_id === store.storeId)))
      .catch((error) => { setLocations([]); setProblem(error?.message || String(error)) })
  }, [orgId, store.storeId])

  return (
    <div className="sh-overlay" onClick={onClose}>
      <div className="sh-modal" onClick={(event) => event.stopPropagation()}>
        <div className="sh-modal-head">
          <h2>Store hours — {store.storeName}</h2>
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="sh-intro">Opening hours for each location. Store staff see them, and the Schedule Builder uses them for opening and closing shifts.</p>
        {problem ? <p className="sh-problem">{problem}</p> : null}
        {locations === null ? <p className="sh-intro">Loading…</p>
          : locations.length ? locations.map((location) => <LocationWeek key={location.location_id} orgId={orgId} location={location} />)
            : <p className="sh-intro">This store has no locations yet. Add its primary location first (Stores → More → Locations &amp; Address).</p>}
      </div>
    </div>
  )
}
