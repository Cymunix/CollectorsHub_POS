import React, { useEffect, useState } from 'react'
import { PROJECT_STATUSES, loadProjects } from '../lib/onboarding'
import OnboardingWorkspace from './OnboardingWorkspace'
import './onboarding.css'

// Store staff: this store's onboarding projects (NORDVIK creates them). One
// open project opens straight away.
export default function OnboardingStore({ session }) {
  const [projects, setProjects] = useState(null)
  const [openId, setOpenId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    loadProjects(session?.storeId)
      .then((rows) => {
        setProjects(rows)
        const open = rows.filter((row) => !['completed', 'cancelled'].includes(row.status))
        if (open.length === 1 && rows.length === 1) setOpenId(open[0].id)
      })
      .catch((err) => { setProjects([]); setError(err.message) })
  }, [session?.storeId])

  if (openId) return <OnboardingWorkspace session={session} projectId={openId} onBack={projects?.length > 1 ? () => setOpenId('') : null} />
  return (
    <section className="ob">
      <header className="ob-head"><div><p className="ob-kicker">{session?.storeName}</p><h1>Inventory Onboarding</h1></div></header>
      {error ? <p className="ob-error">{error}</p> : null}
      {projects === null ? <p className="ob-muted">Loading…</p> : null}
      {projects?.length === 0 && !error ? <p className="ob-muted">There's no onboarding project for this store. NORDVIK sets one up when your inventory is being brought in.</p> : null}
      {projects?.length ? (
        <table className="ob-table">
          <thead><tr><th>Project</th><th>Status</th><th>Started</th></tr></thead>
          <tbody>{projects.map((project) => (
            <tr key={project.id} onClick={() => setOpenId(project.id)}>
              <td><strong>{project.name}</strong></td>
              <td>{PROJECT_STATUSES.find(([key]) => key === project.status)?.[1] || project.status}</td>
              <td>{new Date(project.created_at).toLocaleDateString()}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : null}
    </section>
  )
}
