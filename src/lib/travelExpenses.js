import { supabase } from './supabaseClient'

// MyHR Travel & Expenses (supabase/myhr_travel_expenses.sql) and the employee's own
// payroll results (supabase/payroll_foundation.sql). Policy, approvals and payments
// are the organization's; employees only create and submit their own records.

async function call(name, params, file) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    if (/could not find the function/i.test(error.message || '')) {
      throw new Error(`This isn't installed in Supabase yet: ${name} wasn't found (run supabase/${file}).`)
    }
    throw error
  }
  return data
}
const te = (name, params) => call(name, params, 'myhr_travel_expenses.sql')
const pay = (name, params) => call(name, params, 'payroll_foundation.sql')

export const TRAVEL_STATUS = {
  draft: 'Draft', submitted: 'Submitted', under_review: 'Under Review', approved: 'Approved', rejected: 'Rejected',
  returned: 'Returned for Correction', cancelled: 'Cancelled', partially_approved: 'Partially Approved',
}
export const PAYMENT_STATUS = { not_due: '', awaiting: 'Awaiting Reimbursement', partial: 'Partly Reimbursed', paid: 'Paid' }
export const REIMBURSE_METHODS = ['E-transfer', 'Direct deposit', 'Cheque', 'Cash', 'With payroll', 'Other']
// Approved but not yet fully paid.
export const owing = (record) => Math.max(0, Number(record.approved_total || 0) - Number(record.reimbursed_total || 0))
// The status pill colour group for a record.
export function statusTone(record) {
  if (record.payment_status === 'paid') return 'paid'
  if (record.payment_status === 'partial') return 'returned'
  const status = record.status
  if (status === 'draft' || status === 'cancelled') return 'draft'
  if (status === 'approved' || status === 'partially_approved') return 'approved'
  if (status === 'rejected') return 'rejected'
  if (status === 'returned') return 'returned'
  return 'submitted'
}

export const TRANSPORT = ['Personal vehicle', 'Rental car', 'Air', 'Train', 'Bus', 'Taxi / rideshare', 'Other']
export const ESTIMATE_CATEGORIES = ['Transportation', 'Mileage', 'Accommodation', 'Meals', 'Parking', 'Tolls', 'Registration fees', 'Other']
export const EXPENSE_CATEGORIES = ['Transportation', 'Accommodation', 'Meals', 'Parking', 'Tolls', 'Registration fees', 'Supplies', 'Other']
export const PAYMENT_METHODS = ['Personal card', 'Cash', 'Company card', 'Other']
export const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'AUD', 'JPY', 'MXN']

export const loadContext = (storeId) => te('te_my_context', { p_store_id: storeId })
export const loadMyRecords = async (storeId) => (await te('te_my_records', { p_store_id: storeId })) || []
export const loadRecord = (storeId, kind, id) => te('te_record', { p_store_id: storeId, p_kind: kind, p_id: id })
export const loadApprovedTravel = async (storeId) => (await te('te_my_approved_travel', { p_store_id: storeId })) || []
export const saveTravel = (storeId, id, data, submit) => te('te_save_travel', { p_store_id: storeId, p_id: id || null, p_data: data, p_submit: Boolean(submit) })
export const saveClaim = (storeId, id, data, submit) => te('te_save_claim', { p_store_id: storeId, p_id: id || null, p_data: data, p_submit: Boolean(submit) })
export const cancelRecord = (storeId, kind, id) => te('te_cancel', { p_store_id: storeId, p_kind: kind, p_id: id })
export const loadStoreToDecide = async (storeId) => (await te('te_store_to_decide', { p_store_id: storeId })) || []
export const decideRecord = (storeId, kind, id, decision, note, lines) => te('te_decide', { p_store_id: storeId, p_kind: kind, p_id: id, p_decision: decision, p_note: note || null, p_lines: lines || null })

// Organization
export const loadOrgPolicy = (orgId) => te('te_org_policy', { p_org_id: orgId })
export const saveOrgPolicy = (orgId, policy) => te('te_org_policy_save', { p_org_id: orgId, p_policy: policy })
export const loadOrgRecords = async (orgId) => (await te('te_org_records', { p_org_id: orgId })) || []
export const loadOrgRecord = (orgId, kind, id) => te('te_org_record', { p_org_id: orgId, p_kind: kind, p_id: id })
export const orgDecide = (orgId, kind, id, decision, note, lines) => te('te_org_decide', { p_org_id: orgId, p_kind: kind, p_id: id, p_decision: decision, p_note: note || null, p_lines: lines || null })
export const recordReimbursement = (orgId, claimId, payment) => te('te_org_record_payment', { p_org_id: orgId, p_claim_id: claimId, p_paid_on: payment.paidOn, p_amount: Number(payment.amount), p_method: payment.method, p_reference: payment.reference, p_processed_by: payment.processedBy })

