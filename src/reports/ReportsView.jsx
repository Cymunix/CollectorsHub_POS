import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Download, Info, RefreshCw, X } from 'lucide-react'
import {
  RANGES, exportCsv, exportPdf, exportXlsx, logExport, rangeDates, reportAccess, reportAccounting, reportCustomers, reportDetail, reportEmployees,
  reportInventory, reportOverview, reportPawn, reportRegisters, reportSales, reportTax, toIso,
} from '../lib/reports'
import { Columns, Empty, HBars, LineChart } from './charts'

// Reports & Analytics: every figure is calculated on the server from the store's own
// records (supabase/reports.sql, rpt_facts). Tabs and exports follow the employee's
// report permissions, which the server enforces too.

const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })
const fmtMoney = (v, short) => (short && Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k` : money.format(Number(v || 0)))
const fmtNum = (v) => Number(v || 0).toLocaleString('en-CA', { maximumFractionDigits: 2 })
const fmtPct = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`)
const WEEKDAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const METHOD = { cash: 'Cash', card: 'Card', debit: 'Debit', credit: 'Credit card', store_credit: 'Store credit', trade_credit: 'Trade credit', gift_card: 'Gift card', cheque: 'Cheque', e_transfer: 'E-transfer', other: 'Other' }
const MOVEMENT = { receive: 'Inventory added', sale: 'Sold', return: 'Returned', refund: 'Refunded', trade_in: 'Bought / traded in', purchase_from_customer: 'Bought from customers', exchange: 'Exchanged', adjustment: 'Adjusted', correction: 'Corrected', damage: 'Damaged', transfer_in: 'Transferred in', transfer_out: 'Transferred out', void: 'Voided', pawn_forfeiture: 'From lawful pawn forfeiture' }
const TABS = [['sales', 'Sales & Revenue', 'rep_basic'], ['inventory', 'Inventory & Profitability', 'rep_inventory'], ['customers', 'Customers', 'rep_customers'], ['pawn', 'Pawn & Loans', 'rep_pawn'], ['staff', 'Employees & Registers', null], ['tax', 'Tax & Accounting', 'rep_tax']]

