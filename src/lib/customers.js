import { supabase } from './supabaseClient'
import { COLLECTOR_APPROVAL_URL } from './collectionScanning'

// POS Customers (supabase/customers.sql). Store credit uses the existing
// store_credit_balance / store_credit_history functions and the checkout ledger.

async function call(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    const message = error.message || ''
    // Only a missing function means the SQL isn't installed; anything else is shown as the database said it.
    if (/could not find the function|function [^ ]+ does not exist/i.test(message)) throw new Error(/wishlist|customers_list/i.test(name + message) ? 'Wishlist matching is not installed in Supabase yet (run supabase/customer_wishlists.sql).' : 'Customers are not installed in Supabase yet (run supabase/customers.sql).')
    throw new Error(message ? `${message}${error.hint ? ` (${error.hint})` : ''}` : String(error))
  }
  return data
}

export const customersSummary = (storeId) => call('customers_summary', { p_store_id: storeId })
export const listCustomers = (storeId, { search = '', filter = 'all', sort = 'recent', locationId = null, limit = 50, offset = 0 } = {}) => call('customers_list', { p_store_id: storeId, p_search: search, p_filter: filter, p_limit: limit, p_offset: offset, p_sort: sort, p_location_id: locationId || null })
export const customerProfile = (storeId, customerId) => call('customer_profile', { p_store_id: storeId, p_customer_id: customerId })
export const customerTransactions = (storeId, customerId, { limit = 50, offset = 0 } = {}) => call('customer_transactions', { p_store_id: storeId, p_customer_id: customerId, p_limit: limit, p_offset: offset })
export const transactionDetail = (storeId, transactionId) => call('customer_transaction_detail', { p_store_id: storeId, p_transaction_id: transactionId })
export const customerTradeIns = (storeId, customerId) => call('customer_trade_ins', { p_store_id: storeId, p_customer_id: customerId, p_limit: 200 })
export const customerCollectionJobs = (storeId, customerId) => call('customer_collection_jobs', { p_store_id: storeId, p_customer_id: customerId })
export const customerLoyalty = (storeId, customerId) => call('customer_loyalty', { p_store_id: storeId, p_customer_id: customerId })
export const createCustomer = (storeId, data, force = false) => call('customer_create', { p_store_id: storeId, p_data: data, p_force: force })
export const updateCustomer = (storeId, customerId, data) => call('customer_update', { p_store_id: storeId, p_customer_id: customerId, p_data: data })
export const setCustomerStatus = (storeId, customerId, status) => call('customer_set_status', { p_store_id: storeId, p_customer_id: customerId, p_status: status })
export const customerNotes = (storeId, customerId) => call('customer_notes', { p_store_id: storeId, p_customer_id: customerId })
export const saveCustomerNote = (storeId, customerId, noteId, body) => call('customer_note_save', { p_store_id: storeId, p_customer_id: customerId, p_note_id: noteId || null, p_body: body })
export const deleteCustomerNote = (storeId, noteId) => call('customer_note_delete', { p_store_id: storeId, p_note_id: noteId })
export const requestCustomerLink = (storeId, customerId, profileId) => call('customer_link_request', { p_store_id: storeId, p_customer_id: customerId, p_profile_id: profileId })
export const unlinkCustomer = (storeId, customerId) => call('customer_unlink', { p_store_id: storeId, p_customer_id: customerId })
export const customerDuplicates = (storeId) => call('customer_duplicates', { p_store_id: storeId })
export const mergeCustomers = (storeId, keepId, mergeId, reason) => call('customer_merge', { p_store_id: storeId, p_keep: keepId, p_merge: mergeId, p_reason: reason })

// Wishlist matching (supabase/customer_wishlists.sql): only with the member's permission.
export const customerWishlist = (storeId, customerId, { locationId = null, filter = 'all' } = {}) => call('customer_wishlist', { p_store_id: storeId, p_customer_id: customerId, p_location_id: locationId || null, p_filter: filter })
export const requestWishlistAccess = (storeId, customerId) => call('customer_wishlist_access_request', { p_store_id: storeId, p_customer_id: customerId })
export const withdrawWishlistAccess = (storeId, customerId) => call('customer_wishlist_access_withdraw', { p_store_id: storeId, p_customer_id: customerId })
export const wishlistApprovalUrl = (accessId) => `${COLLECTOR_APPROVAL_URL}?wishlist=${encodeURIComponent(accessId)}`
export const matchLabel = (row) => (row.wishlist_access !== 'granted' ? '' : row.wishlist_matches > 0 ? `${row.wishlist_matches} Match${row.wishlist_matches === 1 ? '' : 'es'}` : 'No Matches')

// Existing store credit functions (per store; needs a linked member).
export const storeCreditBalance = (storeId, customerId, profileId = null) => call('store_credit_balance', { p_store_id: storeId, p_customer_id: customerId || null, p_collectorshub_user_id: profileId || null })
export const storeCreditHistory = (storeId, customerId, profileId = null) => call('store_credit_history', { p_store_id: storeId, p_profile_id: profileId || null, p_customer_id: customerId || null })

// The member approves the link on the same CollectorsHub page as scanning requests.
export const linkApprovalUrl = (requestId) => `${COLLECTOR_APPROVAL_URL}?link=${encodeURIComponent(requestId)}`

export const CREDIT_ENTRY = { trade_credit_issued: 'Trade-in credit issued', store_credit_spent: 'Redeemed', refund_credit: 'Refund to credit', manual_adjustment: 'Adjustment' }
