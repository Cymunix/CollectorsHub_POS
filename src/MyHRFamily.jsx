import React, { useEffect, useState } from 'react'
import { ChevronDown, Pencil, Trash2 } from 'lucide-react'
import { deleteFamilyMember, loadMyFamily, saveFamilyMember } from './lib/myhrPay'

// Family Related Data (Dependents and Beneficiaries): the employee's family
// members, grouped by relationship, each with name, date of birth and gender.
// Add picks the relationship; each entry can be edited or removed.

const RELATIONSHIPS = ['Spouse', 'Common-law partner', 'Child', 'Father', 'Mother', 'Sibling', 'Guardian', 'Other dependent']
const GENDERS = ['', 'Male', 'Female', 'Non-binary', 'Another gender', 'Prefer not to say']
const dateText = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '—')

export default function MyHRFamily({ storeId }) {
  const [members, setMembers] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(null) // { id?, relationship, name, dateOfBirth, gender }
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)

  async function reload() {
    try {
      setMembers(await loadMyFamily(storeId))
      setProblem('')
    } catch (error) {
      setMembers([])
      setProblem(error?.message || String(error))
    }
  }
  useEffect(() => { reload() }, [storeId])

  async function save(event) {
    event.preventDefault()
    if (!editing.name.trim()) { setProblem('Enter their name.'); return }
    setBusy(true)
    try {
      await saveFamilyMember(storeId, editing)
      setEditing(null)
      await reload()
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  async function remove(member) {
    if (!window.confirm(`Remove ${member.name} (${member.relationship})?`)) return
    window.nordvikDesktop?.refocusWindow?.()
    setBusy(true)
    try {
      await deleteFamilyMember(storeId, member.id)
      await reload()
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  if (!members) return <p className="myhr-empty">Loading…</p>
  const order = (relationship) => { const index = RELATIONSHIPS.indexOf(relationship); return index < 0 ? 99 : index }
  const sorted = [...members].sort((a, b) => order(a.relationship) - order(b.relationship))

  return (
    <section className="myhr-family">
      <div className="myhr-family-head">
        <strong>Family Members / Dependents</strong>
        <span className="myhr-family-add">
          <button type="button" onClick={() => setMenuOpen((open) => !open)} disabled={busy} aria-expanded={menuOpen}>Add <ChevronDown size={14} /></button>
          {menuOpen ? (
            <span className="myhr-family-menu" role="menu">
              {RELATIONSHIPS.map((relationship) => (
                <button key={relationship} type="button" role="menuitem" onClick={() => { setMenuOpen(false); setProblem(''); setEditing({ relationship, name: '', dateOfBirth: '', gender: '' }) }}>{relationship}</button>
              ))}
            </span>
          ) : null}
        </span>
      </div>
      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}

      {editing ? (
        <form className="myhr-family-form" onSubmit={save}>
          <strong>{editing.id ? 'Edit' : 'Add'} {editing.relationship.toLowerCase()}</strong>
          <label className="myhr-form-row"><span><b className="myhr-required">*</b>Relationship:</span>
            <select value={editing.relationship} onChange={(event) => setEditing((current) => ({ ...current, relationship: event.target.value }))}>
              {RELATIONSHIPS.map((relationship) => <option key={relationship}>{relationship}</option>)}
              {!RELATIONSHIPS.includes(editing.relationship) ? <option>{editing.relationship}</option> : null}
            </select>
          </label>
          <label className="myhr-form-row"><span><b className="myhr-required">*</b>Name:</span>
            <input autoFocus value={editing.name} onChange={(event) => setEditing((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <label className="myhr-form-row"><span>Date of Birth:</span>
            <input type="date" value={editing.dateOfBirth} onChange={(event) => setEditing((current) => ({ ...current, dateOfBirth: event.target.value }))} />
          </label>
          <label className="myhr-form-row"><span>Gender:</span>
            <select value={editing.gender} onChange={(event) => setEditing((current) => ({ ...current, gender: event.target.value }))}>
              {GENDERS.map((gender) => <option key={gender} value={gender}>{gender}</option>)}
            </select>
          </label>
          <div className="myhr-editor-actions">
            <button type="button" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
            <button type="submit" className="gold-button" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      ) : null}

      {sorted.length ? sorted.map((member) => (
        <div className="myhr-family-member" key={member.id}>
          <div className="myhr-family-member-head">
            <h4>{member.relationship}</h4>
            <span>
              <button type="button" onClick={() => setEditing({ id: member.id, relationship: member.relationship, name: member.name, dateOfBirth: member.date_of_birth || '', gender: member.gender || '' })} aria-label={`Edit ${member.name}`} disabled={busy}><Pencil size={14} /></button>
              <button type="button" onClick={() => remove(member)} aria-label={`Remove ${member.name}`} disabled={busy}><Trash2 size={14} /></button>
            </span>
          </div>
          <dl className="myhr-facts compact">
            <dt>Name:</dt><dd>{member.name}</dd>
            <dt>Date of Birth:</dt><dd>{dateText(member.date_of_birth)}</dd>
            <dt>Gender:</dt><dd>{member.gender || '—'}</dd>
          </dl>
        </div>
      )) : !editing ? <p className="myhr-empty">No family members added. Use Add to add one.</p> : null}
    </section>
  )
}
