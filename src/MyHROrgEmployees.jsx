import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Search } from 'lucide-react'
import { loadOrgStaff } from './lib/myhrPay'
import { OrgJobEditor } from './MyHRJob'
import { OrgLeaveEntitlements, OrgScheduleProfile } from './MyHRLeave'

// The organization's employees, across all of its stores (org sign-in only).
// Pick someone to edit their job, pay and leave entitlements; stores can't change these.

export default function MyHROrgEmployees({ orgId, orgName, onBack, initialSelectedId = '' }) {
  const [staff, setStaff] = useState(null)
  const [selectedId, setSelectedId] = useState(initialSelectedId)
  const [search, setSearch] = useState('')
  const [problem, setProblem] = useState('')

  async function reload() {
    try {
      setStaff(await loadOrgStaff(orgId))
      setProblem('')
    } catch (error) {
      setStaff([])
      setProblem(error?.message || String(error))
    }
  }
  useEffect(() => { reload() }, [orgId])

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (staff || [])
      .filter((person) => !term || [person.name, person.store_name, person.position_title, person.personnel_number, person.role].some((value) => String(value || '').toLowerCase().includes(term)))
      .sort((a, b) => String(a.store_name).localeCompare(String(b.store_name)) || String(a.name).localeCompare(String(b.name)))
  }, [staff, search])

  return (
    <section className="myhr-page myhr-org-employees">
      <div className="myhr-page-top">
        <button type="button" className="myhr-back" onClick={onBack}><ArrowLeft size={16} /> MyHR</button>
      </div>
      <header className="myhr-page-head">
        <h2>Employees</h2>
        <span className="myhr-muted">{orgName ? `${orgName} · ` : ''}job and pay are set here, not by the stores</span>
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
              <thead><tr><th>Name</th><th>Store</th><th>Position</th><th>Personnel #</th><th>Status</th></tr></thead>
              <tbody>
                {shown.map((person) => (
                  <tr key={person.id} className={person.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(person.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') setSelectedId(person.id) }}>
                    <td>{person.name}<small className="myhr-muted"> {String(person.role || '').replace(/_/g, ' ')}</small></td>
                    <td>{person.store_name}</td>
                    <td>{person.position_title || <span className="myhr-muted">Not set</span>}</td>
                    <td>{person.personnel_number || '—'}</td>
                    <td className="capitalize">{person.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="myhr-empty">{staff.length ? 'No one matches that search.' : 'No employees found in this organization’s stores.'}</p>}
        </div>
        {selectedId ? (
          <div className="myhr-org-editors">
            <OrgJobEditor orgId={orgId} employeeId={selectedId} onSaved={reload} />
            <OrgScheduleProfile orgId={orgId} employeeId={selectedId} />
            <OrgLeaveEntitlements orgId={orgId} employeeId={selectedId} />
          </div>
        ) : <p className="myhr-empty">Pick an employee to edit their job, pay and leave entitlements.</p>}
      </div>
    </section>
  )
}
