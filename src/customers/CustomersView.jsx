import React, { useEffect, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, Copy, Heart, Plus, RefreshCw, Search, UserRound, Users, X } from 'lucide-react'
import { createCustomer, customerDuplicates, customersSummary, listCustomers, matchLabel, mergeCustomers } from '../lib/customers'
import { CollectorPicker } from '../scan/collectorParts'
import CustomerProfile, { LinkAccountDialog } from './CustomerProfile'

// Customers: the store's own customers, and CollectorsHub members once they've
// completed a transaction here (customer_wishlists.sql), for this store only. Layout follows Inventory: header, summary, search and
// filters, directory, selected-customer panel; the full profile opens on top.

const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })
const day = (value) => (value ? new Date(value).toLocaleDateString() : '—')
const PAGE = 50
const FILTERS = [['all', 'All Customers'], ['members', 'CollectorsHub Members'], ['store', 'Store Customers'], ['wishlist', 'With Wishlist Matches'], ['active', 'Active'], ['inactive', 'Inactive']]
const SORTS = [['recent', 'Recent activity'], ['name', 'Customer name'], ['transactions', 'Most transactions'], ['matches', 'Most wishlist matches']]

// Wishlist matches with this store's available stock: only when the member shares their wishlist with the store.
export function MatchIndicator({ row, onOpen }) {
  if (!row.is_member) return <span className="cs-muted">—</span>
  if (row.wishlist_access !== 'granted') return <span className="cu-match none" title={row.wishlist_access === 'withdrawn' ? 'Your store stopped using this wishlist' : 'This member turned off wishlist sharing with your store'}>{row.wishlist_access === 'pending' ? 'Requested' : row.wishlist_access === 'withdrawn' ? 'Not used' : 'Turned off'}</span>
  return <button type="button" className={`cu-match ${row.wishlist_matches > 0 ? 'has' : ''}`} onClick={(event) => { event.stopPropagation(); onOpen() }} title="Open their wishlist: In Store">{row.wishlist_matches > 0 ? <Heart size={13} /> : null}{matchLabel(row)}</button>
}

export function CustomerAvatar({ row, size = 36 }) {
  return row.avatar_url ? <img className="cu-avatar" src={row.avatar_url} alt="" style={{ width: size, height: size }} /> : <span className="cu-avatar" style={{ width: size, height: size }}><UserRound size={size * 0.5} /></span>
}

