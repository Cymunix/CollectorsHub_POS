import { supabase } from './supabaseClient'

// MyHR for the signed-in store's organization (supabase/myhr_settings.sql):
// which sections show, the org's page for each section, and whether this user
// (the org owner) can change them. Returns null when there's nothing to apply
// (no organization, or the SQL isn't installed yet): every section shows,
// without pages.

export async function loadMyHRSettings(storeId) {
  if (!storeId) return null
  const { data, error } = await supabase.rpc('store_myhr_settings', { p_store_id: storeId })
  if (error) {
    console.warn('[MyHR] settings unavailable:', error.message)
    return null
  }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null
  // Demo stores see every section, whatever the organization chose.
  if (!row.organization_id) return row.is_test_store ? { organizationId: null, organizationName: '', enabledSections: null, pages: {}, canEdit: false, isTestStore: true } : null
  return {
    organizationId: row.organization_id,
    organizationName: row.organization_name || '',
    // null: the org hasn't chosen yet, so every section shows.
    enabledSections: Array.isArray(row.enabled_sections) && !row.is_test_store ? row.enabled_sections : null,
    pages: row.section_content && typeof row.section_content === 'object' ? row.section_content : {},
    canEdit: Boolean(row.can_edit),
    isTestStore: Boolean(row.is_test_store),
  }
}

export async function saveMyHRSections({ organizationId, enabledSections }) {
  const { error } = await supabase.rpc('set_organization_myhr_sections', { p_org_id: organizationId, p_sections: enabledSections })
  if (error) throw error
}

export async function saveMyHRPage({ organizationId, section, content }) {
  const { error } = await supabase.rpc('set_organization_myhr_page', { p_org_id: organizationId, p_section: section, p_content: content })
  if (error) throw error
}

const isWebLink = (value) => /^https?:\/\/\S+$/i.test(String(value || '').trim())

// A page as saved: trimmed, empty parts dropped, links must be web links.
// Returns { content, problem } (content null when the page is empty).
export function cleanMyHRPage(page = {}) {
  const text = (value) => String(value || '').trim()
  const problems = []
  const link = (entry, where) => {
    const label = text(entry?.label)
    const url = text(entry?.url)
    if (!label && !url) return null
    if (!isWebLink(url)) { problems.push(`${where}: the link for "${label || 'untitled'}" needs to start with https://`); return null }
    return { label: label || url, url }
  }
  const button = link(page.button, 'Main button')
  const groups = (page.groups || []).map((group, index) => {
    const links = (group.links || []).map((entry) => link(entry, text(group.title) || `Group ${index + 1}`)).filter(Boolean)
    const cleaned = { title: text(group.title), text: text(group.text), links }
    return cleaned.title || cleaned.text || links.length ? cleaned : null
  }).filter(Boolean)
  const content = {
    ...(text(page.intro) ? { intro: text(page.intro) } : {}),
    ...(text(page.notice) ? { notice: text(page.notice) } : {}),
    ...(button ? { button } : {}),
    ...(groups.length ? { groups } : {}),
  }
  return { content: Object.keys(content).length ? content : null, problem: problems[0] || '' }
}

export function hasMyHRPage(page) {
  return Boolean(page && (page.intro || page.notice || page.button || page.groups?.length))
}
