import React, { useEffect, useState } from 'react'
import {
  BriefcaseBusiness,
  CalendarClock,
  Check,
  ContactRound,
  DoorOpen,
  HeartHandshake,
  HeartPulse,
  IdCard,
  Plane,
  Presentation,
  RotateCcwSquare,
  SlidersHorizontal,
  TrendingUp,
  UsersRound,
  Wallet,
} from 'lucide-react'
import { loadStoreName } from './lib/auth'
import { loadMyHRSettings, saveMyHRSettings } from './lib/myhrSettings'

// MyHR: the employee's own HR hub (pay, time off, training, etc.). The store's
// organization picks which sections its staff see and supplies its own
// orientation material; the org owner sets both from here ("Choose sections").
// A section that isn't built yet is greyed out as "Coming soon".

const MYHR_SECTIONS = [
  { key: 'orientation', label: 'My Orientation', blurb: "Your organization's orientation", icon: RotateCcwSquare },
  { key: 'pay', label: 'My Pay, Vacation & Leaves', blurb: 'Pay stubs, hours, vacation balance', icon: Wallet },
  { key: 'benefits', label: 'My Benefits', blurb: 'Coverage and employee discount', icon: HeartHandshake },
  { key: 'learning', label: 'My Learning & Development', blurb: 'Training and grading courses', icon: Presentation },
  { key: 'performance', label: 'My Performance', blurb: 'Goals, reviews and feedback', icon: TrendingUp },
  { key: 'job', label: 'My Job & Opportunities', blurb: 'Role, postings and promotions', icon: BriefcaseBusiness },
  { key: 'engagement', label: 'My Workplace Engagement & Diversity', blurb: 'Team news, surveys, recognition', icon: UsersRound },
  { key: 'safety', label: 'My Workplace Health & Safety', blurb: 'Policies and incident reports', icon: HeartPulse },
  { key: 'absences', label: 'My Absences & Leave Requests', blurb: 'Request time off, sick days', icon: CalendarClock },
  { key: 'travel', label: 'My Travel', blurb: 'Card shows, events and expenses', icon: Plane },
  { key: 'departure', label: 'My Retirement & Departure', blurb: 'Resignation and final pay', icon: DoorOpen },
  { key: 'contacts', label: 'HR Contact Directory', blurb: 'Who to ask about what', icon: ContactRound },
]
const ALL_KEYS = MYHR_SECTIONS.map((section) => section.key)

const isWebLink = (value) => /^https?:\/\/\S+$/i.test(String(value || '').trim())

