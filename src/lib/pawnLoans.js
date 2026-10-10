import { supabase } from './supabaseClient'

// Pawn & Loans (supabase/pawn_loans.sql). Every rule, rate and template comes from
// the store's jurisdiction configuration; the server checks permissions and limits.

async function call(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    const message = error.message || ''
    // Only Supabase's own "can't find this function" means the SQL isn't installed (or its cache is stale).
    if (/could not find the function/i.test(message)) throw new Error(`Pawn & Loans is not installed in Supabase yet: ${name} wasn't found. Run supabase/pawn_loans.sql; if it ran without errors, reload the schema with: NOTIFY pgrst, 'reload schema';`)
    throw new Error(message)
  }
  return data
}

export const pawnSummary = (storeId) => call('pawn_summary', { p_store_id: storeId })
export const pawnList = (storeId, { filter = 'all', search = '', customerId = null, limit = 50, offset = 0 } = {}) => call('pawn_list', { p_store_id: storeId, p_filter: filter, p_search: search, p_customer_id: customerId, p_limit: limit, p_offset: offset })
export const pawnDetail = (storeId, loanId) => call('pawn_detail', { p_store_id: storeId, p_loan_id: loanId })
export const pawnSettings = (storeId) => call('pawn_settings', { p_store_id: storeId })
// CollectorsHub admin only: the pawn terms per province / territory.
export const adminPawnConfigs = () => call('pawn_admin_configs', {})
export const adminSaveConfig = (config) => call('pawn_admin_config_save', { p_config: config })
export const adminApproveConfig = (configId, reviewedBy, reference, confirm) => call('pawn_admin_config_approve', { p_config_id: configId, p_reviewed_by: reviewedBy, p_reference: reference, p_confirm: confirm })
export const saveSettings = (storeId, settings) => call('pawn_settings_save', { p_store_id: storeId, p_settings: settings })
export const setEmployeePermissions = (storeId, employeeId, permissions) => call('pawn_set_employee_permissions', { p_store_id: storeId, p_employee_id: employeeId, p_permissions: permissions })
export const saveDraft = (storeId, locationId, loan) => call('pawn_save_draft', { p_store_id: storeId, p_location_id: locationId || null, p_loan: loan })
export const quote = (storeId, principal, termDays) => call('pawn_quote', { p_store_id: storeId, p_principal: principal, p_term_days: termDays || null })
export const approveLoan = (storeId, loanId, version) => call('pawn_approve', { p_store_id: storeId, p_loan_id: loanId, p_version: version ?? null })
export const agreementPreview = (storeId, loanId) => call('pawn_agreement_preview', { p_store_id: storeId, p_loan_id: loanId })
export const signAgreement = (storeId, loanId, method, signature, confirms) => call('pawn_sign_agreement', { p_store_id: storeId, p_loan_id: loanId, p_method: method, p_customer_signature: signature || null, p_employee_confirms: confirms })
export const issueLoan = (storeId, loanId, requestId, method, reference, confirm) => call('pawn_issue', { p_store_id: storeId, p_loan_id: loanId, p_request_id: requestId, p_method: method, p_reference: reference || null, p_confirm: confirm })
export const payLoan = (storeId, loanId, requestId, amount, method, reference) => call('pawn_pay', { p_store_id: storeId, p_loan_id: loanId, p_request_id: requestId, p_amount: amount, p_method: method, p_reference: reference || null })
export const renewLoan = (storeId, loanId, requestId, { termDays, method, reference, signatureMethod, signature, confirms }) => call('pawn_renew', {
  p_store_id: storeId, p_loan_id: loanId, p_request_id: requestId, p_term_days: termDays || null, p_method: method || null, p_reference: reference || null,
  p_signature_method: signatureMethod, p_customer_signature: signature || null, p_employee_confirms: confirms,
})
export const reverseDisbursement = (storeId, loanId, requestId, reason) => call('pawn_reverse_disbursement', { p_store_id: storeId, p_loan_id: loanId, p_request_id: requestId, p_reason: reason })
export const cancelDraft = (storeId, loanId, reason) => call('pawn_cancel_draft', { p_store_id: storeId, p_loan_id: loanId, p_reason: reason })
export const updateStorage = (storeId, collateralId, storage, reason) => call('pawn_update_storage', { p_store_id: storeId, p_collateral_id: collateralId, p_storage: storage, p_reason: reason })
export const releaseCollateral = (storeId, loanId, recipient, reason) => call('pawn_release', { p_store_id: storeId, p_loan_id: loanId, p_recipient: recipient, p_reason: reason })
export const setHold = (storeId, loanId, hold, reason) => call('pawn_set_hold', { p_store_id: storeId, p_loan_id: loanId, p_hold: hold, p_reason: reason })
export const recordNotice = (storeId, loanId, { kind, method, sentAt, delivery, note }) => call('pawn_record_notice', { p_store_id: storeId, p_loan_id: loanId, p_kind: kind, p_method: method, p_sent_at: sentAt || null, p_delivery: delivery, p_note: note || null })
export const startForfeitureReview = (storeId, loanId, reason) => call('pawn_start_forfeiture_review', { p_store_id: storeId, p_loan_id: loanId, p_reason: reason })
export const endForfeitureReview = (storeId, loanId, reason) => call('pawn_end_forfeiture_review', { p_store_id: storeId, p_loan_id: loanId, p_reason: reason })
export const forfeitLoan = (storeId, loanId, { reason, legalBasis, documentation, confirm }) => call('pawn_forfeit', { p_store_id: storeId, p_loan_id: loanId, p_reason: reason, p_legal_basis: legalBasis, p_documentation: documentation || null, p_confirm: confirm })
export const transferToInventory = (storeId, collateralId, locationId, sellPrice) => call('pawn_transfer_to_inventory', { p_store_id: storeId, p_collateral_id: collateralId, p_location_id: locationId || null, p_sell_price: sellPrice })
export const pawnReport = (storeId, { from, to, employeeId, locationId, category } = {}) => call('pawn_report', { p_store_id: storeId, p_from: from || null, p_to: to || null, p_employee_id: employeeId || null, p_location_id: locationId || null, p_category: category || null })

