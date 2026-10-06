import { supabase } from './supabaseClient'

// MyHR settings for the signed-in store's organization (supabase/myhr_settings.sql):
// which sections show, the org's orientation link, and whether this user (the
// org owner) can change them. Returns null when there's nothing to apply (no
// organization, or the SQL isn't installed yet), meaning: show every section.

export async function loadMyHRSettings(storeId) {
  if (!storeId) return null
  const { data, error } = await supabase.rpc('store_myhr_settings', { p_store_id: storeId })
  if (error) {
    console.warn('[MyHR] settings unavailable:', error.message)
    return null
  }
  const row = Array.isArray(data) ? data[0] : data
  if (!row?.organization_id) return null
  return {
    organizationId: row.organization_id,
    organizationName: row.organization_name || '',
    // null: the org hasn't chosen yet, so every section shows.
    enabledSections: Array.isArray(row.enabled_sections) ? row.enabled_sections : null,
    orientationUrl: row.orientation_url || '',
    canEdit: Boolean(row.can_edit),
  }
}

export async function saveMyHRSettings({ organizationId, enabledSections, orientationUrl }) {
  const { error } = await supabase.rpc('set_organization_myhr_settings', {
    p_org_id: organizationId,
    p_sections: enabledSections,
    p_orientation_url: orientationUrl || null,
  })
  if (error) throw error
}
