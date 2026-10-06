import { useEffect, useRef, useState } from 'react'
import {
  orgLocations, createOrgLocation, updateLocationAddress, orgStaff,
  orgInventoryKpis, orgInventory, listOrgTransfers, requestInventoryTransfer, setTransferStatus, searchCommunities,
  orgOrderKpis, orgOrders, orgTradeinKpis, orgTradeins, orgSalesKpis, orgSalesByStore,
  orgPromotionsEvents, saveOrgPromotionEvent, orgPolicies, saveOrgPolicy, orgReportSummary, orgIntegrations, saveOrgIntegration,
  allCatalogueCategories, orgAllowedCategories, setOrgAllowedCategories,
  loadOrganizationInfo, uploadOrganizationBrandingImage, saveOrganizationBranding,
} from './orgApi'
import { taxForProvince } from './orgApi'
import { regionNameById } from './notificationRegions'

// Head-office Phase 1 modules (Locations, Staff, Inventory) — tenant-scoped
// org-wide views over the existing store/location/employee/inventory data.

// ── Shared dark enterprise tokens ───────────────────────────────────────────
const INK = '#172235', SUB = '#5b6677', FAINT = '#8a94a3', CYAN = '#d6a632'
const PANEL = '#ffffff', FIELD = '#ffffff', BORDER = '#e2e8f0', BORDER_STR = '#cbd5e1'
const optDark = { color: '#172235', backgroundColor: '#ffffff' }
const m = {
  h1: { fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 800, color: INK, margin: 0 },
  desc: { color: SUB, fontSize: '0.85rem', margin: '4px 0 16px' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' },
  filters: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 },
  search: { flex: '0 1 220px', padding: '9px 12px', borderRadius: 9, border: `1px solid ${BORDER_STR}`, background: FIELD, color: INK, fontSize: '0.86rem' },
  select: { padding: '9px 12px', borderRadius: 9, border: `1px solid ${BORDER_STR}`, background: FIELD, color: INK, fontSize: '0.84rem', cursor: 'pointer' },
  primary: { background: CYAN, color: '#0b111b', border: 0, borderRadius: 9, padding: '9px 16px', fontWeight: 800, fontSize: '0.82rem', cursor: 'pointer' },
  ghost: { background: FIELD, color: INK, border: `1px solid ${BORDER_STR}`, borderRadius: 8, padding: '6px 12px', fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer' },
  chip: { padding: '6px 12px', borderRadius: 20, border: `1px solid ${BORDER}`, background: 'transparent', color: SUB, fontWeight: 600, fontSize: '0.78rem', cursor: 'pointer' },
  chipOn: { background: 'rgba(214,166,50,0.16)', color: '#1f4f8f', borderColor: 'rgba(214,166,50,0.5)' },
  panel: { background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16 },
  kpi: { background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '12px 14px' },
  kpiGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10, marginBottom: 16 },
  empty: { textAlign: 'center', padding: 26, color: SUB, background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 12 },
  th: { padding: '8px 10px', fontWeight: 700, color: FAINT, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'left' },
  td: { padding: '10px 10px', color: SUB, verticalAlign: 'middle', fontSize: '0.85rem' },
  tr: { borderBottom: `1px solid rgba(23,34,53,0.05)` },
  h2: { fontFamily: 'var(--font-display)', fontSize: '1.05rem', fontWeight: 700, color: INK, margin: '18px 0 12px' },
  inp: { width: '100%', padding: '9px 12px', borderRadius: 9, border: `1px solid ${BORDER_STR}`, background: FIELD, color: INK, fontSize: '0.86rem' },
  lbl: { display: 'block', fontSize: '0.72rem', fontWeight: 600, color: SUB, marginBottom: 4 },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(11,17,27,0.42)', zIndex: 200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 20px', overflowY: 'auto' },
  modal: { background: '#ffffff', border: `1px solid ${BORDER_STR}`, borderRadius: 16, padding: 22, width: '100%', maxWidth: 560 },
}
const statusBadge = (s) => {
  const map = { active: ['#15803d', 'rgba(74,222,128,0.12)'], setup: ['#b45309', 'rgba(245,158,11,0.14)'], inactive: ['#9ca3af', 'rgba(156,163,175,0.14)'], invited: ['#1f4f8f', 'rgba(214,166,50,0.14)'] }
  const [c, bg] = map[s] || map.active
  return { fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 5, color: c, background: bg, textTransform: 'capitalize' }
}
const money = (n) => n == null ? '—' : `$${Number(n).toFixed(2)}`

