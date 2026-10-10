import React, { useEffect, useState } from 'react'
import { AlertTriangle, ArrowLeft, BarChart3, ChevronLeft, ChevronRight, ExternalLink, FileText, HandCoins, Lock, Plus, Printer, RefreshCw, Search, Settings, ShieldAlert, X } from 'lucide-react'
import {
  COLLATERAL_STATUS, STATE, STORAGE_FIELDS, collateralPhotoUrls, endForfeitureReview, forfeitLoan, newRequestId, pawnDetail, pawnList, pawnReport, pawnSummary,
  payLoan, recordNotice, releaseCollateral, renewLoan, reverseDisbursement, setHold, startForfeitureReview, storageText, transferToInventory, updateStorage, cancelDraft,
} from '../lib/pawnLoans'
import NewPawn, { TermsTable } from './NewPawn'
import { money, printAgreement, printCollateralLabels, printPawnReceipt } from './pawnPrint'

// Pawn & Loans: collateral-backed pawn loans only. Everything is checked on the
// server (feature, permissions, configuration, limits); this screen shows what
// the signed-in employee may do.

const PAGE = 50
const FILTERS = [['all', 'All'], ['active', 'Active'], ['due_soon', 'Due Soon'], ['overdue', 'Overdue'], ['redeemed', 'Redeemed'], ['forfeiture_review', 'Forfeiture Review'], ['forfeited', 'Forfeited'], ['cancelled', 'Cancelled'], ['drafts', 'Drafts']]
const day = (value) => (value ? new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : '—')
const when = (value) => (value ? new Date(value).toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
const Pill = ({ state }) => <span className={`pw-pill ${state}`}>{STATE[state] || state}</span>

export default function PawnView({ session, initialLoanId = '', onOpenCustomer }) {
  const storeId = session?.storeId
  const [summary, setSummary] = useState(null)
  const [data, setData] = useState(null)
  const [problem, setProblem] = useState('')
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [screen, setScreen] = useState(initialLoanId ? { kind: 'loan', id: initialLoanId } : { kind: 'list' })
  const [tick, setTick] = useState(0)
  const refresh = () => setTick((value) => value + 1)
  useEffect(() => { if (storeId) pawnSummary(storeId).then(setSummary).catch((error) => setProblem(error.message)) }, [storeId, tick])
  useEffect(() => {
    if (!storeId) return undefined
    let cancelled = false
    const timer = setTimeout(() => pawnList(storeId, { filter, search: search.trim(), limit: PAGE, offset: page * PAGE })
      .then((result) => { if (!cancelled) { setData(result); setProblem('') } })
      .catch((error) => { if (!cancelled) { setData({ rows: [], total: 0 }); setProblem(error.message) } }), 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [storeId, filter, search, page, tick])
  useEffect(() => { setPage(0) }, [filter, search])

  const back = () => { setScreen({ kind: 'list' }); refresh() }
  if (screen.kind === 'new') return <NewPawn session={session} summary={summary} loanId={screen.loanId} onClose={back} onOpenLoan={(id) => { setScreen({ kind: 'loan', id }); refresh() }} />
  if (screen.kind === 'loan') return <LoanDetail session={session} loanId={screen.id} onBack={back} onOpenCustomer={onOpenCustomer} onContinueDraft={(id) => setScreen({ kind: 'new', loanId: id })} />
  if (screen.kind === 'reports') return <Reports storeId={storeId} onBack={back} />

  const perms = summary?.perms || data?.perms || {}
  const readiness = summary?.readiness || {}
  const rows = data?.rows || []
  const total = Number(data?.total || 0)
  // Scanning a collateral label (its code) opens that loan straight away.
  const scanned = rows.length === 1 && /^PL-\d{4}-\d+-\d+$/i.test(search.trim()) ? rows[0] : null
  return (
    <section className="cu-page pw-page">
      <header className="cu-head">
        <h1>Pawn &amp; Loans</h1>
        <div className="cu-head-actions">
          <button type="button" onClick={() => setFilter('overdue')}><AlertTriangle size={15} /> View Overdue Loans</button>
          <button type="button" disabled={!perms.pawn_reports} onClick={() => setScreen({ kind: 'reports' })}><BarChart3 size={15} /> Reports</button>
          <button type="button" className="gold-button" disabled={!perms.pawn_create} onClick={() => setScreen({ kind: 'new' })}><Plus size={16} /> New Pawn</button>
        </div>
      </header>
      {summary && !readiness.ready ? <p className="cu-notice"><Lock size={15} /> Lending isn't live: {(readiness.reasons || []).join(' ')} Pawn settings are managed by your organization.</p> : null}
      {readiness.test_mode ? <p className="cu-notice"><ShieldAlert size={15} /> Test store: loans here are test loans with test agreements, for trying the system out.</p> : null}
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}

      <div className="cu-summary">
        <div><small>Active Loans</small><strong>{summary ? summary.active : '—'}</strong></div>
        <div><small>Principal Outstanding</small><strong>{summary ? money(summary.principal_outstanding) : '—'}</strong></div>
        <div><small>Due Soon</small><strong>{summary ? summary.due_soon : '—'}</strong><em className="pw-sub">next {summary?.due_soon_days || 7} days</em></div>
        <div className={summary?.overdue ? 'pw-alert' : ''}><small>Overdue</small><strong>{summary ? summary.overdue : '—'}</strong></div>
      </div>

      <div className="tx-ledger">
        <div className="tx-tools">
          <div className="cs-tabs small">{FILTERS.map(([value, label]) => <button type="button" key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>
          <label className="cu-search pw-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Loan number, customer, username, customer ID, item, SKU / catalogue ID, serial, storage, or scan a collateral label" /></label>
          {scanned ? <button type="button" className="gold-button" onClick={() => setScreen({ kind: 'loan', id: scanned.id })}>Open {scanned.loan_number}</button> : null}
        </div>
        {data === null ? <p className="cs-muted tx-pad">Loading…</p> : !rows.length ? (
          <div className="cs-empty tx-empty"><HandCoins size={30} /><strong>{search || filter !== 'all' ? 'No loans match' : 'No pawn loans yet'}</strong><span>Pawn loans and their collateral will appear here.</span></div>
        ) : (
          <>
            <div className="tx-table-wrap">
              <table className="cs-table tx-table">
                <thead><tr><th>Loan</th><th>Customer</th><th>Collateral</th><th className="num">Principal</th><th className="num">Outstanding</th><th>Loan date</th><th>Due date</th><th>Status</th><th>Employee</th><th /></tr></thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="cs-clickable" onClick={() => setScreen({ kind: 'loan', id: row.id })} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') setScreen({ kind: 'loan', id: row.id }) }}>
                      <td><strong>{row.loan_number}</strong>{row.is_test ? <span className="pw-test small">TEST</span> : null}{row.legal_hold ? <span className="pw-hold">Hold</span> : null}</td>
                      <td>{row.customer ? <span className="tx-customer"><strong>{row.customer}</strong>{row.username ? <small>@{row.username}</small> : null}</span> : '—'}</td>
                      <td>{row.collateral?.count ? `${row.collateral.first}${row.collateral.count > 1 ? ` +${row.collateral.count - 1} more` : ''}` : '—'}</td>
                      <td className="num">{money(row.principal)}</td>
                      <td className="num"><strong>{['active', 'due_soon', 'overdue', 'forfeiture_review'].includes(row.state) ? money(row.balance) : '—'}</strong></td>
                      <td>{day(row.issue_date)}</td>
                      <td>{day(row.due_date)}{row.days_overdue ? <small className="pw-overdue"> {row.days_overdue} days overdue</small> : null}</td>
                      <td><Pill state={row.state} /></td>
                      <td>{row.employee || '—'}</td>
                      <td className="tx-row-action"><button type="button" onClick={(event) => { event.stopPropagation(); setScreen({ kind: 'loan', id: row.id }) }}>Open</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cu-pager">
              <span>{page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total}</span>
              <button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)} aria-label="Previous page"><ChevronLeft size={15} /></button>
              <button type="button" disabled={(page + 1) * PAGE >= total} onClick={() => setPage((value) => value + 1)} aria-label="Next page"><ChevronRight size={15} /></button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

// ── Loan workspace ───────────────────────────────────────────────────────────
const TABS = [['overview', 'Overview'], ['collateral', 'Collateral'], ['payments', 'Payments'], ['agreement', 'Agreement'], ['history', 'History']]

function LoanDetail({ session, loanId, onBack, onOpenCustomer, onContinueDraft }) {
  const storeId = session?.storeId
  const [detail, setDetail] = useState(null)
  const [tab, setTab] = useState('overview')
  const [modal, setModal] = useState('')
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  async function load() { try { setDetail(await pawnDetail(storeId, loanId)); setProblem('') } catch (error) { setProblem(error.message) } }
  useEffect(() => { load() }, [loanId])
  if (!detail) return <section className="cu-page pw-page"><button type="button" className="cs-back" onClick={onBack}><ArrowLeft size={15} /> Pawn &amp; Loans</button>{problem ? <p className="cs-error">{problem}</p> : <p className="cs-muted">Loading…</p>}</section>
  const { loan, balance, perms, customer } = detail
  const open = ['active', 'forfeiture_review'].includes(loan.status)
  const done = (message) => { setModal(''); setNotice(message); load() }
  const offline = typeof navigator !== 'undefined' && !navigator.onLine
  const awaitingRelease = detail.collateral.some((item) => item.status === 'reserved_for_redemption')
  const acquired = detail.collateral.filter((item) => item.status === 'lawfully_acquired')
  return (
    <section className="cu-page pw-page">
      <button type="button" className="cs-back" onClick={onBack}><ArrowLeft size={15} /> Pawn &amp; Loans</button>
      <div className="tx-detail-head">
        <div>
          <h1>{loan.loan_number}</h1>
          <p><Pill state={loan.state} />{loan.is_test ? <span className="pw-test small">TEST LOAN</span> : null}{loan.legal_hold ? <span className="pw-hold">On hold: {loan.hold_reason}</span> : null}<span className="cs-muted">{customer?.name || ''}</span></p>
        </div>
        <div className="cu-head-actions pw-actions">
          {['draft', 'approved'].includes(loan.status) ? <button type="button" className="gold-button" disabled={!perms.pawn_create} onClick={() => onContinueDraft(loan.id)}>Continue draft</button> : null}
          {['draft', 'approved'].includes(loan.status) ? <button type="button" disabled={!perms.pawn_create} onClick={() => setModal('cancel')}>Cancel draft</button> : null}
          {open ? <button type="button" className="gold-button" disabled={!perms.pawn_payments || offline} onClick={() => setModal('pay')}><HandCoins size={15} /> Take payment</button> : null}
          {loan.status === 'active' ? <button type="button" disabled={!perms.pawn_renew || offline || loan.legal_hold} onClick={() => setModal('renew')}><RefreshCw size={15} /> Renew</button> : null}
          {awaitingRelease ? <button type="button" className="gold-button" disabled={!perms.pawn_release} onClick={() => setModal('release')}>Release collateral</button> : null}
          {loan.status === 'active' && loan.state === 'overdue' ? <button type="button" disabled={!perms.pawn_overdue || loan.legal_hold} onClick={() => setModal('review')}>Start forfeiture review</button> : null}
          {loan.status === 'forfeiture_review' ? <button type="button" disabled={!perms.pawn_forfeit || loan.legal_hold} onClick={() => setModal('forfeit')}>Authorise forfeiture</button> : null}
          {loan.status === 'forfeiture_review' ? <button type="button" disabled={!perms.pawn_overdue} onClick={() => setModal('endreview')}>End review</button> : null}
          {open ? <button type="button" disabled={!perms.pawn_overdue} onClick={() => setModal('notice')}>Record notice</button> : null}
          {open ? <button type="button" disabled={!perms.pawn_overdue} onClick={() => setModal('hold')}>{loan.legal_hold ? 'Remove hold' : 'Place hold'}</button> : null}
          {loan.status === 'active' && loan.issue_date === detail.today && !detail.ledger.some((g) => ['payment', 'renewal'].includes(g.entry_type)) ? <button type="button" disabled={!perms.pawn_disburse} onClick={() => setModal('reverse')}>Reverse disbursement</button> : null}
          <button type="button" onClick={() => printCollateralLabels(loan, detail.collateral)}><Printer size={15} /> Labels</button>
        </div>
      </div>
      {notice ? <p className="cu-notice">{notice}</p> : null}
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      {offline ? <p className="cu-notice"><AlertTriangle size={15} /> Offline: payments, renewals and other money operations are paused until the connection is back.</p> : null}

      <div className="cs-tabs cu-tabs">{TABS.map(([value, label]) => <button type="button" key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>)}</div>
      {tab === 'overview' ? (
        <div className="tx-detail-grid">
          <div className="tx-card">
            <h3>Loan</h3>
            <dl className="cs-facts">
              <dt>Loan number</dt><dd>{loan.loan_number}</dd>
              <dt>Status</dt><dd>{STATE[loan.state]}</dd>
              <dt>Principal</dt><dd>{money(loan.principal)}</dd>
              <dt>Outstanding principal</dt><dd>{money(balance.principal_outstanding)}</dd>
              <dt>Permitted charges owing</dt><dd>{money(balance.charges_unpaid)}</dd>
              <dt>To redeem today</dt><dd><strong>{open ? money(balance.redemption_amount) : '—'}</strong></dd>
              <dt>Loan date</dt><dd>{day(loan.issue_date)}</dd>
              <dt>Due date</dt><dd>{day(loan.due_date)}{loan.days_overdue ? ` (${loan.days_overdue} days overdue)` : ''}</dd>
              {loan.earliest_forfeiture ? <><dt>Earliest forfeiture</dt><dd>{day(loan.earliest_forfeiture)} (configuration)</dd></> : null}
              <dt>Renewals</dt><dd>{loan.renewals}</dd>
              <dt>Employee</dt><dd>{loan.employee || '—'}{loan.approved_by ? ` · approved by ${loan.approved_by}` : ''}</dd>
              {loan.disbursement_method ? <><dt>Paid out</dt><dd>{loan.disbursement_method}{loan.disbursement_reference ? ` · ${loan.disbursement_reference}` : ''} · {when(loan.disbursed_at)}</dd></> : null}
            </dl>
          </div>
          <div className="tx-card">
            <h3>Customer</h3>
            {customer ? (
              <>
                <dl className="cs-facts">
                  <dt>Name</dt><dd>{customer.name}</dd>
                  {customer.username ? <><dt>Username</dt><dd>@{customer.username}</dd></> : null}
                  <dt>Customer ID</dt><dd>{customer.customer_number || '—'}</dd>
                  {customer.phone ? <><dt>Phone</dt><dd>{customer.phone}</dd></> : null}
                  {detail.borrower?.id_type ? <><dt>ID checked</dt><dd>{String(detail.borrower.id_type).replaceAll('_', ' ')}{detail.borrower.checked_at ? ` · ${when(detail.borrower.checked_at)}` : ''}</dd></> : null}
                </dl>
                {onOpenCustomer ? <button type="button" className="tx-link" onClick={() => onOpenCustomer(customer.id)}><ExternalLink size={13} /> Open customer profile</button> : null}
              </>
            ) : <p className="cs-muted">—</p>}
            <h4>Collateral</h4>
            <ul className="tx-mini-list">{detail.collateral.map((item) => <li key={item.id}><span>{item.collateral_code} · {item.name}</span><strong>{COLLATERAL_STATUS[item.status]}</strong></li>)}</ul>
            {detail.notices.length ? <><h4>Notices</h4><ul className="tx-mini-list">{detail.notices.map((n) => <li key={n.id}><span>{n.kind.replaceAll('_', ' ')} · {n.method} · {n.delivery}</span><strong>{day(n.sent_at)}</strong></li>)}</ul></> : null}
          </div>
        </div>
      ) : null}
      {tab === 'collateral' ? <CollateralTab storeId={storeId} detail={detail} onChanged={load} perms={perms} acquired={acquired} session={session} /> : null}
      {tab === 'payments' ? <PaymentsTab detail={detail} /> : null}
      {tab === 'agreement' ? <AgreementTab detail={detail} /> : null}
      {tab === 'history' ? (
        <div className="tx-card"><h3>History</h3><ul className="tx-audit pw-history">{detail.events.map((event, index) => <li key={index}><span>{when(event.created_at)}</span><strong>{event.action.replaceAll('_', ' ')}{event.collateral ? ` · ${event.collateral}` : ''}</strong><span>{event.employee || ''}{event.reason ? ` · ${event.reason}` : ''}</span></li>)}</ul></div>
      ) : null}

      {modal === 'pay' ? <PayDialog storeId={storeId} detail={detail} onCancel={() => setModal('')} onDone={(result) => { done(result.redeemed ? `Loan redeemed: ${money(result.amount)} received. Release the collateral to the customer.` : `Payment of ${money(result.amount)} recorded (charges ${money(result.charges)}, principal ${money(result.principal)}).`); printPawnReceipt({ title: result.redeemed ? 'Pawn redemption receipt' : 'Pawn payment receipt', loan: { ...loan, status: result.redeemed ? 'redeemed' : loan.status }, customer, store: session?.storeName, lines: [['Amount paid', money(result.amount)], ['Towards charges', money(result.charges)], ['Towards principal', money(result.principal)], ['Principal still owing', money(result.principal_outstanding)]] }) }} /> : null}
      {modal === 'renew' ? <RenewDialog storeId={storeId} detail={detail} onCancel={() => setModal('')} onDone={(result) => done(`Renewed: new due date ${day(result.due_date)}${result.charges_paid ? `, charges paid ${money(result.charges_paid)}` : ''}.`)} /> : null}
      {modal === 'release' ? <ReasonDialog title="Release collateral to the customer" note="The redeemed items are handed back. Record who collected them." fields={[['recipient', 'Collected by (name)'], ['reason', 'Note (optional)', true]]} onCancel={() => setModal('')} onSubmit={(values) => releaseCollateral(storeId, loan.id, values.recipient, values.reason).then(() => done('Collateral released to the customer.'))} /> : null}
      {modal === 'review' ? <ReasonDialog title="Start forfeiture review" note="This doesn't transfer ownership. It marks the loan for an authorised review of the legal requirements." fields={[['reason', 'Reason']]} onCancel={() => setModal('')} onSubmit={(values) => startForfeitureReview(storeId, loan.id, values.reason).then(() => done('Loan moved to forfeiture review.'))} /> : null}
      {modal === 'endreview' ? <ReasonDialog title="End forfeiture review" note="The loan goes back to active (e.g. the customer is paying, or there's a dispute)." fields={[['reason', 'Reason']]} onCancel={() => setModal('')} onSubmit={(values) => endForfeitureReview(storeId, loan.id, values.reason).then(() => done('Forfeiture review ended.'))} /> : null}
      {modal === 'forfeit' ? <ForfeitDialog storeId={storeId} detail={detail} onCancel={() => setModal('')} onDone={() => done('Forfeiture authorised. The collateral is lawfully acquired and can be moved to inventory.')} /> : null}
      {modal === 'hold' ? <ReasonDialog title={loan.legal_hold ? 'Remove hold' : 'Place a legal hold or dispute'} note={loan.legal_hold ? '' : 'A hold blocks renewals, release, forfeiture and transfer until it is removed.'} fields={[['reason', 'Reason']]} onCancel={() => setModal('')} onSubmit={(values) => setHold(storeId, loan.id, !loan.legal_hold, values.reason).then(() => done(loan.legal_hold ? 'Hold removed.' : 'Hold placed.'))} /> : null}
      {modal === 'notice' ? <NoticeDialog onCancel={() => setModal('')} onSubmit={(values) => recordNotice(storeId, loan.id, values).then(() => done('Notice recorded.'))} /> : null}
      {modal === 'reverse' ? <ReasonDialog title="Reverse disbursement" note="Only for a loan issued in error today with nothing paid. The money comes back and the loan is cancelled; the collateral goes back to the customer." fields={[['reason', 'Reason']]} onCancel={() => setModal('')} onSubmit={(values) => reverseDisbursement(storeId, loan.id, newRequestId(), values.reason).then(() => done('Disbursement reversed and loan cancelled.'))} /> : null}
      {modal === 'cancel' ? <ReasonDialog title="Cancel draft" note="Nothing was paid out. The draft stays in the records as cancelled." fields={[['reason', 'Reason']]} onCancel={() => setModal('')} onSubmit={(values) => cancelDraft(storeId, loan.id, values.reason).then(() => done('Draft cancelled.'))} /> : null}
    </section>
  )
}

function CollateralTab({ storeId, detail, onChanged, perms, acquired, session }) {
  const [urls, setUrls] = useState({})
  const [editing, setEditing] = useState(null)
  const [transfer, setTransfer] = useState(null)
  const [problem, setProblem] = useState('')
  useEffect(() => { collateralPhotoUrls(detail.collateral.flatMap((item) => item.photos || [])).then(setUrls).catch(() => {}) }, [detail])
  return (
    <div className="pw-collateral">
      {problem ? <p className="cs-error">{problem}</p> : null}
      {detail.collateral.map((item) => (
        <div className="tx-card" key={item.id}>
          <div className="pw-item-head"><h3>{item.collateral_code} · {item.name}</h3><span className={`pw-cstatus ${item.status}`}>{COLLATERAL_STATUS[item.status]}</span></div>
          <div className="pw-photos">{(item.photos || []).map((path) => (urls[path] ? <a key={path} href={urls[path]} target="_blank" rel="noreferrer"><img src={urls[path]} alt="" /></a> : null))}{!(item.photos || []).length ? <span className="cs-muted">No photos</span> : null}</div>
          <dl className="cs-facts">
            {[['Category', item.category], ['Brand', item.brand], ['Model', item.model], ['Serial number', item.serial_number], ['Condition', item.condition], ['Quantity', item.quantity], ['Description', item.description],
              ['Catalogue ID', item.catalog_item_id], ['Estimated value', item.estimated_value != null ? `${money(item.estimated_value)} · ${item.valuation_source || 'source not recorded'}${item.valuation_date ? ` · ${day(item.valuation_date)}` : ''}` : null],
              ['Loan value', money(item.allocated_loan_value)], ['Storage', storageText(item.storage) || 'Not set'], ['Inventory record', item.inventory_id ? `SKU PWN-${item.collateral_code}` : null]]
              .filter(([, value]) => value != null && value !== '').map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}
          </dl>
          <div className="cs-actions left">
            {!['released', 'transferred_to_inventory'].includes(item.status) ? <button type="button" disabled={!perms.pawn_create} onClick={() => setEditing({ id: item.id, storage: { ...item.storage }, reason: '' })}>Change storage</button> : null}
            {item.status === 'lawfully_acquired' ? <button type="button" className="gold-button" disabled={!perms.pawn_transfer || detail.loan.is_test} title={detail.loan.is_test ? 'Test loan items can’t go into inventory' : ''} onClick={() => setTransfer({ id: item.id, name: item.name, price: '' })}>Transfer to inventory</button> : null}
          </div>
        </div>
      ))}
      {acquired.length ? <p className="cs-muted">Transferred items go into Inventory at this location, not listed online. List them yourself when ready.</p> : null}
      {editing ? (
        <div className="register-modal cu-modal" role="dialog" aria-modal="true"><section>
          <button className="modal-close" type="button" onClick={() => setEditing(null)} aria-label="Close"><X size={18} /></button>
          <h2>Change storage</h2>
          <div className="pw-storage">{STORAGE_FIELDS.map(([key, label]) => <label key={key}><span>{label}</span><input value={editing.storage[key] || ''} onChange={(event) => setEditing({ ...editing, storage: { ...editing.storage, [key]: event.target.value } })} /></label>)}</div>
          <label className="tx-field"><span>Reason</span><input value={editing.reason} onChange={(event) => setEditing({ ...editing, reason: event.target.value })} /></label>
          <div className="cs-actions"><button type="button" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="gold-button" onClick={async () => { try { await updateStorage(storeId, editing.id, editing.storage, editing.reason); setEditing(null); onChanged() } catch (error) { setProblem(error.message) } }}>Save</button></div>
        </section></div>
      ) : null}
      {transfer ? (
        <div className="register-modal cu-modal" role="dialog" aria-modal="true"><section>
          <button className="modal-close" type="button" onClick={() => setTransfer(null)} aria-label="Close"><X size={18} /></button>
          <h2>Transfer to inventory</h2>
          <p className="cs-muted">{transfer.name} becomes a store inventory item (SKU PWN-…), linked to this loan. It isn't listed online.</p>
          <label className="tx-field"><span>Retail price</span><input inputMode="decimal" value={transfer.price} onChange={(event) => setTransfer({ ...transfer, price: event.target.value })} /></label>
          <div className="cs-actions"><button type="button" onClick={() => setTransfer(null)}>Cancel</button><button type="button" className="gold-button" disabled={!(Number(transfer.price) > 0)} onClick={async () => { try { await transferToInventory(storeId, transfer.id, session?.locationId, Number(transfer.price)); setTransfer(null); onChanged() } catch (error) { setProblem(error.message) } }}>Transfer</button></div>
        </section></div>
      ) : null}
    </div>
  )
}

const ENTRY = { disbursement: 'Loan paid out', fee_assessed: 'Charges at issue', charges_accrued: 'Interest accrued', payment: 'Payment', renewal: 'Renewal', reversal: 'Disbursement reversed', forfeiture: 'Closed by forfeiture', correction: 'Correction' }
function PaymentsTab({ detail }) {
  return (
    <div className="tx-card">
      <h3>Payments and ledger</h3>
      <table className="cs-table tx-items">
        <thead><tr><th>Date</th><th>Entry</th><th className="num">Cash</th><th className="num">Principal</th><th className="num">Charges</th><th className="num">Principal after</th><th className="num">Charges after</th><th>Method</th><th>Transaction</th><th>Employee</th></tr></thead>
        <tbody>{detail.ledger.map((row) => (
          <tr key={row.id}><td>{when(row.created_at)}</td><td>{ENTRY[row.entry_type] || row.entry_type}{row.note ? <small className="tx-sku">{row.note}</small> : null}</td>
            <td className={`num ${Number(row.amount) < 0 ? 'tx-neg' : ''}`}>{Number(row.amount) ? money(row.amount) : '—'}</td><td className="num">{Number(row.principal_part) ? money(row.principal_part) : '—'}</td><td className="num">{Number(row.charges_part) ? money(row.charges_part) : '—'}</td>
            <td className="num">{row.principal_after != null ? money(row.principal_after) : '—'}</td><td className="num">{row.charges_after != null ? money(row.charges_after) : '—'}</td><td>{row.method || '—'}</td><td>{row.transaction_number || '—'}</td><td>{row.employee || '—'}</td></tr>
        ))}</tbody>
      </table>
      <p className="cs-muted">The ledger only ever adds entries; nothing is overwritten. Payments go to charges first, then principal.</p>
    </div>
  )
}

function AgreementTab({ detail }) {
  const [open, setOpen] = useState(detail.agreements[0]?.id || '')
  const doc = detail.agreements.find((a) => a.id === open)
  return (
    <div className="tx-card">
      <h3>Agreements</h3>
      {!detail.agreements.length ? <p className="cs-muted">No agreement signed yet.</p> : (
        <>
          <div className="cs-tabs small">{detail.agreements.map((a) => <button type="button" key={a.id} className={open === a.id ? 'active' : ''} onClick={() => setOpen(a.id)}>{a.kind === 'original' ? 'Original' : `${a.kind[0].toUpperCase()}${a.kind.slice(1)}`} · {day(a.created_at)}</button>)}</div>
          {doc ? (
            <>
              <p className="cs-muted">Signed {doc.signature_method === 'electronic' ? `electronically by ${doc.customer_signature}` : 'on paper'} · {when(doc.created_at)} · recorded by {doc.employee || '—'} · SHA-256 {doc.sha256.slice(0, 16)}…</p>
              <div className="pw-agreement" dangerouslySetInnerHTML={{ __html: doc.document_html }} />
              <div className="cs-actions left"><button type="button" onClick={() => printAgreement(doc.document_html, { title: `Agreement ${detail.loan.loan_number}`, sha256: doc.sha256, signature: doc.signature_method === 'electronic' ? doc.customer_signature : '', signedAt: doc.created_at })}><Printer size={15} /> Print executed copy</button></div>
            </>
          ) : null}
        </>
      )}
      {detail.loan.terms ? <><h4>Terms</h4><TermsTable terms={detail.loan.terms} /></> : null}
    </div>
  )
}

function PayDialog({ storeId, detail, onCancel, onDone }) {
  const { balance, loan } = detail
  const partial = Boolean(loan.terms?.partial_payments_allowed)
  const [requestId] = useState(newRequestId)
  const [kind, setKind] = useState('redeem')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('cash')
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const value = kind === 'redeem' ? Number(balance.redemption_amount) : kind === 'charges' ? Number(balance.charges_unpaid) : Number(amount || 0)
  const charges = Math.min(value, Number(balance.charges_unpaid))
  async function submit() {
    setBusy(true); setProblem('')
    try { onDone(await payLoan(storeId, loan.id, requestId, kind === 'redeem' ? null : value, method, reference)) } catch (error) { setProblem(error.message) } finally { setBusy(false) }
  }
  return (
    <div className="register-modal cu-modal" role="dialog" aria-modal="true"><section>
      <button className="modal-close" type="button" onClick={onCancel} aria-label="Close"><X size={18} /></button>
      <h2>Take payment · {loan.loan_number}</h2>
      <ul className="tx-mini-list"><li><span>Principal owing</span><strong>{money(balance.principal_outstanding)}</strong></li><li><span>Charges owing (to today)</span><strong>{money(balance.charges_unpaid)}</strong></li><li className="tx-total"><span>To redeem today</span><strong>{money(balance.redemption_amount)}</strong></li></ul>
      <div className="cs-tabs small">
        <button type="button" className={kind === 'redeem' ? 'active' : ''} onClick={() => setKind('redeem')}>Redeem in full</button>
        <button type="button" className={kind === 'charges' ? 'active' : ''} disabled={!Number(balance.charges_unpaid)} onClick={() => setKind('charges')}>Charges only</button>
        <button type="button" className={kind === 'partial' ? 'active' : ''} disabled={!partial} title={partial ? '' : 'Not allowed under this agreement'} onClick={() => setKind('partial')}>Partial payment</button>
      </div>
      <div className="cs-form-grid">
        {kind === 'partial' ? <label><span>Amount</span><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus /></label> : null}
        <label><span>Paid by</span><select value={method} onChange={(event) => setMethod(event.target.value)}><option value="cash">Cash (register)</option><option value="debit">Debit</option><option value="credit">Credit card</option><option value="e_transfer">E-transfer</option><option value="other">Other</option></select></label>
        {method !== 'cash' ? <label><span>Reference / approval code</span><input value={reference} onChange={(event) => setReference(event.target.value)} /></label> : null}
      </div>
      <p className="cs-muted">Goes to charges first ({money(charges)}), then principal ({money(Math.max(value - charges, 0))}). Card payments are taken on the terminal first; record them here once approved.</p>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      <div className="cs-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="gold-button" disabled={busy || !(value > 0)} onClick={submit}>{busy ? 'Recording…' : `Record ${money(value)}`}</button></div>
    </section></div>
  )
}

function RenewDialog({ storeId, detail, onCancel, onDone }) {
  const { loan, balance, config_rules: rules = {} } = detail
  const [requestId] = useState(newRequestId)
  const [termDays, setTermDays] = useState(rules?.term_days_default || loan.term_days || '')
  const [method, setMethod] = useState('cash')
  const [reference, setReference] = useState('')
  const [signatureMethod, setSignatureMethod] = useState(rules?.electronic_signature_allowed ? 'electronic' : 'paper')
  const [signature, setSignature] = useState('')
  const [confirms, setConfirms] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  async function submit() {
    setBusy(true); setProblem('')
    try { onDone(await renewLoan(storeId, loan.id, requestId, { termDays: Number(termDays), method, reference, signatureMethod, signature, confirms })) } catch (error) { setProblem(error.message) } finally { setBusy(false) }
  }
  return (
    <div className="register-modal cu-modal" role="dialog" aria-modal="true"><section>
      <button className="modal-close" type="button" onClick={onCancel} aria-label="Close"><X size={18} /></button>
      <h2>Renew {loan.loan_number}</h2>
      {!rules?.renewals_allowed ? <p className="cs-error">Renewals aren't allowed under this configuration.</p> : null}
      <p className="cs-muted">The charges owing ({money(balance.charges_unpaid)}) are paid to renew; the principal ({money(balance.principal_outstanding)}) carries on. A renewal agreement is stored; the original stays as it was.</p>
      <div className="cs-form-grid">
        <label><span>New term (days{rules?.term_days_max ? `, up to ${rules.term_days_max}` : ''})</span><input type="number" min="1" value={termDays} onChange={(event) => setTermDays(event.target.value)} /></label>
        {Number(balance.charges_unpaid) > 0 ? <label><span>Charges paid by</span><select value={method} onChange={(event) => setMethod(event.target.value)}><option value="cash">Cash (register)</option><option value="debit">Debit</option><option value="credit">Credit card</option><option value="e_transfer">E-transfer</option><option value="other">Other</option></select></label> : null}
        {method !== 'cash' && Number(balance.charges_unpaid) > 0 ? <label><span>Reference</span><input value={reference} onChange={(event) => setReference(event.target.value)} /></label> : null}
        <label><span>Signing</span><select value={signatureMethod} onChange={(event) => setSignatureMethod(event.target.value)}><option value="paper">Printed and signed on paper</option>{rules?.electronic_signature_allowed ? <option value="electronic">Electronic (typed name)</option> : null}</select></label>
        {signatureMethod === 'electronic' ? <label><span>Customer's full name</span><input value={signature} onChange={(event) => setSignature(event.target.value)} /></label> : null}
      </div>
      <label className="tx-check"><input type="checkbox" checked={confirms} onChange={(event) => setConfirms(event.target.checked)} /> The customer reviewed and accepted the renewal terms.</label>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      <div className="cs-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="gold-button" disabled={busy || !confirms || !rules?.renewals_allowed} onClick={submit}>{busy ? 'Renewing…' : 'Renew loan'}</button></div>
    </section></div>
  )
}

function ForfeitDialog({ storeId, detail, onCancel, onDone }) {
  const [values, setValues] = useState({ reason: '', legalBasis: '', documentation: '', confirm: false })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const set = (key) => (event) => setValues({ ...values, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value })
  return (
    <div className="register-modal cu-modal" role="dialog" aria-modal="true"><section>
      <button className="modal-close" type="button" onClick={onCancel} aria-label="Close"><X size={18} /></button>
      <h2>Authorise forfeiture · {detail.loan.loan_number}</h2>
      <p className="cs-muted">Ownership only transfers when every check passes: the configured grace and waiting periods (earliest {day(detail.loan.earliest_forfeiture)}), the required notices, no hold or dispute, and your authorisation. Unpaid principal and charges are written off.</p>
      <div className="cs-form-grid">
        <label className="wide"><span>Reason</span><input value={values.reason} onChange={set('reason')} /></label>
        <label className="wide"><span>Legal basis (statute, section or approved procedure)</span><input value={values.legalBasis} onChange={set('legalBasis')} /></label>
        <label className="wide"><span>Supporting documentation (file reference)</span><input value={values.documentation} onChange={set('documentation')} /></label>
      </div>
      <label className="tx-check"><input type="checkbox" checked={values.confirm} onChange={set('confirm')} /> I checked the legal requirements, the contract and the customer's redemption rights.</label>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      <div className="cs-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="gold-button" disabled={busy || !values.confirm || !values.reason.trim() || !values.legalBasis.trim()} onClick={async () => { setBusy(true); setProblem(''); try { await forfeitLoan(storeId, detail.loan.id, values); onDone() } catch (error) { setProblem(error.message) } finally { setBusy(false) } }}>Authorise forfeiture</button></div>
    </section></div>
  )
}

function NoticeDialog({ onCancel, onSubmit }) {
  const [values, setValues] = useState({ kind: 'overdue_notice', method: 'mail', sentAt: new Date().toISOString().slice(0, 10), delivery: 'sent', note: '' })
  const [problem, setProblem] = useState('')
  const set = (key) => (event) => setValues({ ...values, [key]: event.target.value })
  return (
    <div className="register-modal cu-modal" role="dialog" aria-modal="true"><section>
      <button className="modal-close" type="button" onClick={onCancel} aria-label="Close"><X size={18} /></button>
      <h2>Record a notice</h2>
      <p className="cs-muted">Keep a record of each notice the law requires and how it was delivered (send it through your usual channel).</p>
      <div className="cs-form-grid">
        <label><span>Notice</span><select value={values.kind} onChange={set('kind')}><option value="due_reminder">Due-date reminder</option><option value="overdue_notice">Overdue notice</option><option value="forfeiture_notice">Forfeiture notice</option><option value="other">Other</option></select></label>
        <label><span>Method</span><select value={values.method} onChange={set('method')}><option value="mail">Mail</option><option value="registered_mail">Registered mail</option><option value="email">Email</option><option value="phone">Phone</option><option value="in_person">In person</option><option value="other">Other</option></select></label>
        <label><span>Sent on</span><input type="date" value={values.sentAt} onChange={set('sentAt')} /></label>
        <label><span>Delivery</span><select value={values.delivery} onChange={set('delivery')}><option value="sent">Sent</option><option value="delivered">Delivered / confirmed</option><option value="failed">Failed</option><option value="returned">Returned</option></select></label>
        <label className="wide"><span>Note</span><input value={values.note} onChange={set('note')} placeholder="Tracking number, who was spoken to…" /></label>
      </div>
      {problem ? <p className="cs-error">{problem}</p> : null}
      <div className="cs-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="gold-button" onClick={() => onSubmit({ ...values, sentAt: `${values.sentAt}T12:00:00` }).catch((error) => setProblem(error.message))}>Record</button></div>
    </section></div>
  )
}

function ReasonDialog({ title, note, fields, onCancel, onSubmit }) {
  const [values, setValues] = useState(Object.fromEntries(fields.map(([key]) => [key, ''])))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const ready = fields.every(([key, , optional]) => optional || values[key].trim().length > 1)
  return (
    <div className="register-modal cu-modal" role="dialog" aria-modal="true"><section>
      <button className="modal-close" type="button" onClick={onCancel} aria-label="Close"><X size={18} /></button>
      <h2>{title}</h2>
      {note ? <p className="cs-muted">{note}</p> : null}
      {fields.map(([key, label]) => <label className="tx-field" key={key}><span>{label}</span><input value={values[key]} onChange={(event) => setValues({ ...values, [key]: event.target.value })} /></label>)}
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      <div className="cs-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="gold-button" disabled={busy || !ready} onClick={async () => { setBusy(true); setProblem(''); try { await onSubmit(values) } catch (error) { setProblem(error.message) } finally { setBusy(false) } }}>Confirm</button></div>
    </section></div>
  )
}

// ── Reports ──────────────────────────────────────────────────────────────────
function Reports({ storeId, onBack }) {
  const iso = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10) }
  const [from, setFrom] = useState(iso(-29))
  const [to, setTo] = useState(iso(0))
  const [category, setCategory] = useState('')
  const [data, setData] = useState(null)
  const [problem, setProblem] = useState('')
  useEffect(() => { pawnReport(storeId, { from, to, category }).then(setData).catch((error) => setProblem(error.message)) }, [from, to, category])
  const rows = data ? [
    ['Active loans', data.active_loans], ['Principal outstanding', money(data.principal_outstanding)], ['Overdue loans', data.overdue], ['In forfeiture review', data.forfeiture_reviews],
    ['Loans issued', data.originations], ['Principal disbursed', money(data.disbursed)], ['Cash disbursed', money(data.cash_disbursed)],
    ['Repayments received', money(data.repayments)], ['of which principal', money(data.principal_repaid)], ['of which interest and permitted fees', money(data.charges_income)],
    ['Loans redeemed', data.redeemed], ['Disbursements reversed', money(data.reversals)], ['Loans forfeited', data.forfeited], ['Lawfully acquired items (not yet transferred)', data.lawfully_acquired_items],
    ['Items transferred to inventory', data.transferred_items], ['Collateral held: estimated value', money(data.collateral_estimated_value)], ['Collateral held: loan value', money(data.collateral_loan_value)],
  ] : []
  const reconciled = data ? Math.abs(Number(data.transactions_total) - Number(data.ledger_cash_total)) < 0.005 : true
  return (
    <section className="cu-page pw-page">
      <button type="button" className="cs-back" onClick={onBack}><ArrowLeft size={15} /> Pawn &amp; Loans</button>
      <header className="cu-head"><h1>Pawn reports</h1></header>
      <div className="tx-filter-row">
        <label className="tx-field"><span>From</span><input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
        <label className="tx-field"><span>To</span><input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
        <label className="tx-field"><span>Item category</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All</option>{(data?.categories || []).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      </div>
      {problem ? <p className="cs-error">{problem}</p> : null}
      <div className="tx-card">
        <ul className="tx-mini-list pw-report">{rows.map(([label, value]) => <li key={label}><span>{label}</span><strong>{value}</strong></li>)}</ul>
        {data ? <p className={reconciled ? 'cs-muted' : 'cs-error'}><FileText size={13} /> Reconciliation: pawn ledger cash {money(data.ledger_cash_total)} · pawn transactions {money(data.transactions_total)} {reconciled ? '(match)' : '(DIFFERENT: check the ledger)'}</p> : null}
        <p className="cs-muted">Test loans are excluded. Principal disbursed and repaid isn't sales revenue; interest and permitted fees are shown separately.</p>
      </div>
    </section>
  )
}
