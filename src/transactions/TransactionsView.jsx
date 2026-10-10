import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, Ban, ChevronLeft, ChevronRight, ExternalLink, ImageOff, Mail, Printer, ReceiptText, RefreshCw, RotateCcw, Search, X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import {
  CREDIT_ENTRY, KIND, METHOD, PAYMENT, STATE, itemImage, listTransactions, logReceipt, newRequestId, receiptFromDetail,
  refundTransaction, todayIso, transactionDetail, transactionsSummary, voidTransaction,
} from '../lib/transactions'

// Transactions: the store's ledger (sales, buys, trade-ins, refunds, voids) from
// Supabase, with details, receipts, refunds and voids. The page header (Sync Now,
// Register, sync status) is the app's standard header.

const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })
const fmt = (value) => money.format(Number(value || 0))
const when = (value) => (value ? new Date(value).toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
const PAGE = 50
const FILTERS = [['all', 'All Transactions'], ['sales', 'Sales'], ['buys', 'Buy / Trade-In'], ['refunds', 'Refunds'], ['voided', 'Voided'], ['pending', 'Pending'], ['pawn', 'Pawn'], ['mine', 'My Transactions']]
const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['custom', 'Custom range'], ['all', 'All time']]

const Pill = ({ value, map, tone }) => <span className={`tx-pill ${tone || value}`}>{map[value] || value}</span>

