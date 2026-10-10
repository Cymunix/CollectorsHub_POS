import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, KeyRound, Search } from 'lucide-react'
import { changeEmployeePassword } from './org/orgApi'
import { loadOrgOnboarding, loadOrgStaff } from './lib/myhrPay'
import { OrgJobEditor } from './MyHRJob'
import { OrgLeaveEntitlements, OrgScheduleProfile } from './MyHRLeave'
import { OnboardingBadge, OrgOnboardingPanel, onboardingCounts } from './MyHROnboarding'

// The organization's employees, across all of its stores (org sign-in only):
// their onboarding status, and their job, pay, scheduling and leave
// entitlements (set here, not by the stores). Staff still being onboarded are
// listed first. Used for the org's Staff section and MyHR → Employees.

// Head office: give an employee a new password (it's also their store PIN).
function ChangePassword({ employeeId, name }) {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState({ text: '', bad: false })
  useEffect(() => { setOpen(false); setPassword(''); setConfirm(''); setMessage({ text: '', bad: false }) }, [employeeId])
  const problem = password && password.trim().length < 4 ? 'At least 4 characters.' : confirm && confirm !== password ? "The passwords don't match." : ''
  async function save(event) {
    event.preventDefault()
    if (problem || !password || confirm !== password) return
    setBusy(true)
    setMessage({ text: '', bad: false })
    try {
      await changeEmployeePassword(employeeId, password)
      setPassword('')
      setConfirm('')
      setOpen(false)
      setMessage({ text: `Password changed for ${name || 'this employee'}. Give them the new password; it's also their store PIN.`, bad: false })
    } catch (error) {
      setMessage({ text: error?.message || String(error), bad: true })
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="myhr-org-password">
      <header>
        <span><KeyRound size={16} /> <strong>Sign-in</strong></span>
        {!open ? <button type="button" onClick={() => { setOpen(true); setMessage({ text: '', bad: false }) }}>Change password</button> : null}
      </header>
      {open ? (
        <form onSubmit={save}>
          <label><span>New password</span><input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /></label>
          <label><span>Confirm new password</span><input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
          {problem ? <p className="bad">{problem}</p> : <p className="myhr-muted">At least 4 characters. It's also their PIN for register approvals.</p>}
          <div>
            <button type="button" onClick={() => { setOpen(false); setPassword(''); setConfirm('') }}>Cancel</button>
            <button type="submit" className="gold-button" disabled={busy || Boolean(problem) || !password || confirm !== password}>{busy ? 'Saving…' : 'Save password'}</button>
          </div>
        </form>
      ) : null}
      {message.text ? <p className={message.bad ? 'bad' : 'good'}>{message.text}</p> : null}
    </section>
  )
}

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
            <ChangePassword employeeId={selectedId} name={selected?.name} />
            <div id="org-task-job"><OrgJobEditor orgId={orgId} employeeId={selectedId} onSaved={reload} /></div>
            <div id="org-task-scheduling"><OrgScheduleProfile orgId={orgId} employeeId={selectedId} onSaved={reload} /></div>
            <div id="org-task-leave"><OrgLeaveEntitlements orgId={orgId} employeeId={selectedId} onSaved={reload} /></div>
          </div>
        ) : <p className="myhr-empty">Pick an employee to see their onboarding and set their job, pay, scheduling and leave.</p>}
      </div>
    </section>
  )
}
