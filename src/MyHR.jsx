import React from 'react'
import {
  BriefcaseBusiness,
  CalendarClock,
  ContactRound,
  DoorOpen,
  HeartHandshake,
  HeartPulse,
  IdCard,
  Plane,
  Presentation,
  RotateCcwSquare,
  TrendingUp,
  UsersRound,
  Wallet,
} from 'lucide-react'

// MyHR: the employee's own HR hub (pay, time off, training, etc.). The home
// screen lists every section; each section opens once it's built, and until
// then its tile is greyed out as "Coming soon".

export const MYHR_SECTIONS = [
  { key: 'orientation', label: 'My Orientation', blurb: 'Getting started at the store', icon: RotateCcwSquare },
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

export default function MyHRView({ session, readySections = {} }) {
  const name = session?.displayName || [session?.firstName, session?.lastName].filter(Boolean).join(' ') || session?.username || 'Employee'
  const role = session?.role ? String(session.role).replace(/_/g, ' ') : ''
  const storeName = session?.storeName || session?.orgName || 'CollectorsHub Store'

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
      </header>

      <div className="myhr-body">
        <nav className="myhr-list" aria-label="MyHR sections">
          {MYHR_SECTIONS.map((section) => {
            const ready = Boolean(readySections[section.key])
            return (
              <button
                key={section.key}
                type="button"
                className={ready ? '' : 'not-ready'}
                disabled={!ready}
                title={ready ? section.blurb : 'Coming soon'}
                onClick={() => readySections[section.key]?.()}
              >
                {section.label}
              </button>
            )
          })}
        </nav>

        <div className="myhr-tiles">
          {MYHR_SECTIONS.map((section) => {
            const Icon = section.icon
            const ready = Boolean(readySections[section.key])
            return (
              <button
                key={section.key}
                type="button"
                className={`myhr-tile${ready ? '' : ' not-ready'}`}
                disabled={!ready}
                title={ready ? section.blurb : 'Coming soon'}
                onClick={() => readySections[section.key]?.()}
              >
                <Icon size={46} strokeWidth={1.6} />
                <strong>{section.label}</strong>
                <small>{ready ? section.blurb : 'Coming soon'}</small>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