// Receipts: uploaded to the employee's own folder in a private bucket.
const RECEIPT_TYPES = /^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/i
export async function uploadReceipt(file) {
  if (!file) throw new Error('Choose a file.')
  if (!RECEIPT_TYPES.test(file.type || '')) throw new Error('Receipts can be a photo (JPG, PNG, WebP, HEIC) or a PDF.')
  if (file.size > 10 * 1024 * 1024) throw new Error('That file is over 10 MB.')
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Sign in again to upload receipts.')
  const safe = String(file.name || 'receipt').replace(/[^\w.-]+/g, '_').slice(-80)
  const path = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`
  const { error } = await supabase.storage.from('expense-receipts').upload(path, file, { contentType: file.type, upsert: false })
  if (error) throw new Error(/bucket not found/i.test(error.message || '') ? 'Receipt storage isn\'t set up yet (run supabase/myhr_travel_expenses.sql).' : error.message)
  return { path, name: file.name || safe }
}
export async function receiptUrl(path) {
  const { data, error } = await supabase.storage.from('expense-receipts').createSignedUrl(path, 300)
  if (error) throw error
  return data.signedUrl
}
// Removes an upload that isn't on a submitted claim yet (the storage policy refuses the rest).
export async function removeReceipt(path) {
  await supabase.storage.from('expense-receipts').remove([path])
}

// Payroll (results only)
export const loadPayOverview = (storeId) => pay('pay_my_overview', { p_store_id: storeId })
export const loadPayslips = async (storeId) => (await pay('pay_my_payslips', { p_store_id: storeId })) || []
export const loadPayslip = (storeId, id) => pay('pay_my_payslip', { p_store_id: storeId, p_id: id })
export const loadTaxDocuments = async (storeId) => (await pay('pay_my_tax_documents', { p_store_id: storeId })) || []
export async function taxDocumentUrl(path) {
  const { data, error } = await supabase.storage.from('payroll-documents').createSignedUrl(path, 300)
  if (error) throw error
  return data.signedUrl
}
export const loadOrgPayrollSettings = (orgId) => pay('payroll_org_settings', { p_org_id: orgId })
export const saveOrgPayrollSettings = (orgId, settings) => pay('payroll_org_settings_save', { p_org_id: orgId, p_settings: settings })

// The pay period containing a date, from the organization's calendar (null when not set up).
export function payPeriodFor(settings, date = new Date()) {
  const frequency = settings?.pay_frequency
  const offset = Number(settings?.pay_date_offset_days ?? 5)
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const addDays = (value, n) => new Date(value.getFullYear(), value.getMonth(), value.getDate() + n)
  let start
  let end
  if (frequency === 'weekly' || frequency === 'biweekly') {
    if (!settings.first_period_start) return null
    const length = frequency === 'weekly' ? 7 : 14
    const anchor = new Date(`${settings.first_period_start}T00:00:00`)
    const periods = Math.floor((day - anchor) / 86400000 / length)
    start = addDays(anchor, periods * length)
    end = addDays(start, length - 1)
  } else if (frequency === 'semimonthly') {
    start = new Date(day.getFullYear(), day.getMonth(), day.getDate() <= 15 ? 1 : 16)
    end = day.getDate() <= 15 ? new Date(day.getFullYear(), day.getMonth(), 15) : new Date(day.getFullYear(), day.getMonth() + 1, 0)
  } else if (frequency === 'monthly') {
    start = new Date(day.getFullYear(), day.getMonth(), 1)
    end = new Date(day.getFullYear(), day.getMonth() + 1, 0)
  } else return null
  return { start, end, payDate: addDays(end, offset) }
}
export const loadOrgLineSummary = (orgId, from, to) => te('te_org_line_summary', { p_org_id: orgId, p_from: from || null, p_to: to || null })
// A local calendar date as YYYY-MM-DD (no UTC shift).
export const localIso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
