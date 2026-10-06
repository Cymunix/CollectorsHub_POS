// The organization's head office in the POS (org sign-in). Ported from the
// website's OrgDashboard (Nordvik-main), without its own sidebar: the POS
// sidebar lists the modules. Overview numbers are live.
import { useEffect, useRef, useState } from 'react'
import { loadOrganizationStores, myUnattachedStores, attachStoreToOrganization, detachStoreFromOrganization, createStoreFull, createStoreEmployee, ORG_EMPLOYEE_ROLES, listOrgRegions, updateLocationAddress, setStoreNotificationRegion, searchCommunities , orgSalesKpis, orgOrderKpis, orgTradeinKpis, orgSalesByStore, taxForProvince, loadStoreLocations } from './orgApi'
import { regionsForProvince, defaultRegionIdForProvince, regionNameById, CANADA_PROVINCE_CODES_BY_NAME } from './notificationRegions'
import {
  LocationsModule, StaffModule, InventoryModule, OrdersModule, TradeInsModule, SalesModule,
  PromotionsEventsModule, PoliciesModule, ReportsModule, IntegrationsModule, OrgSettingsModule,
} from './OrgModules'

// Normalise whatever the browser's address autofill gives (full name or code) to
// a 2-letter province code so tax + region derivation work.
const moneyText = (n) => `$${Number(n || 0).toFixed(2)}`
const PROV_BY_LOWER = Object.fromEntries(Object.entries(CANADA_PROVINCE_CODES_BY_NAME).map(([k, v]) => [k.toLowerCase(), v]))
function provinceCode(input) {
  const t = String(input || '').trim()
  if (!t) return ''
  if (t.length === 2) return t.toUpperCase()
  return PROV_BY_LOWER[t.toLowerCase()] || t.toUpperCase().slice(0, 2)
}

// Client-side sandbox store list for the demo organization (non-persisting,
// like the demo store). Real orgs use the DB RPCs.
const DEMO_KEY = 'nordvik_demo_org_stores'
const loadDemoStores = () => { try { return JSON.parse(sessionStorage.getItem(DEMO_KEY) || '[]') } catch { return [] } }
const saveDemoStores = (list) => { try { sessionStorage.setItem(DEMO_KEY, JSON.stringify(list)) } catch { /* ignore */ } }
const genCode = () => String(Math.floor(1000 + Math.random() * 8999)) // 1000–9999, never 0000

