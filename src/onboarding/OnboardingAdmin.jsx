import React, { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { DATA_SOURCES, PROJECT_STATUSES, adminStores, loadProjects, saveProject } from '../lib/onboarding'
import OnboardingWorkspace from './OnboardingWorkspace'
import './onboarding.css'

const statusLabel = (status) => PROJECT_STATUSES.find(([key]) => key === status)?.[1] || status

// NORDVIK administrators: every retailer onboarding project, new projects for
// approved stores, and each project's assessment.
export default function OnboardingAdmin({ session }) {
  const [projects, setProjects] = useState(null)
  const [stores, setStores] = useState([])
  const [openId, setOpenId] = useState('')
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    Promise.all([loadProjects(), adminStores()])
      .then(([rows, storeRows]) => { setProjects(rows); setStores(storeRows || []); setError('') })
      .catch((err) => { setProjects([]); setError(err.message) })
  }, [reload])

  const storeName = (id) => stores.find((store) => store.id === id)?.store_name || 'Store'
  if (openId) {
    return (
      <div className="admin-stack">
        <div className="ob-row"><button type="button" onClick={() => setEditing(projects.find((project) => project.id === openId))}>Edit assessment</button></div>
        <OnboardingWorkspace key={reload} session={session} projectId={openId} onBack={() => { setOpenId(''); setReload((value) => value + 1) }} />
        {editing ? <ProjectForm project={editing} stores={stores} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setReload((value) => value + 1) }} /> : null}
      </div>
    )
  }
  return (
    <section className="admin-panel ob">
      <div className="admin-panel-header">
        <div>
          <p className="admin-kicker">Retailers</p>
          <h2>Inventory Onboarding</h2>
        </div>
        <button className="admin-gold-button" type="button" onClick={() => setEditing({})}><Plus size={15} /> New onboarding project</button>
      </div>
      {error ? <p className="ob-error">{error}</p> : null}
      {projects === null ? <p className="ob-muted">Loading…</p> : (
        <table className="ob-table">
          <thead><tr><th>Project</th><th>Store</th><th>Status</th><th>Categories</th><th>Approx. items</th><th>Expected hours</th><th>Started</th></tr></thead>
          <tbody>{projects.map((project) => (
            <tr key={project.id} onClick={() => setOpenId(project.id)}>
              <td><strong>{project.name}</strong></td>
              <td>{storeName(project.store_id)}</td>
              <td><span className={`ob-pill ${project.status}`}>{statusLabel(project.status)}</span></td>
              <td>{project.categories?.join(', ') || '—'}</td>
              <td>{project.approx_quantity ?? '—'}</td>
              <td>{project.expected_hours ?? '—'}</td>
              <td>{new Date(project.created_at).toLocaleDateString()}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {projects?.length === 0 && !error ? <p className="ob-muted">No onboarding projects yet. Start one for an approved store.</p> : null}
      {editing ? <ProjectForm project={editing} stores={stores} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); setReload((value) => value + 1); if (!editing.id) setOpenId(id) }} /> : null}
    </section>
  )
}

// The onboarding assessment: what the retailer has, where the data comes
// from, how they price, and the expected labour.
function ProjectForm({ project, stores, onClose, onSaved }) {
  const isNew = !project.id
  const [form, setForm] = useState(() => ({
    storeId: project.store_id || '',
    name: project.name || '',
    status: project.status || 'assessment',
    categories: (project.categories || []).join(', '),
    approx_quantity: project.approx_quantity ?? '',
    data_sources: project.data_sources || [],
    existing_pos: project.existing_pos || '',
    pricing_methods: project.pricing_methods || '',
    require_price_approval: project.require_price_approval ?? true,
    expected_hours: project.expected_hours ?? '',
    notes: project.notes || '',
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (patch) => setForm((current) => ({ ...current, ...patch }))

  async function save() {
    setBusy(true); setError('')
    try {
      const details = {
        name: form.name || `${stores.find((store) => store.id === form.storeId)?.store_name || 'Store'} inventory onboarding`,
        status: form.status,
        categories: form.categories.split(',').map((value) => value.trim()).filter(Boolean),
        approx_quantity: form.approx_quantity === '' ? '' : String(parseInt(form.approx_quantity, 10) || 0),
        data_sources: form.data_sources,
        existing_pos: form.existing_pos,
        pricing_methods: form.pricing_methods,
        require_price_approval: form.require_price_approval,
        expected_hours: form.expected_hours === '' ? '' : String(Number(form.expected_hours) || 0),
        notes: form.notes,
      }
      const id = await saveProject({ projectId: project.id || null, storeId: isNew ? form.storeId : null, details })
      onSaved(id)
    } catch (err) { setError(err.message); setBusy(false) }
  }

  return (
    <div className="register-modal ob-panel" role="dialog" aria-modal="true">
      <section>
        <div className="ob-panel-head">
          <div><p className="ob-kicker">Onboarding assessment</p><h2>{isNew ? 'New onboarding project' : project.name}</h2></div>
        </div>
        <div className="ob-grid">
          {isNew ? (
            <label>Store (approved)
              <select value={form.storeId} onChange={(event) => set({ storeId: event.target.value })}>
                <option value="">Choose a store…</option>
                {stores.map((store) => <option key={store.id} value={store.id}>{store.store_name}{store.store_code ? ` (${store.store_code})` : ''} · {store.status}{store.organization ? ` · ${store.organization}` : ''}</option>)}
              </select>
            </label>
          ) : (
            <label>Status
              <select value={form.status} onChange={(event) => set({ status: event.target.value })}>
                {PROJECT_STATUSES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
          )}
          <label>Project name <input value={form.name} onChange={(event) => set({ name: event.target.value })} placeholder="e.g. Main store opening stock" /></label>
          <label>Product categories (comma separated) <input value={form.categories} onChange={(event) => set({ categories: event.target.value })} placeholder="Sports Cards, Trading Cards, LEGO / Building Blocks" /></label>
          <label>Approximate quantity <input type="number" min="0" value={form.approx_quantity} onChange={(event) => set({ approx_quantity: event.target.value })} /></label>
          <label>Existing POS / system <input value={form.existing_pos} onChange={(event) => set({ existing_pos: event.target.value })} placeholder="e.g. Square, Lightspeed, spreadsheet" /></label>
          <label>Expected labour (hours) <input type="number" min="0" step="0.5" value={form.expected_hours} onChange={(event) => set({ expected_hours: event.target.value })} /></label>
          <fieldset className="ob-fieldset"><legend>Data sources</legend>
            {DATA_SOURCES.map(([key, label]) => (
              <label key={key} className="ob-check-line"><input type="checkbox" checked={form.data_sources.includes(key)} onChange={(event) => set({ data_sources: event.target.checked ? [...form.data_sources, key] : form.data_sources.filter((value) => value !== key) })} /> {label}</label>
            ))}
          </fieldset>
          <label>How they price today <textarea rows={2} value={form.pricing_methods} onChange={(event) => set({ pricing_methods: event.target.value })} placeholder="e.g. Price stickers in store, separate eBay prices" /></label>
          <label className="ob-check-line"><input type="checkbox" checked={form.require_price_approval} onChange={(event) => set({ require_price_approval: event.target.checked })} /> The retailer approves prices before stock goes on sale</label>
          <label>Notes <textarea rows={3} value={form.notes} onChange={(event) => set({ notes: event.target.value })} /></label>
        </div>
        {error ? <p className="ob-error">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="update-prompt-primary" type="button" onClick={save} disabled={busy || (isNew && !form.storeId)}>{busy ? 'Saving…' : isNew ? 'Create project' : 'Save'}</button>
        </div>
      </section>
    </div>
  )
}
