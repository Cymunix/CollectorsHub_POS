import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Search } from 'lucide-react'
import { loadOrgOnboarding, loadOrgStaff } from './lib/myhrPay'
import { OrgJobEditor } from './MyHRJob'
import { OrgLeaveEntitlements, OrgScheduleProfile } from './MyHRLeave'
import { OnboardingBadge, OrgOnboardingPanel, onboardingCounts } from './MyHROnboarding'

// The organization's employees, across all of its stores (org sign-in only):
// their onboarding status, and their job, pay, scheduling and leave
// entitlements (set here, not by the stores). Staff still being onboarded are
// listed first. Used for the org's Staff section and MyHR → Employees.

export default function MyHROrgEmployees({ orgId, orgName, onBack, initialSelectedId = '', title = 'Employees' }) {
  const [staff, setStaff] = useState(null)
  const [onboarding, setOnboarding] = useState({})
  const [selectedId, setSelectedId] = useState(initialSelectedId)
  const [search, setSearch] = useState('')
  const [problem, setProblem] = useState('')

  async function reload() {
    try {
      const [people, status] = await Promise.all([loadOrgStaff(orgId), loadOrgOnboarding(orgId).catch(() => ({}))])
      setStaff(people)
      setOnboarding(status)
      setProblem('')
    } catch (error) {
      setStaff([])
      setProblem(error?.message || String(error))
    }
  }
  useEffect(() => { reload() }, [orgId])
  useEffect(() => { if (initialSelectedId) setSelectedId(initialSelectedId) }, [initialSelectedId])

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase()
    const pending = (person) => (onboardingCounts(onboarding[person.id])?.done === false ? 0 : 1)
    return (staff || [])
      .filter((person) => !term || [person.name, person.store_name, person.position_title, person.personnel_number, person.role].some((value) => String(value || '').toLowerCase().includes(term)))
      .sort((a, b) => pending(a) - pending(b) || String(a.store_name).localeCompare(String(b.store_name)) || String(a.name).localeCompare(String(b.name)))
  }, [staff, search, onboarding])

  const selected = (staff || []).find((person) => person.id === selectedId)
  // Org tasks jump to the panel that does them.
  const jump = (task) => document.getElementById(`org-task-${task === 'pay' ? 'job' : task}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <section className="myhr-page myhr-org-employees">
      {onBack ? (
        <div className="myhr-page-top">
          <button type="button" className="myhr-back" onClick={onBack}><ArrowLeft size={16} /> MyHR</button>
        </div>
      ) : null}
      <header className="myhr-page-head">
        <h2>{title}</h2>
        <span className="myhr-muted">{orgName ? `${orgName} · ` : ''}onboarding, job, pay, scheduling and leave are set here, not by the stores</span>
      </header>
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}

      <div className="myhr-org-layout">
        <div className="myhr-pay-panel">
          <label className="myhr-org-search">
            <Search size={15} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, store, position, personnel number" />
          </label>
          {staff === null ? <p className="myhr-empty">Loading…</p> : shown.length ? (
            <table className="myhr-wage-table myhr-org-table">
              <thead><tr><th>Name</th><th>Store</th><th>Position</th><th>Onboarding</th></tr></thead>
              <tbody>
                {shown.map((person) => (
                  <tr key={person.id} className={person.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(person.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') setSelectedId(person.id) }}>
                    <td>{person.name}<small className="myhr-muted"> {String(person.role || '').replace(/_/g, ' ')}{person.personnel_number ? ` · #${person.personnel_number}` : ''}</small></td>
                    <td>{person.store_name}</td>
                    <td>{person.position_title || <span className="myhr-muted">Not set</span>}</td>
                    <td>{onboarding[person.id] ? <OnboardingBadge status={onboarding[person.id]} /> : <span className="myhr-muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="myhr-empty">{staff.length ? 'No one matches that search.' : 'No employees found in this organization’s stores.'}</p>}
        </div>
        {selectedId ? (
          <div className="myhr-org-editors">
            <OrgOnboardingPanel status={onboarding[selectedId]} name={selected?.name} onJump={jump} />
            <div id="org-task-job"><OrgJobEditor orgId={orgId} employeeId={selectedId} onSaved={reload} /></div>
            <div id="org-task-scheduling"><OrgScheduleProfile orgId={orgId} employeeId={selectedId} onSaved={reload} /></div>
            <div id="org-task-leave"><OrgLeaveEntitlements orgId={orgId} employeeId={selectedId} onSaved={reload} /></div>
          </div>
        ) : <p className="myhr-empty">Pick an employee to see their onboarding and set their job, pay, scheduling and leave.</p>}
      </div>
    </section>
  )
}
