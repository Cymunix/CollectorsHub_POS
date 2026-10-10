import { supabase } from './supabaseClient'

// Transactions management (supabase/transactions.sql). Everything reads the
// existing ledger; refunds go through tx_refund (which uses complete_store_return).

async function call(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    const message = error.message || ''
    if (/could not find the function|function [^ ]+ does not exist/i.test(message)) throw new Error('Transactions are not installed in Supabase yet (run supabase/transactions.sql).')
    const failure = new Error(message.replace(/^APPROVAL_REQUIRED:\s*/, ''))
    failure.approvalRequired = /^APPROVAL_REQUIRED:/.test(message)
    throw failure
  }
  return data
}

export const transactionsSummary = (storeId) => call('tx_summary', { p_store_id: storeId })
export const listTransactions = (storeId, { filter = 'all', search = '', range = '30d', from = null, to = null, employeeId = null, payment = '', status = '', customerId = null, limit = 50, offset = 0 } = {}) => call('tx_list', {
  p_store_id: storeId, p_filter: filter, p_search: search, p_range: range, p_from: from || null, p_to: to || null,
  p_employee_id: employeeId || null, p_payment: payment || null, p_status: status || null, p_customer_id: customerId || null, p_limit: limit, p_offset: offset,
})
export const transactionDetail = (storeId, transactionId) => call('tx_detail', { p_store_id: storeId, p_transaction_id: transactionId })
export const refundTransaction = (storeId, { locationId, transactionId, lines, amount, method, reason, requestId, approver = null, cardConfirmed = false }) => call('tx_refund', {
  p_store_id: storeId, p_location_id: locationId || null, p_transaction_id: transactionId, p_lines: lines || [], p_amount: amount || null,
  p_method: method, p_reason: reason, p_request_id: requestId, p_approver: approver, p_card_confirmed: Boolean(cardConfirmed),
})
export const voidTransaction = (storeId, transactionId, reason, approver = null) => call('tx_void', { p_store_id: storeId, p_transaction_id: transactionId, p_reason: reason, p_approver: approver })
export const logReceipt = (storeId, transactionId, action) => call('tx_log_receipt', { p_store_id: storeId, p_transaction_id: transactionId, p_action: action }).catch(() => null)

export const KIND = { sale: 'Sale', buy: 'Buy', trade_in: 'Trade-In', trade: 'Trade + Sale', refund: 'Refund', adjustment: 'Adjustment', pawn_loan: 'Pawn Loan Issued', pawn_payment: 'Pawn Payment', pawn_redemption: 'Pawn Redemption', pawn_renewal: 'Pawn Renewal Charge', pawn_reversal: 'Pawn Disbursement Reversal' }
export const STATE = { completed: 'Completed', refunded: 'Refunded', partially_refunded: 'Partially Refunded', voided: 'Voided', pending: 'Pending' }
export const PAYMENT = { cash: 'Cash', card: 'Card', store_credit: 'Store Credit', mixed: 'Mixed', other: 'Other', none: '—' }
export const METHOD = { cheque: 'Cheque', e_transfer: 'E-transfer', other: 'Other', cash: 'Cash', card: 'Card', debit: 'Debit', credit: 'Credit', store_credit: 'Store Credit', trade_credit: 'Trade Credit', gift_card: 'Gift Card' }
export const CREDIT_ENTRY = { trade_credit_issued: 'Trade-in credit issued', store_credit_spent: 'Store credit redeemed', refund_credit: 'Refunded to store credit', manual_adjustment: 'Adjustment' }

const imageUrl = (bucket, path) => (!path ? '' : /^https?:/.test(path) ? path : supabase.storage.from(bucket).getPublicUrl(path).data?.publicUrl || '')
export const itemImage = (item) => imageUrl('store-inventory-images', item.store_image_path) || imageUrl('item-images', item.image_path)

// The details in the shape the Register's receipt (ReceiptDocument) prints, from the stored values.
export function receiptFromDetail(detail, branding = {}) {
  const t = detail.transaction
  const type = t.kind === 'refund' ? 'refund' : ['buy', 'trade_in'].includes(t.kind) ? 'buy' : t.kind === 'trade' ? 'exchange' : 'sale'
  const payments = (detail.payments || []).map((payment) => ({ method: payment.method, amount: Number(payment.amount) }))
  const payout = type === 'buy' ? payments.find((payment) => payment.amount < 0) : null
  return {
    number: t.group_number ? `${t.number} (${t.group_number})` : t.number,
    type,
    createdAt: t.completed_at || t.created_at,
    items: (detail.items || []).map((item) => ({
      id: item.id,
      name: item.name,
      sku: item.sku,
      condition: [item.condition, item.grade].filter(Boolean).join(' · '),
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price),
      storeOffer: item.direction === 'in' ? Number(item.unit_price) : 0,
      discountTotal: Number(item.discount || 0),
      total: Number(item.line_total),
      direction: item.direction === 'in' ? 'incoming' : 'outgoing',
    })),
    subtotal: Number(t.subtotal),
    discounts: Number(t.discount_total || 0),
    tax: Number(t.tax_total || 0),
    taxRate: Number(t.subtotal) ? Math.abs(Number(t.tax_total || 0) / Number(t.subtotal)) : 0,
    taxLabel: branding.taxLabel || 'HST',
    total: Number(t.total),
    payments: payout ? payments.filter((payment) => payment !== payout) : payments,
    payout: payout ? { method: payout.method, amount: Math.abs(payout.amount) } : null,
    employeeName: t.employee || '',
    registerName: t.register || t.location_name || '',
    receiptBranding: branding,
    customer: detail.customer ? { name: detail.customer.name, username: detail.customer.username, email: detail.customer.email } : { name: 'Guest', guest: true },
  }
}

// Store-local today (YYYY-MM-DD) for the date inputs.
export const todayIso = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` }
export const newRequestId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16) }))