// Parent Organization oversight dashboard. Multi-store overview + provisioning.
// An org account cannot take in items itself — it opens each STORE's POS to do that.
export default function OrgPortal({ session, activeModule = 'overview', onModule = () => {} }) {
  const [stores, setStores] = useState([])
  const [unattached, setUnattached] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [staffStore, setStaffStore] = useState(null) // store whose staff modal is open
  const [wizardOpen, setWizardOpen] = useState(false)
  const [regions, setRegions] = useState([])
  const setActiveModule = onModule
  // Live head-office numbers (the website showed fixed zeros here).
  const [live, setLive] = useState({ sales: {}, orders: {}, tradeins: {}, salesToday: {} })
  const [scope, setScope] = useState('all')          // region filter (region id | 'all')
  const [tableSearch, setTableSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [attentionFilter, setAttentionFilter] = useState(null)  // no_location | no_staff | no_inventory | null
  const [menu, setMenu] = useState(null)  // { storeId, top, left } — fixed-positioned popover
  const [locStore, setLocStore] = useState(null)  // store whose Locations modal (official address) is open

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      if (session.demo) {
        if (!cancelled) { setStores(loadDemoStores()); setLoading(false) }
        return
      }
      const [s, u, rg, sales, orders, tradeins, todayByStore] = await Promise.all([
        loadOrganizationStores(session.orgId), myUnattachedStores(), listOrgRegions(session.orgId),
        orgSalesKpis(session.orgId), orgOrderKpis(session.orgId), orgTradeinKpis(session.orgId), orgSalesByStore(session.orgId, 1),
      ])
      if (cancelled) return
      setStores(s); setUnattached(u); setRegions(rg); setLoading(false)
      setLive({ sales: sales || {}, orders: orders || {}, tradeins: tradeins || {}, salesToday: Object.fromEntries((todayByStore || []).map(r => [r.storeId, r.sales])) })
    }, 0)
    return () => { cancelled = true; clearTimeout(t) }
  }, [session.orgId, session.demo, reloadKey])

  const attach = async (storeId) => {
    setError(''); setBusy(storeId)
    try { await attachStoreToOrganization(storeId, session.orgId); setReloadKey(k => k + 1) }
    catch (e) { setError(e.message) } finally { setBusy('') }
  }
  const detach = async (storeId) => {
    setError(''); setBusy(storeId)
    if (session.demo) { const next = loadDemoStores().filter(s => s.storeId !== storeId); saveDemoStores(next); setStores(next); setBusy(''); return }
    try { await detachStoreFromOrganization(storeId); setReloadKey(k => k + 1) }
    catch (e) { setError(e.message) } finally { setBusy('') }
  }

  // Create Store (+ Primary Location) via the wizard. Demo orgs create a
  // client-side store; real orgs call create_store_full (store + location + settings).
  const onWizardCreate = async (payload) => {
    if (session.demo) {
      const store = { storeId: `demo-${Date.now()}`, storeCode: (payload.storeCode || genCode()), storeName: payload.storeName, primaryLocation: payload.locationName, status: payload.status || 'active', locationCount: 1, staffCount: 0, inventoryCount: 0, demo: true }
      const next = [...loadDemoStores(), store]
      saveDemoStores(next); setStores(next); setWizardOpen(false)
      return
    }
    await createStoreFull(session.orgId, payload)
    setWizardOpen(false); setReloadKey(k => k + 1)
  }


  // Region scope → the base set every KPI / table works from.
  const scopedStores = scope === 'all' ? stores : stores.filter(s => s.regionId === scope)
  const kpis = {
    stores: scopedStores.length,
    locations: scopedStores.reduce((s, x) => s + x.locationCount, 0),
    inventory: scopedStores.reduce((s, x) => s + x.inventoryCount, 0),
    staff: scopedStores.reduce((s, x) => s + (x.staffCount || 0), 0),
  }
  // Needs Attention — derived from the data we actually have.
  const noLocation = scopedStores.filter(s => !s.primaryLocation || s.locationCount === 0)
  const noStaff = scopedStores.filter(s => (s.staffCount || 0) === 0)
  const noInventory = scopedStores.filter(s => (s.inventoryCount || 0) === 0)
  const attention = [
    noLocation.length && { key: 'no_location', label: `${noLocation.length} store${noLocation.length === 1 ? '' : 's'} missing a primary location`, tone: '#b45309' },
    noStaff.length && { key: 'no_staff', label: `${noStaff.length} store${noStaff.length === 1 ? '' : 's'} without staff`, tone: '#38bdf8' },
    noInventory.length && { key: 'no_inventory', label: `${noInventory.length} store${noInventory.length === 1 ? '' : 's'} with no inventory`, tone: '#6d28d9' },
  ].filter(Boolean)

  const tableStores = scopedStores
    .filter(s => statusFilter === 'all' || s.status === statusFilter)
    .filter(s => !attentionFilter || (attentionFilter === 'no_location' ? (!s.primaryLocation || s.locationCount === 0) : attentionFilter === 'no_staff' ? (s.staffCount || 0) === 0 : (s.inventoryCount || 0) === 0))
    .filter(s => { const q = tableSearch.trim().toLowerCase(); return !q || s.storeName.toLowerCase().includes(q) || (s.storeCode || '').toLowerCase().includes(q) })

  const focusStores = (attKey) => { setActiveModule('stores'); setAttentionFilter(attKey) }

  // Set a store's collector notification region (auto-derived from its address,
  // overridable to another region within the same province).
  const changeRegion = async (s, value) => {
    setError('')
    try { await setStoreNotificationRegion(s.storeId, value || null); setReloadKey(k => k + 1) }
    catch (e) { setError(e.message) }
  }

  const storesTable = (
    <>
      {/* Filters */}
      <div style={ent.filters}>
        <input type="search" value={tableSearch} onChange={e => setTableSearch(e.target.value)} placeholder="Search stores…" style={ent.search} />
        {regions.length > 0 && (
          <select value={scope} onChange={e => setScope(e.target.value)} style={ent.select}>
            <option value="all" style={optDark}>All Regions</option>
            {regions.map(r => <option key={r.id} value={r.id} style={optDark}>{r.name}</option>)}
          </select>
        )}
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={ent.select}>
          {['all', 'setup', 'active', 'temporarily_closed', 'suspended', 'archived'].map(s => <option key={s} value={s} style={optDark}>{s === 'all' ? 'All statuses' : s.replace(/_/g, ' ')}</option>)}
        </select>
        {attentionFilter && <button type="button" style={ent.clearFilter} onClick={() => setAttentionFilter(null)}>Clear attention filter ✕</button>}
        <button type="button" onClick={() => setWizardOpen(true)} style={{ ...ent.primary, marginLeft: 'auto' }}>+ Create Store</button>
      </div>

      {loading ? <div style={ent.empty}>Loading…</div>
        : tableStores.length === 0 ? <div style={ent.empty}>{stores.length === 0 ? 'No stores yet.' : 'No stores match these filters.'}</div>
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead><tr style={ent.thRow}>
                <th style={eth}>Store</th><th style={eth}>Code</th><th style={eth}>Region</th><th style={eth}>Primary Location</th>
                <th style={eth}>Staff</th><th style={eth}>Inventory</th><th style={eth}>Sales Today</th><th style={eth}>Status</th><th style={{ ...eth, textAlign: 'right' }}>Actions</th>
              </tr></thead>
              <tbody>
                {tableStores.map(s => (
                  <tr key={s.storeId} style={ent.tr}>
                    <td style={{ ...etd, fontWeight: 700, color: INK }}>{s.storeName}</td>
                    <td style={etd}>{s.storeCode}</td>
                    <td style={etd}>{s.demo ? (<span style={{ color: FAINT }}>{regionNameById(s.notificationRegionId) || '—'}</span>) : (() => {
                      const opts = regionsForProvince(s.primaryProvince)
                      // Ensure the current value shows even if it's outside the province set.
                      const list = (s.notificationRegionId && !opts.some(o => o.id === s.notificationRegionId)) ? [{ id: s.notificationRegionId, name: regionNameById(s.notificationRegionId) || s.notificationRegionId }, ...opts] : opts
                      return (
                        <select value={s.notificationRegionId || ''} onChange={e => changeRegion(s, e.target.value)} style={{ ...ent.select, padding: '5px 8px', fontSize: '0.8rem' }} title={s.primaryProvince ? `Regions in ${s.primaryProvince}` : 'Add an address to derive a region'}>
                          <option value="" style={optDark}>{s.primaryProvince ? '— Auto —' : '— No address —'}</option>
                          {list.map(r => <option key={r.id} value={r.id} style={optDark}>{r.name}</option>)}
                        </select>
                      )
                    })()}</td>
                    <td style={etd}>{s.primaryLocation || <span style={{ color: '#b45309' }}>— required</span>}</td>
                    <td style={etd}>{s.staffCount}</td>
                    <td style={etd}>{s.inventoryCount}</td>
                    <td style={etd}>{moneyText(live.salesToday[s.storeId])}</td>
                    <td style={etd}><span style={statusBadge(s.status)}>{(s.status || 'active').replace(/_/g, ' ')}</span></td>
                    <td style={{ ...etd, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {!s.demo && <button type="button" onClick={() => setStaffStore(s)} style={{ ...ent.rowGhost, marginLeft: 0 }}>Staff</button>}
                      <button type="button" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu(menu?.storeId === s.storeId ? null : { storeId: s.storeId, top: r.bottom + 4, left: Math.max(8, r.right - 200) }) }} style={ent.rowGhost}>More ▾</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {/* More menu — fixed popover so the table's overflow doesn't clip it */}
      {menu && (() => {
        const s = tableStores.find(x => x.storeId === menu.storeId)
        if (!s) return null
        return (
          <>
            <div onClick={() => setMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
            <div style={{ ...ent.menu, position: 'fixed', top: menu.top, left: menu.left, right: 'auto', zIndex: 31 }}>
              <button type="button" style={ent.menuItem} onClick={() => { setMenu(null); setLocStore(s) }}>Locations &amp; Address</button>
              <div style={{ borderTop: `1px solid ${BORDER}`, margin: '4px 0' }} />
              <button type="button" disabled={busy === s.storeId} style={{ ...ent.menuItem, color: '#b91c1c' }}
                onClick={() => { if (window.confirm(`${s.demo ? 'Remove' : 'Detach'} “${s.storeName}” from this organisation?`)) { setMenu(null); detach(s.storeId) } }}>
                {s.demo ? 'Remove' : 'Detach from Organisation'}
              </button>
            </div>
          </>
        )
      })()}
    </>
  )

  return (
    <div className="org-portal">
      {/* Main */}
      <main>
        {session.demo && <div style={ent.demoStrip}><strong>Demo organisation (sandbox)</strong> — non-persisting; created stores &amp; sales reset when the session ends.</div>}
        {error && <div style={{ color: '#b91c1c', fontSize: '0.85rem', marginBottom: 12 }}>{error}</div>}

        {stores.length === 0 && !loading && activeModule === 'overview' ? (
          <SetupState demo={session.demo} onCreate={() => setWizardOpen(true)} />
        ) : activeModule === 'overview' ? (
          <>
            <div style={ent.pageHead}>
              <div>
                <h1 style={ent.h1}>Overview</h1>
                <p style={ent.infoStrip}>Head Office — manage stores, staff, policies and reporting. Selling and stock intake happen in each store's POS sign-in.</p>
              </div>
              {regions.length > 0 && (
                <select value={scope} onChange={e => setScope(e.target.value)} style={ent.select}>
                  <option value="all" style={optDark}>All Regions</option>
                  {regions.map(r => <option key={r.id} value={r.id} style={optDark}>{r.name}</option>)}
                </select>
              )}
            </div>

            {/* KPIs */}
            <div style={ent.kpiGrid}>
              <Kpi label="Stores" value={kpis.stores} onClick={() => setActiveModule('stores')} />
              <Kpi label="Locations" value={kpis.locations} onClick={() => setActiveModule('locations')} />
              <Kpi label="Active Inventory" value={kpis.inventory} onClick={() => setActiveModule('inventory')} />
              <Kpi label="Sales Today" value={moneyText(live.sales.today)} onClick={() => setActiveModule('sales')} />
              <Kpi label="Transactions Today" value={Number(live.sales.transactions_today || 0)} onClick={() => setActiveModule('sales')} />
              <Kpi label="Trade-Ins Today" value={Number(live.tradeins.today || 0)} onClick={() => setActiveModule('tradeins')} />
              <Kpi label="Orders Ready" value={Number(live.orders.ready_for_pickup || 0)} onClick={() => setActiveModule('orders')} />
              <Kpi label="Outstanding Layaway" value={moneyText(live.orders.outstanding_layaway)} onClick={() => setActiveModule('orders')} />
              <Kpi label="Outstanding Pre-Order" value={moneyText(live.orders.outstanding_preorder)} onClick={() => setActiveModule('orders')} />
            </div>

            {/* Needs Attention + Quick Actions */}
            <div style={ent.twoCol}>
              <div style={ent.panel}>
                <div style={ent.panelTitle}>Needs Attention</div>
                {attention.length === 0 ? (
                  <div style={{ color: SUB, fontSize: '0.85rem' }}>✅ Nothing requires attention.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {attention.map(a => (
                      <button key={a.key} type="button" onClick={() => focusStores(a.key)} style={ent.attnRow}>
                        <span style={{ color: a.tone }}>●</span><span style={{ flex: 1, textAlign: 'left', color: INK }}>{a.label}</span><span style={{ color: FAINT }}>›</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div style={ent.panel}>
                <div style={ent.panelTitle}>Quick Actions</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button type="button" style={ent.primary} onClick={() => setWizardOpen(true)}>+ Create Store</button>
                  <button type="button" style={ent.ghost} onClick={() => setActiveModule('staff')}>Manage Staff</button>
                  <button type="button" style={ent.ghost} onClick={() => setActiveModule('orders')}>View Orders</button>
                  <button type="button" style={ent.ghost} onClick={() => setActiveModule('reports')}>View Reports</button>
                </div>
              </div>
            </div>

            {/* Staff summary */}
            <div style={{ ...ent.panel, marginBottom: 18 }}>
              <div style={ent.panelTitle}>Organisation at a glance</div>
              <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
                <Mini label="Total Staff" value={kpis.staff} />
                <Mini label="Regions" value={regions.length} />
                <Mini label="Stores in Setup" value={scopedStores.filter(s => s.status === 'setup').length} />
                <Mini label="Missing Location" value={noLocation.length} />
              </div>
            </div>

            {/* Stores */}
            <h2 style={ent.h2}>Stores</h2>
            {storesTable}
          </>
        ) : activeModule === 'stores' ? (
          <><h1 style={ent.h1}>Stores</h1>{storesTable}
            {unattached.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <h2 style={ent.h2}>Attach an existing store</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {unattached.map(s => (
                    <div key={s.storeId} style={ent.attachRow}>
                      <div style={{ flex: 1 }}><div style={{ fontWeight: 700, color: INK }}>{s.storeName}</div><div style={{ fontSize: '0.78rem', color: FAINT }}>Code {s.storeCode}</div></div>
                      <button type="button" disabled={busy === s.storeId} onClick={() => attach(s.storeId)} style={ent.primary}>Attach</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : activeModule === 'locations' && !session.demo ? (
          <LocationsModule orgId={session.orgId} stores={stores} />
        ) : activeModule === 'staff' && !session.demo ? (
          <StaffModule orgId={session.orgId} stores={stores} />
        ) : activeModule === 'inventory' && !session.demo ? (
          <InventoryModule orgId={session.orgId} stores={stores} />
        ) : activeModule === 'orders' && !session.demo ? (
          <OrdersModule orgId={session.orgId} stores={stores} />
        ) : activeModule === 'tradeins' && !session.demo ? (
          <TradeInsModule orgId={session.orgId} stores={stores} />
        ) : activeModule === 'sales' && !session.demo ? (
          <SalesModule orgId={session.orgId} stores={stores} />
        ) : activeModule === 'promos' && !session.demo ? (
          <PromotionsEventsModule orgId={session.orgId} stores={stores} />
        ) : activeModule === 'policies' && !session.demo ? (
          <PoliciesModule orgId={session.orgId} stores={stores} />
        ) : activeModule === 'reports' && !session.demo ? (
          <ReportsModule orgId={session.orgId} stores={stores} />
        ) : activeModule === 'integrations' && !session.demo ? (
          <IntegrationsModule orgId={session.orgId} />
        ) : activeModule === 'settings' && !session.demo ? (
          <OrgSettingsModule stores={stores} orgId={session.orgId} />
        ) : (
          <ModulePlaceholder module={activeModule} demo={session.demo} />
        )}
      </main>

      {staffStore && <StaffModal store={staffStore} onClose={() => setStaffStore(null)} />}
      {locStore && <LocationsModal store={locStore} onClose={() => setLocStore(null)} />}
      {wizardOpen && <CreateStoreWizard demo={session.demo} onClose={() => setWizardOpen(false)} onCreate={onWizardCreate} />}
    </div>
  )
}

export const NAV = [
  ['overview', 'Overview', '▤'], ['stores', 'Stores', '🏬'], ['locations', 'Locations', '📍'],
  ['staff', 'Staff', '👥'], ['inventory', 'Inventory', '📦'], ['orders', 'Orders', '🧾'],
  ['sales', 'Sales', '💰'], ['tradeins', 'Trade-Ins', '📥'], ['promos', 'Promotions & Events', '🎪'],
  ['reports', 'Reports', '📊'], ['policies', 'Policies', '📋'], ['integrations', 'Integrations', '🔌'],
  ['settings', 'Settings', '⚙'],
]

function Kpi({ label, value, hint, onClick }) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp type={onClick ? 'button' : undefined} onClick={onClick} style={{ ...ent.kpi, cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 800, color: INK }}>{value}</div>
      <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: SUB, marginTop: 2 }}>{label}</div>
      {hint && <div style={{ fontSize: '0.62rem', color: FAINT, marginTop: 2 }}>{hint}</div>}
    </Comp>
  )
}
function Mini({ label, value }) {
  return <div><div style={{ fontFamily: 'var(--font-display)', fontSize: '1.3rem', fontWeight: 800, color: INK }}>{value}</div><div style={{ fontSize: '0.7rem', color: SUB, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div></div>
}
function SetupState({ demo, onCreate }) {
  return (
    <div style={{ ...ent.panel, textAlign: 'center', padding: 36 }}>
      <div style={{ fontSize: '2rem', marginBottom: 8 }}>🏗️</div>
      <h1 style={{ ...ent.h1, marginBottom: 6 }}>Set up your retail network</h1>
      <p style={{ color: SUB, maxWidth: 460, margin: '0 auto 16px' }}>Create your first store to begin managing locations, inventory and staff.{demo ? ' (Demo — non-persisting.)' : ''}</p>
      <button type="button" style={ent.primary} onClick={onCreate}>+ Create Store</button>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', marginTop: 20, fontSize: '0.78rem', color: FAINT }}>
        {['1. Create Store', '2. Primary Location', '3. Add Staff', '4. Policies', '5. Staff sign in at the store'].map(s => <span key={s} style={{ background: FIELD, border: `1px solid ${BORDER}`, borderRadius: 20, padding: '5px 12px' }}>{s}</span>)}
      </div>
    </div>
  )
}
function ModulePlaceholder({ module, demo }) {
  const label = (NAV.find(n => n[0] === module) || [null, module])[1]
  const built = ['locations', 'staff', 'inventory', 'orders', 'tradeins', 'sales', 'promos', 'reports', 'policies', 'integrations', 'settings'].includes(module)
  return (
    <div style={{ ...ent.panel, textAlign: 'center', padding: 40 }}>
      <h1 style={{ ...ent.h1, marginBottom: 6 }}>{label}</h1>
      <p style={{ color: SUB, maxWidth: 460, margin: '0 auto' }}>
        {demo && built
          ? `${label} works for a real organisation — the demo org has no persisted data to show here.`
          : `This head-office module is coming next. Store-level ${label.toLowerCase()} is available today when signed in to that store.`}
      </p>
    </div>
  )
}

// Create Store + Primary Location. Head office enters the official address here.
function CreateStoreWizard({ demo, onClose, onCreate }) {
  const [f, setF] = useState({
    storeName: '', storeCode: '', notificationRegion: '', status: 'active',
    locationName: 'Primary Location', address1: '', address2: '', city: '', province: '', postal: '', country: 'Canada',
    timeZone: 'America/Halifax', currency: 'CAD',
    config: { public_profile: true, inventory_public: true, marketplace: false, trade_ins: true, pickup: false, dropoff: false, layaway: true, preorder: true },
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [cityResults, setCityResults] = useState([])
  const [cityOpen, setCityOpen] = useState(false)
  const cityTimer = useRef(null)
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))
  const setCfg = (k) => setF(p => ({ ...p, config: { ...p.config, [k]: !p.config[k] } }))

  // Town/city typeahead over the communities directory — picking one fills city,
  // province (→ tax), coordinates and the precise collector notification region.
  const onCityType = (v) => {
    set('city', v)
    clearTimeout(cityTimer.current)
    if (v.trim().length < 2) { setCityResults([]); setCityOpen(false); return }
    cityTimer.current = setTimeout(async () => {
      const r = await searchCommunities(v)
      setCityResults(r); setCityOpen(r.length > 0)
    }, 220)
  }
  const pickCity = (c) => {
    setF(p => ({ ...p, city: c.name, province: c.province, notificationRegion: c.regionId || (defaultRegionIdForProvince(c.province) || ''), latitude: c.latitude, longitude: c.longitude }))
    setCityOpen(false)
  }
  // Province drives the collector notification region (auto-select the single
  // region for the province; multi-region provinces leave it to the user).
  const setProvince = (raw) => setF(p => {
    const province = provinceCode(raw)
    const wasAuto = !p.notificationRegion || p.notificationRegion === defaultRegionIdForProvince(p.province)
    return { ...p, province, notificationRegion: wasAuto ? (defaultRegionIdForProvince(province) || '') : p.notificationRegion }
  })
  const regionOpts = regionsForProvince(f.province)

  const submit = async () => {
    setError('')
    if (!f.storeName.trim()) { setError('Store name is required.'); return }
    if (!demo && (!f.address1.trim() || !f.city.trim() || !f.province.trim())) { setError('Official address (line 1, city, province) is required — head office owns the store address.'); return }
    setBusy(true)
    try {
      const t = taxForProvince(f.province)
      await onCreate({ ...f, regionId: null, taxRate: t?.rate ?? null, taxLabel: t?.label ?? null })
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(9,18,40,0.5)', zIndex: 200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 20px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: 24, width: '100%', maxWidth: 640 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h2 style={{ ...h2, margin: 0 }}>Create Store</h2>
          <button type="button" onClick={onClose} style={{ border: 0, background: 'none', fontSize: '1.3rem', color: '#8292ac', cursor: 'pointer' }}>✕</button>
        </div>
        <p style={{ fontSize: '0.8rem', color: '#8292ac', marginTop: 0 }}>Creates the store and its first physical location together. {demo ? 'Demo org — address is not stored.' : 'The official address is set by head office and cannot be changed by store staff.'}</p>

        <form onSubmit={e => { e.preventDefault(); submit() }} autoComplete="on">
        <Section title="Store Identity">
          <Field label="Store Name *"><input style={inp} value={f.storeName} onChange={e => set('storeName', e.target.value)} placeholder="GameStop New Glasgow" /></Field>
          <Field label="Store Code"><input style={inp} value={f.storeCode} onChange={e => set('storeCode', e.target.value)} placeholder="Auto if blank (e.g. NG001)" /></Field>
          <Field label="Notification Region">
            <select style={inp} value={f.notificationRegion} onChange={e => set('notificationRegion', e.target.value)} disabled={demo || !f.province}>
              <option value="">{f.province ? '— Auto from province —' : 'Enter province below'}</option>
              {regionOpts.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <div style={{ fontSize: '0.72rem', color: '#8292ac', marginTop: 4 }}>Auto-selected from the address — the same regions collectors use for alerts.</div>
          </Field>
          <Field label="Store Status"><select style={inp} value={f.status} onChange={e => set('status', e.target.value)}><option value="setup">Setup</option><option value="active">Active</option><option value="temporarily_closed">Temporarily closed</option></select></Field>
        </Section>

        <Section title="Primary Location (official address)">
          <Field label="Location Name"><input style={inp} value={f.locationName} onChange={e => set('locationName', e.target.value)} placeholder="Highland Square" autoComplete="off" /></Field>
          <Field label="Address Line 1 *"><input style={inp} name="address-line1" autoComplete="address-line1" value={f.address1} onChange={e => set('address1', e.target.value)} placeholder="Start typing — your browser can autofill" disabled={demo} /></Field>
          <Field label="Address Line 2"><input style={inp} name="address-line2" autoComplete="address-line2" value={f.address2} onChange={e => set('address2', e.target.value)} disabled={demo} /></Field>
          <Field label="Town / City *">
            <div style={{ position: 'relative' }}>
              <input style={inp} name="city" autoComplete="off" value={f.city} onChange={e => onCityType(e.target.value)} onFocus={() => cityResults.length && setCityOpen(true)} placeholder="Start typing a town…" />
              {cityOpen && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, background: '#fff', border: '1px solid #dde3ef', borderRadius: 10, marginTop: 4, maxHeight: 220, overflowY: 'auto', boxShadow: '0 10px 28px rgba(20,40,80,0.16)' }}>
                  {cityResults.map(c => (
                    <button key={c.id} type="button" onClick={() => pickCity(c)} style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, borderBottom: '1px solid #f0f2f6', background: 'none', padding: '8px 12px', cursor: 'pointer', fontSize: '0.85rem', color: '#17253d' }}>
                      {c.name} <span style={{ color: '#8292ac' }}>· {c.provinceName || c.province}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Field>
          <Field label="Province / State *"><input style={inp} name="province" autoComplete="address-level1" value={f.province} onChange={e => setProvince(e.target.value)} onBlur={e => setProvince(e.target.value)} placeholder="NS" disabled={demo} /></Field>
          <Field label="Postal / ZIP"><input style={inp} name="postal-code" autoComplete="postal-code" value={f.postal} onChange={e => set('postal', e.target.value)} disabled={demo} /></Field>
          <Field label="Country"><input style={inp} name="country" autoComplete="country-name" value={f.country} onChange={e => set('country', e.target.value)} disabled={demo} /></Field>
          <Field label="Time Zone"><input style={inp} value={f.timeZone} onChange={e => set('timeZone', e.target.value)} /></Field>
          <Field label="Currency"><input style={inp} value={f.currency} onChange={e => set('currency', e.target.value)} /></Field>
          <Field label="Default Tax">{f.province && taxForProvince(f.province) ? `${(taxForProvince(f.province).rate * 100).toFixed(2).replace(/\.00$/, '')}% ${taxForProvince(f.province).label}` : 'Set by province'}</Field>
        </Section>

        <Section title="Location Config">
          <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {[['public_profile', 'Public store profile'], ['marketplace', 'Marketplace enabled'], ['trade_ins', 'Trade-ins'], ['pickup', 'Pickup'], ['dropoff', 'Drop-off'], ['layaway', 'Layaway'], ['preorder', 'Pre-orders'], ['inventory_public', 'Inventory public']].map(([k, l]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.84rem', color: '#3d4b63', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!f.config[k]} onChange={() => setCfg(k)} />{l}
              </label>
            ))}
          </div>
        </Section>

        {error && <div style={{ color: '#b91c1c', fontSize: '0.83rem', marginTop: 6 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" style={btnSecondary} onClick={onClose}>Cancel</button>
          <button type="submit" style={{ ...btnPrimary, opacity: busy ? 0.5 : 1 }} disabled={busy}>{busy ? 'Creating…' : 'Create Store'}</button>
        </div>
        </form>
      </div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#8292ac', marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{children}</div>
    </div>
  )
}
function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '0.74rem', fontWeight: 600, color: '#5f7294', marginBottom: 4 }}>{label}</label>
      {typeof children === 'string' ? <div style={{ fontSize: '0.85rem', color: '#17253d', padding: '4px 0' }}>{children}</div> : children}
    </div>
  )
}
function statusBadge(status) {
  const map = { active: ['#15803d', '#f0fdf4', '#bbf7d0'], setup: ['#b45309', '#fffbeb', '#fde68a'], temporarily_closed: ['#6b7280', '#f3f4f6', '#e5e7eb'], suspended: ['#b91c1c', '#fef2f2', '#fecaca'], archived: ['#6b7280', '#f3f4f6', '#e5e7eb'] }
  const [c, bg, b] = map[status] || map.active
  return { fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: bg, color: c, border: `1px solid ${b}`, textTransform: 'capitalize' }
}

// Head-office Location management — view locations and edit the OFFICIAL address
// (organisation-owned, audited). This is where address changes happen — not the
// store POS, where the address is read-only.
function LocationsModal({ store, onClose }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null) // location id being edited
  const [form, setForm] = useState({ address1: '', address2: '', city: '', province: '', postal: '', country: 'Canada' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      if (store.demo) { if (!cancelled) { setRows([]); setLoading(false) }; return }
      const r = await loadStoreLocations(store.storeId)
      if (!cancelled) { setRows(r); setLoading(false) }
    }, 0)
    return () => { cancelled = true; clearTimeout(t) }
  }, [store.storeId, store.demo, reloadKey])

  const startEdit = (l) => {
    setEditing(l.id); setError('')
    setForm({ address1: l.street_address || '', address2: l.address_line2 || '', city: l.city || '', province: l.province || '', postal: l.postal_code || '', country: l.country || 'Canada' })
  }
  const save = async () => {
    setError(''); setBusy(true)
    try { await updateLocationAddress(editing, form); setEditing(null); setReloadKey(k => k + 1) }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(9,18,40,0.45)', zIndex: 200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 20px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: 22, width: '100%', maxWidth: 560 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h2 style={{ ...h2, margin: 0 }}>Locations — {store.storeName}</h2>
          <button type="button" onClick={onClose} style={{ border: 0, background: 'none', fontSize: '1.3rem', color: '#8292ac', cursor: 'pointer' }}>✕</button>
        </div>
        <p style={{ fontSize: '0.8rem', color: '#8292ac', marginTop: 0 }}>The official address is head-office data. Editing it here is audited and re-triggers geocoding. Store staff can only view it.</p>

        {store.demo ? (
          <div style={empty}>Demo store — no persisted locations. Create a real organisation to manage official addresses.</div>
        ) : loading ? (
          <div style={empty}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={empty}>No locations. A store&apos;s primary location is created with the store (Create Store).</div>
        ) : rows.map(l => (
          <div key={l.id} style={{ ...row, flexDirection: 'column', alignItems: 'stretch', gap: 10, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: '#17253d', fontSize: '0.9rem' }}>{l.location_name}</div>
                <div style={{ fontSize: '0.8rem', color: '#5f7294' }}>
                  {[l.street_address, l.address_line2, l.city, l.province, l.postal_code, l.country].filter(Boolean).join(', ') || 'No address set'}
                </div>
              </div>
              {editing !== l.id && <button type="button" style={{ ...btnPrimary, padding: '7px 12px', flexShrink: 0 }} onClick={() => startEdit(l)}>Edit Official Address</button>}
            </div>
            {editing === l.id && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, borderTop: '1px solid #eef1f6', paddingTop: 10 }}>
                <div style={{ gridColumn: '1 / -1' }}><label style={lblSm}>Address Line 1</label><input style={inp} name="address-line1" autoComplete="address-line1" value={form.address1} onChange={e => setForm(f => ({ ...f, address1: e.target.value }))} /></div>
                <div style={{ gridColumn: '1 / -1' }}><label style={lblSm}>Address Line 2</label><input style={inp} name="address-line2" autoComplete="address-line2" value={form.address2} onChange={e => setForm(f => ({ ...f, address2: e.target.value }))} /></div>
                <div><label style={lblSm}>City / Town</label><input style={inp} name="city" autoComplete="address-level2" value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} /></div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div><label style={lblSm}>Province</label><input style={inp} name="province" autoComplete="address-level1" value={form.province} onChange={e => setForm(f => ({ ...f, province: e.target.value }))} /></div>
                  <div><label style={lblSm}>Postal</label><input style={inp} name="postal-code" autoComplete="postal-code" value={form.postal} onChange={e => setForm(f => ({ ...f, postal: e.target.value }))} /></div>
                </div>
                <div><label style={lblSm}>Country</label><input style={inp} name="country" autoComplete="country-name" value={form.country} onChange={e => setForm(f => ({ ...f, country: e.target.value }))} /></div>
                {error && <div style={{ gridColumn: '1 / -1', color: '#b91c1c', fontSize: '0.82rem' }}>{error}</div>}
                <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button type="button" style={btnSecondary} onClick={() => setEditing(null)}>Cancel</button>
                  <button type="button" style={{ ...btnPrimary, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save Address'}</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

const lblSm = { display: 'block', fontSize: '0.72rem', fontWeight: 600, color: '#5f7294', marginBottom: 3 }

function StaffModal({ store, onClose }) {
  const [form, setForm] = useState({ firstName: '', lastName: '', role: 'cashier', pin: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState(null) // { username, pin }
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const add = async () => {
    setError(''); setCreated(null); setBusy(true)
    try {
      const emp = await createStoreEmployee({ storeId: store.storeId, firstName: form.firstName, lastName: form.lastName, role: form.role, pin: form.pin })
      setCreated({ username: emp.username, pin: form.pin })
      setForm({ firstName: '', lastName: '', role: 'cashier', pin: '' })
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(9,18,40,0.45)', zIndex: 200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 20px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: 22, width: '100%', maxWidth: 520 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ ...h2, margin: 0 }}>Add staff — {store.storeName}</h2>
          <button type="button" onClick={onClose} style={{ border: 0, background: 'none', fontSize: '1.3rem', color: '#8292ac', cursor: 'pointer' }}>✕</button>
        </div>
        <p style={{ fontSize: '0.8rem', color: '#8292ac', marginTop: 0 }}>Add a POS login for this store. Staff sign in at Store POS with store code <strong>{store.storeCode}</strong>, their username, and PIN.</p>

        {created && (
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: '0.84rem', color: '#15803d' }}>
            Login created. Store code <strong>{store.storeCode}</strong> · username <strong>@{created.username}</strong> · PIN <strong>{created.pin}</strong>. Save these — the PIN isn&apos;t shown again.
          </div>
        )}

        <div style={{ borderTop: '1px solid #eef1f6', paddingTop: 14 }}>
          <div style={{ fontWeight: 700, fontSize: '0.86rem', color: '#17253d', marginBottom: 10 }}>Add a POS login</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <input placeholder="First name" value={form.firstName} onChange={e => set('firstName', e.target.value)} style={inp} />
            <input placeholder="Last name" value={form.lastName} onChange={e => set('lastName', e.target.value)} style={inp} />
            <select value={form.role} onChange={e => set('role', e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
              {ORG_EMPLOYEE_ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <input placeholder="PIN (min 4)" value={form.pin} onChange={e => set('pin', e.target.value)} style={inp} />
          </div>
          {error && <div style={{ color: '#b91c1c', fontSize: '0.82rem', marginTop: 8 }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" disabled={busy} onClick={add} style={{ ...btnPrimary, opacity: busy ? 0.5 : 1 }}>{busy ? 'Creating…' : 'Add login'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Light styles used by the (white) modals.
const h2 = { fontFamily: 'var(--font-display)', fontSize: '1.05rem', fontWeight: 700, color: '#17253d', margin: '0 0 12px' }
const empty = { textAlign: 'center', padding: 30, color: '#5f7294', border: '1px dashed #d9e0ec', borderRadius: 14, marginBottom: 26 }
const row = { display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', background: '#fff', border: '1px solid #e4e9f2', borderRadius: 12 }
const inp = { padding: '9px 12px', borderRadius: 9, border: '1.5px solid #d9e0ec', fontSize: '0.9rem' }
const btnPrimary = { background: '#17253d', color: '#fff', border: 0, borderRadius: 9, padding: '8px 16px', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer', fontFamily: 'var(--font-ui)' }
const btnSecondary = { background: '#fff', color: '#5f7294', border: '1.5px solid #d9e0ec', borderRadius: 9, padding: '8px 16px', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer', fontFamily: 'var(--font-ui)' }

// ── Enterprise dark shell tokens + styles ────────────────────────────────────
const INK = '#172235', SUB = '#5b6677', FAINT = '#8a94a3', CYAN = '#d6a632'
const PANEL = '#ffffff', FIELD = '#ffffff', BORDER = '#e2e8f0', BORDER_STR = '#cbd5e1'
const optDark = { color: '#172235', backgroundColor: '#ffffff' }
const eth = { padding: '8px 10px', fontWeight: 700, color: FAINT, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'left' }
const etd = { padding: '11px 10px', color: SUB, verticalAlign: 'middle' }
const ent = {
  shell: { display: 'flex', minHeight: '100svh', background: '#0a1120' },
  sidebar: { width: 216, flexShrink: 0, background: 'linear-gradient(180deg,#0a1428,#0c1830)', borderRight: `1px solid ${BORDER}`, display: 'flex', flexDirection: 'column', position: 'sticky', top: 0, height: '100svh' },
  navBtn: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 11px', background: 'none', border: 0, borderRadius: 9, color: 'rgba(23,34,53,0.6)', fontSize: '0.83rem', fontWeight: 600, cursor: 'pointer', textAlign: 'left', marginBottom: 2, fontFamily: 'var(--font-ui)' },
  navBtnOn: { background: 'rgba(56,197,255,0.14)', color: '#1f4f8f', fontWeight: 700 },
  logout: { width: '100%', background: 'none', border: `1px solid ${BORDER_STR}`, color: 'rgba(23,34,53,0.6)', borderRadius: 8, padding: '8px', cursor: 'pointer', fontSize: '0.8rem', fontFamily: 'var(--font-ui)' },
  main: { flex: 1, minWidth: 0, padding: '24px 32px', maxWidth: 1440 },
  demoStrip: { background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)', color: '#b45309', borderRadius: 10, padding: '9px 14px', fontSize: '0.82rem', marginBottom: 16 },
  pageHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 18, flexWrap: 'wrap' },
  h1: { fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 800, color: INK, margin: 0 },
  h2: { fontFamily: 'var(--font-display)', fontSize: '1.05rem', fontWeight: 700, color: INK, margin: '0 0 12px' },
  infoStrip: { color: SUB, fontSize: '0.85rem', margin: '4px 0 0' },
  kpiGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginBottom: 18 },
  kpi: { textAlign: 'left', background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '14px 16px', fontFamily: 'inherit' },
  twoCol: { display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 14, marginBottom: 18 },
  panel: { background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16 },
  panelTitle: { fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: FAINT, marginBottom: 12 },
  attnRow: { display: 'flex', alignItems: 'center', gap: 10, background: FIELD, border: `1px solid ${BORDER}`, borderRadius: 9, padding: '10px 12px', cursor: 'pointer', fontSize: '0.85rem', fontFamily: 'inherit' },
  filters: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 },
  search: { flex: '0 1 240px', padding: '9px 12px', borderRadius: 9, border: `1px solid ${BORDER_STR}`, background: FIELD, color: INK, fontSize: '0.86rem' },
  select: { padding: '9px 12px', borderRadius: 9, border: `1px solid ${BORDER_STR}`, background: FIELD, color: INK, fontSize: '0.84rem', cursor: 'pointer' },
  clearFilter: { padding: '8px 12px', borderRadius: 9, border: '1px solid rgba(214,166,50,0.4)', background: 'transparent', color: CYAN, fontSize: '0.8rem', cursor: 'pointer' },
  thRow: { borderBottom: `1px solid ${BORDER}` },
  tr: { borderBottom: `1px solid rgba(23,34,53,0.05)` },
  empty: { textAlign: 'center', padding: 26, color: SUB, background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 12 },
  primary: { background: CYAN, color: '#0b111b', border: 0, borderRadius: 9, padding: '9px 16px', fontWeight: 800, fontSize: '0.82rem', cursor: 'pointer', fontFamily: 'var(--font-ui)' },
  ghost: { background: FIELD, color: INK, border: `1px solid ${BORDER_STR}`, borderRadius: 9, padding: '9px 14px', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer', fontFamily: 'var(--font-ui)' },
  rowPrimary: { background: CYAN, color: '#0b111b', border: 0, borderRadius: 8, padding: '6px 12px', fontWeight: 800, fontSize: '0.78rem', cursor: 'pointer' },
  rowGhost: { background: 'transparent', color: SUB, border: `1px solid ${BORDER_STR}`, borderRadius: 8, padding: '6px 12px', fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer', marginLeft: 6 },
  menu: { position: 'absolute', right: 0, top: '100%', marginTop: 4, background: '#ffffff', border: `1px solid ${BORDER_STR}`, borderRadius: 10, padding: 6, minWidth: 190, zIndex: 20, boxShadow: '0 10px 30px rgba(0,0,0,0.4)' },
  menuItem: { display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 0, color: INK, padding: '8px 10px', borderRadius: 7, cursor: 'pointer', fontSize: '0.82rem', fontFamily: 'var(--font-ui)' },
  attachRow: { display: 'flex', alignItems: 'center', gap: 12, background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '12px 14px' },
}
