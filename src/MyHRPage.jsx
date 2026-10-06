import React, { useState } from 'react'
import { ArrowLeft, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react'
import { cleanMyHRPage, hasMyHRPage, saveMyHRPage } from './lib/myhrSettings'

// One MyHR section's page, written by the organization: an intro, a notice,
// a main button (e.g. the payroll portal) and groups of links to forms and
// guides. Links open in the browser. The org owner can edit it in place.
// A section with a built feature (children, e.g. the time clock and leave on
// My Pay) shows it first, with the org's page underneath.

const openLink = (url) => window.open(url, '_blank')

export default function MyHRPage({ section, page, settings, onBack, onSaved, children = null }) {
  const [draft, setDraft] = useState(null)
  const Icon = section.icon

  return (
    <section className="myhr-page">
      <div className="myhr-page-top">
        <button type="button" className="myhr-back" onClick={onBack}><ArrowLeft size={16} /> MyHR</button>
        {settings?.canEdit && !draft ? (
          <button type="button" className="myhr-edit-button" onClick={() => setDraft(toDraft(page))}><Pencil size={15} /> Edit page</button>
        ) : null}
      </div>
      <header className="myhr-page-head">
        <span className="myhr-logo" aria-hidden="true"><Icon size={28} /></span>
        <h2>{section.label}</h2>
      </header>

      {children && !draft ? children : null}
      {children && !draft && (hasMyHRPage(page) || settings?.canEdit) ? <h3 className="myhr-page-subhead">From {settings?.organizationName || 'your organization'}</h3> : null}

      {draft ? (
        <PageEditor
          draft={draft}
          setDraft={setDraft}
          organizationId={settings.organizationId}
          sectionKey={section.key}
          onCancel={() => setDraft(null)}
          onSaved={(content) => { setDraft(null); onSaved(content) }}
        />
      ) : hasMyHRPage(page) ? (
        <div className="myhr-page-body">
          {page.button ? (
            <button type="button" className="myhr-main-link" onClick={() => openLink(page.button.url)}>
              {page.button.label} <ExternalLink size={16} />
            </button>
          ) : null}
          {page.notice ? <p className="myhr-page-notice">{page.notice}</p> : null}
          {page.intro ? <p className="myhr-page-intro">{page.intro}</p> : null}
          {(page.groups || []).map((group, index) => (
            <div className="myhr-page-group" key={index}>
              {group.title ? <h3>{group.title}</h3> : null}
              {group.text ? <p>{group.text}</p> : null}
              {group.links?.length ? (
                <ul>
                  {group.links.map((link, linkIndex) => (
                    <li key={linkIndex}>
                      <button type="button" onClick={() => openLink(link.url)}>{link.label} <ExternalLink size={13} /></button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      ) : children ? null : (
        <p className="myhr-empty">
          {settings?.canEdit ? 'This page is empty. Use Edit page to add what your staff need here.' : "Your organization hasn't set up this page yet."}
        </p>
      )}
    </section>
  )
}

function toDraft(page = {}) {
  return {
    intro: page?.intro || '',
    notice: page?.notice || '',
    button: { label: page?.button?.label || '', url: page?.button?.url || '' },
    groups: (page?.groups || []).map((group) => ({
      title: group.title || '',
      text: group.text || '',
      links: (group.links || []).map((link) => ({ ...link })),
    })),
  }
}

function PageEditor({ draft, setDraft, organizationId, sectionKey, onCancel, onSaved }) {
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState('')
  const set = (changes) => setDraft((current) => ({ ...current, ...changes }))
  const setGroup = (index, changes) => setDraft((current) => ({ ...current, groups: current.groups.map((group, i) => (i === index ? { ...group, ...changes } : group)) }))
  const setLink = (groupIndex, linkIndex, changes) => setGroup(groupIndex, { links: draft.groups[groupIndex].links.map((link, i) => (i === linkIndex ? { ...link, ...changes } : link)) })

  async function save() {
    const { content, problem: found } = cleanMyHRPage(draft)
    if (found) { setProblem(found); return }
    setSaving(true)
    setProblem('')
    try {
      await saveMyHRPage({ organizationId, section: sectionKey, content })
      onSaved(content)
    } catch (error) {
      setProblem(`Couldn't save: ${error?.message || error}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="myhr-page-editor">
      <label>
        Main button (optional): e.g. your payroll or scheduling site
        <span className="myhr-editor-pair">
          <input value={draft.button.label} onChange={(event) => set({ button: { ...draft.button, label: event.target.value } })} placeholder="Button text, e.g. Payroll portal" />
          <input value={draft.button.url} onChange={(event) => set({ button: { ...draft.button, url: event.target.value } })} placeholder="https://…" />
        </span>
      </label>
      <label>
        Notice (optional): shown highlighted at the top
        <input value={draft.notice} onChange={(event) => set({ notice: event.target.value })} placeholder="e.g. 2025 T4s are now available in the payroll portal" />
      </label>
      <label>
        Introduction
        <textarea rows={3} value={draft.intro} onChange={(event) => set({ intro: event.target.value })} placeholder="What staff will find on this page." />
      </label>

      {draft.groups.map((group, groupIndex) => (
        <fieldset className="myhr-editor-group" key={groupIndex}>
          <legend>Group {groupIndex + 1}</legend>
          <span className="myhr-editor-pair">
            <input value={group.title} onChange={(event) => setGroup(groupIndex, { title: event.target.value })} placeholder="Heading, e.g. Forms" />
            <button type="button" className="myhr-editor-remove" onClick={() => set({ groups: draft.groups.filter((_, i) => i !== groupIndex) })} title="Remove this group"><Trash2 size={15} /></button>
          </span>
          <textarea rows={2} value={group.text} onChange={(event) => setGroup(groupIndex, { text: event.target.value })} placeholder="Description (optional)" />
          {group.links.map((link, linkIndex) => (
            <span className="myhr-editor-pair" key={linkIndex}>
              <input value={link.label} onChange={(event) => setLink(groupIndex, linkIndex, { label: event.target.value })} placeholder="Link text, e.g. Direct deposit form" />
              <input value={link.url} onChange={(event) => setLink(groupIndex, linkIndex, { url: event.target.value })} placeholder="https://…" />
              <button type="button" className="myhr-editor-remove" onClick={() => setGroup(groupIndex, { links: group.links.filter((_, i) => i !== linkIndex) })} title="Remove this link"><Trash2 size={15} /></button>
            </span>
          ))}
          <button type="button" className="myhr-editor-add" onClick={() => setGroup(groupIndex, { links: [...group.links, { label: '', url: '' }] })}><Plus size={14} /> Add link</button>
        </fieldset>
      ))}
      <button type="button" className="myhr-editor-add" onClick={() => set({ groups: [...draft.groups, { title: '', text: '', links: [{ label: '', url: '' }] }] })}><Plus size={14} /> Add group of links</button>

      {problem ? <p className="myhr-editor-problem">{problem}</p> : null}
      <div className="myhr-editor-actions">
        <button type="button" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" className="gold-button" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save page'}</button>
      </div>
    </div>
  )
}