export default function MyHRView({ session }) {
  const name = session?.displayName || [session?.firstName, session?.lastName].filter(Boolean).join(' ') || session?.username || 'Employee'
  const role = session?.role ? String(session.role).replace(/_/g, ' ') : ''
  // Sessions from before the store name was looked up at sign-in say 'Store'.
  const sessionStore = session?.storeName && session.storeName !== 'Store' ? session.storeName : ''
  const [lookedUp, setLookedUp] = useState('')
  useEffect(() => {
    if (sessionStore || !session?.storeId) return
    let live = true
    loadStoreName(session.storeId).then((found) => { if (live) setLookedUp(found) })
    return () => { live = false }
  }, [session?.storeId, sessionStore])
  const storeName = sessionStore || lookedUp || session?.orgName || 'your store'

  // The organization's choices (null: none, so every section shows).
  const [settings, setSettings] = useState(null)
  const [editing, setEditing] = useState(null) // { sections: Set, orientationUrl } while choosing
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let live = true
    loadMyHRSettings(session?.storeId).then((loaded) => { if (live) setSettings(loaded) })
    return () => { live = false }
  }, [session?.storeId])

  const enabled = new Set(settings?.enabledSections || ALL_KEYS)
  const orientationUrl = settings?.orientationUrl || ''
  // What each section does when opened (only the built ones).
  const openers = {
    orientation: isWebLink(orientationUrl) ? () => window.open(orientationUrl, '_blank') : null,
  }

  function startEditing() {
    setNotice('')
    setEditing({ sections: new Set(enabled), orientationUrl })
  }

  function toggleSection(key) {
    setEditing((current) => {
      const sections = new Set(current.sections)
      if (sections.has(key)) sections.delete(key)
      else sections.add(key)
      return { ...current, sections }
    })
  }

  async function saveEditing() {
    const link = editing.orientationUrl.trim()
    if (link && !isWebLink(link)) {
      setNotice('The orientation link needs to start with https://')
      return
    }
    const enabledSections = ALL_KEYS.filter((key) => editing.sections.has(key))
    setSaving(true)
    try {
      await saveMyHRSettings({ organizationId: settings.organizationId, enabledSections, orientationUrl: link })
      setSettings((current) => ({ ...current, enabledSections, orientationUrl: link }))
      setEditing(null)
      setNotice(`Saved. ${settings.organizationName || 'Your organization'}'s staff now see ${enabledSections.length} section${enabledSections.length === 1 ? '' : 's'}.`)
    } catch (error) {
      setNotice(`Couldn't save: ${error?.message || error}`)
    } finally {
      setSaving(false)
    }
  }

  const shown = editing ? MYHR_SECTIONS : MYHR_SECTIONS.filter((section) => enabled.has(section.key))

  return (
    <section className="myhr">
      <header className="myhr-head">
        <span className="myhr-logo" aria-hidden="true"><IdCard size={30} /></span>
        <div>
          <h2>MyHR</h2>
          <p>Human resources for the {storeName} team</p>
        </div>
        <div className="myhr-me">
          <strong>{name}</strong>
          <small>{[role, storeName].filter(Boolean).join(' · ')}</small>
        </div>
        {settings?.canEdit && !editing ? (
          <button type="button" className="myhr-edit-button" onClick={startEditing}>
            <SlidersHorizontal size={16} /> Choose sections
          </button>
        ) : null}
      </header>

      {editing ? (
        <div className="myhr-editbar">
          <span>
            <strong>Choose what {settings.organizationName || 'your organization'}'s staff see.</strong>
            <small>Click a tile to show or hide it. {editing.sections.size} of {MYHR_SECTIONS.length} shown.</small>
          </span>
          <label>
            Orientation link
            <input
              value={editing.orientationUrl}
              onChange={(event) => setEditing((current) => ({ ...current, orientationUrl: event.target.value }))}
              placeholder="https://… (your orientation document or site)"
            />
          </label>
          <button type="button" onClick={() => { setEditing(null); setNotice('') }} disabled={saving}>Cancel</button>
          <button type="button" className="gold-button" onClick={saveEditing} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      ) : null}
      {notice ? <p className="myhr-notice">{notice}</p> : null}

      {!shown.length ? (
        <p className="myhr-empty">Your organization hasn't turned on any MyHR sections yet.</p>
      ) : (
        <div className="myhr-tiles">
          {shown.map((section) => {
            const Icon = section.icon
            if (editing) {
              const on = editing.sections.has(section.key)
              return (
                <button
                  key={section.key}
                  type="button"
                  className={`myhr-tile myhr-tile-choose${on ? ' on' : ' off'}`}
                  aria-pressed={on}
                  onClick={() => toggleSection(section.key)}
                >
                  <span className="myhr-tile-check" aria-hidden="true">{on ? <Check size={18} /> : null}</span>
                  <Icon size={46} strokeWidth={1.6} />
                  <strong>{section.label}</strong>
                  <small>{on ? 'Shown' : 'Hidden'}</small>
                </button>
              )
            }
            const open = openers[section.key]
            const waiting = section.key === 'orientation' && !open ? 'Not set up by your organization yet' : 'Coming soon'
            return (
              <button
                key={section.key}
                type="button"
                className={`myhr-tile${open ? '' : ' not-ready'}`}
                disabled={!open}
                title={open ? section.blurb : waiting}
                onClick={() => open?.()}
              >
                <Icon size={46} strokeWidth={1.6} />
                <strong>{section.label}</strong>
                <small>{open ? section.blurb : waiting}</small>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