// Sold-price averages from the existing pricing data (register_market_condition_averages).
export async function soldPriceEstimate(itemId) {
  if (!itemId) return null
  const { data, error } = await supabase.rpc('register_market_condition_averages', { p_item_ids: [itemId], p_currency: 'CAD' })
  if (error || !data?.length) return null
  const best = [...data].sort((a, b) => Number(b.sales_count || 0) - Number(a.sales_count || 0))[0]
  return { value: Number(best.avg_30d || best.average_price || 0), sales: Number(best.sales_count || 0), condition: best.condition }
}

// Collateral photos: private bucket, folder per store.
export async function uploadCollateralPhoto(storeId, loanKey, blob) {
  const path = `${storeId}/${loanKey}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
  const { error } = await supabase.storage.from('pawn-collateral').upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false })
  if (error) throw new Error(error.message)
  return path
}
export async function collateralPhotoUrls(paths) {
  if (!paths?.length) return {}
  const { data } = await supabase.storage.from('pawn-collateral').createSignedUrls(paths, 600)
  return Object.fromEntries((data || []).map((row, index) => [paths[index], row.signedUrl]))
}

export const PAWN_PERMISSIONS = [
  ['pawn_view', 'View pawn loans'], ['pawn_create', 'Create drafts and record collateral'], ['pawn_approve', 'Approve loans'],
  ['pawn_disburse', 'Disburse funds'], ['pawn_payments', 'Accept payments'], ['pawn_renew', 'Renew loans'], ['pawn_release', 'Release collateral'],
  ['pawn_overdue', 'Review overdue loans, holds and notices'], ['pawn_forfeit', 'Authorise forfeiture'], ['pawn_transfer', 'Transfer acquired items to inventory'], ['pawn_reports', 'View financial reports'],
]
export const STATE = { draft: 'Draft', approved: 'Approved, not issued', active: 'Active', due_soon: 'Due Soon', overdue: 'Overdue', redeemed: 'Redeemed', forfeiture_review: 'Forfeiture Review', forfeited: 'Forfeited', cancelled: 'Cancelled' }
export const COLLATERAL_STATUS = { pending_intake: 'Pending Intake', in_custody: 'In Custody', reserved_for_redemption: 'Reserved for Redemption', released: 'Released to Customer', forfeiture_review: 'Under Forfeiture Review', lawfully_acquired: 'Lawfully Acquired', transferred_to_inventory: 'Transferred to Inventory' }
export const ID_FIELDS = [['name', 'Full legal name'], ['date_of_birth', 'Date of birth'], ['address', 'Address'], ['id_type', 'ID type'], ['id_expiry', 'ID expiry date'], ['id_number', 'ID number']]
export const STORAGE_FIELDS = [['room', 'Room'], ['cabinet', 'Cabinet'], ['shelf', 'Shelf'], ['bin', 'Bin'], ['container', 'Container'], ['seal', 'Seal no.']]
export const storageText = (storage = {}) => STORAGE_FIELDS.filter(([key]) => storage?.[key]).map(([key, label]) => `${label} ${storage[key]}`).join(' · ')
export const newRequestId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16) }))
