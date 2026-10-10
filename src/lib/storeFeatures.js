import { supabase } from './supabaseClient'

// Optional features per store, decided by the organization (supabase/store_features.sql).
export const STORE_FEATURES = [
  { id: 'pawns_loans', label: 'Pawns & Loans', description: 'Shows the Pawns & Loans tab in this store\'s POS.' },
  { id: 'collector_scanning', label: 'Collector Scanning', description: 'Scan Centre can scan items into collectors\' own CollectorsHub collections (Express Scan and Collection Drop-Off).' },
]

// { pawns_loans: true, ... } for the signed-in store. Off when unknown or not installed.
export async function loadStoreFeatures(storeId) {
  if (!storeId) return {}
  const { data, error } = await supabase.rpc('store_feature_flags', { p_store_id: storeId })
  if (error) {
    if (!/could not find the function|does not exist/i.test(error.message || '')) console.warn('[Features]', error.message)
    return {}
  }
  return data || {}
}

export async function loadOrgStoreFeatures(orgId) {
  const { data, error } = await supabase.rpc('org_store_features', { p_org_id: orgId })
  if (error) {
    if (/could not find the function|does not exist|schema cache/i.test(error.message || '')) throw new Error('Store features are not installed in Supabase yet (run supabase/store_features.sql).')
    throw error
  }
  return data || []
}

export async function setOrgStoreFeature(orgId, storeId, feature, enabled) {
  const { error } = await supabase.rpc('org_set_store_feature', { p_org_id: orgId, p_store_id: storeId, p_feature: feature, p_enabled: enabled })
  if (error) {
    if (/could not find the function|does not exist|schema cache/i.test(error.message || '')) throw new Error('Store features are not installed in Supabase yet (run supabase/store_features.sql).')
    throw error
  }
}
