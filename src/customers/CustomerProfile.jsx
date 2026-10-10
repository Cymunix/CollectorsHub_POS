import React, { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Heart, ImageOff, Link2, Lock, Package, Pencil, ShoppingCart, Trash2, UserRound, X } from 'lucide-react'
import {
  CREDIT_ENTRY, customerCollectionJobs, customerWishlist, requestWishlistAccess, withdrawWishlistAccess, wishlistApprovalUrl, customerLoyalty, customerNotes, customerProfile, customerTradeIns, customerTransactions, deleteCustomerNote,
  linkApprovalUrl, requestCustomerLink, saveCustomerNote, setCustomerStatus, storeCreditBalance, storeCreditHistory, transactionDetail, unlinkCustomer, updateCustomer,
} from '../lib/customers'
import { JOB_STATUS, CUSTODY_STATUS } from '../lib/collectionScanning'
import { CollectorPicker } from '../scan/collectorParts'
import { supabase } from '../lib/supabaseClient'
import { pawnList, STATE as PAWN_STATE } from '../lib/pawnLoans'

const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })
const when = (value) => (value ? new Date(value).toLocaleString() : '—')
const day = (value) => (value ? new Date(value).toLocaleDateString() : '—')
const TABS = [['overview', 'Overview'], ['purchases', 'Purchase History'], ['wishlist', 'Wishlist'], ['credit', 'Store Credit'], ['trades', 'Trade-Ins'], ['collection', 'Collection Services'], ['loyalty', 'Loyalty & Membership'], ['notes', 'Notes']]
const TYPE = { sale: 'Sale', trade_in: 'Trade-in', exchange: 'Exchange', return: 'Return', refund: 'Refund', adjustment: 'Adjustment' }

export default function CustomerProfile({ session, customerId, initialTab = '', onBack, onScanForCollector, onStartSale, onViewInventory, pawnEnabled = false, onOpenPawnLoan }) {
  const storeId = session?.storeId
  const [data, setData] = useState(null)
  const [tab, setTab] = useState(initialTab || 'overview')
  const [problem, setProblem] = useState('')
  const [linking, setLinking] = useState(false)
  async function reload() { try { setData(await customerProfile(storeId, customerId)); setProblem('') } catch (error) { setProblem(error?.message || String(error)) } }
  useEffect(() => { reload() }, [customerId])
  if (!data) return <section className="cu-page"><button type="button" onClick={onBack}><ArrowLeft size={15} /> Customers</button>{problem ? <p className="cs-error">{problem}</p> : <p className="cs-muted">Loading…</p>}</section>
  const { customer, member, stats, balance, can_manage: canManage, link_request: linkRequest, notices } = data
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.display_name || member?.display_name || member?.username || 'Customer'

  return (
    <section className="cu-page">
      <button type="button" className="cs-back" onClick={onBack}><ArrowLeft size={15} /> Customers</button>
      <div className="cu-profile-head">
        {member?.avatar_url ? <img className="cu-avatar" src={member.avatar_url} alt="" style={{ width: 64, height: 64 }} /> : <span className="cu-avatar" style={{ width: 64, height: 64 }}><UserRound size={30} /></span>}
        <div>
          <h1>{name}</h1>
          <p className="cs-muted">{member ? `@${member.username} · CollectorsHub member` : 'Store customer'} · {customer.customer_number}{customer.status === 'inactive' ? ' · Inactive' : ''}</p>
        </div>
        <div className="cu-head-actions">
          {!member && !linkRequest ? <button type="button" onClick={() => setLinking(true)}><Link2 size={15} /> Link CollectorsHub Account</button> : null}
          {member && canManage ? <button type="button" onClick={async () => { if (window.confirm('Unlink this CollectorsHub account? History and records stay with this customer.')) { try { await unlinkCustomer(storeId, customer.id); reload() } catch (error) { setProblem(error.message) } } }}>Unlink account</button> : null}
          {canManage ? <button type="button" onClick={async () => { try { await setCustomerStatus(storeId, customer.id, customer.status === 'active' ? 'inactive' : 'active'); reload() } catch (error) { setProblem(error.message) } }}>{customer.status === 'active' ? 'Mark inactive' : 'Reactivate'}</button> : null}
        </div>
      </div>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      {linkRequest ? <p className="cu-notice"><Clock3 size={15} /> Waiting for @{linkRequest.username} to confirm the link on their CollectorsHub account (until {when(linkRequest.expires_at)}). <button type="button" onClick={() => setLinking(true)}>Show approval code</button></p> : null}
      {notices?.collection_held ? <p className="cu-notice"><AlertTriangle size={15} /> The store is holding {notices.collection_held} of their collection drop-off{notices.collection_held === 1 ? '' : 's'} awaiting return.</p> : null}

      <div className="cs-tabs cu-tabs">{(pawnEnabled ? [...TABS.slice(0, -1), ['pawn', 'Pawn & Loans'], TABS[TABS.length - 1]] : TABS).map(([value, label]) => <button type="button" key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>)}</div>
      <div className="cu-tab-body">
        {tab === 'overview' ? <Overview storeId={storeId} data={data} name={name} balance={balance} stats={stats} onSaved={reload} /> : null}
        {tab === 'purchases' ? <Purchases storeId={storeId} customerId={customer.id} /> : null}
        {tab === 'wishlist' ? <Wishlist session={session} customer={customer} member={member} name={name} canManage={canManage} initialFilter={initialTab === 'wishlist' ? 'in_store' : 'all'} onLink={() => setLinking(true)} onStartSale={onStartSale} onViewInventory={onViewInventory} /> : null}
        {tab === 'credit' ? <Credit storeId={storeId} customer={customer} balance={balance} /> : null}
        {tab === 'trades' ? <TradeIns storeId={storeId} customerId={customer.id} /> : null}
        {tab === 'collection' ? <Collection storeId={storeId} customer={customer} member={member} onScanForCollector={onScanForCollector} /> : null}
        {tab === 'loyalty' ? <Loyalty storeId={storeId} customer={customer} member={member} onLink={() => setLinking(true)} /> : null}
        {tab === 'pawn' ? <PawnLoansTab storeId={storeId} customerId={customer.id} onOpenPawnLoan={onOpenPawnLoan} /> : null}
        {tab === 'notes' ? <Notes storeId={storeId} customerId={customer.id} canManage={canManage} /> : null}
      </div>
      {linking ? <LinkAccountDialog storeId={storeId} customerId={customer.id} existingRequest={linkRequest} onClose={() => { setLinking(false); reload() }} /> : null}
    </section>
  )
}