export default function TransactionsView({ session, online = true, receiptBranding, renderReceipt, onOpenCustomer, localTransactions = [] }) {
  const storeId = session?.storeId
  const [summary, setSummary] = useState(null)
  const [data, setData] = useState(null)
  const [problem, setProblem] = useState('')
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [range, setRange] = useState('30d')
  const [from, setFrom] = useState(todayIso())
  const [to, setTo] = useState(todayIso())
  const [employeeId, setEmployeeId] = useState('')
  const [payment, setPayment] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(0)
  const [openId, setOpenId] = useState('')
  const [tick, setTick] = useState(0)
  const refresh = () => setTick((value) => value + 1)

  useEffect(() => { if (storeId && online) transactionsSummary(storeId).then(setSummary).catch(() => setSummary(null)) }, [storeId, online, tick])
  useEffect(() => {
    if (!storeId || !online) return undefined
    let cancelled = false
    const timer = setTimeout(() => {
      listTransactions(storeId, { filter, search: search.trim(), range, from, to, employeeId, payment, status, limit: PAGE, offset: page * PAGE })
        .then((result) => { if (!cancelled) { setData(result); setProblem('') } })
        .catch((error) => { if (!cancelled) { setData((current) => current || { rows: [], total: 0 }); setProblem(error?.message || String(error)) } })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [storeId, online, filter, search, range, from, to, employeeId, payment, status, page, tick])
  useEffect(() => { setPage(0) }, [filter, search, range, from, to, employeeId, payment, status])

  if (openId) return <TransactionDetail session={session} transactionId={openId} receiptBranding={receiptBranding} renderReceipt={renderReceipt} onOpenCustomer={onOpenCustomer} onOpen={setOpenId} onBack={() => { setOpenId(''); refresh() }} />

  const rows = data?.rows || []
  const total = Number(data?.total || 0)
  const access = data?.access || {}
  return (
    <section className="cu-page tx-page">
      <div className="cu-summary tx-summary">
        <div><small>Sales Today</small><strong>{summary ? fmt(summary.sales) : '—'}</strong><em>before tax, net of refunds</em></div>
        <div><small>Refunds Today</small><strong>{summary ? fmt(summary.refunds) : '—'}</strong></div>
        <div><small>Items Sold Today</small><strong>{summary ? Number(summary.items_sold || 0).toLocaleString() : '—'}</strong></div>
        <div><small>Transactions Today</small><strong>{summary ? Number(summary.transactions || 0).toLocaleString() : '—'}</strong></div>
      </div>

      <div className="tx-ledger">
        <div className="tx-tools">
          <div className="cs-tabs small">{FILTERS.map(([value, label]) => <button type="button" key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>
          <div className="tx-filter-row">
            <label className="cu-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Transaction ID, receipt, customer, username, SKU, barcode or product" /></label>
            <select value={range} onChange={(event) => setRange(event.target.value)} aria-label="Date range">{RANGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            {range === 'custom' ? <><input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} aria-label="From" /><input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} aria-label="To" /></> : null}
            {data?.employees ? <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} aria-label="Employee"><option value="">All employees</option>{data.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select> : null}
            <select value={payment} onChange={(event) => setPayment(event.target.value)} aria-label="Payment method"><option value="">Any payment</option>{['cash', 'card', 'store_credit', 'mixed', 'other'].map((value) => <option key={value} value={value}>{PAYMENT[value]}</option>)}</select>
            <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Status"><option value="">Any status</option>{Object.entries(STATE).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          </div>
          {data && access.view_all === false ? <p className="cs-muted tx-note">You see the transactions you processed. Search an exact transaction number to find another one.</p> : null}
        </div>
        {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}

        {!online ? (
          <OfflineList transactions={localTransactions} />
        ) : data === null ? <p className="cs-muted tx-pad">Loading…</p> : !rows.length ? (
          <div className="cs-empty tx-empty"><ReceiptText size={30} /><strong>{search || filter !== 'all' || payment || status || employeeId ? 'No transactions match' : 'No transactions yet'}</strong><span>Completed sales, purchases and trade-ins will appear here.</span></div>
        ) : (
          <>
            <div className="tx-table-wrap">
              <table className="cs-table tx-table">
                <thead><tr><th>Transaction ID</th><th>Date &amp; Time</th><th>Type</th><th>Customer</th><th>Employee</th><th className="num">Items</th><th className="num">Total</th><th>Payment</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="cs-clickable" onClick={() => setOpenId(row.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') setOpenId(row.id) }}>
                      <td><strong>{row.number}</strong></td>
                      <td>{when(row.created_at)}</td>
                      <td><Pill value={row.kind} map={KIND} tone={`kind-${row.kind}`} /></td>
                      <td>{row.customer ? <span className="tx-customer"><strong>{row.customer}</strong>{row.username ? <small>@{row.username}</small> : null}</span> : <span className="cs-muted">Guest</span>}</td>
                      <td>{row.employee || '—'}</td>
                      <td className="num">{row.items}</td>
                      <td className={`num ${Number(row.total) < 0 ? 'tx-neg' : ''}`}><strong>{fmt(row.total)}</strong></td>
                      <td>{PAYMENT[row.payment] || row.payment}</td>
                      <td><Pill value={row.state} map={STATE} /></td>
                      <td className="tx-row-action"><button type="button" onClick={(event) => { event.stopPropagation(); setOpenId(row.id) }}>View</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cu-pager">
              <span>{page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total.toLocaleString()}</span>
              <button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)} aria-label="Previous page"><ChevronLeft size={15} /></button>
              <button type="button" disabled={(page + 1) * PAGE >= total} onClick={() => setPage((value) => value + 1)} aria-label="Next page"><ChevronRight size={15} /></button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

// Offline: the Supabase ledger can't be reached, so show this register's own recent records (read-only).
function OfflineList({ transactions }) {
  return (
    <div className="tx-offline">
      <p className="cu-notice"><AlertTriangle size={15} /> Offline. Showing this register's recent transactions saved on this PC. Sales can't be completed until the connection is back, and refunds and receipts from the store ledger need a connection.</p>
      {!transactions.length ? <div className="cs-empty tx-empty"><ReceiptText size={30} /><strong>No transactions on this register</strong></div> : (
        <table className="cs-table tx-table">
          <thead><tr><th>Transaction ID</th><th>Date &amp; Time</th><th>Type</th><th className="num">Items</th><th className="num">Total</th></tr></thead>
          <tbody>{transactions.slice(0, 200).map((transaction) => <tr key={transaction.id}><td><strong>{transaction.number}</strong></td><td>{when(transaction.createdAt)}</td><td>{transaction.type === 'refund' ? 'Refund' : transaction.type === 'buy' ? 'Buy / Trade-In' : 'Sale'}</td><td className="num">{(transaction.items || []).length}</td><td className="num">{fmt(transaction.total)}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  )
}

// ── Details ──────────────────────────────────────────────────────────────────
function TransactionDetail({ session, transactionId, receiptBranding, renderReceipt, onOpenCustomer, onOpen, onBack }) {
  const storeId = session?.storeId
  const [detail, setDetail] = useState(null)
  const [problem, setProblem] = useState('')
  const [modal, setModal] = useState('')
  const [notice, setNotice] = useState('')
  async function load() { try { setDetail(await transactionDetail(storeId, transactionId)); setProblem('') } catch (error) { setProblem(error?.message || String(error)) } }
  useEffect(() => { setDetail(null); load() }, [transactionId])
  if (!detail) return <section className="cu-page tx-page"><button type="button" className="cs-back" onClick={onBack}><ArrowLeft size={15} /> Transactions</button>{problem ? <p className="cs-error">{problem}</p> : <p className="cs-muted">Loading…</p>}</section>

  const t = detail.transaction
  const access = detail.access || {}
  const out = detail.items.filter((item) => item.direction === 'out')
  const inc = detail.items.filter((item) => item.direction === 'in')
  const canRefund = t.status === 'completed' && ['sale', 'exchange'].includes(t.type) && Number(t.refundable) > 0
  const canVoid = !['completed', 'void'].includes(t.status)
  const storeCreditRedeemed = detail.payments.filter((payment) => payment.method === 'store_credit' && Number(payment.amount) > 0).reduce((sum, payment) => sum + Number(payment.amount), 0)

  return (
    <section className="cu-page tx-page">
      <button type="button" className="cs-back" onClick={onBack}><ArrowLeft size={15} /> Transactions</button>
      <div className="tx-detail-head">
        <div>
          <h1>{t.number}</h1>
          <p><Pill value={t.kind} map={KIND} tone={`kind-${t.kind}`} /> <Pill value={t.state} map={STATE} /> <span className="cs-muted">{when(t.completed_at || t.created_at)}</span></p>
        </div>
        <div className="cu-head-actions">
          <button type="button" onClick={() => { setModal('receipt'); logReceipt(storeId, t.id, 'receipt_viewed') }}><ReceiptText size={15} /> View Receipt</button>
          <button type="button" onClick={() => setModal('receipt-print')}><Printer size={15} /> Reprint</button>
          {canVoid ? <button type="button" onClick={() => setModal('void')}><Ban size={15} /> Void</button> : null}
          {canRefund ? <button type="button" className="gold-button" onClick={() => setModal('refund')}><RotateCcw size={15} /> Refund</button> : null}
        </div>
      </div>
      {notice ? <p className="cu-notice">{notice}</p> : null}
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      {t.original ? <p className="cu-notice">Refund for <button type="button" className="tx-link" onClick={() => onOpen(t.original.id)}>{t.original.number}</button>.</p> : null}

      <div className="tx-detail-grid">
        <div className="tx-card">
          <h3>Overview</h3>
          <dl className="cs-facts">
            <dt>Transaction</dt><dd>{t.number}</dd>
            {t.group_number ? <><dt>Receipt</dt><dd>{t.group_number}</dd></> : null}
            <dt>Date</dt><dd>{when(t.completed_at || t.created_at)}</dd>
            <dt>Store</dt><dd>{t.store_name || '—'}{t.location_name ? ` · ${t.location_name}` : ''}</dd>
            <dt>Register</dt><dd>{t.register || '—'}</dd>
            <dt>Employee</dt><dd>{t.employee || '—'}</dd>
            <dt>Type</dt><dd>{KIND[t.kind] || t.kind}</dd>
            <dt>Status</dt><dd>{STATE[t.state] || t.state}</dd>
            {t.notes ? <><dt>Notes</dt><dd>{t.notes}</dd></> : null}
          </dl>
        </div>
        <div className="tx-card">
          <h3>Customer</h3>
          {detail.customer ? (
            <>
              <dl className="cs-facts">
                <dt>Name</dt><dd>{detail.customer.name || 'Customer'}</dd>
                {detail.customer.username ? <><dt>Username</dt><dd>@{detail.customer.username}</dd></> : null}
                <dt>Customer ID</dt><dd>{detail.customer.customer_number || '—'}</dd>
                <dt>Type</dt><dd>{detail.customer.is_member ? 'CollectorsHub member' : 'Store customer'}</dd>
              </dl>
              {onOpenCustomer ? <button type="button" className="tx-link" onClick={() => onOpenCustomer(detail.customer.id)}><ExternalLink size={13} /> Open customer profile</button> : null}
            </>
          ) : <p className="cs-muted">Guest</p>}
          {detail.store_credit.length ? (
            <>
              <h4>Store credit</h4>
              <ul className="tx-mini-list">{detail.store_credit.map((entry, index) => <li key={index}><span>{CREDIT_ENTRY[entry.entry_type] || entry.entry_type}</span><strong className={Number(entry.amount) < 0 ? 'tx-neg' : ''}>{fmt(entry.amount)}</strong></li>)}</ul>
            </>
          ) : null}
        </div>
      </div>

      {out.length ? <ItemsTable title={t.kind === 'refund' ? 'Items returned' : 'Items sold'} items={out} showRefunded={t.kind !== 'refund'} /> : null}
      {inc.length ? <ItemsTable title={t.kind === 'refund' ? 'Items returned to stock' : 'Items bought / traded in from the customer'} items={inc} /> : null}
      {!out.length && !inc.length ? <div className="tx-card"><p className="cs-muted">No items recorded{t.kind === 'refund' ? ' (an amount-only refund)' : ''}.</p></div> : null}

      <div className="tx-detail-grid">
        <div className="tx-card">
          <h3>Financial summary</h3>
          <ul className="tx-mini-list">
            <li><span>Subtotal</span><strong>{fmt(t.subtotal)}</strong></li>
            {Number(t.discount_total) ? <li><span>Discounts</span><strong>−{fmt(t.discount_total)}</strong></li> : null}
            {Number(t.trade_credit_total) ? <li><span>Trade-in credit</span><strong>{fmt(t.trade_credit_total)}</strong></li> : null}
            {storeCreditRedeemed ? <li><span>Store credit redeemed</span><strong>{fmt(storeCreditRedeemed)}</strong></li> : null}
            <li><span>Tax</span><strong>{fmt(t.tax_total)}</strong></li>
            <li className="tx-total"><span>Total</span><strong>{fmt(t.total)}</strong></li>
          </ul>
          <h4>Payments</h4>
          <ul className="tx-mini-list">{detail.payments.length ? detail.payments.map((payment, index) => <li key={index}><span>{METHOD[payment.method] || payment.method}{Number(payment.amount) < 0 ? ' (paid out)' : ''}</span><strong>{fmt(payment.amount)}</strong></li>) : <li><span className="cs-muted">No payments recorded</span></li>}</ul>
          {['sale', 'exchange'].includes(t.type) ? (
            <ul className="tx-mini-list">
              <li><span>Refunds issued</span><strong>{fmt(t.refunded)}</strong></li>
              <li className="tx-total"><span>Net retained</span><strong>{fmt(Number(t.paid) - Number(t.refunded))}</strong></li>
            </ul>
          ) : null}
        </div>
        <div className="tx-card">
          <h3>Refunds</h3>
          {!detail.refunds.length ? <p className="cs-muted">{['sale', 'exchange'].includes(t.type) ? 'No refunds.' : 'Not applicable.'}</p> : detail.refunds.map((refund) => (
            <div className="tx-refund" key={refund.id}>
              <p><button type="button" className="tx-link" onClick={() => refund.transaction_id && onOpen(refund.transaction_id)}>{refund.number || 'Refund'}</button> · {when(refund.created_at)} · {METHOD[refund.method] || refund.method} · <strong>{fmt(refund.amount)}</strong></p>
              <small>{refund.reason || 'No reason'}{refund.employee ? ` · ${refund.employee}` : ''}</small>
              {refund.lines.length ? <ul>{refund.lines.map((line, index) => <li key={index}>{line.quantity} × {line.name} · {fmt(line.amount)} · {line.restocked ? 'returned to stock' : 'not returned to stock'}</li>)}</ul> : null}
            </div>
          ))}
          {detail.identification && (detail.identification.seller || detail.identification.buyback) ? (
            <>
              <h4>Seller identification</h4>
              <dl className="cs-facts">
                {detail.identification.seller ? <><dt>Seller</dt><dd>{detail.identification.seller.name}</dd><dt>Photo ID</dt><dd>{detail.identification.seller.photo_id_shown ? `Shown${detail.identification.seller.id_type ? ` (${detail.identification.seller.id_type.replaceAll('_', ' ')})` : ''}` : 'Not shown'}</dd><dt>Checked by</dt><dd>{detail.identification.seller.verified_by || '—'}</dd></> : null}
                {detail.identification.buyback ? <><dt>ID method</dt><dd>{detail.identification.buyback.method.replaceAll('_', ' ')}{detail.identification.buyback.id_type ? ` · ${detail.identification.buyback.id_type.replaceAll('_', ' ')}` : ''}</dd><dt>Recorded by</dt><dd>{detail.identification.buyback.employee || '—'}</dd></> : null}
              </dl>
            </>
          ) : null}
        </div>
      </div>

      {detail.audit ? (
        <div className="tx-card">
          <h3>Audit trail</h3>
          {!detail.audit.length ? <p className="cs-muted">No audit entries yet (recorded from now on).</p> : (
            <ul className="tx-audit">{detail.audit.map((entry, index) => <li key={index}><span>{when(entry.created_at)}</span><strong>{entry.action.replaceAll('_', ' ')}</strong><span>{entry.employee || ''}{entry.reason ? ` · ${entry.reason}` : ''}</span></li>)}</ul>
          )}
        </div>
      ) : null}

      {modal === 'receipt' || modal === 'receipt-print' ? <ReceiptModal storeId={storeId} detail={detail} branding={receiptBranding} renderReceipt={renderReceipt} autoPrint={modal === 'receipt-print'} onClose={() => setModal('')} /> : null}
      {modal === 'refund' ? <RefundDialog session={session} detail={detail} onCancel={() => setModal('')} onDone={(result) => { setModal(''); setNotice(`Refund ${result.transaction_number} recorded: ${fmt(result.amount)} by ${METHOD[result.method] || result.method}.${result.repeated ? ' (Already recorded; nothing was refunded twice.)' : ''}`); load(); onOpen(result.transaction_id) }} />
        : null}
      {modal === 'void' ? <VoidDialog storeId={storeId} detail={detail} onCancel={() => setModal('')} onDone={() => { setModal(''); setNotice('Transaction voided.'); load() }} /> : null}
    </section>
  )
}

function ItemsTable({ title, items, showRefunded = false }) {
  return (
    <div className="tx-card">
      <h3>{title}</h3>
      <table className="cs-table tx-items">
        <thead><tr><th /><th>Item</th><th>SKU</th><th>Catalogue ID</th><th>Condition</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Discount</th><th className="num">Line total</th>{showRefunded ? <th className="num">Refunded</th> : null}</tr></thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{itemImage(item) ? <img className="tx-thumb" src={itemImage(item)} alt="" loading="lazy" /> : <span className="tx-thumb empty"><ImageOff size={14} /></span>}</td>
              <td><strong>{item.name || 'Item'}</strong></td>
              <td>{item.sku || '—'}</td>
              <td className="tx-mono" title={item.catalog_item_id || ''}>{item.catalog_item_id ? item.catalog_item_id.slice(0, 8) : '—'}</td>
              <td>{[item.condition, item.grade].filter(Boolean).join(' · ') || '—'}</td>
              <td className="num">{item.quantity}</td>
              <td className="num">{fmt(item.unit_price)}</td>
              <td className="num">{Number(item.discount) ? fmt(item.discount) : '—'}</td>
              <td className="num"><strong>{fmt(item.line_total)}</strong></td>
              {showRefunded ? <td className="num">{Number(item.refunded_qty) ? `${item.refunded_qty} of ${item.quantity}` : '—'}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// The Register's receipt, from the stored transaction values (not today's prices).
function ReceiptModal({ storeId, detail, branding, renderReceipt, autoPrint, onClose }) {
  const receipt = useMemo(() => receiptFromDetail(detail, branding || {}), [detail, branding])
  const [email, setEmail] = useState(detail.customer?.email || '')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  function print() { logReceipt(storeId, detail.transaction.id, 'receipt_printed'); window.print() }
  useEffect(() => { if (autoPrint) { const timer = setTimeout(print, 300); return () => clearTimeout(timer) } return undefined }, [])
  async function send(event) {
    event.preventDefault()
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setMessage('Enter an email address.'); return }
    setBusy(true)
    setMessage(`Sending receipt to ${email.trim()}…`)
    try {
      const { data, error } = await supabase.functions.invoke('hyper-api', { // the send-receipt function
        body: { to: email.trim(), storeId, receipt: { ...receipt, items: receipt.items.map((item) => ({ name: item.name, sku: item.sku, quantity: item.quantity, total: item.total, direction: item.direction, condition: item.condition })) } },
      })
      if (error || data?.error) {
        let text = data?.error || error?.message || 'The receipt could not be emailed.'
        try { const details = await error?.context?.json?.(); if (details?.error) text = details.error } catch {}
        throw new Error(text)
      }
      logReceipt(storeId, detail.transaction.id, 'receipt_emailed')
      setMessage(`Receipt emailed to ${email.trim()}.`)
    } catch (error) { setMessage(error?.message || 'The receipt could not be emailed.') } finally { setBusy(false) }
  }
  return (
    <div className="completion-modal tx-receipt-modal" role="dialog" aria-modal="true" aria-label="Receipt">
      <section>
        <button className="modal-close tx-no-print" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        {renderReceipt ? renderReceipt(receipt) : <p>Receipt unavailable.</p>}
        <div className="tx-receipt-actions tx-no-print">
          <button type="button" className="gold-button" onClick={print}><Printer size={15} /> Print / Save PDF</button>
          <form onSubmit={send}><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email the receipt to…" /><button type="submit" disabled={busy}><Mail size={15} /> Email</button></form>
          {message ? <p className="cs-muted">{message}</p> : null}
        </div>
      </section>
    </div>
  )
}

function Approval({ value, onChange }) {
  return (
    <div className="tx-approval">
      <p><strong>Supervisor or manager approval needed.</strong> They enter their username and PIN.</p>
      <div className="cs-form-grid">
        <label><span>Username</span><input value={value.username} onChange={(event) => onChange({ ...value, username: event.target.value })} autoComplete="off" /></label>
        <label><span>PIN</span><input type="password" inputMode="numeric" value={value.pin} onChange={(event) => onChange({ ...value, pin: event.target.value })} autoComplete="off" /></label>
      </div>
    </div>
  )
}

// Refund: whole, part, items or quantities. The server checks the refundable balance, card limits and permission.
function RefundDialog({ session, detail, onCancel, onDone }) {
  const t = detail.transaction
  const items = detail.items.filter((item) => item.direction === 'out' && Number(item.quantity) - Number(item.refunded_qty) > 0)
  const outTotal = detail.items.filter((item) => item.direction === 'out').reduce((sum, item) => sum + Number(item.line_total), 0)
  const cardPaid = detail.payments.filter((payment) => ['card', 'debit', 'credit'].includes(payment.method) && Number(payment.amount) > 0).reduce((sum, payment) => sum + Number(payment.amount), 0)
  const methods = [['cash', 'Cash'], ...(cardPaid > 0 ? [['card', 'Card (refund on the terminal)']] : []), ...(detail.customer?.is_member ? [['store_credit', 'Store credit']] : [])]
  const [requestId] = useState(newRequestId)
  const [qty, setQty] = useState({})
  const [restock, setRestock] = useState({})
  const [amountText, setAmountText] = useState('')
  const [method, setMethod] = useState(cardPaid > 0 ? 'card' : 'cash')
  const [reason, setReason] = useState('')
  const [cardDone, setCardDone] = useState(false)
  const [approval, setApproval] = useState(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const refundable = Number(t.refundable)
  // Estimate shown while choosing (the server works out the exact amount).
  const linesValue = items.reduce((sum, item) => {
    const count = Number(qty[item.id] || 0)
    if (!count) return sum
    const base = Number(item.line_total) / Math.max(Number(item.quantity), 1) * count
    return sum + base + (outTotal > 0 ? Number(t.tax_total) * base / outTotal : 0)
  }, 0)
  const typed = Number(String(amountText).replace(/[^0-9.]/g, ''))
  const amount = Math.round((amountText !== '' ? typed : linesValue) * 100) / 100
  const all = () => { setQty(Object.fromEntries(items.map((item) => [item.id, Number(item.quantity) - Number(item.refunded_qty)]))); setAmountText('') }

  async function submit() {
    setBusy(true)
    setProblem('')
    try {
      const lines = items.filter((item) => Number(qty[item.id] || 0) > 0).map((item) => ({ item_id: item.id, quantity: Number(qty[item.id]), restock: Boolean(restock[item.id]) }))
      const result = await refundTransaction(session.storeId, {
        locationId: session.locationId, transactionId: t.id, lines, amount: amountText !== '' ? amount : null, method, reason: reason.trim(), requestId,
        approver: approval && approval.username && approval.pin ? approval : null, cardConfirmed: cardDone,
      })
      onDone(result)
    } catch (error) {
      if (error.approvalRequired) setApproval((current) => current || { username: '', pin: '' })
      setProblem(error?.message || String(error))
    } finally { setBusy(false) }
  }
  const ready = amount > 0 && amount <= refundable + 0.005 && reason.trim().length > 1 && (method !== 'card' || cardDone) && !busy

  return (
    <div className="register-modal cu-modal wide" role="dialog" aria-modal="true" aria-labelledby="tx-refund-title">
      <section>
        <button className="modal-close" type="button" onClick={onCancel} aria-label="Close"><X size={18} /></button>
        <h2 id="tx-refund-title">Refund {t.number}</h2>
        <p className="cs-muted">Up to <strong>{fmt(refundable)}</strong> can still be refunded{Number(t.refunded) ? ` (${fmt(t.refunded)} already refunded)` : ''}. The refund is recorded as its own transaction linked to this sale.</p>
        {items.length ? (
          <>
            <div className="tx-refund-head"><strong>Items being returned</strong><button type="button" onClick={all}>Select everything</button></div>
            <table className="cs-table tx-items">
              <thead><tr><th>Item</th><th>Condition</th><th className="num">Price</th><th className="num">Can refund</th><th className="num">Refund qty</th><th>Returned and accepted into stock</th></tr></thead>
              <tbody>
                {items.map((item) => {
                  const left = Number(item.quantity) - Number(item.refunded_qty)
                  return (
                    <tr key={item.id}>
                      <td><strong>{item.name}</strong><small className="tx-sku">{item.sku}</small></td>
                      <td>{[item.condition, item.grade].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="num">{fmt(Number(item.line_total) / Math.max(Number(item.quantity), 1))}</td>
                      <td className="num">{left}</td>
                      <td className="num"><input className="tx-qty" type="number" min="0" max={left} value={qty[item.id] || 0} onChange={(event) => { setQty((current) => ({ ...current, [item.id]: Math.max(0, Math.min(left, Number(event.target.value) || 0)) })); setAmountText('') }} /></td>
                      <td>{item.inventory_id ? <label className="tx-check"><input type="checkbox" checked={Boolean(restock[item.id])} disabled={!Number(qty[item.id] || 0)} onChange={(event) => setRestock((current) => ({ ...current, [item.id]: event.target.checked }))} /> Back to stock ({item.condition || 'same condition'})</label> : <span className="cs-muted">Not a stock item</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        ) : null}
        <div className="cs-form-grid">
          <label><span>Refund amount{items.length ? ' (leave as calculated, or type a different amount)' : ''}</span><input inputMode="decimal" value={amountText !== '' ? amountText : (linesValue ? linesValue.toFixed(2) : '')} onChange={(event) => setAmountText(event.target.value)} placeholder="0.00" /></label>
          <label><span>Refund method</span><select value={method} onChange={(event) => { setMethod(event.target.value); setCardDone(false) }}>{methods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="wide"><span>Reason (required)</span><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. damaged on arrival, changed mind" /></label>
        </div>
        {amount > refundable + 0.005 ? <p className="cs-error"><AlertTriangle size={14} /> More than the {fmt(refundable)} that can still be refunded.</p> : null}
        {method === 'card' ? (
          <label className="tx-check tx-card-confirm"><input type="checkbox" checked={cardDone} onChange={(event) => setCardDone(event.target.checked)} /> I refunded {fmt(amount)} to the customer's card on the payment terminal. (CollectorsHub doesn't connect to the terminal, so this records the refund you made there.)</label>
        ) : null}
        {approval ? <Approval value={approval} onChange={setApproval} /> : null}
        {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
        <div className="cs-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="gold-button" disabled={!ready} onClick={submit}><RotateCcw size={15} /> {busy ? 'Refunding…' : `Refund ${fmt(amount)}`}</button>
        </div>
      </section>
    </div>
  )
}

function VoidDialog({ storeId, detail, onCancel, onDone }) {
  const [reason, setReason] = useState('')
  const [approval, setApproval] = useState(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  async function submit() {
    setBusy(true)
    setProblem('')
    try { await voidTransaction(storeId, detail.transaction.id, reason.trim(), approval && approval.username && approval.pin ? approval : null); onDone() } catch (error) {
      if (error.approvalRequired) setApproval((current) => current || { username: '', pin: '' })
      setProblem(error?.message || String(error))
    } finally { setBusy(false) }
  }
  return (
    <div className="register-modal cu-modal" role="dialog" aria-modal="true">
      <section>
        <button className="modal-close" type="button" onClick={onCancel} aria-label="Close"><X size={18} /></button>
        <h2>Void {detail.transaction.number}</h2>
        <p className="cs-muted">Voiding cancels a transaction that wasn't completed. Nothing was paid or taken from stock, so nothing is reversed. It stays in the ledger as Voided.</p>
        <label className="tx-field"><span>Reason (required)</span><input value={reason} onChange={(event) => setReason(event.target.value)} autoFocus /></label>
        {approval ? <Approval value={approval} onChange={setApproval} /> : null}
        {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
        <div className="cs-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="gold-button" disabled={busy || reason.trim().length < 2} onClick={submit}><Ban size={15} /> {busy ? 'Voiding…' : 'Void transaction'}</button></div>
      </section>
    </div>
  )
}