export default function CustomersView({ session, initialProfileId = '', onProfileOpened, onScanForCollector, onStartSale, onViewInventory, pawnEnabled = false, onOpenPawnLoan }) {
  const storeId = session?.storeId
  const [summary, setSummary] = useState(null)
  const [rows, setRows] = useState(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('recent')
  const [profileTab, setProfileTab] = useState('')
  // Opened from elsewhere (e.g. a transaction's customer).
  useEffect(() => { if (initialProfileId) { setProfileTab(''); setProfileId(initialProfileId); onProfileOpened?.() } }, [initialProfileId])
  const [selectedId, setSelectedId] = useState('')
  const [profileId, setProfileId] = useState('')
  const [modal, setModal] = useState('')
  const [problem, setProblem] = useState('')
  const [tick, setTick] = useState(0)
  const refresh = () => setTick((value) => value + 1)

  useEffect(() => { if (storeId) customersSummary(storeId).then(setSummary).catch((error) => setProblem(error?.message || String(error))) }, [storeId, tick])
  useEffect(() => {
    if (!storeId) return undefined
    let cancelled = false
    const timer = setTimeout(() => {
      listCustomers(storeId, { search, filter, sort, locationId: session?.locationId, limit: PAGE, offset: page * PAGE })
        .then((data) => { if (cancelled) return; setRows(data || []); setTotal(Number(data?.[0]?.total_count || 0)); setProblem('') })
        .catch((error) => { if (!cancelled) { setRows([]); setProblem(error?.message || String(error)) } })
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [storeId, search, filter, sort, page, tick])
  useEffect(() => { setPage(0) }, [search, filter, sort])

  const selected = (rows || []).find((row) => row.id === selectedId) || null
  const openProfile = (id, tab = '') => { setProfileTab(tab); setProfileId(id) }
  if (profileId) return <CustomerProfile session={session} customerId={profileId} initialTab={profileTab} onBack={() => { setProfileId(''); setProfileTab(''); refresh() }} onScanForCollector={onScanForCollector} onStartSale={onStartSale} onViewInventory={onViewInventory} pawnEnabled={pawnEnabled} onOpenPawnLoan={onOpenPawnLoan} />

  return (
    <section className="cu-page">
      <header className="cu-head">
        <h1>Customers</h1>
        <div className="cu-head-actions">
          <button type="button" onClick={() => setModal('duplicates')}><Copy size={15} /> Possible duplicates</button>
          <button type="button" onClick={refresh}><RefreshCw size={15} /> Refresh</button>
          <button type="button" className="gold-button" onClick={() => setModal('add')}><Plus size={16} /> Add Customer</button>
        </div>
      </header>

      <div className="cu-summary">
        <div><small>Total Customers</small><strong>{summary ? summary.total : '—'}</strong></div>
        <div><small>CollectorsHub Members</small><strong>{summary ? summary.members : '—'}</strong></div>
        <div><small>Outstanding Store Credit</small><strong>{summary ? money.format(Number(summary.outstanding_credit || 0)) : '—'}</strong></div>
        <div><small>New This Month</small><strong>{summary ? summary.new_this_month : '—'}</strong></div>
      </div>

      <div className="cu-tools">
        <label className="cu-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, username, customer ID, membership ID, email or phone" /></label>
        <label className="cu-sort"><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value)}>{SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <div className="cs-tabs small">{FILTERS.map(([value, label]) => <button type="button" key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>
      </div>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}

      <div className="cu-body">
        <div className="cu-directory">
          {rows === null ? <p className="cs-muted">Loading…</p> : !rows.length ? (
            <div className="cs-empty">
              <Users size={30} />
              <strong>{search || filter !== 'all' ? 'No customers match' : 'No customers yet'}</strong>
              <span>{filter === 'wishlist' ? 'No customers sharing their wishlist have matches in your stock right now.' : 'Customers added by your store appear here. CollectorsHub members appear after their first completed transaction at this store.'}</span>
              {!search && filter === 'all' ? <button type="button" className="gold-button" onClick={() => setModal('add')}><Plus size={15} /> Add Customer</button> : null}
            </div>
          ) : (
            <>
              <table className="cs-table cu-table">
                <thead><tr><th>Customer</th><th>Transactions</th><th>Last transaction</th><th>Wishlist matches</th><th>Store credit</th><th>Status</th></tr></thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className={`cs-clickable ${row.id === selectedId ? 'selected' : ''}`} onClick={() => setSelectedId(row.id)} onDoubleClick={() => openProfile(row.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') openProfile(row.id) }}>
                      <td><span className="cu-name"><CustomerAvatar row={row} /><span><strong>{row.name}</strong><small>{row.username ? `@${row.username}` : 'Store customer'} · {row.customer_number}</small></span></span></td>
                      <td>{row.transactions}</td>
                      <td>{day(row.last_purchase)}</td>
                      <td><MatchIndicator row={row} onOpen={() => openProfile(row.id, 'wishlist')} /></td>
                      <td>{Number(row.balance || 0) ? money.format(Number(row.balance)) : <span className="cs-muted">—</span>}</td>
                      <td>{row.status === 'active' ? 'Active' : <span className="cs-pill cancelled">Inactive</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="cu-pager">
                <span>{page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total}</span>
                <button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)} aria-label="Previous page"><ChevronLeft size={15} /></button>
                <button type="button" disabled={(page + 1) * PAGE >= total} onClick={() => setPage((value) => value + 1)} aria-label="Next page"><ChevronRight size={15} /></button>
              </div>
            </>
          )}
        </div>

        <aside className="cu-panel">
          {selected ? (
            <>
              <div className="cu-panel-head"><CustomerAvatar row={selected} size={56} /><div><strong>{selected.name}</strong>{selected.username ? <small>@{selected.username}</small> : null}<small>{selected.customer_number}</small></div></div>
              <dl className="cs-facts">
                <dt>Type</dt><dd>{selected.is_member ? 'CollectorsHub member' : 'Store customer'}</dd>
                <dt>Status</dt><dd>{selected.status === 'active' ? 'Active' : 'Inactive'}</dd>
                <dt>Store credit</dt><dd>{money.format(Number(selected.balance || 0))}</dd>
                <dt>Last transaction</dt><dd>{day(selected.last_purchase)}</dd>
                <dt>Transactions</dt><dd>{selected.transactions}</dd>
                {selected.is_member ? <><dt>Wishlist</dt><dd><MatchIndicator row={selected} onOpen={() => openProfile(selected.id, 'wishlist')} /></dd></> : null}
                {selected.email ? <><dt>Email</dt><dd>{selected.email}</dd></> : null}
                {selected.phone ? <><dt>Phone</dt><dd>{selected.phone}</dd></> : null}
              </dl>
              <button type="button" className="gold-button" onClick={() => openProfile(selected.id)}>Open full profile</button>
            </>
          ) : <div className="cs-empty small"><UserRound size={22} /><strong>Select a customer</strong><span>Their details show here.</span></div>}
        </aside>
      </div>

      {modal === 'add' ? <AddCustomerDialog storeId={storeId} onCancel={() => setModal('')} onCreated={(id) => { setModal(''); refresh(); setSelectedId(id); openProfile(id) }} /> : null}
      {modal === 'duplicates' ? <DuplicatesDialog storeId={storeId} onClose={() => { setModal(''); refresh() }} /> : null}
    </section>
  )
}

// Add a store customer, or start linking a CollectorsHub member.
function AddCustomerDialog({ storeId, onCancel, onCreated }) {
  const [type, setType] = useState('store')
  const [form, setForm] = useState({ first_name: '', last_name: '', display_name: '', email: '', phone: '', address: '', notes: '' })
  const [duplicates, setDuplicates] = useState(null)
  const [member, setMember] = useState(null)
  const [linkFor, setLinkFor] = useState(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const ready = (form.first_name.trim() || form.last_name.trim() || form.display_name.trim()).length > 0

  async function save(force = false) {
    setBusy(true)
    setProblem('')
    try {
      const data = type === 'member'
        ? { display_name: member.name, first_name: form.first_name, last_name: form.last_name, email: form.email, phone: form.phone }
        : form
      const result = await createCustomer(storeId, data, force)
      if (result?.duplicates) { setDuplicates(result.duplicates); return }
      if (type === 'member') setLinkFor({ id: result.id, member })
      else onCreated(result.id)
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  if (linkFor) return <LinkAccountDialog storeId={storeId} customerId={linkFor.id} preselected={linkFor.member} onClose={() => onCreated(linkFor.id)} />
  return (
    <div className="register-modal cu-modal" role="dialog" aria-modal="true" aria-labelledby="cu-add-title">
      <section>
        <button className="modal-close" type="button" onClick={onCancel} aria-label="Close"><X size={18} /></button>
        <h2 id="cu-add-title">Add Customer</h2>
        <div className="cs-tabs small">
          <button type="button" className={type === 'store' ? 'active' : ''} onClick={() => setType('store')}>Store Customer</button>
          <button type="button" className={type === 'member' ? 'active' : ''} onClick={() => setType('member')}>CollectorsHub Member</button>
        </div>
        <p className="cs-muted">{type === 'store' ? 'A customer record for this store only. No CollectorsHub account needed. Collect only what you need.' : 'Find their account. They confirm the link on their own CollectorsHub account before it\'s connected.'}</p>
        {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
        {type === 'member' && !member ? <CollectorPicker storeId={storeId} onPick={setMember} /> : null}
        {type === 'member' && member ? <p className="cu-picked"><strong>{member.name}</strong> @{member.username} <button type="button" onClick={() => setMember(null)}>Change</button></p> : null}
        {type === 'store' || member ? (
          <div className="cs-form-grid">
            <label><span>First name</span><input value={form.first_name} onChange={set('first_name')} autoFocus={type === 'store'} /></label>
            <label><span>Last name</span><input value={form.last_name} onChange={set('last_name')} /></label>
            {type === 'store' ? <label><span>Display name (optional)</span><input value={form.display_name} onChange={set('display_name')} /></label> : <span />}
            <label><span>Email (optional)</span><input type="email" value={form.email} onChange={set('email')} /></label>
            <label><span>Phone (optional)</span><input type="tel" value={form.phone} onChange={set('phone')} /></label>
            {type === 'store' ? <label className="wide"><span>Address (optional)</span><input value={form.address} onChange={set('address')} /></label> : null}
            {type === 'store' ? <label className="wide"><span>Note (optional, internal)</span><textarea rows={2} value={form.notes} onChange={set('notes')} /></label> : null}
          </div>
        ) : null}
        {duplicates ? (
          <div className="cu-dupes">
            <strong><AlertTriangle size={14} /> This might already be a customer:</strong>
            <ul>{duplicates.map((dupe) => <li key={dupe.id}>{dupe.name || 'Customer'} · {dupe.customer_number}{dupe.email ? ` · ${dupe.email}` : ''}{dupe.phone ? ` · ${dupe.phone}` : ''}</li>)}</ul>
            <div className="cs-actions left"><button type="button" onClick={() => onCreated(duplicates[0].id)}>Open the existing customer</button><button type="button" onClick={() => save(true)} disabled={busy}>Create anyway</button></div>
          </div>
        ) : null}
        <div className="cs-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="gold-button" disabled={busy || (type === 'member' ? !member : !ready)} onClick={() => save(false)}>{busy ? 'Saving…' : type === 'member' ? 'Create and request link' : 'Create customer'}</button>
        </div>
      </section>
    </div>
  )
}

// Managers: review possible duplicates and merge (audited; nothing is deleted).
function DuplicatesDialog({ storeId, onClose }) {
  const [groups, setGroups] = useState(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  async function load() { try { setGroups(await customerDuplicates(storeId)) } catch (error) { setProblem(error?.message || String(error)); setGroups([]) } }
  useEffect(() => { load() }, [storeId])
  async function merge(keep, other) {
    const reason = window.prompt(`Merge ${other.name || other.customer_number} into ${keep.name || keep.customer_number}? Their transactions, credit, notes and records move to ${keep.customer_number}. Reason:`)
    if (!reason) return
    setBusy(true)
    setProblem('')
    try { await mergeCustomers(storeId, keep.id, other.id, reason); await load() } catch (error) { setProblem(error?.message || String(error)) } finally { setBusy(false) }
  }
  return (
    <div className="register-modal cu-modal wide" role="dialog" aria-modal="true">
      <section>
        <button className="modal-close" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <h2>Possible duplicates</h2>
        <p className="cs-muted">Customers sharing an email, phone number or full name. Only managers can merge; the merge is recorded and nothing is deleted.</p>
        {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
        {groups === null ? <p className="cs-muted">Checking…</p> : !groups.length ? <div className="cs-empty small"><Users size={22} /><strong>No likely duplicates</strong></div> : groups.map((group) => (
          <div className="cu-dupe-group" key={group.reason + group.key}>
            <strong>{group.reason}</strong>
            {group.customers.map((customer, index) => (
              <div className="cu-dupe-row" key={customer.id}>
                <span>{customer.name || 'Customer'} · {customer.customer_number}{customer.is_member ? ' · member' : ''}{customer.email ? ` · ${customer.email}` : ''}{customer.phone ? ` · ${customer.phone}` : ''} · since {day(customer.created_at)}</span>
                {index > 0 ? <button type="button" disabled={busy} onClick={() => merge(group.customers[0], customer)}>Merge into {group.customers[0].customer_number}</button> : <small className="cs-muted">kept</small>}
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  )
}