function Overview({ storeId, data, name, balance, stats, onSaved }) {
  const { customer, member } = data
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ first_name: customer.first_name || '', last_name: customer.last_name || '', display_name: customer.display_name || '', email: customer.email || '', phone: customer.phone || '', address: customer.address || '' })
  const [problem, setProblem] = useState('')
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))
  async function save() {
    setProblem('')
    try { await updateCustomer(storeId, customer.id, member ? { first_name: form.first_name, last_name: form.last_name, email: form.email, phone: form.phone, address: form.address } : form); setEditing(false); onSaved() } catch (error) { setProblem(error?.message || String(error)) }
  }
  return (
    <div className="cu-overview">
      <div className="cu-stats">
        <div><small>Store credit</small><strong>{money.format(Number(balance || 0))}</strong></div>
        <div><small>Purchases</small><strong>{stats.purchases}</strong></div>
        <div><small>Spent here</small><strong>{money.format(Number(stats.total_spent || 0))}</strong></div>
        <div><small>Last purchase</small><strong>{day(stats.last_purchase)}</strong></div>
      </div>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      {editing ? (
        <div className="cs-form-grid">
          <label><span>First name</span><input value={form.first_name} onChange={set('first_name')} /></label>
          <label><span>Last name</span><input value={form.last_name} onChange={set('last_name')} /></label>
          {member ? <label><span>Display name</span><input value={member.display_name || member.username} disabled title="Set by the member on their CollectorsHub account" /></label> : <label><span>Display name</span><input value={form.display_name} onChange={set('display_name')} /></label>}
          <label><span>Email</span><input type="email" value={form.email} onChange={set('email')} /></label>
          <label><span>Phone</span><input type="tel" value={form.phone} onChange={set('phone')} /></label>
          <label className="wide"><span>Address</span><input value={form.address} onChange={set('address')} /></label>
          {member ? <p className="cs-muted wide">Their username, display name and photo belong to their CollectorsHub account and change there.</p> : null}
          <div className="cs-actions wide"><button type="button" onClick={() => setEditing(false)}>Cancel</button><button type="button" className="gold-button" onClick={save}>Save</button></div>
        </div>
      ) : (
        <>
          <dl className="cs-facts">
            <dt>Full name</dt><dd>{name}</dd>
            {member ? <><dt>Username</dt><dd>@{member.username}</dd></> : null}
            <dt>Customer ID</dt><dd>{customer.customer_number}</dd>
            <dt>Membership</dt><dd>{member ? 'Linked CollectorsHub member' : 'Store customer (no CollectorsHub account linked)'}</dd>
            <dt>Customer since</dt><dd>{day(customer.created_at)}</dd>
            <dt>Transactions</dt><dd>{stats.transactions}{stats.trade_ins ? ` (${stats.trade_ins} with trade-ins)` : ''}</dd>
            <dt>Email</dt><dd>{customer.email || '—'}</dd>
            <dt>Phone</dt><dd>{customer.phone || '—'}</dd>
            <dt>Address</dt><dd>{customer.address || '—'}</dd>
          </dl>
          <div className="cs-actions left"><button type="button" onClick={() => setEditing(true)}><Pencil size={14} /> Edit details</button></div>
        </>
      )}
    </div>
  )
}