export default function ReportsView({ session, online = true, pendingChanges = 0, onOpenTransactions }) {
  const storeId = session?.storeId
  const [access, setAccess] = useState(null)
  const [rangeKey, setRangeKey] = useState('last_30')
  const [custom, setCustom] = useState(() => { const [a, b] = rangeDates('last_30'); return { from: toIso(a), to: toIso(b) } })
  const [locationId, setLocationId] = useState('')
  const [compare, setCompare] = useState('previous')
  const [tab, setTab] = useState('sales')
  const [overview, setOverview] = useState(null)
  const [data, setData] = useState({})
  const [problem, setProblem] = useState('')
  const [tick, setTick] = useState(0)
  const [exporting, setExporting] = useState(false)
  const range = useMemo(() => {
    if (rangeKey === 'custom') return { from: custom.from, to: custom.to, locationId }
    const [a, b] = rangeDates(rangeKey)
    return { from: toIso(a), to: toIso(b), locationId }
  }, [rangeKey, custom, locationId])
  const rangeLabel = `${RANGES.find(([k]) => k === rangeKey)?.[1] || ''} (${range.from} to ${range.to})`

  useEffect(() => { if (storeId) reportAccess(storeId).then(setAccess).catch((error) => setProblem(error.message)) }, [storeId])
  const tabs = TABS.filter(([key, , perm]) => (key === 'pawn' ? access?.rep_pawn && access?.pawn_enabled : key === 'staff' ? access?.rep_employees || access?.rep_registers : access?.[perm]))
  useEffect(() => { if (access && tabs.length && !tabs.some(([key]) => key === tab)) setTab(tabs[0][0]) }, [access])

  useEffect(() => {
    if (!storeId || !access || !online) return
    setProblem('')
    reportOverview(storeId, range, compare).then(setOverview).catch((error) => setProblem(error.message))
  }, [storeId, access, range.from, range.to, range.locationId, compare, tick, online])
  useEffect(() => {
    if (!storeId || !access || !online) return
    let cancelled = false
    const key = `${tab}|${range.from}|${range.to}|${range.locationId}|${tick}`
    setData((current) => ({ ...current, [tab]: current[tab]?.key === key ? current[tab] : { key, loading: true } }))
    const loaders = {
      sales: () => reportSales(storeId, range),
      inventory: () => reportInventory(storeId, range),
      customers: () => reportCustomers(storeId, range),
      pawn: () => reportPawn(storeId, range),
      staff: async () => ({ employees: access.rep_employees ? await reportEmployees(storeId, range) : null, registers: access.rep_registers ? await reportRegisters(storeId, range) : null }),
      tax: async () => ({ tax: await reportTax(storeId, range), accounting: await reportAccounting(storeId, range) }),
    }
    loaders[tab]?.().then((result) => { if (!cancelled) setData((current) => ({ ...current, [tab]: { key, result } })) })
      .catch((error) => { if (!cancelled) setData((current) => ({ ...current, [tab]: { key, error: error.message } })) })
    return () => { cancelled = true }
  }, [storeId, access, tab, range.from, range.to, range.locationId, tick, online])

  const drill = (filters) => onOpenTransactions?.({ from: range.from, to: range.to, ...filters })
  const current = overview?.current
  const prev = overview?.comparison
  const tabState = data[tab] || { loading: true }

  if (!access) return <section className="cu-page rp-page"><header className="rp-head"><div><h1>Reports &amp; Analytics</h1></div></header>{problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : <p className="cs-muted">Loading…</p>}</section>
  return (
    <section className="cu-page rp-page">
      <header className="rp-head">
        <div><h1>Reports &amp; Analytics</h1><p>Monitor sales, inventory, customers and financial performance.</p></div>
        <div className="rp-controls">
          <select value={rangeKey} onChange={(event) => setRangeKey(event.target.value)} aria-label="Date range">{RANGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          {rangeKey === 'custom' ? <><input type="date" value={custom.from} max={custom.to} onChange={(event) => setCustom({ ...custom, from: event.target.value })} aria-label="From" /><input type="date" value={custom.to} min={custom.from} onChange={(event) => setCustom({ ...custom, to: event.target.value })} aria-label="To" /></> : null}
          {access.locations?.length > 1 ? <select value={locationId} onChange={(event) => setLocationId(event.target.value)} aria-label="Store location"><option value="">All locations</option>{access.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select> : null}
          <select value={compare} onChange={(event) => setCompare(event.target.value)} aria-label="Compare with"><option value="previous">vs previous period</option><option value="year">vs same period last year</option></select>
          <button type="button" onClick={() => setTick((v) => v + 1)}><RefreshCw size={15} /> Refresh</button>
          <button type="button" className="gold-button" disabled={!access.rep_export} title={access.rep_export ? '' : "You don't have permission to export reports"} onClick={() => setExporting(true)}><Download size={15} /> Export Report</button>
        </div>
      </header>
      {!online ? <p className="cu-notice"><AlertTriangle size={15} /> Offline. Reports are calculated from the store's records in Supabase, so they can't be shown until the connection is back.</p> : null}
      {online && pendingChanges > 0 ? <p className="cu-notice"><AlertTriangle size={15} /> Waiting for synchronisation: {pendingChanges} local change{pendingChanges === 1 ? '' : 's'} haven't reached Supabase yet. Store-wide totals may be incomplete.</p> : null}
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      {overview?.scope === 'own' ? <p className="cu-notice"><Info size={15} /> These figures cover the transactions you processed. Store-wide figures need the "Store-wide sales" report permission.</p> : null}

      <div className="cu-summary rp-cards">
        <Card label="Net Sales" value={current ? money.format(current.net_sales) : '—'} now={current?.net_sales} before={prev?.net_sales} note="excludes tax; after discounts and refunds" />
        <Card label="Gross Profit" value={current ? money.format(current.gross_profit) : '—'} now={current?.gross_profit} before={prev?.gross_profit}
          note={current && Number(current.missing_cost_lines) > 0 ? `incomplete: ${current.missing_cost_lines} sold line${Number(current.missing_cost_lines) === 1 ? '' : 's'} without a recorded cost` : current?.margin_pct != null ? `${fmtPct(current.margin_pct)} margin` : ''} warn={current && Number(current.missing_cost_lines) > 0} />
        <Card label="Transactions" value={current ? fmtNum(current.sales_count) : '—'} now={current?.sales_count} before={prev?.sales_count} note="completed sales (pawn and buys counted separately)" />
        <Card label="Average Transaction Value" value={current?.avg_sale != null ? money.format(current.avg_sale) : '—'} now={current?.avg_sale} before={prev?.avg_sale} note="net sales ÷ sales" />
      </div>
      {overview ? <p className="rp-compare">{prev ? `Compared with ${overview.comparison_period.from} to ${overview.comparison_period.to} (${compare === 'year' ? 'same period last year' : 'previous period'}).` : `No comparison: there were no completed sales from ${overview.comparison_period.from} to ${overview.comparison_period.to}.`}</p> : null}

      <div className="cs-tabs rp-tabs">{tabs.map(([key, label]) => <button type="button" key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
      {tabState.error ? <p className="cs-error"><AlertTriangle size={14} /> {tabState.error}</p> : tabState.loading || !tabState.result ? <p className="cs-muted">Loading…</p> : (
        <>
          {tab === 'sales' ? <SalesTab d={tabState.result} drill={drill} /> : null}
          {tab === 'inventory' ? <InventoryTab d={tabState.result} /> : null}
          {tab === 'customers' ? <CustomersTab d={tabState.result} /> : null}
          {tab === 'pawn' ? <PawnTab d={tabState.result} /> : null}
          {tab === 'staff' ? <StaffTab d={tabState.result} drill={drill} /> : null}
          {tab === 'tax' ? <TaxTab d={tabState.result} /> : null}
        </>
      )}
      {exporting ? <ExportDialog storeId={storeId} access={access} range={range} rangeLabel={rangeLabel} tab={tab} tabs={tabs} data={data} overview={overview} onClose={() => setExporting(false)} /> : null}
    </section>
  )
}

function Card({ label, value, now, before, note, warn }) {
  const change = before != null && Number(before) !== 0 && now != null ? ((Number(now) - Number(before)) / Math.abs(Number(before))) * 100 : null
  return (
    <div className={warn ? 'rp-card warn' : 'rp-card'}>
      <small>{label}</small>
      <strong>{value}</strong>
      {change != null ? <span className={`rp-change ${change >= 0 ? 'up' : 'down'}`}>{change >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{Math.abs(change).toFixed(1)}%</span> : null}
      {note ? <em>{note}</em> : null}
    </div>
  )
}

const Tiles = ({ items }) => <div className="rp-tiles">{items.filter(Boolean).map(([label, value, note]) => <div key={label}><small>{label}</small><strong>{value}</strong>{note ? <em>{note}</em> : null}</div>)}</div>
const Panel = ({ title, children, wide, note }) => <div className={`tx-card rp-panel${wide ? ' wide' : ''}`}><h3>{title}</h3>{children}{note ? <p className="cs-muted rp-note">{note}</p> : null}</div>
function Table({ columns, rows, empty = 'Nothing for this period.', onRow }) {
  if (!rows?.length) return <p className="cs-muted">{empty}</p>
  return (
    <div className="tx-table-wrap">
      <table className="cs-table rp-table">
        <thead><tr>{columns.map(([key, label, type]) => <th key={key} className={type && type !== 'text' ? 'num' : ''}>{label}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => (
          <tr key={index} className={onRow ? 'cs-clickable' : ''} onClick={onRow ? () => onRow(row) : undefined}>
            {columns.map(([key, , type]) => <td key={key} className={type && type !== 'text' ? 'num' : ''}>{type === 'money' ? (row[key] == null ? '—' : money.format(Number(row[key]))) : type === 'pct' ? fmtPct(row[key]) : type === 'number' ? fmtNum(row[key]) : (row[key] ?? '—')}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

// ── Sales & Revenue ──────────────────────────────────────────────────────────
const PRODUCT_LISTS = [['best_sellers', 'Bestselling'], ['top_revenue', 'Highest revenue'], ['top_profit', 'Highest profit'], ['most_discounted', 'Most discounted'], ['highest_refund_rate', 'Highest refund rate']]
function SalesTab({ d, drill }) {
  const t = d.totals
  const [list, setList] = useState('best_sellers')
  if (!Number(t.sales_count) && !Number(t.refund_count)) return <div className="tx-card"><Empty /></div>
  const productColumns = [['name', 'Product', 'text'], ['sku', 'SKU', 'text'], ['qty', 'Sold', 'number'], ['revenue', 'Revenue', 'money'],
    ...(list === 'top_profit' ? [['profit', 'Profit', 'money']] : []), ...(list === 'most_discounted' ? [['discounted', 'Times discounted', 'number'], ['discount', 'Discount total', 'money']] : []),
    ...(list === 'highest_refund_rate' ? [['refunded_qty', 'Refunded', 'number'], ['refund_rate', 'Refund rate', 'pct']] : [])]
  return (
    <div className="rp-grid">
      <Tiles items={[['Gross Sales', money.format(t.gross_sales)], ['Net Sales', money.format(t.net_sales)], ['Discounts', money.format(t.discounts)], ['Refunds', money.format(t.refunds), `${t.refund_count} refund${Number(t.refund_count) === 1 ? '' : 's'}`],
        ['Sales Tax Collected', money.format(t.tax_collected)], ['Number of Sales', fmtNum(t.sales_count)], ['Items Sold', fmtNum(t.items_sold), 'net of returns'],
        ['Average Transaction', t.avg_sale != null ? money.format(t.avg_sale) : '—'], ['Gross Profit', money.format(t.gross_profit), Number(t.missing_cost_lines) ? 'incomplete: some costs missing' : ''], ['Gross Margin', fmtPct(t.margin_pct)]]} />
      <Panel title={`Net sales by ${d.granularity}`} wide note="Click a point to see that period's transactions."><LineChart rows={d.over_time} format={fmtMoney} axisLabel="Net sales (CAD)" onSelect={(row) => drill(d.granularity === 'day' ? { from: row.bucket, to: row.bucket } : {})} /></Panel>
      <Panel title="Sales by category"><HBars rows={d.by_category} format={fmtMoney} /></Panel>
      <Panel title="Sales by payment method" note="Amounts taken by each method, including refunds paid back (negative)."><HBars rows={(d.by_payment || []).map((r) => ({ ...r, label: METHOD[r.label] || r.label }))} value="amount" format={fmtMoney} /></Panel>
      {d.by_location?.length > 1 ? <Panel title="Sales by store location"><HBars rows={d.by_location} format={fmtMoney} /></Panel> : null}
      {d.by_employee ? <Panel title="Sales by employee" note="Click an employee to see their transactions."><HBars rows={d.by_employee} format={fmtMoney} onSelect={(row) => drill({ employeeId: row.id })} /></Panel> : null}
      <Panel title="Sales by hour of day"><Columns rows={Array.from({ length: 24 }, (_, h) => ({ label: `${h}`, ...(d.by_hour.find((r) => Number(r.label) === h) || { net: 0, count: 0 }) }))} format={fmtMoney} axisLabel="Hour of day (store time)" /></Panel>
      <Panel title="Sales by day of week"><Columns rows={[1, 2, 3, 4, 5, 6, 7].map((n) => ({ ...(d.by_weekday.find((r) => Number(r.label) === n) || { net: 0, count: 0 }), label: WEEKDAYS[n] }))} format={fmtMoney} axisLabel="Day of week" /></Panel>
      <Panel title="Product performance" wide note="Click a product to see the transactions it was sold in.">
        <div className="cs-tabs small">{PRODUCT_LISTS.map(([key, label]) => <button type="button" key={key} className={list === key ? 'active' : ''} onClick={() => setList(key)}>{label}</button>)}</div>
        <Table columns={productColumns} rows={d[list]} empty={list === 'top_profit' ? 'No products with recorded costs sold in this period.' : 'Nothing for this period.'} onRow={(row) => drill({ search: row.sku || row.name })} />
      </Panel>
    </div>
  )
}

// ── Inventory & Profitability ────────────────────────────────────────────────
function InventoryTab({ d }) {
  const s = d.stats || {}
  if (!Number(s.stock_records) && !d.out_of_stock) return <div className="tx-card"><Empty title="No inventory records" text="Items added to Inventory will appear here." /></div>
  const turnover = Number(s.cost_value) > 0 ? Number(d.period?.cost || 0) / Number(s.cost_value) : null
  return (
    <div className="rp-grid">
      <Tiles items={[['Inventory Units', fmtNum(s.units), `${fmtNum(s.available_units)} available`], ['Unique Products', fmtNum(s.unique_products), `${fmtNum(s.stock_records)} stock records`],
        ['Inventory Cost Value', money.format(s.cost_value), Number(s.units_missing_cost) ? `${fmtNum(s.units_missing_cost)} units have no recorded cost` : 'recorded acquisition cost'],
        ['Estimated Retail Value', money.format(s.retail_value), 'at in-store prices'], ['Potential Gross Margin', money.format(s.potential_margin), 'priced items with a cost'],
        ['Low Stock', fmtNum(s.low_stock), '1–2 available'], ['Out of Stock', fmtNum(d.out_of_stock)], ['Unpriced Items', fmtNum(s.unpriced)],
        ['Inventory Turnover', turnover != null ? turnover.toFixed(2) : '—', 'cost of goods sold in the period ÷ current inventory cost']]} />
      <Panel title="Inventory valuation" note="Estimated values aren't realised revenue. Market value uses catalogue market prices where the catalogue has one.">
        <Table columns={[['method', 'Valuation method', 'text'], ['value', 'Value', 'money'], ['coverage', 'Covers', 'text']]} rows={[
          { method: 'Recorded acquisition cost', value: s.cost_value, coverage: `${fmtNum(Number(s.units) - Number(s.units_missing_cost || 0))} of ${fmtNum(s.units)} units` },
          { method: 'Current in-store price', value: s.retail_value, coverage: 'priced items' },
          { method: 'Current online price', value: s.online_value, coverage: 'items listed online' },
          { method: 'Catalogue market value', value: s.market_value, coverage: `${fmtNum(s.units_with_market_value)} of ${fmtNum(s.units)} units` }]} />
      </Panel>
      <Panel title="Inventory ageing" note="By the date each stock record was added."><Columns rows={(d.ageing || []).map((r) => ({ label: r.bucket, net: Number(r.units) }))} format={(v) => fmtNum(v)} axisLabel="Units held" /></Panel>
      <Panel title="Gross profit by category" wide><Table columns={[['label', 'Category', 'text'], ['revenue', 'Revenue', 'money'], ['cost', 'Cost', 'money'], ['profit', 'Profit', 'money'], ['margin_pct', 'Margin', 'pct'], ['flag', '', 'text']]} rows={(d.profit_by_category || []).map((r) => ({ ...r, flag: r.incomplete ? 'some costs missing' : '' }))} /></Panel>
      <Panel title="Gross profit by brand"><Table columns={[['label', 'Brand', 'text'], ['revenue', 'Revenue', 'money'], ['profit', 'Profit', 'money'], ['margin_pct', 'Margin', 'pct']]} rows={d.profit_by_brand} /></Panel>
      <Panel title="Gross profit by location"><Table columns={[['label', 'Location', 'text'], ['revenue', 'Revenue', 'money'], ['profit', 'Profit', 'money'], ['margin_pct', 'Margin', 'pct']]} rows={d.profit_by_location} /></Panel>
      <Panel title="Inventory movement" note="Active pawn collateral isn't store inventory and isn't counted."><Table columns={[['label', 'Movement', 'text'], ['units', 'Units', 'number'], ['records', 'Records', 'number']]} rows={(d.movement || []).map((r) => ({ ...r, label: MOVEMENT[r.type] || r.type }))} /></Panel>
      <Panel title="Slow-moving inventory" note="Held over 90 days with no sale in the last 90 days, largest cost first."><Table columns={[['name', 'Item', 'text'], ['units', 'Units', 'number'], ['cost', 'Cost', 'money'], ['days_held', 'Days held', 'number']]} rows={d.slow_moving} empty="No slow-moving items." /></Panel>
    </div>
  )
}

// ── Customers ────────────────────────────────────────────────────────────────
function CustomersTab({ d }) {
  const m = d.members || {}
  const w = d.wishlist
  return (
    <div className="rp-grid">
      <p className="cs-muted rp-wide">Only CollectorsHub members who've bought from this store are counted; guests and store customers are included in sales totals but never as members.</p>
      {!Number(m.purchasing) && !Number(d.non_members?.transactions) ? <div className="tx-card rp-wide"><Empty title="No customer data for this period" text="Sales to members and other customers will appear here." /></div> : (
        <Tiles items={[['Purchasing Members', fmtNum(m.purchasing)], ['New Purchasing Members', fmtNum(m.new), 'first purchase here in this period'], ['Returning Members', fmtNum(m.returning)],
          ['Repeat Purchase Rate', fmtPct(m.repeat_rate_pct), '2+ purchases in the period'], ['Average Spend per Member', m.avg_spend != null ? money.format(m.avg_spend) : '—'],
          ['Purchase Frequency', m.frequency != null ? fmtNum(m.frequency) : '—', 'purchases per member'], ['Member Transactions', fmtNum(m.transactions)],
          ['Average Basket', m.avg_basket_items != null ? `${fmtNum(m.avg_basket_items)} items` : '—'], ['Non-member Sales', money.format(d.non_members?.net || 0), `${fmtNum(d.non_members?.transactions)} sales (guests and store customers)`]]} />
      )}
      <Panel title="Spending over time" wide><Columns rows={(d.spending_over_time || []).map((r) => ({ label: r.bucket, members: Number(r.members), others: Number(r.others) }))} series={[{ key: 'members', label: 'Members' }, { key: 'others', label: 'Guests and store customers' }]} format={fmtMoney} axisLabel="Net sales by month" /></Panel>
      <Panel title="What members buy"><HBars rows={d.member_categories} format={fmtMoney} /></Panel>
      <Panel title="Wishlist demand" wide note="Only members who shop here and share their wishlist with this store are included. This is for viewing demand; it doesn't send anything to collectors. CollectorsHub's own wishlist alerts (when collectors opt in) already cover price changes and new availability.">
        {!d.wishlist_available ? <p className="cs-muted">Wishlist matching isn't installed (supabase/customer_wishlists.sql).</p> : !w || !Number(w.unique_items) ? <Empty title="No matching wishlists" text="Wishlists shared by members who shop here will appear here." /> : (
          <>
            <Tiles items={[['Members Sharing Wishlists', fmtNum(w.sharing_members)], ['Members With In-Store Matches', fmtNum(w.members_with_matches)], ['Unique Wishlisted Items', fmtNum(w.unique_items)],
              ['Available In Store', fmtNum(w.items_in_store)], ['Not In Store', fmtNum(w.items_not_in_store)]]} />
            <div className="rp-split">
              <div><h4>Most wished-for categories</h4><HBars rows={(w.top_categories || []).map((r) => ({ ...r, net: Number(r.wishers) }))} format={(v) => `${fmtNum(v)} wishes`} /></div>
              <div><h4>Inventory demand</h4><Table columns={[['name', 'Product', 'text'], ['catalog_item_id', 'Catalogue ID', 'text'], ['category', 'Category', 'text'], ['wishers', 'Members wishing', 'number'], ['available', 'In stock', 'number'], ['price', 'In-store price', 'text'], ['status', 'Status', 'text']]}
                rows={(w.demand || []).map((r) => ({ ...r, catalog_item_id: String(r.catalog_item_id).slice(0, 8), price: r.price_min == null ? '—' : Number(r.price_min) === Number(r.price_max) ? money.format(r.price_min) : `${money.format(r.price_min)}–${money.format(r.price_max)}`, status: Number(r.available) > 0 ? 'In store' : 'Not in store' }))} /></div>
            </div>
          </>
        )}
      </Panel>
    </div>
  )
}

// ── Pawn & Loans ─────────────────────────────────────────────────────────────
function PawnTab({ d }) {
  const t = d.totals || {}
  const a = d.activity || {}
  const c = d.collateral || {}
  return (
    <div className="rp-grid">
      <p className="cs-muted rp-wide">Loan principal paid out and repaid is financing, not retail sales; only interest and permitted fees are income. Test loans are excluded.</p>
      <Tiles items={[['Active Loans', fmtNum(t.active_loans)], ['Principal Issued', money.format(t.principal_issued), 'in this period'], ['Principal Outstanding', money.format(t.principal_outstanding)],
        ['Repayments Received', money.format(t.repayments)], ['of which Principal', money.format(t.principal_repaid)], ['Interest & Permitted Fees', money.format(t.interest_and_fees)],
        ['Loans Redeemed', fmtNum(t.redeemed)], ['Overdue Loans', fmtNum(t.overdue)], ['In Forfeiture Review', fmtNum(t.forfeiture_review)], ['Lawfully Acquired Items', fmtNum(t.lawfully_acquired)]]} />
      <Panel title="Loan activity in this period"><Table columns={[['label', 'Activity', 'text'], ['n', 'Count', 'number']]} rows={[['issued', 'New loans issued'], ['renewed', 'Renewals'], ['payment', 'Partial payments'], ['redeemed', 'Full redemptions'], ['collateral_released', 'Collateral releases'], ['forfeited', 'Lawful forfeitures'], ['transferred_to_inventory', 'Transfers to inventory']].map(([key, label]) => ({ label, n: a[key] || 0 }))} /></Panel>
      <Panel title="Collateral"><Table columns={[['label', 'Collateral', 'text'], ['value', 'Value', 'text']]} rows={[
        { label: 'Items held', value: fmtNum(c.held_items) }, { label: 'Estimated value held', value: money.format(c.held_estimated_value || 0) }, { label: 'Loan value held', value: money.format(c.held_loan_value || 0) },
        { label: 'Under forfeiture review', value: fmtNum(c.under_review) }, { label: 'Released to customers', value: fmtNum(c.released) }, { label: 'Lawfully acquired', value: fmtNum(c.lawfully_acquired) }, { label: 'Transferred to inventory', value: fmtNum(c.transferred) }]} /></Panel>
      <Panel title="Collateral by category"><Table columns={[['label', 'Category', 'text'], ['items', 'Items', 'number'], ['value', 'Estimated value', 'money']]} rows={d.by_category} empty="No collateral held." /></Panel>
      <Panel title="Collateral by storage location" note="Use this to check the physical collateral against the loan records."><Table columns={[['label', 'Room / cabinet', 'text'], ['items', 'Items', 'number']]} rows={d.by_storage} empty="No collateral held." /></Panel>
      <Panel title="Overdue loans"><Table columns={[['loan_number', 'Loan', 'text'], ['due_date', 'Due', 'text'], ['principal_outstanding', 'Principal owing', 'money']]} rows={d.overdue} empty="No overdue loans." /></Panel>
    </div>
  )
}

// ── Employees & Registers ────────────────────────────────────────────────────
function StaffTab({ d, drill }) {
  const e = d.employees
  const r = d.registers
  return (
    <div className="rp-grid">
      {e ? (
        <Panel title="Employee performance" wide note={e.note}>
          <Table columns={[['name', 'Employee', 'text'], ['role', 'Role', 'text'], ['transactions', 'Transactions', 'number'], ['net', 'Sales revenue', 'money'], ['items', 'Items sold', 'number'], ['avg_sale', 'Avg. sale', 'money'],
            ['refunds', 'Refunds', 'number'], ['discounts', 'Discounts', 'money'], ['buys', 'Buys / trade-ins', 'number'], ...(e.rows?.some((x) => x.pawn != null) ? [['pawn', 'Pawn', 'number']] : [])]}
            rows={e.rows} empty="No employee activity in this period." onRow={(row) => row.id && drill({ employeeId: row.id })} />
        </Panel>
      ) : null}
      {r ? (
        <Panel title="Register sessions and cash reconciliation" wide note={r.note}>
          <Table columns={[['register', 'Register', 'text'], ['opened', 'Opened', 'text'], ['opened_by', 'Opened by', 'text'], ['closed_by', 'Closed by', 'text'], ['opening', 'Opening', 'money'], ['sales', 'Cash sales', 'money'], ['refunds', 'Cash refunds', 'money'],
            ['buy_outs', 'Cash buy-outs', 'money'], ['pawn_out', 'Pawn paid out', 'money'], ['pawn_in', 'Pawn repaid', 'money'], ['other', 'Orders / adjustments', 'money'], ['expected', 'Expected', 'money'], ['counted', 'Counted', 'money'], ['over_short', 'Over / short', 'money'], ['notes', 'Notes', 'text']]}
            rows={(r.sessions || []).map((s) => ({ ...s, opened: s.opened_at ? new Date(s.opened_at).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—', sales: s.cash?.sales, refunds: s.cash?.refunds, buy_outs: s.cash?.buy_outs,
              pawn_out: s.cash?.pawn_disbursements, pawn_in: s.cash?.pawn_repayments, other: Number(s.cash?.adjustments || 0) + Number(s.orders_cash || 0), counted: s.status === 'closed' ? s.counted : null, over_short: s.status === 'closed' ? s.over_short : null, closed_by: s.status === 'closed' ? s.closed_by || 'Not recorded' : 'Still open' }))}
            empty="No register sessions in this period." />
        </Panel>
      ) : null}
    </div>
  )
}

// ── Tax & Accounting ─────────────────────────────────────────────────────────
function TaxTab({ d }) {
  const s = d.tax.summary || {}
  const a = d.accounting || {}
  const t = a.totals || {}
  return (
    <div className="rp-grid">
      <p className="cu-notice rp-wide"><Info size={15} /> {d.tax.note}</p>
      <Tiles items={[['Taxable Sales', money.format(s.taxable_sales)], ['Sales With No Tax', money.format(s.untaxed_sales), 'exempt or zero-rated (not distinguished)'], ['Tax Collected', money.format(s.tax_collected)],
        ['Tax Refunded', money.format(s.tax_refunded)], ['Net Tax Collected', money.format(s.net_tax)], ['Transactions', fmtNum(s.transactions), `${fmtNum(s.with_breakdown)} with a recorded tax breakdown`]]} />
      <Panel title="Tax by type and province"><Table columns={[['province', 'Province', 'text'], ['label', 'Tax', 'text'], ['collected', 'Collected', 'money'], ['refunded', 'Refunded', 'money'], ['net', 'Net', 'money']]} rows={d.tax.by_tax} /></Panel>
      <Panel title="Jurisdiction"><Table columns={[['location', 'Location', 'text'], ['province', 'Province', 'text'], ['tax', 'Current tax setting', 'text']]} rows={(d.tax.jurisdictions || []).map((j) => ({ ...j, tax: [j.label_1 && `${j.label_1} ${(Number(j.rate_1) * 100).toFixed(2)}%`, j.label_2 && `${j.label_2} ${(Number(j.rate_2) * 100).toFixed(2)}%`].filter(Boolean).join(' + ') || 'Not set' }))} /></Panel>
      <Panel title="Sales and refunds summary"><Table columns={[['label', 'Line', 'text'], ['value', 'Amount', 'money']]} rows={[
        { label: 'Gross sales (before tax)', value: t.gross_sales }, { label: 'Discounts', value: -Number(t.discounts || 0) }, { label: 'Refunds (before tax)', value: -Number(t.refunds || 0) }, { label: 'Net sales', value: t.net_sales },
        { label: 'Cost of goods sold', value: -Number(t.cogs || 0) }, { label: 'Gross profit', value: t.gross_profit }, { label: 'Buys / trade-ins paid out', value: -Number(a.buys?.paid_out || 0) }]} /></Panel>
      <Panel title="Payment method reconciliation" note="Totals per tender and transaction kind, to match against the bank, card terminal and drawer."><Table columns={[['method', 'Method', 'text'], ['kind', 'Transaction kind', 'text'], ['count', 'Payments', 'number'], ['amount', 'Amount', 'money']]} rows={(a.payments || []).map((p) => ({ ...p, method: METHOD[p.method] || p.method }))} /></Panel>
      <Panel title="Balance sheet items"><Table columns={[['label', 'Item', 'text'], ['value', 'Amount', 'money']]} rows={[
        { label: 'Store credit liability (now)', value: a.store_credit?.liability_now }, { label: 'Store credit liability (end of period)', value: a.store_credit?.liability_at_end },
        { label: 'Store credit issued in period', value: a.store_credit?.issued }, { label: 'Store credit redeemed in period', value: a.store_credit?.redeemed },
        { label: 'Inventory at recorded cost (now)', value: a.inventory_cost_value },
        ...(a.pawn ? [{ label: 'Pawn principal outstanding', value: a.pawn.principal_outstanding }, { label: 'Pawn interest and fee income (period)', value: a.pawn.interest_and_fees }] : [])]} /></Panel>
    </div>
  )
}

// ── Export ───────────────────────────────────────────────────────────────────
function buildSections(kind, data, overview) {
  const r = data[kind]?.result
  const cols = (spec) => spec.map(([key, label, type = 'text']) => [key, label, type])
  if (kind === 'overview') {
    const c = overview?.current || {}
    return [{ title: 'Summary', columns: cols([['label', 'Measure'], ['value', 'Value', 'money']]), rows: [
      { label: 'Net sales', value: c.net_sales }, { label: 'Gross profit', value: c.gross_profit }, { label: 'Transactions (sales)', value: c.sales_count }, { label: 'Average transaction value', value: c.avg_sale }] }]
  }
  if (!r) return []
  if (kind === 'sales') {
    const t = r.totals
    return [
      { title: 'Sales summary', columns: cols([['label', 'Measure'], ['value', 'Value', 'money']]), rows: [['Gross sales', t.gross_sales], ['Discounts', t.discounts], ['Refunds', t.refunds], ['Net sales', t.net_sales], ['Tax collected', t.tax_collected], ['Cost of goods sold', t.cogs], ['Gross profit', t.gross_profit], ['Average transaction value', t.avg_sale]].map(([label, value]) => ({ label, value })) },
      { title: 'Sales over time', columns: cols([['bucket', 'Period'], ['net', 'Net sales', 'money'], ['count', 'Sales', 'number']]), rows: r.over_time },
      { title: 'By category', columns: cols([['label', 'Category'], ['net', 'Revenue', 'money'], ['qty', 'Units', 'number']]), rows: r.by_category },
      { title: 'By payment method', columns: cols([['label', 'Method'], ['amount', 'Amount', 'money']]), rows: r.by_payment },
      { title: 'Top products', columns: cols([['name', 'Product'], ['sku', 'SKU'], ['qty', 'Sold', 'number'], ['revenue', 'Revenue', 'money']]), rows: r.top_revenue },
    ]
  }
  if (kind === 'inventory') {
    const s = r.stats || {}
    return [
      { title: 'Inventory summary', columns: cols([['label', 'Measure'], ['value', 'Value', 'number']]), rows: [['Units', s.units], ['Unique products', s.unique_products], ['Cost value', s.cost_value], ['Retail value', s.retail_value], ['Potential margin', s.potential_margin], ['Low stock', s.low_stock], ['Out of stock', r.out_of_stock], ['Unpriced', s.unpriced]].map(([label, value]) => ({ label, value })) },
      { title: 'Ageing', columns: cols([['bucket', 'Age'], ['units', 'Units', 'number'], ['cost', 'Cost', 'money']]), rows: r.ageing },
      { title: 'Profit by category', columns: cols([['label', 'Category'], ['revenue', 'Revenue', 'money'], ['cost', 'Cost', 'money'], ['profit', 'Profit', 'money'], ['margin_pct', 'Margin', 'pct']]), rows: r.profit_by_category },
      { title: 'Movement', columns: cols([['type', 'Movement'], ['units', 'Units', 'number'], ['records', 'Records', 'number']]), rows: r.movement },
    ]
  }
  if (kind === 'customers') {
    const m = r.members || {}
    return [
      { title: 'Member summary', columns: cols([['label', 'Measure'], ['value', 'Value', 'number']]), rows: [['Purchasing members', m.purchasing], ['New', m.new], ['Returning', m.returning], ['Repeat rate %', m.repeat_rate_pct], ['Avg spend', m.avg_spend], ['Member transactions', m.transactions]].map(([label, value]) => ({ label, value })) },
      ...(r.wishlist ? [{ title: 'Wishlist demand', columns: cols([['name', 'Product'], ['catalog_item_id', 'Catalogue ID'], ['category', 'Category'], ['wishers', 'Members', 'number'], ['available', 'In stock', 'number'], ['price_min', 'Price', 'money']]), rows: r.wishlist.demand }] : []),
    ]
  }
  if (kind === 'pawn') {
    const t = r.totals || {}
    return [{ title: 'Pawn portfolio', columns: cols([['label', 'Measure'], ['value', 'Value', 'money']]), rows: [['Principal issued', t.principal_issued], ['Principal outstanding', t.principal_outstanding], ['Repayments', t.repayments], ['Principal repaid', t.principal_repaid], ['Interest and fees', t.interest_and_fees]].map(([label, value]) => ({ label, value })) },
      { title: 'Collateral by category', columns: cols([['label', 'Category'], ['items', 'Items', 'number'], ['value', 'Estimated value', 'money']]), rows: r.by_category }]
  }
  if (kind === 'staff') {
    return [
      ...(r.employees ? [{ title: 'Employees', columns: cols([['name', 'Employee'], ['role', 'Role'], ['transactions', 'Transactions', 'number'], ['net', 'Sales revenue', 'money'], ['items', 'Items', 'number'], ['refunds', 'Refunds', 'number'], ['discounts', 'Discounts', 'money'], ['buys', 'Buys', 'number']]), rows: r.employees.rows }] : []),
      ...(r.registers ? [{ title: 'Register sessions', columns: cols([['register', 'Register'], ['opened_at', 'Opened'], ['opened_by', 'Opened by'], ['closed_by', 'Closed by'], ['opening', 'Opening', 'money'], ['expected', 'Expected', 'money'], ['counted', 'Counted', 'money'], ['over_short', 'Over/short', 'money'], ['notes', 'Notes']]), rows: r.registers.sessions }] : []),
    ]
  }
  if (kind === 'tax') {
    const s = r.tax.summary || {}
    return [
      { title: 'Tax summary', columns: cols([['label', 'Measure'], ['value', 'Value', 'money']]), rows: [['Taxable sales', s.taxable_sales], ['Sales with no tax', s.untaxed_sales], ['Tax collected', s.tax_collected], ['Tax refunded', s.tax_refunded], ['Net tax collected', s.net_tax]].map(([label, value]) => ({ label, value })) },
      { title: 'Tax by type', columns: cols([['province', 'Province'], ['label', 'Tax'], ['collected', 'Collected', 'money'], ['refunded', 'Refunded', 'money'], ['net', 'Net', 'money']]), rows: r.tax.by_tax },
      { title: 'Payments', columns: cols([['method', 'Method'], ['kind', 'Kind'], ['count', 'Payments', 'number'], ['amount', 'Amount', 'money']]), rows: r.accounting.payments },
    ]
  }
  return []
}

function ExportDialog({ storeId, access, range, rangeLabel, tab, tabs, data, overview, onClose }) {
  const [kind, setKind] = useState(tab)
  const [format, setFormat] = useState('xlsx')
  const [detail, setDetail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const options = [['overview', 'Dashboard summary'], ...tabs.filter(([key]) => data[key]?.result).map(([key, label]) => [key, label])]
  async function run() {
    setBusy(true); setProblem('')
    try {
      await logExport(storeId, kind, format, rangeLabel, { location: range.locationId || 'all', detail })
      const sections = buildSections(kind, data, overview)
      if (detail) {
        const rows = await reportDetail(storeId, range)
        sections.push({ title: 'Transactions (detail)', columns: [['number', 'Transaction', 'text'], ['date', 'Date', 'text'], ['type', 'Type', 'text'], ['employee', 'Employee', 'text'], ['location', 'Location', 'text'], ['customer_type', 'Customer', 'text'],
          ['gross', 'Gross', 'money'], ['discount', 'Discount', 'money'], ['net', 'Net', 'money'], ['tax', 'Tax', 'money'], ['total', 'Total', 'money'], ['cost', 'Cost', 'money'], ['payments', 'Payments', 'text'], ['tax_breakdown', 'Tax breakdown', 'text']],
          rows: rows.map((row) => ({ ...row, tax_breakdown: row.tax_detail ? [row.tax_detail.label_1 && `${row.tax_detail.label_1} ${row.tax_detail.rate_1}`, row.tax_detail.label_2 && `${row.tax_detail.label_2} ${row.tax_detail.rate_2}`].filter(Boolean).join(' + ') : 'not recorded' })) })
      }
      const label = options.find(([k]) => k === kind)?.[1] || 'Report'
      const location = range.locationId ? access.locations.find((l) => l.id === range.locationId)?.name : 'All locations'
      const meta = { title: `Reports & Analytics: ${label}`, store: access.store_name || '', period: `${range.from} to ${range.to}`, generated: new Date().toLocaleString('en-CA'), filters: `Location: ${location}${detail ? '; detailed records included' : '; summary only'}`, fileName: `CollectorsHub ${label} ${range.from} to ${range.to}`.replace(/[\\/:*?"<>|&]/g, '-') }
      if (format === 'csv') exportCsv(meta, sections)
      else if (format === 'xlsx') exportXlsx(meta, sections)
      else exportPdf(meta, sections)
      onClose()
    } catch (error) { setProblem(error.message) } finally { setBusy(false) }
  }
  return (
    <div className="register-modal cu-modal" role="dialog" aria-modal="true"><section>
      <button className="modal-close" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
      <h2>Export report</h2>
      <p className="cs-muted">Uses exactly the figures on screen for {rangeLabel}{range.locationId ? '' : ', all locations'}.</p>
      <div className="cs-form-grid">
        <label><span>Report</span><select value={kind} onChange={(event) => setKind(event.target.value)}>{options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value)}><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV</option><option value="pdf">PDF (print, then Save as PDF)</option></select></label>
      </div>
      <label className="tx-check"><input type="checkbox" checked={detail} onChange={(event) => setDetail(event.target.checked)} /> Include detailed transaction records (references, dates, tax breakdown)</label>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      <div className="cs-actions"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="gold-button" disabled={busy} onClick={run}><Download size={15} /> {busy ? 'Preparing…' : 'Export'}</button></div>
    </section></div>
  )
}
