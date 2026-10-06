import React, { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { RESTRICTIONS, loadMyAvailabilityProfile, saveMyAvailabilityProfile } from './lib/myhrPay'

// Availability: when the employee can work and their limits, set by them.
// For each day: any time, not available, or one or more time windows (e.g. a
// student: 3:30 PM – 10:00 PM); preferred and most hours a week;
// restrictions (can't open / close, needs a keyholder on shift, can't work
// alone); and a note. Managers see this in the Schedule Builder, which flags
// shifts that don't fit; they can't change it.

const DAYS = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [0, 'Sunday']]

export default function MyHRAvailability({ storeId }) {
  const [profile, setProfile] = useState(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState('')

  useEffect(() => {
    loadMyAvailabilityProfile(storeId)
      .then((loaded) => setProfile({
        availability: loaded?.availability || {},
        preferred_hours: loaded?.preferred_hours ?? '',
        most_hours: loaded?.most_hours ?? '',
        restrictions: loaded?.restrictions || [],
        note: loaded?.note || '',
        updated_at: loaded?.updated_at || null,
      }))
      .catch((error) => { setProfile({ availability: {}, preferred_hours: '', most_hours: '', restrictions: [], note: '' }); setProblem(error?.message || String(error)) })
  }, [storeId])

  if (!profile) return <p className="myhr-empty">Loading…</p>

  // Per weekday: missing = any time; [] = not available; [{from,to}, …] = only then.
  const modeOf = (day) => (!Array.isArray(profile.availability[day]) ? 'any' : profile.availability[day].length ? 'hours' : 'none')
  const setDay = (day, windows) => setProfile((current) => {
    const availability = { ...current.availability }
    if (windows === undefined) delete availability[day]
    else availability[day] = windows
    return { ...current, availability }
  })
  const windowsOf = (day) => profile.availability[day] || []

  async function save() {
    for (const [weekday, label] of DAYS) {
      for (const window of profile.availability[String(weekday)] || []) {
        if (!window.from || !window.to || window.to <= window.from) { setProblem(`${label}: each time window needs an end after its start.`); return }
      }
    }
    setSaving(true)
    setProblem('')
    try {
      await saveMyAvailabilityProfile(storeId, {
        availability: profile.availability,
        preferred_hours: profile.preferred_hours === '' ? '' : String(profile.preferred_hours),
        most_hours: profile.most_hours === '' ? '' : String(profile.most_hours),
        restrictions: profile.restrictions,
        note: profile.note,
      })
      setNotice('Saved. Your managers will see this when they build the schedule.')
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setSaving(false)
    }
  }

  const toggleRestriction = (key) => setProfile((current) => ({
    ...current,
    restrictions: current.restrictions.includes(key) ? current.restrictions.filter((value) => value !== key) : [...current.restrictions, key],
  }))

  return (
    <div className="av-page">
      <div className="myhr-form-toolbar ts-toolbar">
        <button type="button" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save availability'}</button>
        {notice ? <span className="myhr-notice">{notice}</span> : null}
      </div>
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}

      <section className="myhr-sap-panel">
        <div className="myhr-sap-head"><strong>When I can work</strong></div>
        <div className="av-days">
          {DAYS.map(([weekday, label]) => {
            const day = String(weekday)
            const mode = modeOf(day)
            return (
              <div key={day} className={`av-day ${mode}`}>
                <strong>{label}</strong>
                <select value={mode} onChange={(event) => setDay(day, event.target.value === 'any' ? undefined : event.target.value === 'none' ? [] : [{ from: '15:30', to: '22:00' }])}>
                  <option value="any">Any time</option>
                  <option value="hours">Only these times</option>
                  <option value="none">Not available</option>
                </select>
                {mode === 'hours' ? (
                  <span className="av-windows">
                    {windowsOf(day).map((window, index) => (
                      <span key={index} className="av-window">
                        <input type="time" value={window.from} onChange={(event) => setDay(day, windowsOf(day).map((entry, i) => (i === index ? { ...entry, from: event.target.value } : entry)))} aria-label={`${label} from`} />
                        <span>to</span>
                        <input type="time" value={window.to} onChange={(event) => setDay(day, windowsOf(day).map((entry, i) => (i === index ? { ...entry, to: event.target.value } : entry)))} aria-label={`${label} to`} />
                        {windowsOf(day).length > 1 ? <button type="button" onClick={() => setDay(day, windowsOf(day).filter((_, i) => i !== index))} aria-label="Remove these times"><X size={13} /></button> : null}
                      </span>
                    ))}
                    <button type="button" className="av-add" onClick={() => setDay(day, [...windowsOf(day), { from: '09:00', to: '12:00' }])}><Plus size={13} /> Add times</button>
                  </span>
                ) : <span className="myhr-muted">{mode === 'any' ? 'Can be scheduled any time' : 'Not scheduled this day'}</span>}
              </div>
            )
          })}
        </div>
      </section>

      <div className="av-columns">
        <section className="myhr-sap-panel">
          <div className="myhr-sap-head"><strong>Hours</strong></div>
          <div className="av-fields">
            <label className="myhr-form-row"><span>Preferred hours / week:</span><input type="number" min="0" max="80" step="0.5" value={profile.preferred_hours} onChange={(event) => setProfile((current) => ({ ...current, preferred_hours: event.target.value }))} placeholder="e.g. 20" /></label>
            <label className="myhr-form-row"><span>Most I can work / week:</span><input type="number" min="0" max="80" step="0.5" value={profile.most_hours} onChange={(event) => setProfile((current) => ({ ...current, most_hours: event.target.value }))} placeholder="e.g. 24" /></label>
          </div>
        </section>
        <section className="myhr-sap-panel">
          <div className="myhr-sap-head"><strong>Restrictions</strong></div>
          <div className="av-fields av-restrictions">
            {RESTRICTIONS.map(([key, label]) => (
              <label key={key}><input type="checkbox" checked={profile.restrictions.includes(key)} onChange={() => toggleRestriction(key)} /> {label}</label>
            ))}
          </div>
        </section>
      </div>

      <section className="myhr-sap-panel">
        <div className="myhr-sap-head"><strong>Note for my manager</strong></div>
        <div className="av-fields">
          <textarea rows={3} value={profile.note} onChange={(event) => setProfile((current) => ({ ...current, note: event.target.value }))} placeholder="e.g. Student: classes until 3 on weekdays, exams Dec 8–19" />
        </div>
      </section>
      <small className="myhr-muted">Your managers see this when building the schedule, and the schedule warns them if a shift doesn't fit. Only you can change it.{profile.updated_at ? ` Last updated ${new Date(profile.updated_at).toLocaleDateString([], { dateStyle: 'medium' })}.` : ''}</small>
    </div>
  )
}