function Purchases({ storeId, customerId }) {
  const [rows, setRows] = useState(null)
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState('')
  const [detail, setDetail] = useState({})
  useEffect(() => { customerTransactions(storeId, customerId, { offset, limit: 50 }).then(setRows).catch(() => setRows([])) }, [customerId, offset])
  async function toggle(row) {
    if (open === row.id) { setOpen(''); return }
    setOpen(row.id)
    if (!detail[row.id]) { try { const value = await transactionDetail(storeId, row.id); setDetail((current) => ({ ...current, [row.id]: value })) } catch {} }
  }
  const total = Number(rows?.[0]?.total_count || 0)
  if (rows === null) return <p className="cs-muted">Loading…</p>
  if (!rows.length) return <div className="cs-empty small"><strong>No transactions at this store yet</strong></div>
  return (
    <>
      <table className="cs-table">
        <thead><tr><th>Transaction</th><th>Date</th><th>Type</th><th>Items</th><th>Subtotal</th><th>Tax</th><th>Total</th><th>Payment</th><th>Refund</th><th>Employee</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <React.Fragment key={row.id}>
              <tr className="cs-clickable" onClick={() => toggle(row)}>
                <td><strong>{row.transaction_number}</strong></td><td>{when(row.created_at)}</td><td>{TYPE[row.transaction_type] || row.transaction_type}</td>
                <td title={row.items}>{row.item_count} item{row.item_count === 1 ? '' : 's'}</td><td>{money.format(Number(row.subtotal || 0))}</td><td>{money.format(Number(row.tax || 0))}</td>
                <td><strong>{money.format(Number(row.total || 0))}</strong></td><td>{row.payments || '—'}</td><td>{row.refunded ? <span className="cs-pill needs_review">Refunded</span> : '—'}</td><td>{row.employee_name || '—'}</td>
              </tr>
              {open === row.id ? (
                <tr className="cu-detail"><td colSpan={10}>
                  {!detail[row.id] ? 'Loading…' : (
                    <div className="cu-detail-grid">
                      <ul>{detail[row.id].items.map((item, index) => <li key={index}>{item.quantity} × {item.name || 'Item'}{item.condition ? ` (${item.condition})` : ''}{item.direction === 'in' ? ' · traded in' : ''} · {money.format(Number(item.line_total || 0))}</li>)}</ul>
                      <ul>{detail[row.id].payments.map((payment, index) => <li key={index}>{payment.method.replace('_', ' ')}: {money.format(Number(payment.amount || 0))}</li>)}{detail[row.id].refunds.length ? <li>Refunded: {detail[row.id].refunds.map((refund) => money.format(Number(refund.refund_amount || refund.amount || 0))).join(', ')}</li> : null}</ul>
                    </div>
                  )}
                </td></tr>
              ) : null}
            </React.Fragment>
          ))}
        </tbody>
      </table>
      {total > 50 ? <div className="cu-pager"><span>{offset + 1}–{Math.min(total, offset + 50)} of {total}</span><button type="button" disabled={!offset} onClick={() => setOffset(offset - 50)}>Previous</button><button type="button" disabled={offset + 50 >= total} onClick={() => setOffset(offset + 50)}>Next</button></div> : null}
    </>
  )
}

