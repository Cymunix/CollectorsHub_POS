import { supabase } from './supabaseClient'

// How a store identified the person it's buying from (supabase/buyback_identification.sql).
// Methods (never one "verified" flag):
//   nordvik_identity       account-level NORDVIK Identity verification (recorded by the server at checkout)
//   manual_id_check        registered, unverified customer: an employee examined their ID for this transaction
//   guest_manual_id_check  guest: details recorded and ID examined for this transaction
// The server records which signed-in employee confirmed, links the record to
// the transaction, and refuses buybacks without one.

export const MANUAL_CONFIRMATION = "I confirm that I have examined this customer's government-issued identification and that the identification details match the customer presenting it."
export const MANUAL_CONFIRMATION_VERSION = 'manual-id-confirmation-2026-10-v1'

export const DEFAULT_RULES = {
  accepted_id_types: ['drivers_licence', 'passport', 'provincial_id'],
  require_date_of_birth: true,
  require_address: false,
  require_contact: false,
  require_id_number: false,
  minimum_age: 18,
  allow_manual_check: true,
  allow_guest_buyback: true,
  policy_note: '',
}

async function call(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    if (/could not find the function|does not exist/i.test(error.message || '')) throw new Error('Buyback identification is not installed in Supabase yet (run supabase/buyback_identification.sql).')
    throw error
  }
  return data
}

export async function loadBuybackRules(storeId, locationId) {
  return { ...DEFAULT_RULES, ...((await call('buyback_id_rules', { p_store_id: storeId, p_location_id: locationId || null })) || {}) }
}

// Returns the identification record id (valid for this transaction, 30 minutes).
export const recordBuybackIdentification = ({ storeId, locationId, method, accountId = null, idType, details = {} }) =>
  call('buyback_id_record', {
    p_store_id: storeId,
    p_location_id: locationId || null,
    p_method: method,
    p_account_id: accountId,
    p_id_type: idType,
    p_guest: details,
    p_confirmed: true,
    p_confirmation_version: MANUAL_CONFIRMATION_VERSION,
  })

export const loadBuybackIdLog = (storeId, from, to) => call('buyback_id_log', { p_store_id: storeId, p_from: from, p_to: to })
export const correctBuybackIdentification = (id, reason, idType, details) => call('buyback_id_correct', { p_identification_id: id, p_reason: reason, p_id_type: idType || null, p_guest: details || null })
export const loadOrgBuybackRules = (orgId) => call('org_buyback_id_rules', { p_org_id: orgId })
export const saveOrgBuybackRules = (orgId, storeId, locationId, rules) => call('org_set_buyback_id_rules', { p_org_id: orgId, p_store_id: storeId, p_location_id: locationId || null, p_rules: rules })