function KpiCard({ label, value, tone }) {
  return <div style={m.kpi}><div style={{ fontFamily: 'var(--font-display)', fontSize: '1.35rem', fontWeight: 800, color: tone || INK }}>{value}</div><div style={{ fontSize: '0.66rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: SUB, marginTop: 2 }}>{label}</div></div>
}

const blankScope = () => ({ regionId: '', storeId: '', locationId: '', dateFrom: '', dateTo: '' })

function EnterpriseScopeControls({ orgId, stores, scope, onScopeChange, showDate = false }) {
  const [locations, setLocations] = useState([])

  useEffect(() => {
    let cancelled = false
    orgLocations(orgId).then(rows => { if (!cancelled) setLocations(rows || []) })
    return () => { cancelled = true }
  }, [orgId])

  const realStores = (stores || []).filter(s => !s.demo)
  const regions = []
  const regionSeen = new Set()
  for (const s of realStores) {
    if (!s.regionId || regionSeen.has(s.regionId)) continue
    regionSeen.add(s.regionId)
    regions.push({ id: s.regionId, name: s.regionName || 'Unnamed Region' })
  }
  regions.sort((a, b) => a.name.localeCompare(b.name))

  const scopedStores = scope.regionId ? realStores.filter(s => s.regionId === scope.regionId) : realStores
  const scopedLocations = locations
    .filter(l => !scope.regionId || l.storeId && scopedStores.some(s => s.storeId === l.storeId))
    .filter(l => !scope.storeId || l.storeId === scope.storeId)

  const patchScope = (patch) => onScopeChange({ ...scope, ...patch })
  const pickRegion = (regionId) => {
    const nextStores = regionId ? realStores.filter(s => s.regionId === regionId) : realStores
    const storeStillValid = scope.storeId && nextStores.some(s => s.storeId === scope.storeId)
    patchScope({ regionId, storeId: storeStillValid ? scope.storeId : '', locationId: '' })
  }
  const pickStore = (storeId) => {
    const store = realStores.find(s => s.storeId === storeId)
    patchScope({ storeId, regionId: store?.regionId || scope.regionId || '', locationId: '' })
  }
  const pickLocation = (locationId) => {
    const loc = locations.find(l => l.locationId === locationId)
    const store = loc ? realStores.find(s => s.storeId === loc.storeId) : null
    patchScope({ locationId, storeId: loc?.storeId || scope.storeId || '', regionId: store?.regionId || scope.regionId || '' })
  }

  return (
    <div style={{ ...m.panel, marginBottom: 14, padding: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select style={m.select} value={scope.regionId || ''} onChange={e => pickRegion(e.target.value)}>
          <option value="" style={optDark}>All regions</option>
          {regions.map(r => <option key={r.id} value={r.id} style={optDark}>{r.name}</option>)}
        </select>
        <select style={m.select} value={scope.storeId || ''} onChange={e => pickStore(e.target.value)}>
          <option value="" style={optDark}>All stores</option>
          {scopedStores.map(s => <option key={s.storeId} value={s.storeId} style={optDark}>{s.storeName}</option>)}
        </select>
        <select style={m.select} value={scope.locationId || ''} onChange={e => pickLocation(e.target.value)}>
          <option value="" style={optDark}>All locations</option>
          {scopedLocations.map(l => <option key={l.locationId} value={l.locationId} style={optDark}>{l.storeName} · {l.name}</option>)}
        </select>
        {showDate && (
          <>
            <input style={{ ...m.search, flexBasis: 150 }} type="date" value={scope.dateFrom || ''} onChange={e => patchScope({ dateFrom: e.target.value })} />
            <input style={{ ...m.search, flexBasis: 150 }} type="date" value={scope.dateTo || ''} onChange={e => patchScope({ dateTo: e.target.value })} />
          </>
        )}
        {(scope.regionId || scope.storeId || scope.locationId || scope.dateFrom || scope.dateTo) && (
          <button type="button" style={m.ghost} onClick={() => onScopeChange(blankScope())}>Clear scope</button>
        )}
      </div>
    </div>
  )
}

// ── LOCATIONS ────────────────────────────────────────────────────────────────
export function LocationsModule({ orgId, stores }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState(blankScope())
  const [reloadKey, setReloadKey] = useState(0)
  const [creating, setCreating] = useState(false)
  const [editAddr, setEditAddr] = useState(null)

  useEffect(() => {
    let c = false
    const t = setTimeout(async () => { setLoading(true); const r = await orgLocations(orgId, scope, search); if (!c) { setRows(r); setLoading(false) } }, search ? 300 : 0)
    return () => { c = true; clearTimeout(t) }
  }, [orgId, scope, search, reloadKey])

  const realStores = (stores || []).filter(s => !s.demo)

  return (
    <div>
      <div style={m.head}>
        <div><h1 style={m.h1}>Locations</h1><p style={m.desc}>Every physical operating location across the organisation. Official addresses are head-office controlled.</p></div>
        <button type="button" style={m.primary} onClick={() => setCreating(true)}>+ Create Location</button>
      </div>
      <EnterpriseScopeControls orgId={orgId} stores={stores} scope={scope} onScopeChange={setScope} />
      <div style={m.filters}><input style={m.search} placeholder="Search locations…" value={search} onChange={e => setSearch(e.target.value)} /></div>

      {loading ? <div style={m.empty}>Loading…</div>
        : rows.length === 0 ? <div style={m.empty}>No locations have been created yet.</div>
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                <th style={m.th}>Location</th><th style={m.th}>Store</th><th style={m.th}>Region</th><th style={m.th}>Official Address</th>
                <th style={m.th}>Staff</th><th style={m.th}>Inventory</th><th style={m.th}>Tax</th><th style={m.th}>Services</th><th style={m.th}>Status</th><th style={{ ...m.th, textAlign: 'right' }}>Actions</th>
              </tr></thead>
              <tbody>
                {rows.map(l => (
                  <tr key={l.locationId} style={m.tr}>
                    <td style={{ ...m.td, color: INK, fontWeight: 700 }}>{l.name}</td>
                    <td style={m.td}>{l.storeName}</td>
                    <td style={m.td}>{regionNameById(l.regionId) || <span style={{ color: FAINT }}>—</span>}</td>
                    <td style={m.td}>{[l.address1, l.city, l.province, l.postal].filter(Boolean).join(', ') || <span style={{ color: '#b45309' }}>Not set</span>}{l.geocodeStatus === 'pending' && l.address1 ? <span style={{ color: FAINT, fontSize: '0.7rem' }}> · geocode pending</span> : null}</td>
                    <td style={m.td}>{l.staffCount}</td>
                    <td style={m.td}>{l.inventoryCount}</td>
                    <td style={m.td}>{l.taxRate != null ? `${(l.taxRate * 100).toFixed(2).replace(/\.00$/, '')}% ${l.taxLabel || ''}` : '—'}</td>
                    <td style={m.td}>{Object.entries(l.services).filter(([, v]) => v).map(([k]) => k).join(' · ') || '—'}</td>
                    <td style={m.td}><span style={statusBadge(l.status)}>{l.status}</span></td>
                    <td style={{ ...m.td, textAlign: 'right', whiteSpace: 'nowrap' }}><button type="button" style={m.ghost} onClick={() => setEditAddr(l)}>Edit Address</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {creating && <CreateLocationModal stores={realStores} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); setReloadKey(k => k + 1) }} />}
      {editAddr && <EditAddressModal location={editAddr} onClose={() => setEditAddr(null)} onSaved={() => { setEditAddr(null); setReloadKey(k => k + 1) }} />}
    </div>
  )
}

function CityInput({ value, onPick, onType, disabled }) {
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const timer = useRef(null)
  const type = (v) => {
    onType(v); clearTimeout(timer.current)
    if (v.trim().length < 2) { setResults([]); setOpen(false); return }
    timer.current = setTimeout(async () => { const r = await searchCommunities(v); setResults(r); setOpen(r.length > 0) }, 220)
  }
  return (
    <div style={{ position: 'relative' }}>
      <input style={m.inp} value={value} disabled={disabled} onChange={e => type(e.target.value)} placeholder="Start typing a town…" />
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, background: '#ffffff', border: `1px solid ${BORDER_STR}`, borderRadius: 10, marginTop: 4, maxHeight: 200, overflowY: 'auto' }}>
          {results.map(c => (
            <button key={c.id} type="button" onClick={() => { onPick(c); setOpen(false) }} style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, borderBottom: `1px solid ${BORDER}`, background: 'none', padding: '8px 12px', cursor: 'pointer', fontSize: '0.85rem', color: INK }}>
              {c.name} <span style={{ color: FAINT }}>· {c.provinceName || c.province}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function CreateLocationModal({ stores, onClose, onCreated }) {
  const [f, setF] = useState({ storeId: stores[0]?.storeId || '', name: 'Primary Location', address1: '', address2: '', city: '', province: '', postal: '', country: 'Canada', timeZone: 'America/Halifax', currency: 'CAD', latitude: null, longitude: null })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))
  const pick = (c) => setF(p => ({ ...p, city: c.name, province: c.province, latitude: c.latitude, longitude: c.longitude }))
  const submit = async () => {
    setError('')
    if (!f.storeId) { setError('Pick a store.'); return }
    if (!f.address1.trim() || !f.city.trim() || !f.province.trim()) { setError('Address line 1, city and province are required.'); return }
    setBusy(true)
    try { const t = taxForProvince(f.province); await createOrgLocation(f.storeId, { ...f, taxRate: t?.rate ?? null, taxLabel: t?.label ?? null }); onCreated() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return (
    <div onClick={onClose} style={m.overlay}>
      <div onClick={e => e.stopPropagation()} style={m.modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ ...m.h2, margin: 0 }}>Create Location</h2>
          <button type="button" onClick={onClose} style={{ border: 0, background: 'none', color: FAINT, fontSize: '1.3rem', cursor: 'pointer' }}>✕</button>
        </div>
        {stores.length === 0 ? <div style={m.empty}>Create a store first — locations belong to a store.</div> : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ gridColumn: '1 / -1' }}><label style={m.lbl}>Store *</label><select style={m.inp} value={f.storeId} onChange={e => set('storeId', e.target.value)}>{stores.map(s => <option key={s.storeId} value={s.storeId} style={optDark}>{s.storeName}</option>)}</select></div>
            <div style={{ gridColumn: '1 / -1' }}><label style={m.lbl}>Location Name</label><input style={m.inp} value={f.name} onChange={e => set('name', e.target.value)} /></div>
            <div style={{ gridColumn: '1 / -1' }}><label style={m.lbl}>Town / City *</label><CityInput value={f.city} onType={v => set('city', v)} onPick={pick} /></div>
            <div style={{ gridColumn: '1 / -1' }}><label style={m.lbl}>Address Line 1 *</label><input style={m.inp} name="address-line1" autoComplete="address-line1" value={f.address1} onChange={e => set('address1', e.target.value)} /></div>
            <div><label style={m.lbl}>Province *</label><input style={m.inp} name="province" autoComplete="address-level1" value={f.province} onChange={e => set('province', e.target.value.toUpperCase())} /></div>
            <div><label style={m.lbl}>Postal</label><input style={m.inp} name="postal-code" autoComplete="postal-code" value={f.postal} onChange={e => set('postal', e.target.value)} /></div>
            <div style={{ gridColumn: '1 / -1', fontSize: '0.74rem', color: FAINT }}>{f.province && taxForProvince(f.province) ? `Tax: ${(taxForProvince(f.province).rate * 100).toFixed(2).replace(/\.00$/, '')}% ${taxForProvince(f.province).label}` : 'Tax defaults from province'}{f.latitude ? ' · geocoded' : ''}</div>
          </div>
        )}
        {error && <div style={{ color: '#b91c1c', fontSize: '0.83rem', marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" style={m.ghost} onClick={onClose}>Cancel</button>
          {stores.length > 0 && <button type="button" style={{ ...m.primary, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Create Location'}</button>}
        </div>
      </div>
    </div>
  )
}

function EditAddressModal({ location, onClose, onSaved }) {
  const [f, setF] = useState({ address1: location.address1 || '', address2: '', city: location.city || '', province: location.province || '', postal: location.postal || '', country: location.country || 'Canada' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))
  const save = async () => { setBusy(true); setError(''); try { await updateLocationAddress(location.locationId, f); onSaved() } catch (e) { setError(e.message) } finally { setBusy(false) } }
  return (
    <div onClick={onClose} style={m.overlay}>
      <div onClick={e => e.stopPropagation()} style={m.modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ ...m.h2, margin: 0 }}>Edit Official Address — {location.name}</h2>
          <button type="button" onClick={onClose} style={{ border: 0, background: 'none', color: FAINT, fontSize: '1.3rem', cursor: 'pointer' }}>✕</button>
        </div>
        <p style={{ fontSize: '0.8rem', color: SUB, marginTop: 0 }}>Head-office only. Audited; re-triggers geocoding.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ gridColumn: '1 / -1' }}><label style={m.lbl}>Address Line 1</label><input style={m.inp} name="address-line1" autoComplete="address-line1" value={f.address1} onChange={e => set('address1', e.target.value)} /></div>
          <div><label style={m.lbl}>City</label><input style={m.inp} name="city" autoComplete="address-level2" value={f.city} onChange={e => set('city', e.target.value)} /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div><label style={m.lbl}>Province</label><input style={m.inp} name="province" autoComplete="address-level1" value={f.province} onChange={e => set('province', e.target.value.toUpperCase())} /></div>
            <div><label style={m.lbl}>Postal</label><input style={m.inp} name="postal-code" autoComplete="postal-code" value={f.postal} onChange={e => set('postal', e.target.value)} /></div>
          </div>
        </div>
        {error && <div style={{ color: '#b91c1c', fontSize: '0.83rem', marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" style={m.ghost} onClick={onClose}>Cancel</button>
          <button type="button" style={{ ...m.primary, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save Address'}</button>
        </div>
      </div>
    </div>
  )
}

// ── STAFF ────────────────────────────────────────────────────────────────────
export function StaffModule({ orgId, stores }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState(blankScope())
  const [roleFilter, setRoleFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')

  useEffect(() => {
    let c = false
    const t = setTimeout(async () => {
      setLoading(true)
      const r = await orgStaff(orgId, { scope, search, role: roleFilter === 'all' ? null : roleFilter, status: statusFilter === 'all' ? null : statusFilter })
      if (!c) { setRows(r); setLoading(false) }
    }, search ? 300 : 0)
    return () => { c = true; clearTimeout(t) }
  }, [orgId, scope, search, roleFilter, statusFilter])

  const roles = [...new Set(rows.map(r => r.role).filter(Boolean))]

  return (
    <div>
      <div style={m.head}><div><h1 style={m.h1}>Staff</h1><p style={m.desc}>Everyone across the organisation&apos;s stores. Staff log into each store&apos;s POS with their username + PIN.</p></div></div>
      <EnterpriseScopeControls orgId={orgId} stores={stores} scope={scope} onScopeChange={setScope} />
      <div style={m.filters}>
        <input style={m.search} placeholder="Search name or username…" value={search} onChange={e => setSearch(e.target.value)} />
        <select style={m.select} value={roleFilter} onChange={e => setRoleFilter(e.target.value)}><option value="all" style={optDark}>All roles</option>{roles.map(r => <option key={r} value={r} style={optDark}>{r}</option>)}</select>
        <select style={m.select} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>{['all', 'active', 'invited', 'inactive'].map(s => <option key={s} value={s} style={optDark}>{s === 'all' ? 'All statuses' : s}</option>)}</select>
      </div>
      {loading ? <div style={m.empty}>Loading…</div>
        : rows.length === 0 ? <div style={m.empty}>No staff yet. Add POS logins from a store&apos;s Staff panel.</div>
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                <th style={m.th}>Employee</th><th style={m.th}>Username</th><th style={m.th}>Role</th><th style={m.th}>Store</th><th style={m.th}>Locations</th><th style={m.th}>Status</th><th style={m.th}>Last Login</th>
              </tr></thead>
              <tbody>
                {rows.map(e => (
                  <tr key={e.id} style={m.tr}>
                    <td style={{ ...m.td, color: INK, fontWeight: 700 }}>{e.firstName} {e.lastName}</td>
                    <td style={m.td}>@{e.username}</td>
                    <td style={{ ...m.td, textTransform: 'capitalize' }}>{(e.role || '').replace(/_/g, ' ')}</td>
                    <td style={m.td}>{e.storeName}</td>
                    <td style={m.td}>{e.allLocations ? 'All' : 'Assigned'}</td>
                    <td style={m.td}><span style={statusBadge(e.status)}>{e.status}</span></td>
                    <td style={m.td}>{e.lastLogin ? new Date(e.lastLogin).toLocaleString() : <span style={{ color: FAINT }}>Never</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}

// ── INVENTORY ────────────────────────────────────────────────────────────────
export function InventoryModule({ orgId, stores }) {
  const [kpis, setKpis] = useState({})
  const [rows, setRows] = useState([])
  const [transfers, setTransfers] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState(blankScope())
  const [availability, setAvailability] = useState('')
  const [condition, setCondition] = useState('')
  const [lowStock, setLowStock] = useState(false)
  const [reserved, setReserved] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [xfer, setXfer] = useState(null) // inventory row to transfer

  useEffect(() => {
    let c = false
    const t = setTimeout(async () => {
      setLoading(true)
      const inventoryScope = { ...scope, availability, condition, lowStock, reserved }
      const [k, r, x] = await Promise.all([
        orgInventoryKpis(orgId, inventoryScope),
        orgInventory(orgId, { scope, search, lowStock, condition: condition || null, availability: availability || null, reserved, limit: 100 }),
        listOrgTransfers(orgId),
      ])
      if (c) return
      setKpis(k); setRows(r); setTransfers(x); setLoading(false)
    }, search ? 300 : 0)
    return () => { c = true; clearTimeout(t) }
  }, [orgId, scope, search, availability, condition, lowStock, reserved, reloadKey])

  const advance = async (id, status) => { await setTransferStatus(id, status); setReloadKey(k => k + 1) }

  return (
    <div>
      <div style={m.head}><div><h1 style={m.h1}>Inventory</h1><p style={m.desc}>Stock across the whole organisation. Aggregated server-side — not fetched wholesale.</p></div></div>
      <EnterpriseScopeControls orgId={orgId} stores={stores} scope={scope} onScopeChange={setScope} />

      <div style={m.kpiGrid}>
        <KpiCard label="SKUs" value={kpis.skus ?? 0} />
        <KpiCard label="On Hand" value={kpis.on_hand ?? 0} />
        <KpiCard label="Reserved" value={kpis.reserved ?? 0} tone="#6d28d9" />
        <KpiCard label="Available" value={kpis.available ?? 0} tone="#15803d" />
        <KpiCard label="Low Stock" value={kpis.low_stock ?? 0} tone="#b45309" />
        <KpiCard label="Out of Stock" value={kpis.out_of_stock ?? 0} tone="#b91c1c" />
        <KpiCard label="Unpublished" value={kpis.unpublished ?? 0} />
      </div>

      <div style={m.filters}>
        <input style={m.search} placeholder="Search item or SKU…" value={search} onChange={e => setSearch(e.target.value)} />
        <select style={m.select} value={availability} onChange={e => setAvailability(e.target.value)}><option value="" style={optDark}>All availability</option><option value="in_stock" style={optDark}>In stock</option><option value="out_of_stock" style={optDark}>Out of stock</option><option value="listed" style={optDark}>Listed</option><option value="unlisted" style={optDark}>Unlisted</option></select>
        <select style={m.select} value={condition} onChange={e => setCondition(e.target.value)}><option value="" style={optDark}>All conditions</option>{['Mint','Near Mint','Excellent','Good','Light Played','Played','Poor'].map(c => <option key={c} value={c} style={optDark}>{c}</option>)}</select>
        <button type="button" style={{ ...m.chip, ...(lowStock ? m.chipOn : {}) }} onClick={() => setLowStock(v => !v)}>Low stock</button>
        <button type="button" style={{ ...m.chip, ...(reserved ? m.chipOn : {}) }} onClick={() => setReserved(v => !v)}>Reserved</button>
      </div>

      {loading ? <div style={m.empty}>Loading…</div>
        : rows.length === 0 ? <div style={m.empty}>No inventory found{search || lowStock ? ' for this filter' : ''}.</div>
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                <th style={m.th}>Item</th><th style={m.th}>SKU</th><th style={m.th}>Cond.</th><th style={m.th}>Store</th>
                <th style={m.th}>On Hand</th><th style={m.th}>Reserved</th><th style={m.th}>Available</th><th style={m.th}>Price</th><th style={m.th}>Listed</th><th style={{ ...m.th, textAlign: 'right' }}>Actions</th>
              </tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.inventoryId} style={m.tr}>
                    <td style={{ ...m.td, color: INK, fontWeight: 700 }}>{r.name}</td>
                    <td style={m.td}>{r.sku}</td>
                    <td style={m.td}>{r.grade || r.condition || '—'}</td>
                    <td style={m.td}>{r.storeName}</td>
                    <td style={m.td}>{r.onHand}</td>
                    <td style={m.td}>{r.reserved}</td>
                    <td style={{ ...m.td, color: r.available <= 0 ? '#b91c1c' : r.available <= 3 ? '#b45309' : INK, fontWeight: 700 }}>{r.available}</td>
                    <td style={m.td}>{money(r.sellPrice)}</td>
                    <td style={m.td}>{r.listed ? '✓' : '—'}</td>
                    <td style={{ ...m.td, textAlign: 'right' }}><button type="button" style={m.ghost} onClick={() => setXfer(r)}>Transfer</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      <h2 style={m.h2}>Transfers</h2>
      {transfers.length === 0 ? <div style={m.empty}>No transfers yet.</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ borderBottom: `1px solid ${BORDER}` }}>
              <th style={m.th}>Item</th><th style={m.th}>From</th><th style={m.th}>To</th><th style={m.th}>Qty</th><th style={m.th}>Status</th><th style={{ ...m.th, textAlign: 'right' }}>Actions</th>
            </tr></thead>
            <tbody>
              {transfers.map(t => (
                <tr key={t.id} style={m.tr}>
                  <td style={{ ...m.td, color: INK }}>{t.item}</td><td style={m.td}>{t.from}</td><td style={m.td}>{t.to}</td><td style={m.td}>{t.quantity}</td>
                  <td style={m.td}><span style={statusBadge(t.status === 'received' ? 'active' : t.status === 'cancelled' ? 'inactive' : 'invited')}>{t.status.replace(/_/g, ' ')}</span></td>
                  <td style={{ ...m.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {t.status === 'requested' && <button type="button" style={m.ghost} onClick={() => advance(t.id, 'approved')}>Approve</button>}
                    {t.status === 'approved' && <button type="button" style={m.ghost} onClick={() => advance(t.id, 'in_transit')}>Ship</button>}
                    {t.status === 'in_transit' && <button type="button" style={{ ...m.primary, padding: '6px 12px' }} onClick={() => advance(t.id, 'received')}>Receive</button>}
                    {['requested', 'approved'].includes(t.status) && <button type="button" style={{ ...m.ghost, color: '#b91c1c', marginLeft: 6 }} onClick={() => advance(t.id, 'cancelled')}>Cancel</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {xfer && <TransferModal item={xfer} orgId={orgId} onClose={() => setXfer(null)} onDone={() => { setXfer(null); setReloadKey(k => k + 1) }} />}
    </div>
  )
}

function TransferModal({ item, orgId, onClose, onDone }) {
  const [locations, setLocations] = useState([])
  const [f, setF] = useState({ from: '', to: '', quantity: 1, notes: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { let c = false; orgLocations(orgId).then(ls => { if (!c) setLocations(ls.filter(l => l.storeId === item.storeId)) }); return () => { c = true } }, [orgId, item.storeId])
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))
  const submit = async () => {
    setError('')
    if (!f.from || !f.to || f.from === f.to) { setError('Pick different from/to locations (same store).'); return }
    setBusy(true)
    try { await requestInventoryTransfer(item.inventoryId, f.from, f.to, Number(f.quantity) || 1, f.notes); onDone() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return (
    <div onClick={onClose} style={m.overlay}>
      <div onClick={e => e.stopPropagation()} style={{ ...m.modal, maxWidth: 460 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ ...m.h2, margin: 0 }}>Transfer — {item.name}</h2>
          <button type="button" onClick={onClose} style={{ border: 0, background: 'none', color: FAINT, fontSize: '1.3rem', cursor: 'pointer' }}>✕</button>
        </div>
        <p style={{ fontSize: '0.8rem', color: SUB, marginTop: 0 }}>Between locations of {item.storeName}. Stock moves when the destination confirms receipt.</p>
        {locations.length < 2 ? <div style={m.empty}>This store needs at least two locations to transfer between.</div> : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div><label style={m.lbl}>From</label><select style={m.inp} value={f.from} onChange={e => set('from', e.target.value)}><option value="" style={optDark}>—</option>{locations.map(l => <option key={l.locationId} value={l.locationId} style={optDark}>{l.name}</option>)}</select></div>
            <div><label style={m.lbl}>To</label><select style={m.inp} value={f.to} onChange={e => set('to', e.target.value)}><option value="" style={optDark}>—</option>{locations.map(l => <option key={l.locationId} value={l.locationId} style={optDark}>{l.name}</option>)}</select></div>
            <div><label style={m.lbl}>Quantity</label><input style={m.inp} type="number" min={1} value={f.quantity} onChange={e => set('quantity', e.target.value)} /></div>
            <div style={{ gridColumn: '1 / -1' }}><label style={m.lbl}>Notes</label><input style={m.inp} value={f.notes} onChange={e => set('notes', e.target.value)} /></div>
          </div>
        )}
        {error && <div style={{ color: '#b91c1c', fontSize: '0.83rem', marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" style={m.ghost} onClick={onClose}>Cancel</button>
          {locations.length >= 2 && <button type="button" style={{ ...m.primary, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={submit}>{busy ? 'Requesting…' : 'Request Transfer'}</button>}
        </div>
      </div>
    </div>
  )
}

// ── ORDERS ───────────────────────────────────────────────────────────────────
const ORDER_STATUS = [['all', 'All'], ['open', 'Open'], ['partially_paid', 'Partially paid'], ['awaiting_inventory', 'Awaiting inventory'], ['ready_for_pickup', 'Ready for pickup'], ['fulfilled', 'Fulfilled'], ['cancelled', 'Cancelled']]
export function OrdersModule({ orgId, stores }) {
  const [kpis, setKpis] = useState({})
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [scope, setScope] = useState(blankScope())
  const [type, setType] = useState('all')
  const [status, setStatus] = useState('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    let c = false
    const t = setTimeout(async () => {
      setLoading(true)
      const orderScope = { ...scope, orderType: type === 'all' ? null : type, status: status === 'all' ? null : status }
      const [k, r] = await Promise.all([
        orgOrderKpis(orgId, orderScope),
        orgOrders(orgId, { scope: orderScope, type: type === 'all' ? null : type, status: status === 'all' ? null : status, search }),
      ])
      if (!c) { setKpis(k); setRows(r); setLoading(false) }
    }, search ? 300 : 0)
    return () => { c = true; clearTimeout(t) }
  }, [orgId, scope, type, status, search])

  return (
    <div>
      <div style={m.head}><div><h1 style={m.h1}>Orders</h1><p style={m.desc}>Pre-orders and layaways across the organisation. Reporting — fulfilment happens at the store.</p></div></div>
      <EnterpriseScopeControls orgId={orgId} stores={stores} scope={scope} onScopeChange={setScope} showDate />
      <div style={m.kpiGrid}>
        <KpiCard label="Ready for Pickup" value={kpis.ready_for_pickup ?? 0} tone="#38bdf8" />
        <KpiCard label="Awaiting Inventory" value={kpis.awaiting_inventory ?? 0} tone="#b45309" />
        <KpiCard label="Partially Paid" value={kpis.partially_paid ?? 0} />
        <KpiCard label="Overdue Layaways" value={kpis.overdue_layaways ?? 0} tone="#b91c1c" />
        <KpiCard label="Outstanding Layaway" value={money(kpis.outstanding_layaway)} />
        <KpiCard label="Outstanding Pre-Order" value={money(kpis.outstanding_preorder)} />
        <KpiCard label="Created Today" value={kpis.created_today ?? 0} tone="#15803d" />
      </div>
      <div style={m.filters}>
        <input style={m.search} placeholder="Search order # or customer…" value={search} onChange={e => setSearch(e.target.value)} />
        <select style={m.select} value={type} onChange={e => setType(e.target.value)}>{[['all', 'All types'], ['preorder', 'Pre-orders'], ['layaway', 'Layaways']].map(([v, l]) => <option key={v} value={v} style={optDark}>{l}</option>)}</select>
        <select style={m.select} value={status} onChange={e => setStatus(e.target.value)}>{ORDER_STATUS.map(([v, l]) => <option key={v} value={v} style={optDark}>{l}</option>)}</select>
      </div>
      {loading ? <div style={m.empty}>Loading…</div>
        : rows.length === 0 ? <div style={m.empty}>No orders match this scope.</div>
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: '1px solid ' + BORDER }}>
                <th style={m.th}>Order #</th><th style={m.th}>Type</th><th style={m.th}>Customer</th><th style={m.th}>Store</th><th style={m.th}>Total</th><th style={m.th}>Paid</th><th style={m.th}>Balance</th><th style={m.th}>Status</th><th style={m.th}>Due / Release</th>
              </tr></thead>
              <tbody>
                {rows.map(o => (
                  <tr key={o.id} style={m.tr}>
                    <td style={{ ...m.td, color: '#1f4f8f', fontWeight: 700 }}>{o.number}</td>
                    <td style={{ ...m.td, textTransform: 'capitalize' }}>{o.type}</td>
                    <td style={m.td}>{o.customer}</td>
                    <td style={m.td}>{o.storeName}</td>
                    <td style={m.td}>{money(o.total)}</td>
                    <td style={m.td}>{money(o.paid)}</td>
                    <td style={{ ...m.td, color: o.balance > 0 ? '#b45309' : INK }}>{money(o.balance)}</td>
                    <td style={m.td}><span style={statusBadge(o.status === 'fulfilled' ? 'active' : o.status === 'cancelled' ? 'inactive' : 'invited')}>{o.status.replace(/_/g, ' ')}</span></td>
                    <td style={m.td}>{o.dueDate || o.releaseDate || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}

// ── TRADE-INS ────────────────────────────────────────────────────────────────
export function TradeInsModule({ orgId, stores }) {
  const [kpis, setKpis] = useState({})
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [scope, setScope] = useState(blankScope())
  const [payoutKind, setPayoutKind] = useState('')
  const [approvalStatus, setApprovalStatus] = useState('')
  useEffect(() => {
    let c = false
    const t = setTimeout(async () => {
      setLoading(true)
      const tradeScope = { ...scope, payoutKind: payoutKind || null, approvalStatus: approvalStatus || null }
      const [k, r] = await Promise.all([orgTradeinKpis(orgId, tradeScope), orgTradeins(orgId, { scope: tradeScope })])
      if (!c) { setKpis(k); setRows(r); setLoading(false) }
    }, 0)
    return () => { c = true; clearTimeout(t) }
  }, [orgId, scope, payoutKind, approvalStatus])
  return (
    <div>
      <div style={m.head}><div><h1 style={m.h1}>Trade-Ins</h1><p style={m.desc}>Items acquired from customers across the organisation.</p></div></div>
      <EnterpriseScopeControls orgId={orgId} stores={stores} scope={scope} onScopeChange={setScope} showDate />
      <div style={m.kpiGrid}>
        <KpiCard label="Trade-Ins Today" value={kpis.today ?? 0} />
        <KpiCard label="This Week" value={kpis.this_week ?? 0} />
        <KpiCard label="Items Acquired (today)" value={kpis.items_acquired ?? 0} tone="#15803d" />
        <KpiCard label="Cash Paid (today)" value={money(kpis.cash_paid)} tone="#b45309" />
        <KpiCard label="Trade Credit (today)" value={money(kpis.trade_credit_issued)} tone="#6d28d9" />
      </div>
      <div style={m.filters}>
        <select style={m.select} value={payoutKind} onChange={e => setPayoutKind(e.target.value)}><option value="" style={optDark}>All payouts</option><option value="cash" style={optDark}>Cash</option><option value="trade_credit" style={optDark}>Trade credit</option></select>
        <select style={m.select} value={approvalStatus} onChange={e => setApprovalStatus(e.target.value)}><option value="" style={optDark}>All approvals</option><option value="verified" style={optDark}>ID verified</option><option value="unverified" style={optDark}>Needs verification</option></select>
      </div>
      {loading ? <div style={m.empty}>Loading…</div>
        : rows.length === 0 ? <div style={m.empty}>No trade-ins recorded.</div>
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: '1px solid ' + BORDER }}>
                <th style={m.th}>#</th><th style={m.th}>Seller</th><th style={m.th}>Store</th><th style={m.th}>Employee</th><th style={m.th}>Items</th><th style={m.th}>Payout</th><th style={m.th}>Trade Credit</th><th style={m.th}>ID Verified</th><th style={m.th}>Date</th>
              </tr></thead>
              <tbody>
                {rows.map(t => (
                  <tr key={t.id} style={m.tr}>
                    <td style={{ ...m.td, color: '#1f4f8f', fontWeight: 700 }}>{t.number}</td>
                    <td style={m.td}>{t.seller}</td>
                    <td style={m.td}>{t.storeName}</td>
                    <td style={m.td}>{t.employee || '—'}</td>
                    <td style={m.td}>{t.items}</td>
                    <td style={m.td}>{money(t.amount)}</td>
                    <td style={m.td}>{money(t.tradeCredit)}</td>
                    <td style={m.td}>{t.idVerified ? '✓' : '—'}</td>
                    <td style={m.td}>{new Date(t.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}

// ── SALES ────────────────────────────────────────────────────────────────────
export function SalesModule({ orgId, stores }) {
  const [kpis, setKpis] = useState({})
  const [byStore, setByStore] = useState([])
  const [loading, setLoading] = useState(true)
  const [scope, setScope] = useState(blankScope())
  const [days, setDays] = useState(30)
  const [paymentMethod, setPaymentMethod] = useState('')
  const [transactionType, setTransactionType] = useState('')
  useEffect(() => {
    let c = false
    const t = setTimeout(async () => {
      setLoading(true)
      const salesScope = { ...scope, paymentMethod: paymentMethod || null, transactionType: transactionType || null }
      const [k, b] = await Promise.all([orgSalesKpis(orgId, salesScope), orgSalesByStore(orgId, days, salesScope)])
      if (!c) { setKpis(k); setByStore(b); setLoading(false) }
    }, 0)
    return () => { c = true; clearTimeout(t) }
  }, [orgId, scope, days, paymentMethod, transactionType])
  return (
    <div>
      <div style={m.head}><div><h1 style={m.h1}>Sales</h1><p style={m.desc}>Reporting and analysis — not a checkout. Completed sales across the organisation.</p></div></div>
      <EnterpriseScopeControls orgId={orgId} stores={stores} scope={scope} onScopeChange={setScope} showDate />
      <div style={m.kpiGrid}>
        <KpiCard label="Gross Sales" value={money(kpis.gross_sales ?? kpis.today)} tone="#15803d" />
        <KpiCard label="Net Sales" value={money(kpis.net_sales ?? kpis.today)} />
        <KpiCard label="Transactions" value={kpis.transactions ?? kpis.transactions_today ?? 0} />
        <KpiCard label="Average Basket" value={money(kpis.average_basket ?? kpis.avg_basket_today)} />
        <KpiCard label="Discounts" value={money(kpis.discounts)} tone="#b45309" />
        <KpiCard label="Refunds" value={money(kpis.refunds)} tone="#b91c1c" />
        <KpiCard label="Voids" value={kpis.voids ?? 0} tone="#b91c1c" />
        <KpiCard label="Tax" value={money(kpis.tax)} />
        <KpiCard label="Units Sold" value={kpis.units_sold ?? 0} />
        <KpiCard label="Gross Margin" value={money(kpis.gross_margin)} tone="#6d28d9" />
      </div>
      <div style={m.filters}>
        <select style={m.select} value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}>
          <option value="" style={optDark}>All payment methods</option>
          {['cash','debit','credit','gift_card','store_credit','trade_credit'].map(v => <option key={v} value={v} style={optDark}>{v.replace(/_/g, ' ')}</option>)}
        </select>
        <select style={m.select} value={transactionType} onChange={e => setTransactionType(e.target.value)}>
          <option value="" style={optDark}>Sales only</option>
          {['sale','exchange','return','refund','adjustment'].map(v => <option key={v} value={v} style={optDark}>{v.replace(/_/g, ' ')}</option>)}
        </select>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={m.h2}>Sales by Store</h2>
        <select style={m.select} value={days} onChange={e => setDays(Number(e.target.value))}>{[[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']].map(([v, l]) => <option key={v} value={v} style={optDark}>{l}</option>)}</select>
      </div>
      {loading ? <div style={m.empty}>Loading…</div>
        : byStore.length === 0 ? <div style={m.empty}>No sales in this period.</div>
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: '1px solid ' + BORDER }}>
                <th style={m.th}>Store</th><th style={m.th}>Transactions</th><th style={m.th}>Sales</th><th style={m.th}>Avg Basket</th>
              </tr></thead>
              <tbody>
                {byStore.map(r => (
                  <tr key={r.storeId} style={m.tr}>
                    <td style={{ ...m.td, color: INK, fontWeight: 700 }}>{r.storeName}</td>
                    <td style={m.td}>{r.transactions}</td>
                    <td style={{ ...m.td, color: '#15803d', fontWeight: 700 }}>{money(r.sales)}</td>
                    <td style={m.td}>{money(r.avgBasket)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}

// ── PROMOTIONS & EVENTS ─────────────────────────────────────────────────────
export function PromotionsEventsModule({ orgId, stores }) {
  const [scope, setScope] = useState(blankScope())
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState({ title: '', kind: 'promotion', status: 'draft', startsAt: '', endsAt: '', discountSummary: '', description: '' })
  const [message, setMessage] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let c = false
    const t = setTimeout(async () => {
      setLoading(true)
      const r = await orgPromotionsEvents(orgId, { scope, kind: kind || null, status: status || null })
      if (!c) { setRows(r); setLoading(false) }
    }, 0)
    return () => { c = true; clearTimeout(t) }
  }, [orgId, scope, kind, status, reloadKey])

  const save = async () => {
    setMessage('')
    try {
      await saveOrgPromotionEvent(orgId, { ...form, regionId: scope.regionId, storeId: scope.storeId, locationId: scope.locationId })
      setForm({ title: '', kind: 'promotion', status: 'draft', startsAt: '', endsAt: '', discountSummary: '', description: '' })
      setFormOpen(false); setReloadKey(k => k + 1); setMessage('Saved.')
    } catch (e) { setMessage(e.message || 'Could not save.') }
  }

  return (
    <div>
      <div style={m.head}>
        <div><h1 style={m.h1}>Promotions &amp; Events</h1><p style={m.desc}>Create and review scoped campaigns, sales, and store events.</p></div>
        <button type="button" style={m.primary} onClick={() => setFormOpen(v => !v)}>+ New</button>
      </div>
      <EnterpriseScopeControls orgId={orgId} stores={stores} scope={scope} onScopeChange={setScope} showDate />
      <div style={m.filters}>
        <select style={m.select} value={kind} onChange={e => setKind(e.target.value)}><option value="" style={optDark}>All types</option><option value="promotion" style={optDark}>Promotions</option><option value="event" style={optDark}>Events</option></select>
        <select style={m.select} value={status} onChange={e => setStatus(e.target.value)}><option value="" style={optDark}>All statuses</option>{['draft','scheduled','active','paused','ended','cancelled'].map(s => <option key={s} value={s} style={optDark}>{s}</option>)}</select>
      </div>
      {formOpen && (
        <div style={{ ...m.panel, marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 160px', gap: 10 }}>
            <div><label style={m.lbl}>Title</label><input style={m.inp} value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} /></div>
            <div><label style={m.lbl}>Type</label><select style={m.inp} value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.target.value }))}><option value="promotion" style={optDark}>Promotion</option><option value="event" style={optDark}>Event</option></select></div>
            <div><label style={m.lbl}>Status</label><select style={m.inp} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>{['draft','scheduled','active','paused','ended','cancelled'].map(s => <option key={s} value={s} style={optDark}>{s}</option>)}</select></div>
            <div><label style={m.lbl}>Start</label><input style={m.inp} type="datetime-local" value={form.startsAt} onChange={e => setForm(f => ({ ...f, startsAt: e.target.value }))} /></div>
            <div><label style={m.lbl}>End</label><input style={m.inp} type="datetime-local" value={form.endsAt} onChange={e => setForm(f => ({ ...f, endsAt: e.target.value }))} /></div>
            <div><label style={m.lbl}>Discount / Details</label><input style={m.inp} value={form.discountSummary} onChange={e => setForm(f => ({ ...f, discountSummary: e.target.value }))} /></div>
            <div style={{ gridColumn: '1 / -1' }}><label style={m.lbl}>Description</label><textarea style={{ ...m.inp, minHeight: 70, resize: 'vertical' }} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}><button type="button" style={m.ghost} onClick={() => setFormOpen(false)}>Cancel</button><button type="button" style={m.primary} onClick={save}>Save</button></div>
        </div>
      )}
      {message && <div style={{ color: message === 'Saved.' ? '#15803d' : '#b91c1c', fontSize: '0.83rem', marginBottom: 10 }}>{message}</div>}
      {loading ? <div style={m.empty}>Loading…</div> : rows.length === 0 ? <div style={m.empty}>No promotions or events match this scope.</div> : <SimpleRows rows={rows} columns={[['title','Title'],['kind','Type'],['status','Status'],['regionName','Region'],['storeName','Store'],['locationName','Location'],['startsAt','Start'],['endsAt','End']]} />}
    </div>
  )
}

// ── POLICIES ────────────────────────────────────────────────────────────────
export function PoliciesModule({ orgId, stores }) {
  const [scope, setScope] = useState(blankScope())
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ title: '', policyType: 'general', status: 'draft', effectiveAt: '', body: '' })
  const [showForm, setShowForm] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let c = false
    orgPolicies(orgId, { scope }).then(r => { if (!c) { setRows(r); setLoading(false) } })
    return () => { c = true }
  }, [orgId, scope, reloadKey])

  const save = async () => {
    setMessage('')
    try {
      await saveOrgPolicy(orgId, { ...form, regionId: scope.regionId, storeId: scope.storeId, locationId: scope.locationId })
      setForm({ title: '', policyType: 'general', status: 'draft', effectiveAt: '', body: '' })
      setShowForm(false); setReloadKey(k => k + 1); setMessage('Saved.')
    } catch (e) { setMessage(e.message || 'Could not save.') }
  }

  return (
    <div>
      <div style={m.head}><div><h1 style={m.h1}>Policies</h1><p style={m.desc}>Head-office rules scoped by organisation, region, store, or location.</p></div><button type="button" style={m.primary} onClick={() => setShowForm(v => !v)}>+ New Policy</button></div>
      <EnterpriseScopeControls orgId={orgId} stores={stores} scope={scope} onScopeChange={setScope} />
      {showForm && (
        <div style={{ ...m.panel, marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 140px', gap: 10 }}>
            <div><label style={m.lbl}>Title</label><input style={m.inp} value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} /></div>
            <div><label style={m.lbl}>Type</label><input style={m.inp} value={form.policyType} onChange={e => setForm(f => ({ ...f, policyType: e.target.value }))} /></div>
            <div><label style={m.lbl}>Status</label><select style={m.inp} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>{['draft','active','archived'].map(s => <option key={s} value={s} style={optDark}>{s}</option>)}</select></div>
            <div><label style={m.lbl}>Effective</label><input style={m.inp} type="date" value={form.effectiveAt} onChange={e => setForm(f => ({ ...f, effectiveAt: e.target.value }))} /></div>
            <div style={{ gridColumn: '1 / -1' }}><label style={m.lbl}>Policy Text</label><textarea style={{ ...m.inp, minHeight: 96, resize: 'vertical' }} value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} /></div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}><button type="button" style={m.ghost} onClick={() => setShowForm(false)}>Cancel</button><button type="button" style={m.primary} onClick={save}>Save</button></div>
        </div>
      )}
      {message && <div style={{ color: message === 'Saved.' ? '#15803d' : '#b91c1c', fontSize: '0.83rem', marginBottom: 10 }}>{message}</div>}
      {loading ? <div style={m.empty}>Loading…</div> : rows.length === 0 ? <div style={m.empty}>No policies match this scope.</div> : <SimpleRows rows={rows} columns={[['title','Policy'],['policy_type','Type'],['status','Status'],['region_name','Region'],['store_name','Store'],['location_name','Location'],['effective_at','Effective']]} />}
    </div>
  )
}

// ── REPORTS ─────────────────────────────────────────────────────────────────
export function ReportsModule({ orgId, stores }) {
  const [scope, setScope] = useState(blankScope())
  const [summary, setSummary] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let c = false
    setLoading(true)
    orgReportSummary(orgId, scope).then(r => { if (!c) { setSummary(r || {}); setLoading(false) } })
    return () => { c = true }
  }, [orgId, scope])

  const exportCsv = () => {
    const rows = [
      ['Scope', [scope.regionId && 'region', scope.storeId && 'store', scope.locationId && 'location', scope.dateFrom && `from ${scope.dateFrom}`, scope.dateTo && `to ${scope.dateTo}`].filter(Boolean).join(' / ') || 'organization'],
      ['Gross Sales', summary.sales?.gross_sales ?? 0],
      ['Net Sales', summary.sales?.net_sales ?? 0],
      ['Transactions', summary.sales?.transactions ?? 0],
      ['Trade-Ins', summary.tradeins?.this_week ?? 0],
      ['Orders Created Today', summary.orders?.created_today ?? 0],
      ['Inventory SKUs', summary.inventory?.skus ?? 0],
      ['Promotions & Events', summary.promotions_events ?? 0],
    ]
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'nordvik-org-report.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <div style={m.head}><div><h1 style={m.h1}>Reports</h1><p style={m.desc}>Scoped reporting across sales, trade-ins, orders, inventory, promotions, and events.</p></div><button type="button" style={m.primary} onClick={exportCsv}>Export CSV</button></div>
      <EnterpriseScopeControls orgId={orgId} stores={stores} scope={scope} onScopeChange={setScope} showDate />
      {loading ? <div style={m.empty}>Loading…</div> : (
        <div style={m.kpiGrid}>
          <KpiCard label="Gross Sales" value={money(summary.sales?.gross_sales)} tone="#15803d" />
          <KpiCard label="Net Sales" value={money(summary.sales?.net_sales)} />
          <KpiCard label="Transactions" value={summary.sales?.transactions ?? 0} />
          <KpiCard label="Trade-Ins" value={summary.tradeins?.this_week ?? 0} />
          <KpiCard label="Orders Today" value={summary.orders?.created_today ?? 0} />
          <KpiCard label="Inventory SKUs" value={summary.inventory?.skus ?? 0} />
          <KpiCard label="Promos / Events" value={summary.promotions_events ?? 0} tone="#b45309" />
        </div>
      )}
    </div>
  )
}

// ── INTEGRATIONS / SETTINGS ─────────────────────────────────────────────────
export function IntegrationsModule({ orgId }) {
  const [rows, setRows] = useState([])
  const [provider, setProvider] = useState('shopify')
  const [status, setStatus] = useState('disabled')
  const [message, setMessage] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => { let c = false; orgIntegrations(orgId).then(r => { if (!c) setRows(r) }); return () => { c = true } }, [orgId, reloadKey])
  const save = async () => {
    setMessage('')
    try { await saveOrgIntegration(orgId, { provider, status, config: {} }); setReloadKey(k => k + 1); setMessage('Saved.') }
    catch (e) { setMessage(e.message || 'Could not save.') }
  }
  return (
    <div>
      <div style={m.head}><div><h1 style={m.h1}>Integrations</h1><p style={m.desc}>Track external systems connected to this organisation.</p></div></div>
      <div style={{ ...m.panel, marginBottom: 14, display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div><label style={m.lbl}>Provider</label><input style={{ ...m.inp, width: 220 }} value={provider} onChange={e => setProvider(e.target.value)} /></div>
        <div><label style={m.lbl}>Status</label><select style={{ ...m.inp, width: 160 }} value={status} onChange={e => setStatus(e.target.value)}>{['disabled','connected','error'].map(s => <option key={s} value={s} style={optDark}>{s}</option>)}</select></div>
        <button type="button" style={m.primary} onClick={save}>Save</button>
        {message && <span style={{ color: message === 'Saved.' ? '#15803d' : '#b91c1c', fontSize: '0.83rem' }}>{message}</span>}
      </div>
      {rows.length === 0 ? <div style={m.empty}>No integrations configured yet.</div> : <SimpleRows rows={rows} columns={[['provider','Provider'],['status','Status'],['updated_at','Updated']]} />}
    </div>
  )
}

export function OrgSettingsModule({ stores, orgId }) {
  const realStores = (stores || []).filter(s => !s.demo)
  const regions = new Set(realStores.map(s => s.regionId).filter(Boolean))
  return (
    <div>
      <div style={m.head}><div><h1 style={m.h1}>Settings</h1><p style={m.desc}>Organisation-level operational settings. Store settings remain inside each store.</p></div></div>
      <div style={m.kpiGrid}>
        <KpiCard label="Stores" value={realStores.length} />
        <KpiCard label="Regions" value={regions.size} />
        <KpiCard label="Locations" value={realStores.reduce((n, s) => n + (Number(s.locationCount) || 0), 0)} />
        <KpiCard label="Staff" value={realStores.reduce((n, s) => n + (Number(s.staffCount) || 0), 0)} />
      </div>
      {orgId ? <OrgBrandingCard orgId={orgId} /> : null}
      {orgId ? <OrgCategoriesCard orgId={orgId} /> : null}
      <div style={m.empty}>Use Stores, Locations, Staff, Policies, and Integrations for specific changes. This keeps head-office settings from duplicating store-level controls.</div>
    </div>
  )
}

function OrgBrandingCard({ orgId }) {
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    let cancelled = false
    loadOrganizationInfo(orgId).then((data) => {
      if (!cancelled) {
        setInfo(data || { logoUrl: '', bannerUrl: '' })
        setLoading(false)
      }
    }, () => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [orgId])

  const upload = async (kind, file) => {
    if (!file) return
    setUploading(kind); setMsg(''); setErr('')
    try {
      const url = await uploadOrganizationBrandingImage(orgId, file, kind)
      await saveOrganizationBranding(orgId, kind === 'banner' ? { bannerUrl: url } : { logoUrl: url })
      setInfo((prev) => ({ ...(prev || {}), [kind === 'banner' ? 'bannerUrl' : 'logoUrl']: url }))
      setMsg(kind === 'banner' ? 'Banner updated.' : 'Logo updated.')
    } catch (e) {
      setErr(e.message || 'Upload failed.')
    } finally {
      setUploading('')
    }
  }

  const clear = async (kind) => {
    setUploading(kind); setMsg(''); setErr('')
    try {
      await saveOrganizationBranding(orgId, kind === 'banner' ? { bannerUrl: '' } : { logoUrl: '' })
      setInfo((prev) => ({ ...(prev || {}), [kind === 'banner' ? 'bannerUrl' : 'logoUrl']: '' }))
      setMsg('Removed.')
    } catch (e) {
      setErr(e.message || 'Could not remove.')
    } finally {
      setUploading('')
    }
  }

  if (loading) return <div style={{ ...m.panel, marginTop: 16 }}><div style={m.empty}>Loading branding…</div></div>
  const banner = info?.bannerUrl || ''
  const logo = info?.logoUrl || ''

  return (
    <div style={{ ...m.panel, marginTop: 16 }}>
      <h2 style={{ ...m.h2, margin: '0 0 4px' }}>Branding</h2>
      <p style={{ ...m.desc, marginTop: 2 }}>Logo and header banner apply across all stores in this organisation.</p>
      <div style={{ display: 'grid', gap: 16 }}>
        <div>
          <label style={m.lbl}>Header banner</label>
          <div style={{ height: 116, borderRadius: 12, border: `1px solid ${BORDER_STR}`, background: banner ? `${FIELD} center/cover no-repeat url(${banner})` : FIELD, display: 'flex', alignItems: 'center', justifyContent: 'center', color: FAINT, overflow: 'hidden' }}>
            {banner ? '' : 'No banner yet'}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <label style={{ ...m.ghost, cursor: uploading === 'banner' ? 'default' : 'pointer', opacity: uploading === 'banner' ? 0.6 : 1 }}>
              {uploading === 'banner' ? 'Uploading…' : (banner ? 'Replace banner' : 'Upload banner')}
              <input type="file" accept="image/*" style={{ display: 'none' }} disabled={uploading === 'banner'} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; upload('banner', f) }} />
            </label>
            {banner && <button type="button" style={{ ...m.ghost, color: '#b91c1c' }} disabled={uploading === 'banner'} onClick={() => clear('banner')}>Remove</button>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <label style={m.lbl}>Logo</label>
            <div style={{ width: 78, height: 78, borderRadius: 12, border: `1px solid ${BORDER_STR}`, background: logo ? `${FIELD} center/cover no-repeat url(${logo})` : FIELD, display: 'flex', alignItems: 'center', justifyContent: 'center', color: FAINT, fontSize: '0.75rem', overflow: 'hidden' }}>
              {logo ? '' : 'None'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ ...m.ghost, cursor: uploading === 'logo' ? 'default' : 'pointer', opacity: uploading === 'logo' ? 0.6 : 1 }}>
              {uploading === 'logo' ? 'Uploading…' : (logo ? 'Replace logo' : 'Upload logo')}
              <input type="file" accept="image/*" style={{ display: 'none' }} disabled={uploading === 'logo'} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; upload('logo', f) }} />
            </label>
            {logo && <button type="button" style={{ ...m.ghost, color: '#b91c1c' }} disabled={uploading === 'logo'} onClick={() => clear('logo')}>Remove</button>}
          </div>
        </div>
      </div>
      {msg && <p style={{ color: '#15803d', fontSize: '0.82rem', marginTop: 8 }}>{msg}</p>}
      {err && <p style={{ color: '#b91c1c', fontSize: '0.82rem', marginTop: 8 }}>{err}</p>}
    </div>
  )
}

// What the org deals in. Empty selection = all categories (unrestricted).
function OrgCategoriesCard({ orgId }) {
  const [all, setAll] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.all([allCatalogueCategories(), orgAllowedCategories(orgId)]).then(([cats, allowed]) => {
      if (cancelled) return
      setAll(cats)
      setSelected(new Set(allowed.map((c) => c.id)))
      setLoading(false)
    }, () => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [orgId])

  const toggle = (id) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const save = async () => {
    setSaving(true); setErr(''); setMsg('')
    try { await setOrgAllowedCategories(orgId, [...selected]); setMsg('Saved. Your stores now deal only in the selected categories (none selected = all).') }
    catch (e) { setErr(e.message || 'Could not save.') } finally { setSaving(false) }
  }

  return (
    <div style={{ ...m.panel, marginTop: 16 }}>
      <h2 style={{ ...m.h2, margin: '0 0 4px' }}>Categories we deal in</h2>
      <p style={{ ...m.desc, marginTop: 2 }}>Restrict what your stores can add to inventory and what collectors see from you. Select none to allow every category.</p>
      {loading ? <div style={m.empty}>Loading categories…</div> : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            {all.map((c) => {
              const on = selected.has(c.id)
              return (
                <button key={c.id} type="button" onClick={() => toggle(c.id)}
                  style={{ padding: '8px 14px', borderRadius: 999, cursor: 'pointer', fontWeight: 700, fontSize: '0.82rem',
                    border: `1px solid ${on ? CYAN : BORDER}`, background: on ? 'rgba(214,166,50,0.15)' : 'transparent', color: on ? INK : SUB }}>
                  {on ? '✓ ' : ''}{c.name}
                </button>
              )
            })}
          </div>
          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="button" style={{ ...m.primary, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save categories'}</button>
            <span style={{ fontSize: '0.8rem', color: FAINT }}>{selected.size === 0 ? 'All categories (unrestricted)' : `${selected.size} selected`}</span>
          </div>
          {msg && <p style={{ color: '#15803d', fontSize: '0.82rem', marginTop: 8 }}>{msg}</p>}
          {err && <p style={{ color: '#b91c1c', fontSize: '0.82rem', marginTop: 8 }}>{err}</p>}
        </>
      )}
    </div>
  )
}

function SimpleRows({ rows, columns }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr style={{ borderBottom: `1px solid ${BORDER}` }}>{columns.map(([, label]) => <th key={label} style={m.th}>{label}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id || i} style={m.tr}>
              {columns.map(([key]) => <td key={key} style={m.td}>{row[key] || <span style={{ color: FAINT }}>—</span>}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