const WISHLIST_PAGE = 48
const WISHLIST_FILTERS = [['all', 'All'], ['in_store', 'In Store'], ['not_in_store', 'Not In Store']]
const imageUrl = (path) => (!path ? '' : /^https?:/.test(path) ? path : supabase.storage.from('item-images').getPublicUrl(path).data?.publicUrl || '')
const priceRange = (item) => (item.price_min == null ? '—' : Number(item.price_min) === Number(item.price_max) ? money.format(Number(item.price_min)) : `${money.format(Number(item.price_min))} – ${money.format(Number(item.price_max))}`)

// The member's wishlist matched against this store's available stock. Shared with the
// store automatically once they've shopped here, unless they turn it off; read-only.
function Wishlist({ session, customer, member, name, canManage, initialFilter, onLink, onStartSale, onViewInventory }) {
  const storeId = session?.storeId
  const [filter, setFilter] = useState(initialFilter)
  const [page, setPage] = useState(0)
  const [data, setData] = useState(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const [qr, setQr] = useState('')
  const [requestId, setRequestId] = useState('')
  async function load() {
    try { setData(await customerWishlist(storeId, customer.id, { locationId: session?.locationId, filter })); setProblem('') } catch (error) { setProblem(error?.message || String(error)); setData((current) => current || { access: { status: 'error' }, items: [] }) }
  }
  useEffect(() => { if (member) load() }, [customer.id, filter])
  useEffect(() => { setPage(0) }, [customer.id, filter])
  const status = data?.access?.status
  const pendingId = requestId || (status === 'pending' ? data?.access?.id : '')
  useEffect(() => { if (pendingId) QRCode.toDataURL(wishlistApprovalUrl(pendingId), { margin: 1, width: 200, color: { dark: '#0B111B', light: '#FFFFFF' } }).then(setQr) }, [pendingId])
  // Shows the wishlist as soon as the member approves on their phone.
  useEffect(() => {
    if (!pendingId || status === 'granted') return undefined
    const timer = setInterval(load, 4000)
    return () => clearInterval(timer)
  }, [pendingId, status])
  async function ask() {
    setBusy(true)
    setProblem('')
    try { setRequestId((await requestWishlistAccess(storeId, customer.id)) || ''); await load() } catch (error) { setProblem(error?.message || String(error)) } finally { setBusy(false) }
  }
  async function withdraw() {
    if (!window.confirm(`Stop using ${name}'s wishlist? Your store won't see it until they share it again.`)) return
    try { await withdrawWishlistAccess(storeId, customer.id); setRequestId(''); load() } catch (error) { setProblem(error?.message || String(error)) }
  }

  if (!member) return <div className="cs-empty small"><Heart size={22} /><strong>Wishlists need a linked CollectorsHub account</strong><span>Store customers don't have a CollectorsHub wishlist.</span><button type="button" onClick={onLink}><Link2 size={14} /> Link CollectorsHub Account</button></div>
  if (!data) return problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : <p className="cs-muted">Loading…</p>
  if (status !== 'granted') {
    return (
      <div className="cu-overview">
        {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
        {pendingId && status === 'pending' ? (
          <div className="cs-auth pending">
            {qr ? <img src={qr} alt="Wishlist sharing QR code" /> : null}
            <div>
              <p className="cs-auth-title"><Clock3 size={16} /> Waiting for @{member.username} to share their wishlist</p>
              <p>They scan this code, sign in to their own CollectorsHub account and choose whether to share their wishlist with your store. They can stop sharing at any time.</p>
              <p className="cs-link">{wishlistApprovalUrl(pendingId)}</p>
            </div>
          </div>
        ) : (
          <div className="cs-empty">
            <Lock size={28} />
            <strong>{status === 'revoked' ? 'The member turned off wishlist sharing with your store' : status === 'declined' ? 'The member chose not to share their wishlist' : status === 'withdrawn' ? 'Your store stopped using this wishlist' : 'Wishlist not shared yet'}</strong>
            <span>{status === 'withdrawn' ? 'Start using it again to see their wishlist matches.' : status === 'revoked' || status === 'declined' ? 'You can ask again; they decide on their own account. The store can only see a wishlist, never change it.' : 'Members share their wishlist automatically once they complete a purchase here. You can also ask them now; they approve on their own account.'}</span>
            <button type="button" className="gold-button" disabled={busy} onClick={ask}><Heart size={15} /> {busy ? 'Asking…' : status === 'withdrawn' ? 'Start using their wishlist' : 'Ask to share their wishlist'}</button>
          </div>
        )}
      </div>
    )
  }
  const counts = data.counts || {}
  const allItems = data.items || []
  const pages = Math.max(1, Math.ceil(allItems.length / WISHLIST_PAGE))
  const current = Math.min(page, pages - 1)
  const items = allItems.slice(current * WISHLIST_PAGE, (current + 1) * WISHLIST_PAGE)
  const turn = (next) => { setPage(next); document.querySelector('.cu-wish-head')?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }
  return (
    <div className="cu-overview">
      <div className="cu-wish-head">
        <div className="cs-tabs small">{WISHLIST_FILTERS.map(([value, label]) => <button type="button" key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}{counts[value] != null ? <em>{counts[value]}</em> : null}</button>)}</div>
        <span className="cs-muted">{data.access.automatic ? 'Shared automatically because they shop here' : `Shared with your store${data.access.decided_at ? ` since ${day(data.access.decided_at)}` : ''}`}. Read-only; they can turn it off on their account.</span>
        {canManage ? <button type="button" className="cu-link-button" onClick={withdraw}>Stop using</button> : null}
      </div>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      {!allItems.length ? (
        <div className="cs-empty small"><Heart size={22} /><strong>{filter === 'in_store' ? 'Nothing on their wishlist is in stock here right now' : filter === 'not_in_store' ? 'Everything on their wishlist is in stock here' : 'Their wishlist is empty'}</strong></div>
      ) : (
        <div className="cu-wish-list">
          {items.map((item) => {
            const inStore = Number(item.available) > 0
            const ident = [item.set_name, item.card_number ? `#${item.card_number}` : '', item.release_year].filter(Boolean).join(' · ')
            return (
              <div className={`cu-wish ${inStore ? 'in' : ''}`} key={item.catalog_item_id}>
                <div className="cu-wish-img">
                  {imageUrl(item.image_path) ? <img src={imageUrl(item.image_path)} alt="" loading="lazy" /> : <span className="cu-wish-noimg"><ImageOff size={26} /></span>}
                  {inStore ? <span className="cu-match has"><Heart size={12} /> In store</span> : <span className="cu-match out">Not in store</span>}
                </div>
                <div className="cu-wish-main">
                  <strong title={item.name || item.subject || ''}>{item.name || item.subject || 'Catalogue item'}</strong>
                  <small>{ident || 'Catalogue item'}</small>
                  {item.notes ? <small className="cu-wish-pref">Preference: {item.notes}</small> : null}
                  {inStore ? <div className="cu-wish-price"><strong>{priceRange(item)}</strong><small>{item.available} available</small></div> : null}
                </div>
                {inStore ? (
                  <ul className="cu-wish-stock">
                    {item.stock.map((line) => (
                      <li key={line.inventory_id}>
                        <span>{line.condition || 'Condition not set'}{line.grade ? ` · ${line.grade}` : ''} · {line.available} · <b>{line.price != null ? money.format(Number(line.price)) : 'No price'}</b></span>
                        <span className="cu-wish-actions">
                          <button type="button" onClick={() => onViewInventory?.(line)} disabled={!onViewInventory} title="View in Inventory"><Package size={13} /> View</button>
                          <button type="button" className="gold-button" onClick={() => onStartSale?.(line, { profileId: customer.profile_id, name, username: member.username, customerId: customer.id })} disabled={!onStartSale}><ShoppingCart size={13} /> Sell</button>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
      {allItems.length > WISHLIST_PAGE ? (
        <div className="cu-pager">
          <span>{current * WISHLIST_PAGE + 1}–{Math.min(allItems.length, (current + 1) * WISHLIST_PAGE)} of {allItems.length} · page {current + 1} of {pages}</span>
          <button type="button" disabled={current === 0} onClick={() => turn(current - 1)} aria-label="Previous page"><ChevronLeft size={15} /></button>
          <button type="button" disabled={current >= pages - 1} onClick={() => turn(current + 1)} aria-label="Next page"><ChevronRight size={15} /></button>
        </div>
      ) : null}
    </div>
  )
}

// This store's pawn loans for the customer (only staff with pawn access; never on their CollectorsHub profile).
function PawnLoansTab({ storeId, customerId, onOpenPawnLoan }) {
  const [data, setData] = useState(null)
  const [problem, setProblem] = useState('')
  useEffect(() => { pawnList(storeId, { customerId, limit: 200 }).then(setData).catch((error) => setProblem(error.message)) }, [customerId])
  if (problem) return <div className="cs-empty small"><strong>Pawn loans aren't available</strong><span>{problem}</span></div>
  if (!data) return <p className="cs-muted">Loading…</p>
  if (!data.rows.length) return <div className="cs-empty small"><strong>No pawn loans with this customer</strong></div>
  const open = data.rows.filter((row) => ['active', 'due_soon', 'overdue', 'forfeiture_review'].includes(row.state))
  return (
    <div className="cu-overview">
      <div className="cu-stats">
        <div><small>Active loans</small><strong>{open.length}</strong></div>
        <div><small>Owing today</small><strong>{money.format(open.reduce((sum, row) => sum + Number(row.balance || 0), 0))}</strong></div>
        <div><small>Redeemed</small><strong>{data.rows.filter((row) => row.state === 'redeemed').length}</strong></div>
        <div><small>All loans</small><strong>{data.total}</strong></div>
      </div>
      <table className="cs-table">
        <thead><tr><th>Loan</th><th>Collateral</th><th>Principal</th><th>Owing</th><th>Loan date</th><th>Due date</th><th>Status</th></tr></thead>
        <tbody>{data.rows.map((row) => (
          <tr key={row.id} className="cs-clickable" onClick={() => onOpenPawnLoan?.(row.id)}>
            <td><strong>{row.loan_number}</strong>{row.is_test ? ' (test)' : ''}</td><td>{row.collateral?.first || '—'}{row.collateral?.count > 1 ? ` +${row.collateral.count - 1}` : ''}</td>
            <td>{money.format(Number(row.principal || 0))}</td><td>{['active', 'due_soon', 'overdue', 'forfeiture_review'].includes(row.state) ? money.format(Number(row.balance || 0)) : '—'}</td>
            <td>{day(row.issue_date)}</td><td>{day(row.due_date)}</td><td>{PAWN_STATE[row.state] || row.state}</td>
          </tr>
        ))}</tbody>
      </table>
      <p className="cs-muted">Pawn records are private to this store. Open a loan for its collateral, payments and agreements.</p>
    </div>
  )
}

function Credit({ storeId, customer, balance }) {
  const [rows, setRows] = useState(null)
  const [live, setLive] = useState(balance)
  useEffect(() => {
    storeCreditHistory(storeId, customer.id, customer.profile_id).then(setRows).catch(() => setRows([]))
    storeCreditBalance(storeId, customer.id, customer.profile_id).then(setLive).catch(() => {})
  }, [customer.id])
  const issued = (rows || []).filter((row) => Number(row.amount) > 0).reduce((sum, row) => sum + Number(row.amount), 0)
  const redeemed = (rows || []).filter((row) => Number(row.amount) < 0).reduce((sum, row) => sum - Number(row.amount), 0)
  return (
    <div className="cu-overview">
      <div className="cu-stats">
        <div><small>Available</small><strong>{money.format(Number(live || 0))}</strong></div>
        <div><small>Issued</small><strong>{money.format(issued)}</strong></div>
        <div><small>Redeemed</small><strong>{money.format(redeemed)}</strong></div>
      </div>
      <p className="cs-muted">Store credit belongs to this store and can only be spent here. It's issued by trade-ins paid in credit and refunds, and spent at checkout.{customer.is_member ? '' : ' A store customer needs a linked CollectorsHub account to hold store credit.'}</p>
      {rows === null ? <p className="cs-muted">Loading…</p> : !rows.length ? <div className="cs-empty small"><strong>No store credit history</strong></div> : (
        <table className="cs-table"><thead><tr><th>Date</th><th>Entry</th><th>Amount</th><th>Transaction</th><th>Note</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}><td>{when(row.created_at)}</td><td>{CREDIT_ENTRY[row.entry_type] || row.entry_type}</td><td className={Number(row.amount) < 0 ? 'cu-neg' : 'cu-pos'}>{money.format(Number(row.amount))}</td><td>{row.transaction_number || '—'}</td><td>{row.note || '—'}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  )
}

function TradeIns({ storeId, customerId }) {
  const [rows, setRows] = useState(null)
  useEffect(() => { customerTradeIns(storeId, customerId).then(setRows).catch(() => setRows([])) }, [customerId])
  if (rows === null) return <p className="cs-muted">Loading…</p>
  if (!rows.length) return <div className="cs-empty small"><strong>No trade-ins or buybacks yet</strong><span>Items bought from this customer through Buy / Trade-In appear here.</span></div>
  return (
    <table className="cs-table"><thead><tr><th>Transaction</th><th>Date</th><th>Item</th><th>Condition</th><th>Qty</th><th>Amount</th><th>Paid as</th><th>Status</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={`${row.transaction_id}-${index}`}><td><strong>{row.transaction_number}</strong></td><td>{day(row.created_at)}</td><td>{row.name || 'Item'}</td><td>{row.condition || '—'}</td><td>{row.quantity}</td><td>{money.format(Number(row.amount || 0))}</td><td>{row.paid_as}</td><td>{row.status}</td></tr>)}</tbody>
    </table>
  )
}

function Collection({ storeId, customer, member, onScanForCollector }) {
  const [jobs, setJobs] = useState(null)
  useEffect(() => { customerCollectionJobs(storeId, customer.id).then(setJobs).catch(() => setJobs([])) }, [customer.id])
  if (!member) return <div className="cs-empty small"><strong>Collection services need a linked CollectorsHub account</strong><span>Link their account to scan items into their collection.</span></div>
  return (
    <div className="cu-overview">
      <div className="cs-actions left">
        <button type="button" className="gold-button" onClick={() => onScanForCollector?.('express')}>New Express Scan</button>
        <button type="button" onClick={() => onScanForCollector?.('dropoff')}>New Collection Drop-Off</button>
      </div>
      <p className="cs-muted">The collector approves on their own account before anything is added to their collection.</p>
      {jobs === null ? <p className="cs-muted">Loading…</p> : !jobs.length ? <div className="cs-empty small"><strong>No collection scanning yet</strong></div> : (
        <table className="cs-table"><thead><tr><th>Reference</th><th>Type</th><th>Started</th><th>Scanned</th><th>In collection</th><th>Status</th><th>Custody</th></tr></thead>
          <tbody>{jobs.map((job) => <tr key={job.id}><td><strong>{job.reference}</strong></td><td>{job.kind === 'express' ? 'Express Scan' : 'Drop-Off'}</td><td>{day(job.created_at)}</td><td>{job.scanned}</td><td>{job.imported}</td><td><span className={`cs-pill ${job.status}`}>{JOB_STATUS[job.status] || job.status}</span></td><td>{CUSTODY_STATUS[job.custody_status]}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  )
}

function Loyalty({ storeId, customer, member, onLink }) {
  const [data, setData] = useState(undefined)
  useEffect(() => { if (member) customerLoyalty(storeId, customer.id).then(setData).catch(() => setData(null)) }, [customer.id])
  if (!member) return <div className="cs-empty small"><strong>Not a CollectorsHub member</strong><span>Store customers don't earn CollectorsHub XP. Link their account if they have one.</span><button type="button" onClick={onLink}><Link2 size={14} /> Link CollectorsHub Account</button></div>
  if (data === undefined) return <p className="cs-muted">Loading…</p>
  return (
    <div className="cu-overview">
      <div className="cu-stats">
        <div><small>Collector level</small><strong>{data?.level ?? '—'}</strong></div>
        <div><small>Items added from this store</small><strong>{data?.items_from_store ?? 0}</strong></div>
        <div><small>From purchases</small><strong>{data?.items_from_purchases ?? 0}</strong></div>
        <div><small>From collection scanning</small><strong>{data?.items_from_scanning ?? 0}</strong></div>
      </div>
      <p className="cs-muted">XP comes from the existing CollectorsHub rules: items added to their collection (purchases here and collection scanning) count toward their XP and level on their account. The store doesn't see the rest of their collection; it sees their wishlist while they share it (automatic once they shop here).</p>
    </div>
  )
}

function Notes({ storeId, customerId, canManage }) {
  const [rows, setRows] = useState(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(null)
  const [problem, setProblem] = useState('')
  async function load() { try { setRows(await customerNotes(storeId, customerId)) } catch (error) { setProblem(error?.message || String(error)); setRows([]) } }
  useEffect(() => { load() }, [customerId])
  async function save(id, body) { setProblem(''); try { await saveCustomerNote(storeId, customerId, id, body); setDraft(''); setEditing(null); load() } catch (error) { setProblem(error?.message || String(error)) } }
  return (
    <div className="cu-overview">
      <p className="cs-muted">Internal notes for this store's staff. Other stores and the customer never see them.</p>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      <div className="cu-note-new"><textarea rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Add a note…" /><button type="button" className="gold-button" disabled={!draft.trim()} onClick={() => save(null, draft)}>Add note</button></div>
      {rows === null ? <p className="cs-muted">Loading…</p> : rows.map((note) => (
        <div className="cu-note" key={note.id}>
          {editing?.id === note.id ? (
            <><textarea rows={2} value={editing.body} onChange={(event) => setEditing({ ...editing, body: event.target.value })} /><div className="cs-actions left"><button type="button" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="gold-button" onClick={() => save(note.id, editing.body)}>Save</button></div></>
          ) : <p>{note.body}</p>}
          <small>{note.created_by} · {when(note.created_at)}{note.updated_at ? ` · edited ${when(note.updated_at)}${note.updated_by ? ` by ${note.updated_by}` : ''}` : ''}</small>
          {(note.mine || canManage) && editing?.id !== note.id ? (
            <span className="cu-note-actions"><button type="button" onClick={() => setEditing({ id: note.id, body: note.body })} aria-label="Edit note"><Pencil size={13} /></button><button type="button" onClick={async () => { if (window.confirm('Remove this note?')) { try { await deleteCustomerNote(storeId, note.id); load() } catch (error) { setProblem(error.message) } } }} aria-label="Remove note"><Trash2 size={13} /></button></span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

// Link a store customer to a CollectorsHub account: the member confirms on their own account.
export function LinkAccountDialog({ storeId, customerId, preselected = null, existingRequest = null, onClose }) {
  const [member, setMember] = useState(preselected)
  const [requestId, setRequestId] = useState(existingRequest?.id || '')
  const [qr, setQr] = useState('')
  const [status, setStatus] = useState(existingRequest ? 'pending' : '')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (requestId) QRCode.toDataURL(linkApprovalUrl(requestId), { margin: 1, width: 200, color: { dark: '#0B111B', light: '#FFFFFF' } }).then(setQr) }, [requestId])
  // The profile shows when the member has confirmed (the link request disappears and the account appears).
  useEffect(() => {
    if (!requestId || status !== 'pending') return undefined
    const timer = setInterval(async () => { try { const profile = await customerProfile(storeId, customerId); if (profile.customer.is_member) setStatus('linked') } catch {} }, 3000)
    return () => clearInterval(timer)
  }, [requestId, status])
  async function request() {
    setBusy(true)
    setProblem('')
    try { setRequestId(await requestCustomerLink(storeId, customerId, member.id)); setStatus('pending') } catch (error) { setProblem(error?.message || String(error)) } finally { setBusy(false) }
  }
  return (
    <div className="register-modal cu-modal" role="dialog" aria-modal="true">
      <section>
        <button className="modal-close" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <h2>Link CollectorsHub Account</h2>
        {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
        {status === 'linked' ? (
          <div className="cs-done"><CheckCircle2 size={36} /><h3>Linked</h3><p>The member confirmed. Their store history, credit and notes are kept on this customer.</p><button type="button" className="gold-button" onClick={onClose}>Done</button></div>
        ) : requestId ? (
          <div className="cs-auth pending">
            {qr ? <img src={qr} alt="Link approval QR code" /> : null}
            <div>
              <p className="cs-auth-title"><Clock3 size={16} /> Waiting for the member to confirm</p>
              <p>They scan this code, sign in to their own CollectorsHub account and confirm the link. Finding their username alone doesn't link anything.</p>
              <p className="cs-link">{linkApprovalUrl(requestId)}</p>
            </div>
          </div>
        ) : member ? (
          <>
            <p className="cu-picked"><strong>{member.name}</strong> @{member.username} <button type="button" onClick={() => setMember(null)}>Change</button></p>
            <p className="cs-muted">The member confirms on their own account. Once linked, this customer's history, store credit, notes and trade-ins stay together; if they already had a record here from a checkout, it's folded into this one.</p>
            <div className="cs-actions"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="gold-button" disabled={busy} onClick={request}>{busy ? 'Requesting…' : 'Request confirmation'}</button></div>
          </>
        ) : <CollectorPicker storeId={storeId} onPick={setMember} />}
      </section>
    </div>
  )
}
