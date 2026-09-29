import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  Boxes,
  CircleAlert,
  Database,
  FileUp,
  FileSearch,
  Gauge,
  Image,
  Layers3,
  LogOut,
  RefreshCw,
  ScanLine,
  Search,
  Settings,
  Shield,
  Store,
  Tags,
  Users,
} from 'lucide-react'
import {
  ADMIN_EXPLORER_TABLES,
  loadAdminCategories,
  loadAdminOverview,
  loadCatalogueItemRecord,
  loadCatalogueItems,
  loadExplorerRecords,
  loadImagesMediaData,
  loadPricingData,
  loadMarketDataAdmin,
  fetchMarketSales,
  approveMarketSales,
  generateMarketSearchQuery,
  loadStoresOrganizationsData,
  loadTaxonomyData,
  loadUsersData,
  identifyScannedDraft,
  createCatalogueItemFromScan,
  updateCatalogueItemRecord,
  updateExplorerRecord,
} from './lib/adminData'

const adminNav = [
  { key: 'overview', label: 'Overview', icon: Gauge },
  { key: 'catalogue', label: 'Catalogue', icon: Boxes },
  { key: 'scan', label: 'Scan Intake', icon: ScanLine },
  { key: 'review', label: 'Pending Review', icon: CircleAlert },
  { key: 'explorer', label: 'Data Explorer', icon: Database },
  { key: 'taxonomy', label: 'Taxonomy', icon: Tags },
  { key: 'media', label: 'Images & Media', icon: Image },
  { key: 'pricing', label: 'Pricing / Sales Data', icon: Layers3 },
  { key: 'market', label: 'Market Data', icon: FileSearch },
  { key: 'stores', label: 'Stores & Organisations', icon: Store },
  { key: 'users', label: 'Users', icon: Users },
  { key: 'system', label: 'System / Sync', icon: RefreshCw },
  { key: 'settings', label: 'Settings', icon: Settings },
]

const itemTabs = ['Overview', 'Catalogue Data', 'Category Data', 'Relationships', 'Images', 'Pricing', 'Market Data', 'Sales', 'Sets', 'External IDs', 'Raw Data', 'History']

function AdminDismissibleAlert({ className = 'admin-error', children, onDismiss }) {
  return (
    <div className={`${className} dismissible-alert`} role="alert">
      <span>{children}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss message">x</button>
    </div>
  )
}
const PAGE_SIZE = 25

function formatNumber(value) {
  return Number(value || 0).toLocaleString()
}

function formatDate(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

function firstFilled(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || ''
}

function scanDraftTitle(draft) {
  const metadata = draft?.metadata || {}
  return firstFilled(
    metadata.cardName,
    metadata.player,
    metadata.name,
    metadata.subject,
    metadata.productSet,
    metadata.set,
    metadata.setName,
    metadata.brand,
  ) || 'Untitled scanned item'
}

function meaningfulScanMetadata(metadata = {}) {
  const hiddenValues = new Set(['No', 'Base', 'Available'])
  return Object.entries(metadata)
    .filter(([, value]) => {
      const text = String(value || '').trim()
      return text && !hiddenValues.has(text)
    })
    .slice(0, 8)
}

function scanRouteLabel(route) {
  const labels = {
    existing_match: 'Matched catalogue item',
    manual_review_existing_item: 'Needs field review',
    possible_duplicate: 'Possible duplicate',
    new_item_proposal: 'Proposed new item',
    ocr_review_needed: 'Needs OCR review',
  }
  return labels[route] || 'Awaiting analysis'
}

function mergeScanMetadata(metadata = {}, ocr = {}) {
  const next = { ...metadata }
  const rejectedNames = new Set((ocr.rejectedNames || []).map((value) => String(value || '').trim().toUpperCase()))
  ;['cardName', 'player', 'name'].forEach((key) => {
    const value = String(next[key] || '').trim().toUpperCase()
    if (value && rejectedNames.has(value)) next[key] = ''
  })
  Object.entries(ocr.metadata || {}).forEach(([key, value]) => {
    const text = String(value || '').trim()
    if (text && !String(next[key] || '').trim()) next[key] = text
  })
  return next
}

async function enrichDraftWithOcr(draft) {
  const images = [draft.frontImage, draft.backImage].filter((image) => image?.path)
  if (!images.length) return draft
  const api = adminDesktopApi()
  // Read both sides: card backs usually carry the number, year and set text.
  // Merge the more confident side first: merging only fills empty fields, so a
  // noisy guess from the artwork-heavy front must not beat a clean back read.
  const results = (await Promise.all(images.map((image) => api.analyzeCardScan(image, { category: draft.category }))))
    .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0))
  const metadata = results.reduce((current, result) => mergeScanMetadata(current, result), draft.metadata)
  // OCR can tell a sports card apart from a TCG card left on the default category.
  const detectedCategory = results.map((result) => result.detectedCategory).find((value) => value && value !== draft.category)
  const ocr = {
    detectedCategory: detectedCategory || draft.category,
    metadata: results.reduce((current, result) => ({ ...(result.metadata || {}), ...current }), {}),
    rawText: results.map((result) => result.rawText).filter(Boolean).join('\n\n'),
    confidence: Math.max(0, ...results.map((result) => Number(result.confidence) || 0)),
    confidenceNotes: [...new Set(results.flatMap((result) => result.confidenceNotes || []))],
    rejectedNames: [...new Set(results.flatMap((result) => result.rejectedNames || []))],
  }
  return { ...draft, category: detectedCategory || draft.category, metadata, ocr }
}

function JsonBlock({ value }) {
  return <pre className="admin-json">{JSON.stringify(value || {}, null, 2)}</pre>
}

function parseJsonEditor(value) {
  try {
    return { data: JSON.parse(value), error: '' }
  } catch (error) {
    return { data: null, error: error.message || 'Invalid JSON.' }
  }
}

function adminDesktopApi() {
  const fallback = {
    async loadStore() {
      try {
        return JSON.parse(window.localStorage.getItem('collectorshub-desktop-preview-store') || '{}')
      } catch {
        return {}
      }
    },
    async saveStore(store) {
      window.localStorage.setItem('collectorshub-desktop-preview-store', JSON.stringify(store))
      return store
    },
    async selectScanImages() {
      return []
    },
    async scanImage() {
      throw new Error('Direct scanner control is only available in the installed Windows desktop app.')
    },
    async analyzeCardScan() {
      return { metadata: {}, rawText: '', confidence: 0, confidenceNotes: [] }
    },
  }

  // Older running Electron windows may have a preload bridge without scanImage.
  // Keep the rest of the bridge usable and surface a clear scanner message.
  return window.nordvikDesktop
    ? {
        ...fallback,
        ...window.nordvikDesktop,
        scanImage: typeof window.nordvikDesktop.scanImage === 'function' ? window.nordvikDesktop.scanImage : fallback.scanImage,
        analyzeCardScan: typeof window.nordvikDesktop.analyzeCardScan === 'function' ? window.nordvikDesktop.analyzeCardScan : fallback.analyzeCardScan,
      }
    : fallback
}

function createLocalId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

export default function AdminWorkspace({ session, syncStatus, onLogout }) {
  const [activeView, setActiveView] = useState('overview')
  const [scanDrafts, setScanDrafts] = useState([])
  // Draft writes happen after slow OCR/Supabase calls, so they must apply to the
  // latest list (not a render-time snapshot) and persist one at a time.
  const scanDraftsRef = useRef([])
  const scanDraftSaveQueue = useRef(Promise.resolve())
  const [storeContext, setStoreContext] = useState({
    storeId: session?.storeId || syncStatus?.context?.storeId || '',
    storeCode: session?.storeCode || '',
  })

  useEffect(() => {
    let cancelled = false
    adminDesktopApi().loadStore().then((store) => {
      if (!cancelled) {
        scanDraftsRef.current = store?.admin?.scanDrafts || []
        setScanDrafts(scanDraftsRef.current)
        setStoreContext({
          storeId: session?.storeId || store?.sync?.context?.storeId || syncStatus?.context?.storeId || '',
          storeCode: session?.storeCode || store?.sync?.context?.storeCode || '',
        })
      }
    })
    return () => { cancelled = true }
  }, [session?.storeCode, session?.storeId, syncStatus?.context?.storeId])

  function saveScanDrafts(updateDrafts) {
    const nextDrafts = updateDrafts(scanDraftsRef.current)
    scanDraftsRef.current = nextDrafts
    setScanDrafts(nextDrafts)
    const persist = scanDraftSaveQueue.current.then(async () => {
      const store = await adminDesktopApi().loadStore()
      await adminDesktopApi().saveStore({
        ...store,
        admin: {
          ...(store.admin || {}),
          scanDrafts: scanDraftsRef.current,
        },
      })
    })
    scanDraftSaveQueue.current = persist.catch(() => {})
    return persist
  }

  async function createScanDraft(draft) {
    const draftWithIdentity = {
      id: createLocalId('scan_draft'),
      status: 'Needs Review',
      createdBy: session?.userId || session?.email || 'admin',
      createdAt: new Date().toISOString(),
      ...draft,
    }
    let nextDraft = draftWithIdentity
    try {
      const ocrDraft = await enrichDraftWithOcr(draftWithIdentity)
      const scanAnalysis = await identifyScannedDraft(ocrDraft)
      nextDraft = { ...ocrDraft, scanAnalysis, status: scanAnalysis.status }
    } catch (error) {
      nextDraft = { ...draftWithIdentity, analysisError: error.message || 'Scan analysis failed.' }
    }
    await saveScanDrafts((drafts) => [nextDraft, ...drafts])
    setActiveView('review')
  }

  async function updateScanDraft(draftId, patch) {
    await saveScanDrafts((drafts) => drafts.map((draft) => draft.id === draftId ? { ...draft, ...patch, updatedAt: new Date().toISOString() } : draft))
  }

  async function deleteScanDraft(draftId) {
    await saveScanDrafts((drafts) => drafts.filter((draft) => draft.id !== draftId))
  }

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <div className="admin-brand-mark"><Shield size={21} /></div>
          <div>
            <strong>CollectorsHub</strong>
            <small>ADMIN CONSOLE</small>
          </div>
        </div>

        <nav className="admin-nav" aria-label="Admin">
          {adminNav.map(({ key, label, icon: Icon }) => (
            <button className={activeView === key ? 'admin-nav-button active' : 'admin-nav-button'} type="button" key={key} onClick={() => setActiveView(key)}>
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="admin-user-card">
          <strong>{session?.displayName || 'Platform Admin'}</strong>
          <span>{session?.email || 'CollectorsHub admin'}</span>
          <small>Role: platform_admin</small>
          <small>{syncStatus?.online ? 'Online' : 'Offline'} · Supabase authenticated</small>
          <button type="button" onClick={onLogout}>
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </aside>

      <section className="admin-workspace">
        <header className="admin-topbar">
          <div>
            <p className="admin-mode-label">COLLECTORSHUB ADMIN</p>
            <h1>{adminNav.find((entry) => entry.key === activeView)?.label || 'Overview'}</h1>
          </div>
          <span className="admin-status-pill">
            <span />
            {syncStatus?.online ? 'Online' : 'Offline'}
          </span>
        </header>

        {activeView === 'overview' ? <AdminOverview onNavigate={setActiveView} /> : null}
        {activeView === 'catalogue' ? <AdminCatalogue /> : null}
        {activeView === 'scan' ? <ScanIntake onCreateDraft={createScanDraft} /> : null}
        {activeView === 'review' ? <PendingReview drafts={scanDrafts} onUpdateDraft={updateScanDraft} onDeleteDraft={deleteScanDraft} onCreateMore={() => setActiveView('scan')} /> : null}
        {activeView === 'explorer' ? <DataExplorer /> : null}
        {activeView === 'taxonomy' ? <TaxonomyAdmin /> : null}
        {activeView === 'media' ? <AdminSectionBrowser title="Images & Media" kicker="Catalogue media administration" loader={loadImagesMediaData} /> : null}
        {activeView === 'pricing' ? <AdminSectionBrowser title="Pricing / Sales Data" kicker="Valuation and sales inputs" loader={loadPricingData} /> : null}
        {activeView === 'market' ? <MarketDataAdmin storeContext={storeContext} /> : null}
        {activeView === 'stores' ? <AdminSectionBrowser title="Stores & Organisations" kicker="Enterprise account administration" loader={loadStoresOrganizationsData} /> : null}
        {activeView === 'users' ? <AdminSectionBrowser title="Users" kicker="Profiles and memberships" loader={loadUsersData} /> : null}
        {activeView === 'system' ? <AdminSystem syncStatus={syncStatus} /> : null}
        {activeView === 'settings' ? <AdminPlaceholder icon={Settings} title="Settings" copy="Admin-specific desktop preferences, scanner defaults, and local cache configuration will live here." /> : null}
      </section>
    </main>
  )
}

function AdminOverview({ onNavigate }) {
  const [overview, setOverview] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    loadAdminOverview()
      .then((data) => {
        if (!cancelled) setOverview(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load admin overview.')
      })
    return () => { cancelled = true }
  }, [])

  const metrics = overview?.metrics || {}
  return (
    <div className="admin-stack">
      {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
      <section className="admin-metrics">
        <AdminMetric label="Catalogue Items" value={metrics.catalogueItems} />
        <AdminMetric label="Pending Reviews" value={metrics.pendingReviews} accent />
        <AdminMetric label="Items Missing Images" value={metrics.missingImages} />
        <AdminMetric label="Items Missing Pricing" value={metrics.missingPricing} />
        <AdminMetric label="Duplicate Candidates" value={metrics.duplicateCandidates} />
        <AdminMetric label="Failed Imports / Sync Errors" value={metrics.failedImports} warning />
      </section>

      <section className="admin-quick-actions">
        <button type="button" onClick={() => onNavigate('catalogue')}>+ Add Catalogue Item</button>
        <button type="button" onClick={() => onNavigate('scan')}>Scan New Items</button>
        <button type="button" onClick={() => onNavigate('review')}>Import Data</button>
        <button type="button" onClick={() => onNavigate('explorer')}>Open Data Explorer</button>
      </section>

      <div className="admin-grid-two">
        <AdminPanel title="Recent Catalogue Changes">
          <CompactItemList rows={overview?.recentCatalogue || []} />
        </AdminPanel>
        <AdminPanel title="Recent Imports">
          <RecordList rows={overview?.recentImports || []} />
        </AdminPanel>
        <AdminPanel title="Items Requiring Review">
          <EmptyAdminState text="Review queues will populate from scan drafts, low-confidence matches, duplicate candidates, and failed uploads." />
        </AdminPanel>
        <AdminPanel title="System / Sync Issues">
          {(overview?.systemIssues || []).length ? overview.systemIssues.map((issue) => <p className="admin-list-line" key={issue}>{issue}</p>) : <EmptyAdminState text="No current system issues found." />}
        </AdminPanel>
      </div>
    </div>
  )
}

function MarketDataAdmin({ storeContext = {} }) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [selectedId, setSelectedId] = useState('')
  const [selectedRecord, setSelectedRecord] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setPage(1)
  }, [search])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      setLoading(true)
      loadMarketDataAdmin({ search, page, limit: PAGE_SIZE, context: storeContext })
        .then((result) => {
          if (!cancelled) {
            setData(result)
            setError(result.errors?.join(' ') || '')
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err.message || 'Could not load market data admin.')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [search, page, storeContext?.storeId])

  useEffect(() => {
    if (!selectedId) {
      setSelectedRecord(null)
      return undefined
    }
    let cancelled = false
    loadCatalogueItemRecord(selectedId, storeContext)
      .then((record) => { if (!cancelled) setSelectedRecord(record) })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load selected catalogue item.') })
    return () => { cancelled = true }
  }, [selectedId, storeContext?.storeId])

  const catalogue = data?.catalogue || { rows: [], total: 0 }
  const totalPages = Math.max(1, Math.ceil((catalogue.total || 0) / PAGE_SIZE))

  async function reloadSelected() {
    if (!selectedId) return
    setSelectedRecord(await loadCatalogueItemRecord(selectedId, storeContext))
    setData(await loadMarketDataAdmin({ search, page, limit: PAGE_SIZE, context: storeContext }))
  }

  return (
    <div className="admin-stack">
      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <p className="admin-kicker">External sales fetching</p>
            <h2>Market Data</h2>
          </div>
        </div>
        <div className="admin-filters">
          <label className="admin-search">
            <Search size={16} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search catalogue item for market data..." />
          </label>
        </div>
        <div className="admin-table-note">{loading ? 'Loading...' : `${formatNumber(catalogue.total || 0)} catalogue records`}</div>
        {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
        <CatalogueTable rows={catalogue.rows || []} selectedId={selectedId} onSelect={setSelectedId} />
        <PaginationControls page={page} totalPages={totalPages} total={catalogue.total || 0} onPage={setPage} />
      </section>

      {selectedRecord ? (
        <CatalogueItemMarketData record={selectedRecord} onReload={reloadSelected} storeContext={storeContext} />
      ) : (
        <section className="admin-panel">
          <div className="admin-panel-header">
            <div>
              <p className="admin-kicker">Import History</p>
              <h2>Recent Market Fetches</h2>
            </div>
          </div>
          <RecordList rows={(data?.imports || []).slice(0, 12).map((row) => ({
            id: row.id,
            title: `${formatDate(row.started_at)} · ${row.source}`,
            detail: row.search_query,
            status: `${row.results_found || 0} found · ${row.results_approved || 0} approved · ${row.status}`,
          }))} />
        </section>
      )}
    </div>
  )
}

function AdminCatalogue() {
  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [missingImages, setMissingImages] = useState(false)
  const [missingPricing, setMissingPricing] = useState(false)
  const [categories, setCategories] = useState([])
  const [rows, setRows] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    loadAdminCategories().then(setCategories).catch(() => setCategories([]))
  }, [])

  useEffect(() => {
    setPage(1)
  }, [search, categoryId, missingImages, missingPricing])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLoading(true)
      loadCatalogueItems({ search, categoryId, missingImages, missingPricing, page, limit: PAGE_SIZE })
        .then((result) => {
          setRows(result.rows)
          setTotal(result.total)
          setError('')
        })
        .catch((err) => setError(err.message || 'Catalogue search failed.'))
        .finally(() => setLoading(false))
    }, 220)
    return () => window.clearTimeout(timer)
  }, [search, categoryId, missingImages, missingPricing, page])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="admin-stack">
      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <p className="admin-kicker">Real Supabase catalogue</p>
            <h2>Catalogue Administration</h2>
          </div>
          <button className="admin-gold-button" type="button">+ Add Catalogue Item</button>
        </div>
        <div className="admin-filters">
          <label className="admin-search">
            <Search size={16} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, catalogue ID, UPC, barcode, external ID..." />
          </label>
          <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="">All Categories</option>
            {categories.map((category) => <option key={category.category_id} value={category.category_id}>{category.name}</option>)}
          </select>
          <label className="admin-check"><input type="checkbox" checked={missingImages} onChange={(event) => setMissingImages(event.target.checked)} /> Missing Images</label>
          <label className="admin-check"><input type="checkbox" checked={missingPricing} onChange={(event) => setMissingPricing(event.target.checked)} /> Missing Pricing</label>
        </div>
        <div className="admin-table-note">{loading ? 'Loading...' : `${formatNumber(total)} matching records`}</div>
        {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
        <CatalogueTable rows={rows} onSelect={setSelectedId} selectedId={selectedId} />
        <PaginationControls page={page} totalPages={totalPages} total={total} onPage={setPage} />
      </section>

      {selectedId ? <CatalogueItemRecord itemId={selectedId} onClose={() => setSelectedId('')} /> : null}
    </div>
  )
}

function CatalogueTable({ rows, selectedId, onSelect }) {
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Image</th>
            <th>Item Name</th>
            <th>Category</th>
            <th>Franchise / Brand</th>
            <th>Set</th>
            <th>Year</th>
            <th>Catalogue ID</th>
            <th>Status</th>
            <th>Images</th>
            <th>Pricing</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className={selectedId === row.item_id ? 'selected' : ''} key={row.item_id} onClick={() => onSelect(row.item_id)}>
              <td>{row.imageUrl ? <img className="admin-thumb" src={row.imageUrl} alt="" /> : <span className="admin-thumb-placeholder" />}</td>
              <td><strong>{row.displayName}</strong><small>{row.subcategoryName || row.subject || '—'}</small></td>
              <td>{row.categoryName || '—'}</td>
              <td>{[row.franchiseName, row.brandName].filter(Boolean).join(' / ') || '—'}</td>
              <td>{row.setName || '—'}</td>
              <td>{row.release_year || row.dynamic_fields?.release_year || '—'}</td>
              <td><code>{row.item_id}</code></td>
              <td>{row.status}</td>
              <td>{row.imageCount}</td>
              <td>{row.pricingStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length ? <EmptyAdminState text="No catalogue records match the current filters." /> : null}
    </div>
  )
}

function CatalogueItemRecord({ itemId, onClose }) {
  const [activeTab, setActiveTab] = useState('Overview')
  const [record, setRecord] = useState(null)
  const [error, setError] = useState('')
  const [editorValue, setEditorValue] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadCatalogueItemRecord(itemId)
      .then((data) => {
        if (!cancelled) {
          setRecord(data)
          setEditorValue(JSON.stringify(data.raw || {}, null, 2))
          setIsEditing(false)
          setError('')
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load catalogue item.')
      })
    return () => { cancelled = true }
  }, [itemId])

  const raw = record?.raw || {}
  const details = record?.details || {}
  const categoryFields = { ...(raw.attributes || {}), ...(raw.dynamic_fields || {}) }

  async function saveCatalogueRecord() {
    const parsed = parseJsonEditor(editorValue)
    if (parsed.error) {
      setError(parsed.error)
      return
    }

    setIsSaving(true)
    try {
      await updateCatalogueItemRecord(itemId, parsed.data)
      const refreshed = await loadCatalogueItemRecord(itemId)
      setRecord(refreshed)
      setEditorValue(JSON.stringify(refreshed.raw || {}, null, 2))
      setIsEditing(false)
      setError('')
    } catch (err) {
      setError(err.message || 'Could not save catalogue item.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section className="admin-panel">
      <div className="admin-panel-header">
        <div>
          <p className="admin-kicker">Catalogue Item Record</p>
          <h2>{raw.name || details.subject || itemId}</h2>
        </div>
        <div className="admin-button-row">
          <button className="admin-secondary-button" type="button" onClick={() => setIsEditing((current) => !current)}>
            {isEditing ? 'View Record' : 'Edit Values'}
          </button>
          <button className="admin-secondary-button" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
      {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
      {isEditing ? (
        <div className="admin-editor">
          <div className="admin-editor-header">
            <strong>Edit catalogue item JSON</strong>
            <span>Saved through Supabase as the signed-in admin. RLS still applies.</span>
          </div>
          <textarea value={editorValue} onChange={(event) => setEditorValue(event.target.value)} spellCheck="false" />
          <div className="admin-button-row">
            <button className="admin-gold-button" type="button" onClick={saveCatalogueRecord} disabled={isSaving}>{isSaving ? 'Saving...' : 'Save Changes'}</button>
            <button className="admin-secondary-button" type="button" onClick={() => setEditorValue(JSON.stringify(raw || {}, null, 2))}>Reset</button>
          </div>
        </div>
      ) : null}
      <div className="admin-tabs">
        {itemTabs.map((tab) => <button className={activeTab === tab ? 'active' : ''} type="button" key={tab} onClick={() => setActiveTab(tab)}>{tab}</button>)}
      </div>
      <div className="admin-record-body">
        {activeTab === 'Overview' ? (
          <div className="admin-detail-grid">
            <AdminField label="Name" value={raw.name || details.subject} />
            <AdminField label="Catalogue ID" value={raw.item_id} mono />
            <AdminField label="Category" value={details.category} />
            <AdminField label="Subcategory" value={details.subcategory} />
            <AdminField label="Franchise" value={details.franchise} />
            <AdminField label="Set" value={details.collectible_set} />
            <AdminField label="Year" value={raw.release_year || details.release_year} />
            <AdminField label="Item Number" value={raw.card_number || raw.lego_set_number || raw.minifig_code || raw.catalog_code} />
            <AdminField label="Status" value={raw.availability || 'Published'} />
          </div>
        ) : null}
        {activeTab === 'Catalogue Data' ? <JsonBlock value={raw} /> : null}
        {activeTab === 'Category Data' ? <DynamicCategoryFields fields={categoryFields} /> : null}
        {activeTab === 'Relationships' ? <JsonBlock value={details} /> : null}
        {activeTab === 'Images' ? <MediaRows rows={record?.images || []} /> : null}
        {activeTab === 'Pricing' ? <JsonBlock value={{ market: record?.market, conditionPrices: record?.conditionPrices }} /> : null}
        {activeTab === 'Market Data' ? <CatalogueItemMarketData record={record} onReload={async () => setRecord(await loadCatalogueItemRecord(itemId))} /> : null}
        {activeTab === 'Sales' ? <JsonBlock value={record?.listings || []} /> : null}
        {activeTab === 'Sets' ? <JsonBlock value={{ collectible_set_id: raw.collectible_set_id, set: details.collectible_set, series_id: raw.series_id, subset_id: raw.subset_id }} /> : null}
        {activeTab === 'External IDs' ? <JsonBlock value={{ upc: raw.upc, bricklink_id: raw.bricklink_id, rebrickable_fig_id: raw.rebrickable_fig_id, scryfall_id: raw.scryfall_id, external_ids: raw.external_ids }} /> : null}
        {activeTab === 'Raw Data' ? <JsonBlock value={record} /> : null}
        {activeTab === 'History' ? <EmptyAdminState text="No catalogue change history table is connected yet. Future admin writes should record actor, field changes, and timestamps here." /> : null}
      </div>
    </section>
  )
}

function CatalogueItemMarketData({ record, onReload, storeContext = {} }) {
  const item = record?.raw || {}
  const reviewRef = useRef(null)
  const [provider, setProvider] = useState('ebay')
  const [query, setQuery] = useState(() => generateMarketSearchQuery(item))
  const [fetchResult, setFetchResult] = useState(null)
  const [candidates, setCandidates] = useState([])
  const [activeFilter, setActiveFilter] = useState('All')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState('')
  const [isEbayConfigOpen, setIsEbayConfigOpen] = useState(false)
  const [ebayConfig, setEbayConfig] = useState(null)
  const [ebayDraft, setEbayDraft] = useState({
    environment: 'production',
    marketplaceId: 'EBAY_CA',
    clientId: '',
    clientSecret: '',
    sellerAccessToken: '',
    salesDataMode: 'browse',
    merchantLocationKey: '',
    categoryId: '',
    paymentPolicyId: '',
    fulfillmentPolicyId: '',
    returnPolicyId: '',
    currency: 'CAD',
  })
  const [ebayConfigMessage, setEbayConfigMessage] = useState('')

  useEffect(() => {
    setQuery(generateMarketSearchQuery(item))
    setFetchResult(null)
    setCandidates([])
    setError('')
    setSuccess('')
  }, [item?.item_id])

  useEffect(() => {
    let cancelled = false

    async function loadEbayConfig() {
      try {
        const config = await window.nordvikDesktop?.getEbayApiConfig?.()
        if (!cancelled && config) {
          setEbayConfig(config)
          setEbayDraft({
            environment: config.environment || 'production',
            marketplaceId: config.marketplaceId || 'EBAY_CA',
            clientId: config.clientId || '',
            clientSecret: '',
            salesDataMode: config.salesDataMode || 'browse',
            sellerAccessToken: '',
            merchantLocationKey: config.merchantLocationKey || '',
            categoryId: config.categoryId || '',
            paymentPolicyId: config.paymentPolicyId || '',
            fulfillmentPolicyId: config.fulfillmentPolicyId || '',
            returnPolicyId: config.returnPolicyId || '',
            currency: config.currency || 'CAD',
          })
        }
      } catch (err) {
        if (!cancelled) setEbayConfigMessage(err.message || 'Could not load eBay API settings.')
      }
    }

    loadEbayConfig()

    return () => {
      cancelled = true
    }
  }, [])

  const savedSales = record?.marketSales || []
  const imports = record?.marketImports || []
  const marketBuckets = record?.marketBuckets || []
  const conditionChoices = marketConditionOptions(record)
  const filteredCandidates = candidates.filter((candidate) => {
    if (activeFilter === 'All') return true
    if (activeFilter === 'Raw') return candidate.itemState === 'RAW'
    if (activeFilter === 'Graded') return candidate.itemState === 'GRADED'
    if (activeFilter === 'Foil') return candidate.finish === 'FOIL'
    if (activeFilter === 'Non-Foil') return candidate.finish === 'NON_FOIL'
    if (activeFilter === 'Review') return candidate.reviewStatus === 'REVIEW'
    if (activeFilter === 'Excluded') return candidate.reviewStatus === 'EXCLUDED'
    return true
  })
  const summary = {
    found: candidates.length,
    matched: candidates.filter((candidate) => candidate.reviewStatus !== 'EXCLUDED').length,
    graded: candidates.filter((candidate) => candidate.itemState === 'GRADED').length,
    review: candidates.filter((candidate) => candidate.reviewStatus === 'REVIEW').length,
    excluded: candidates.filter((candidate) => candidate.reviewStatus === 'EXCLUDED').length,
  }

  async function runFetch() {
    setBusy('fetch')
    setError('')
    setSuccess('')
    try {
      const result = await fetchMarketSales({ catalogueItemId: item.item_id, provider, queryOverride: query, context: storeContext })
      setFetchResult(result)
      setCandidates(result.candidates || [])
      await onReload?.()
    } catch (err) {
      setError(err.message || 'Could not fetch market sales.')
    } finally {
      setBusy('')
    }
  }

  async function importCsv(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy('csv')
    setError('')
    setSuccess('')
    try {
      const text = await file.text()
      const parsed = parseMarketSalesCsv(text, item, storeContext)
      if (!parsed.length) throw new Error('No usable market sales rows were found in that CSV.')
      setProvider('csv')
      setFetchResult({
        provider: 'csv',
        candidates: parsed,
        import: null,
        uploadedFileName: file.name,
        uploadedAt: new Date().toISOString(),
      })
      setCandidates(parsed)
      setSuccess('')
      setActiveFilter('All')
      window.setTimeout(() => {
        reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 50)
    } catch (err) {
      setError(err.message || 'Could not import CSV.')
    } finally {
      setBusy('')
    }
  }

  function updateCandidate(candidateId, patch) {
    setCandidates((current) => current.map((candidate) => (
      candidate.id === candidateId ? { ...candidate, ...patch } : candidate
    )))
  }

  function bulkStatus(status) {
    setCandidates((current) => current.map((candidate) => (
      candidate.include ? { ...candidate, reviewStatus: status, include: status !== 'EXCLUDED' } : candidate
    )))
  }

  async function approveSelected(validOnly = false) {
    setBusy('approve')
    setError('')
    setSuccess('')
    try {
      const input = validOnly
        ? candidates.filter((candidate) => candidate.reviewStatus !== 'EXCLUDED')
        : candidates.filter((candidate) => candidate.include)
      const result = await approveMarketSales({ importId: fetchResult?.import?.id, candidates: input, context: storeContext })
      await onReload?.()
      setSuccess(`Saved ${result?.approved || input.length} market sale${(result?.approved || input.length) === 1 ? '' : 's'} for this item.`)
    } catch (err) {
      setError(err.message || 'Could not approve selected market sales.')
    } finally {
      setBusy('')
    }
  }

  async function saveEbayConfig() {
    setBusy('ebay-config')
    setError('')
    setEbayConfigMessage('')
    try {
      if (!window.nordvikDesktop?.saveEbayApiConfig) {
        throw new Error('eBay API settings are only available in the installed desktop app.')
      }
      const config = await window.nordvikDesktop.saveEbayApiConfig(ebayDraft)
      setEbayConfig(config)
      setEbayDraft((current) => ({ ...current, clientSecret: '', sellerAccessToken: '' }))
      setEbayConfigMessage('eBay API settings saved.')
    } catch (err) {
      setEbayConfigMessage(err.message || 'Could not save eBay API settings.')
    } finally {
      setBusy('')
    }
  }

  async function testEbayConfig() {
    setBusy('ebay-test')
    setError('')
    setEbayConfigMessage('')
    try {
      const config = await window.nordvikDesktop?.testEbayApiConfig?.()
      if (!config) throw new Error('eBay API test is only available in the installed desktop app.')
      setEbayConfig(config)
      setEbayConfigMessage('eBay OAuth connection succeeded.')
    } catch (err) {
      setEbayConfigMessage(err.message || 'eBay OAuth connection failed.')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="market-data-workspace">
      <section className="market-data-card">
        <div className="market-data-item-head">
          <div>
            <p className="admin-kicker">Admin Market Data</p>
            <h3>{item.name || item.subject || item.item_id}</h3>
            <small>{[record?.details?.category, record?.details?.franchise, record?.details?.collectible_set, item.card_number || item.lego_set_number || item.catalog_code].filter(Boolean).join(' · ') || item.item_id}</small>
            <small>Pricing sales history: platform admin only</small>
          </div>
          <div className="market-data-stats">
            <span><b>{item.market_price != null ? `$${Number(item.market_price).toFixed(2)}` : '—'}</b><small>Existing market</small></span>
            <span><b>{savedSales.length}</b><small>Saved sales</small></span>
            <span><b>{imports[0]?.started_at ? formatDate(imports[0].started_at) : 'Never'}</b><small>Last fetch</small></span>
          </div>
        </div>
        <div className="market-fetch-row">
          <select value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="ebay">eBay</option>
            <option value="tcgplayer" disabled>TCGplayer later</option>
            <option value="bricklink" disabled>BrickLink later</option>
          </select>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Generated market search query" />
          <button className="admin-gold-button" type="button" onClick={runFetch} disabled={busy === 'fetch' || !query.trim()}>
            {busy === 'fetch' ? 'Fetching...' : ebayConfig?.salesDataMode === 'insights' ? 'Fetch Market Sales' : 'Fetch eBay Listings'}
          </button>
        </div>
        <div className="admin-button-row">
          <button className="admin-secondary-button" type="button" onClick={() => setQuery(generateMarketSearchQuery(item))}>Regenerate Query</button>
          <button className="admin-secondary-button" type="button" onClick={onReload}>View Sales History</button>
          <button className="admin-secondary-button" type="button" onClick={() => setIsEbayConfigOpen((current) => !current)}>
            {ebayConfig?.clientSecretConfigured ? 'eBay Connected' : 'Configure eBay API'}
          </button>
          <label className={`admin-secondary-button market-csv-upload ${busy === 'csv' ? 'disabled' : ''}`}>
            <FileUp size={16} />
            {busy === 'csv' ? 'Importing CSV...' : 'Upload CSV to Selected Item'}
            <input type="file" accept=".csv,text/csv" onChange={importCsv} disabled={busy === 'csv'} />
          </label>
        </div>
        {isEbayConfigOpen ? (
          <div className="market-api-config">
            <label>
              <span>Environment</span>
              <select value={ebayDraft.environment} onChange={(event) => setEbayDraft({ ...ebayDraft, environment: event.target.value })}>
                <option value="production">Production</option>
                <option value="sandbox">Sandbox</option>
              </select>
            </label>
            <label>
              <span>Marketplace</span>
              <select value={ebayDraft.marketplaceId} onChange={(event) => setEbayDraft({ ...ebayDraft, marketplaceId: event.target.value })}>
                <option value="EBAY_CA">Canada</option>
                <option value="EBAY_US">United States</option>
                <option value="EBAY_GB">United Kingdom</option>
                <option value="EBAY_AU">Australia</option>
              </select>
            </label>
            <label>
              <span>Sales Data Mode</span>
              <select value={ebayDraft.salesDataMode} onChange={(event) => setEbayDraft({ ...ebayDraft, salesDataMode: event.target.value })}>
                <option value="browse">Browse API: active listings</option>
                <option value="insights">Marketplace Insights: sold history</option>
              </select>
            </label>
            <label>
              <span>Client ID</span>
              <input value={ebayDraft.clientId} onChange={(event) => setEbayDraft({ ...ebayDraft, clientId: event.target.value })} placeholder="eBay App ID / Client ID" />
            </label>
            <label>
              <span>Client Secret</span>
              <input type="password" value={ebayDraft.clientSecret} onChange={(event) => setEbayDraft({ ...ebayDraft, clientSecret: event.target.value })} placeholder={ebayConfig?.clientSecretConfigured ? 'Saved; leave blank to keep current secret' : 'eBay Cert ID / Client Secret'} />
            </label>
            <label>
              <span>Seller OAuth Token</span>
              <input type="password" value={ebayDraft.sellerAccessToken} onChange={(event) => setEbayDraft({ ...ebayDraft, sellerAccessToken: event.target.value })} placeholder={ebayConfig?.sellerAccessTokenConfigured ? 'Saved; leave blank to keep current seller token' : 'User access token with sell.inventory scope'} />
            </label>
            <label>
              <span>Currency</span>
              <input value={ebayDraft.currency} onChange={(event) => setEbayDraft({ ...ebayDraft, currency: event.target.value.toUpperCase() })} placeholder="CAD" />
            </label>
            <label>
              <span>Merchant Location Key</span>
              <input value={ebayDraft.merchantLocationKey} onChange={(event) => setEbayDraft({ ...ebayDraft, merchantLocationKey: event.target.value })} placeholder="Default warehouse/location key" />
            </label>
            <label>
              <span>Default Category ID</span>
              <input value={ebayDraft.categoryId} onChange={(event) => setEbayDraft({ ...ebayDraft, categoryId: event.target.value })} placeholder="e.g. eBay category ID" />
            </label>
            <label>
              <span>Payment Policy ID</span>
              <input value={ebayDraft.paymentPolicyId} onChange={(event) => setEbayDraft({ ...ebayDraft, paymentPolicyId: event.target.value })} />
            </label>
            <label>
              <span>Fulfillment Policy ID</span>
              <input value={ebayDraft.fulfillmentPolicyId} onChange={(event) => setEbayDraft({ ...ebayDraft, fulfillmentPolicyId: event.target.value })} />
            </label>
            <label>
              <span>Return Policy ID</span>
              <input value={ebayDraft.returnPolicyId} onChange={(event) => setEbayDraft({ ...ebayDraft, returnPolicyId: event.target.value })} />
            </label>
            <div className="admin-button-row">
              <button className="admin-gold-button" type="button" onClick={saveEbayConfig} disabled={busy === 'ebay-config'}>
                {busy === 'ebay-config' ? 'Saving...' : 'Save eBay API'}
              </button>
              <button className="admin-secondary-button" type="button" onClick={testEbayConfig} disabled={busy === 'ebay-test' || !ebayConfig?.clientSecretConfigured}>
                {busy === 'ebay-test' ? 'Testing...' : 'Test Connection'}
              </button>
            </div>
            {ebayConfigMessage ? <p className="admin-success">{ebayConfigMessage}</p> : null}
          </div>
        ) : null}
        {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
        {success ? <p className="admin-success">{success}</p> : null}
        {fetchResult?.error ? (
          <AdminDismissibleAlert
            className="admin-warning"
            onDismiss={() => setFetchResult((current) => ({ ...current, error: '' }))}
          >
            {fetchResult.error}
          </AdminDismissibleAlert>
        ) : null}
        {fetchResult?.uploadedFileName ? <p className="admin-success">Loaded {candidates.length} rows from {fetchResult.uploadedFileName}. Review them below, then approve the sales you want to save.</p> : null}
      </section>

      <MarketBucketStats buckets={marketBuckets} sales={savedSales} />

      <section className="market-data-card" ref={reviewRef}>
        <div className="market-review-header">
          <span><strong>{item.name || item.subject || 'Market Sale Review'}</strong><small>Source: {provider}</small></span>
          <span>{summary.found} found · {summary.matched} matched · {summary.graded} graded · {summary.review} need review · {summary.excluded} excluded</span>
        </div>
        <div className="market-review-tabs">
          {['All', 'Raw', 'Graded', 'Foil', 'Non-Foil', 'Review', 'Excluded'].map((filter) => (
            <button className={activeFilter === filter ? 'active' : ''} type="button" key={filter} onClick={() => setActiveFilter(filter)}>{filter}</button>
          ))}
        </div>
        <MarketCandidatesTable candidates={filteredCandidates} onUpdate={updateCandidate} conditionOptions={conditionChoices} />
        <div className="market-review-actions">
          <button type="button" onClick={() => approveSelected(false)} disabled={busy === 'approve' || !candidates.some((candidate) => candidate.include)}>Approve Selected</button>
          <button type="button" onClick={() => approveSelected(true)} disabled={busy === 'approve' || !candidates.length}>Approve All Valid</button>
          <button type="button" onClick={() => bulkStatus('EXCLUDED')} disabled={!candidates.some((candidate) => candidate.include)}>Reject Selected</button>
          <button type="button" onClick={() => setFetchResult((current) => ({ ...current, savedAt: new Date().toISOString() }))}>Save Review</button>
        </div>
      </section>

      <MarketHistory imports={imports} sales={savedSales} />
    </div>
  )
}

function parseMarketSalesCsv(text, item, storeContext = {}) {
  const rows = parseCsvRows(text)
  if (rows.length < 2) return []
  const headers = rows[0].map(normalizeCsvHeader)
  return rows.slice(1).map((row, index) => {
    const data = headers.reduce((acc, header, columnIndex) => {
      if (header) acc[header] = (row[columnIndex] || '').trim()
      return acc
    }, {})
    const soldPrice = parseMoney(readCsvValue(data, [
      'sold_price',
      'price',
      'price_each',
      'price_each_cad',
      'alt_price',
      'alt_price_cad',
      'soldprice',
      'amount',
      'total',
    ]))
    const exactSoldDate = readCsvValue(data, ['sold_at', 'date', 'date_sold', 'sold_date', 'dateofsale'])
    const soldMonth = readCsvValue(data, ['sold_month', 'month', 'sale_month'])
    const soldAt = parseCsvDate(exactSoldDate) || parseCsvMonth(soldMonth)
    if (soldPrice == null || !soldAt) return null
    const source = readCsvValue(data, ['source', 'provider', 'marketplace']) || 'CSV'
    const gradeValue = parseGrade(readCsvValue(data, ['grade', 'grade_numeric']))
    const grader = readCsvValue(data, ['grading_company', 'grader', 'gradingcompany'])
    const condition = readCsvValue(data, ['condition_code', 'condition', 'conditioncode'])
    return {
      id: `csv_${Date.now()}_${index}`,
      catalogueItemId: item.item_id,
      source,
      sourceSaleId: readCsvValue(data, ['source_sale_id', 'sale_id', 'providersaleid', 'external_id']) || null,
      sourceUrl: readCsvValue(data, ['source_url', 'url', 'link']) || null,
      title: readCsvValue(data, ['title', 'name', 'item_title']) || item.name || item.subject || 'CSV market sale',
      dateOfSale: soldAt,
      soldAt,
      price: soldPrice,
      soldPrice,
      shippingPrice: parseMoney(readCsvValue(data, ['shipping_price', 'shipping', 'shipping_cad', 'postage'])),
      currency: (readCsvValue(data, ['currency', 'currency_code']) || 'CAD').toUpperCase(),
      marketRegion: readCsvValue(data, ['market_region', 'region', 'country']) || null,
      normalisedCondition: condition,
      condition,
      conditionCode: conditionCodeForReview(condition),
      finish: normalizeFinish(readCsvValue(data, ['finish', 'foil'])),
      variant: readCsvValue(data, ['variant', 'parallel']) || null,
      language: readCsvValue(data, ['language', 'lang']) || null,
      itemState: grader || gradeValue != null ? 'GRADED' : 'RAW',
      grader: grader || null,
      grade: gradeValue,
      gradingLabel: readCsvValue(data, ['grading_label', 'label']) || null,
      quantity: Math.max(1, Number(readCsvValue(data, ['quantity', 'qty']) || 1)),
      include: true,
      reviewStatus: 'REVIEW',
      matchConfidence: 1,
      rawData: {
        ...data,
        date_precision: exactSoldDate ? 'day' : soldMonth ? 'month' : null,
      },
    }
  }).filter(Boolean)
}

function parseCsvRows(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      if (row.some((value) => value.trim())) rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }
  row.push(field)
  if (row.some((value) => value.trim())) rows.push(row)
  return rows
}

function normalizeCsvHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/^\uFEFF/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function readCsvValue(data, names) {
  for (const name of names) {
    const normalized = normalizeCsvHeader(name)
    if (data[normalized] != null && data[normalized] !== '') return data[normalized]
  }
  return ''
}

function parseMoney(value) {
  if (value == null || value === '') return null
  const number = Number(String(value).replace(/[^0-9.-]+/g, ''))
  return Number.isFinite(number) ? number : null
}

function parseGrade(value) {
  if (value == null || value === '') return null
  const number = Number(String(value).replace(/[^0-9.]+/g, ''))
  return Number.isFinite(number) ? number : null
}

function parseCsvDate(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const dateMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (dateMatch) {
    const [, year, month, day] = dateMatch
    return localMiddayIso(Number(year), Number(month) - 1, Number(day))
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
}

function parseCsvMonth(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const monthMatch = text.match(/^(\d{4})-(\d{1,2})$/)
  if (monthMatch) {
    const [, year, month] = monthMatch
    return localMiddayIso(Number(year), Number(month) - 1, 1)
  }
  const parsed = new Date(`${text} 1 12:00`)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
}

function localMiddayIso(year, monthIndex, day) {
  const parsed = new Date(year, monthIndex, day, 12, 0, 0, 0)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
}

function normalizeFinish(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return null
  if (['foil', 'holo', 'holofoil', 'yes', 'true'].includes(text)) return 'FOIL'
  if (['non foil', 'non-foil', 'nonfoil', 'regular', 'no', 'false'].includes(text)) return 'NON_FOIL'
  return value
}

function conditionCodeForReview(condition) {
  const normalized = String(condition || '').trim().toLowerCase()
  if (!normalized) return null
  const map = {
    mint: 'MT',
    'near mint': 'NM',
    nm: 'NM',
    'light played': 'LP',
    'lightly played': 'LP',
    lp: 'LP',
    'moderately played': 'MP',
    mp: 'MP',
    'heavily played': 'HP',
    hp: 'HP',
    damaged: 'DMG',
    dmg: 'DMG',
    sealed: 'SEALED',
    'new/sealed': 'SEALED',
    'pre-owned 100%': 'COMPLETE',
    'pre owned 100%': 'COMPLETE',
    'pre-owned - missing parts': 'MISSING_PARTS',
    'pre owned missing parts': 'MISSING_PARTS',
  }
  return map[normalized] || condition
}

function marketConditionOptions(record) {
  const item = record?.raw || {}
  const categoryText = [
    record?.details?.category,
    record?.details?.subcategory,
    item.categoryName,
    item.category,
    item.type,
  ].filter(Boolean).join(' ').toLowerCase()

  if (categoryText.includes('lego') || categoryText.includes('building')) {
    return ['New/Sealed', 'Pre-Owned 100%', 'Pre-Owned - Missing Parts', 'Damaged']
  }

  if (categoryText.includes('card') || categoryText.includes('pokemon') || categoryText.includes('magic') || categoryText.includes('sport')) {
    return ['Mint', 'Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged']
  }

  return ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged', 'New/Sealed', 'Used/Complete']
}

function optionsWithCurrent(options, currentValue) {
  const current = String(currentValue || '').trim()
  if (!current) return options
  const exists = options.some((option) => option.toLowerCase() === current.toLowerCase())
  return exists ? options : [current, ...options]
}

const marketSourceOptions = ['CSV', 'eBay', 'TCGplayer', 'CollectorsHub', 'CardLadder', 'Beckett', 'BrickLink', 'Other']

const marketSourceGroups = [
  { key: 'all', label: 'All Approved Sources' },
  { key: 'in_store', label: 'In-Store (CollectorsHub Partner Retail Stores)' },
  { key: 'collectorshub', label: 'CollectorsHub (items sold via CollectorsHub)' },
  { key: 'external', label: 'External (All other Sources)' },
]

const marketDateWindows = [
  { key: 'all', label: 'All time', days: null },
  { key: '90', label: '90 Days', days: 90 },
  { key: '60', label: '60 Days', days: 60 },
  { key: '30', label: '30 Days', days: 30 },
]

function MarketBucketStats({ buckets, sales = [] }) {
  const [sourceGroup, setSourceGroup] = useState('all')
  const [dateWindow, setDateWindow] = useState('all')
  const dateFilteredSales = sales.filter((sale) => marketSaleInDateWindow(sale, dateWindow))
  const sourceCounts = marketSourceGroups.reduce((acc, group) => {
    acc[group.key] = group.key === 'all'
      ? dateFilteredSales.length
      : dateFilteredSales.filter((sale) => marketSaleSourceGroup(sale) === group.key).length
    return acc
  }, {})
  const filteredSales = sourceGroup === 'all'
    ? dateFilteredSales
    : dateFilteredSales.filter((sale) => marketSaleSourceGroup(sale) === sourceGroup)
  const summary = summarizeApprovedSales(filteredSales)
  return (
    <section className="market-data-card">
      <div className="market-review-header">
        <span><strong>Calculated Market Pricing</strong><small>Direct sales-history values grouped by exact state</small></span>
      </div>
      <div className="market-source-filter-row">
        {marketSourceGroups.map((group) => (
          <button
            className={sourceGroup === group.key ? 'active' : ''}
            key={group.key}
            type="button"
            onClick={() => setSourceGroup(group.key)}
          >
            <span>{group.label}</span>
            <b>{sourceCounts[group.key] || 0}</b>
          </button>
        ))}
      </div>
      <div className="market-date-filter-row">
        {marketDateWindows.map((window) => (
          <button
            className={dateWindow === window.key ? 'active' : ''}
            key={window.key}
            type="button"
            onClick={() => setDateWindow(window.key)}
          >
            {window.label}
          </button>
        ))}
      </div>
      {summary.count ? (
        <>
          <div className="market-history-summary">
            <span><b>{summary.count}</b><small>Approved Sales</small></span>
            <span><b>{summary.average}</b><small>Average</small></span>
            <span><b>{summary.median}</b><small>Median</small></span>
            <span><b>{summary.range}</b><small>Range</small></span>
          </div>
          <div className="market-history-breakdown">
            <strong>Sources</strong>
            <span>{summary.sources}</span>
          </div>
          <div className="market-history-breakdown">
            <strong>Condition Averages</strong>
            <div className="market-history-condition-grid">
              {summary.conditionAverages.map((condition) => (
                <span key={condition.label}>
                  <b>{condition.label}</b>
                  <small>{condition.count} sales · avg {condition.average}</small>
                  <small>Low {condition.low} · High {condition.high}</small>
                </span>
              ))}
            </div>
          </div>
        </>
      ) : sales.length ? <EmptyAdminState text="No approved market sales match the selected source and date filters." /> : null}
      <div className="market-bucket-grid">
        {(buckets || []).map((bucket) => (
          <article className="market-bucket-card" key={[bucket.finish, bucket.condition_code, bucket.is_graded, bucket.grading_company, bucket.grade ?? bucket.grade_numeric, bucket.currency].join('|')}>
            <strong>{marketBucketLabel(bucket)}</strong>
            <span><b>{bucket.market_value != null ? `$${Number(bucket.market_value).toFixed(2)}` : '—'}</b><small>{bucket.value_basis || 'unavailable'}</small></span>
            <dl>
              <div><dt>Sales Recorded</dt><dd>{bucket.sales_count || 0}</dd></div>
              <div><dt>Average Sale</dt><dd>{formatCurrencyValue(bucket.average_price, bucket.currency)}</dd></div>
              <div><dt>Median Sale</dt><dd>{formatCurrencyValue(bucket.median_price, bucket.currency)}</dd></div>
              <div><dt>Latest Sale</dt><dd>{formatCurrencyValue(bucket.last_sale_price, bucket.currency)}</dd></div>
              <div><dt>30-Day Average</dt><dd>{formatCurrencyValue(bucket.avg_30d, bucket.currency)}</dd></div>
              <div><dt>Last Sold</dt><dd>{bucket.last_sale_at ? formatDate(bucket.last_sale_at) : '—'}</dd></div>
            </dl>
          </article>
        ))}
        {!buckets?.length && !sales.length ? <EmptyAdminState text="No approved market sales exist for this item yet, so no direct market value can be calculated." /> : null}
      </div>
    </section>
  )
}

function marketSaleSourceGroup(row) {
  const source = String(row?.source || row?.source_name || '').trim().toLowerCase()
  if (!source) return 'external'
  const compact = source.replace(/[\s_-]+/g, '')
  if (
    compact.includes('instore') ||
    compact.includes('pointofsale') ||
    source.includes('partner retail') ||
    source.includes('retail store') ||
    source.includes('pos')
  ) {
    return 'in_store'
  }
  if (source.includes('collectorshub')) return 'collectorshub'
  return 'external'
}

function marketSaleInDateWindow(row, windowKey) {
  const option = marketDateWindows.find((window) => window.key === windowKey)
  if (!option?.days) return true
  const value = marketSaleDate(row)
  if (!value) return false
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return false
  const cutoff = new Date()
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - option.days)
  return date >= cutoff
}

function marketBucketLabel(bucket) {
  const gradeValue = bucket.grade ?? bucket.grade_numeric
  const state = bucket.is_graded
    ? [bucket.finish, bucket.grading_company, gradeValue ? `Grade ${gradeValue}` : '', bucket.grading_label].filter(Boolean)
    : [bucket.finish, bucket.condition_code, bucket.variant, bucket.language].filter(Boolean)
  return state.length ? state.join(' · ') : 'Default raw bucket'
}

function formatCurrencyValue(value, currency = 'CAD') {
  if (value == null) return '—'
  return `${currency || 'CAD'} ${Number(value).toFixed(2)}`
}

function MarketCandidatesTable({ candidates, onUpdate, conditionOptions = [] }) {
  return (
    <div className="market-table-wrap">
      <table className="admin-table market-review-table">
        <thead>
          <tr>
            <th>Include</th>
            <th>Date</th>
            <th>Price</th>
            <th>Shipping</th>
            <th>Qty</th>
            <th>Currency</th>
            <th>Source</th>
            <th>Title</th>
            <th>State</th>
            <th>Finish</th>
            <th>Condition</th>
            <th>Grader</th>
            <th>Grade</th>
            <th>Confidence</th>
            <th>Status</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((candidate) => (
            <tr key={candidate.id}>
              <td><input type="checkbox" checked={candidate.include !== false} onChange={(event) => onUpdate(candidate.id, { include: event.target.checked })} /></td>
              <td>{candidate.dateOfSale ? new Date(candidate.dateOfSale).toLocaleDateString() : '—'}</td>
              <td>{Number(candidate.price || 0).toFixed(2)}</td>
              <td><input value={candidate.shippingPrice ?? ''} onChange={(event) => onUpdate(candidate.id, { shippingPrice: event.target.value ? Number(event.target.value) : null })} /></td>
              <td><input value={candidate.quantity || 1} onChange={(event) => onUpdate(candidate.id, { quantity: Math.max(1, Number(event.target.value || 1)) })} /></td>
              <td>{candidate.currency || '—'}</td>
              <td>
                <select value={candidate.source || ''} onChange={(event) => onUpdate(candidate.id, { source: event.target.value || null })}>
                  <option value="">Select source</option>
                  {optionsWithCurrent(marketSourceOptions, candidate.source).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </td>
              <td><strong>{candidate.title}</strong><small>{candidate.sourceSaleId || candidate.sourceUrl || 'No source ID'}</small></td>
              <td><select value={candidate.itemState || ''} onChange={(event) => onUpdate(candidate.id, { itemState: event.target.value || null })}><option value="">—</option><option>RAW</option><option>GRADED</option></select></td>
              <td><select value={candidate.finish || ''} onChange={(event) => onUpdate(candidate.id, { finish: event.target.value || null })}><option value="">Unknown</option><option value="FOIL">Foil</option><option value="NON_FOIL">Non-Foil</option></select></td>
              <td>
                <select
                  value={candidate.normalisedCondition || candidate.condition || ''}
                  onChange={(event) => {
                    const condition = event.target.value
                    onUpdate(candidate.id, {
                      normalisedCondition: condition || null,
                      condition: condition || null,
                      conditionCode: condition ? conditionCodeForReview(condition) : null,
                    })
                  }}
                >
                  <option value="">Select condition</option>
                  {optionsWithCurrent(conditionOptions, candidate.normalisedCondition || candidate.condition).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </td>
              <td><input value={candidate.grader || ''} onChange={(event) => onUpdate(candidate.id, { grader: event.target.value || null })} /></td>
              <td><input value={candidate.grade ?? ''} onChange={(event) => onUpdate(candidate.id, { grade: event.target.value ? Number(event.target.value) : null })} /></td>
              <td>{candidate.matchConfidence ?? '—'}</td>
              <td><select value={candidate.reviewStatus || 'REVIEW'} onChange={(event) => onUpdate(candidate.id, { reviewStatus: event.target.value, include: event.target.value !== 'EXCLUDED' })}><option>AUTO_APPROVED</option><option>REVIEW</option><option>EXCLUDED</option></select></td>
              <td>{candidate.exclusionReason || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!candidates.length ? <EmptyAdminState text="No fetched candidates to review. The provider may be unavailable or the search returned no official sold-market data." /> : null}
    </div>
  )
}

function MarketHistory({ imports, sales }) {
  const summary = summarizeApprovedSales(sales)
  const recentSales = [...(sales || [])]
    .sort((a, b) => new Date(marketSaleDate(b) || 0) - new Date(marketSaleDate(a) || 0))
    .slice(0, 8)
  return (
    <div className="admin-grid-two">
      <section className="market-data-card">
        <div className="market-review-header"><strong>Import History</strong></div>
        <RecordList rows={(imports || []).map((row) => ({
          id: row.id,
          title: `${formatDate(row.started_at)} · ${row.source}`,
          detail: row.search_query,
          status: `${row.results_found || 0} found · ${row.results_approved || 0} approved · ${row.status}`,
        }))} />
      </section>
      <section className="market-data-card">
        <div className="market-review-header">
          <span><strong>Approved Sales History</strong><small>{summary.count} approved rows</small></span>
        </div>
        {summary.count ? (
          <div className="market-history-breakdown">
            <strong>Recent</strong>
            <div className="market-history-recent">
              {recentSales.map((row) => (
                <div key={row.sale_id || row.source_sale_id || `${row.source}-${marketSaleDate(row)}-${marketSalePrice(row)}`}>
                  <span>{row.source || 'Sale'} · {formatDate(marketSaleDate(row))}</span>
                  <b>{formatCurrencyValue(marketSalePrice(row), row.currency || 'CAD')}</b>
                </div>
              ))}
            </div>
          </div>
        ) : <EmptyAdminState text="No approved market sales are saved for this item yet." />}
      </section>
    </div>
  )
}

function summarizeApprovedSales(sales = []) {
  const prices = sales.map(marketSalePrice).filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  const currency = sales.find((row) => row.currency)?.currency || 'CAD'
  const countBySource = countBy(sales, (row) => row.source || 'Unknown')
  const countByCondition = countBy(sales, (row) => row.condition || row.condition_code || 'Unknown')
  return {
    count: sales.length,
    average: prices.length ? formatCurrencyValue(prices.reduce((sum, value) => sum + value, 0) / prices.length, currency) : '—',
    median: prices.length ? formatCurrencyValue(medianValue(prices), currency) : '—',
    range: prices.length ? `${formatCurrencyValue(prices[0], currency)} - ${formatCurrencyValue(prices[prices.length - 1], currency)}` : '—',
    sources: formatCounts(countBySource),
    conditions: formatCounts(countByCondition),
    conditionAverages: conditionAverageRows(sales, currency),
  }
}

function conditionAverageRows(sales = [], currency = 'CAD') {
  const groups = sales.reduce((acc, row) => {
    const label = row.condition || row.condition_code || 'Unknown'
    const price = marketSalePrice(row)
    if (!Number.isFinite(price)) return acc
    if (!acc[label]) acc[label] = []
    acc[label].push(price)
    return acc
  }, {})
  return Object.entries(groups)
    .map(([label, prices]) => ({
      label,
      count: prices.length,
      average: formatCurrencyValue(prices.reduce((sum, value) => sum + value, 0) / prices.length, currency),
      low: formatCurrencyValue(Math.min(...prices), currency),
      high: formatCurrencyValue(Math.max(...prices), currency),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

function marketSalePrice(row) {
  const value = row?.sold_price ?? row?.price ?? row?.unit_sale_price
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function marketSaleDate(row) {
  return row?.sold_at || row?.date_of_sale || row?.sale_timestamp || row?.created_at || ''
}

function medianValue(sortedValues) {
  const middle = Math.floor(sortedValues.length / 2)
  return sortedValues.length % 2 ? sortedValues[middle] : (sortedValues[middle - 1] + sortedValues[middle]) / 2
}

function countBy(rows, getKey) {
  return rows.reduce((acc, row) => {
    const key = getKey(row)
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
}

function formatCounts(counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return entries.length ? entries.map(([label, count]) => `${label} ${count}`).join(' · ') : '—'
}

function DataExplorer() {
  const [table, setTable] = useState(ADMIN_EXPLORER_TABLES[0].table)
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState(null)
  const [tableConfig, setTableConfig] = useState(ADMIN_EXPLORER_TABLES[0])
  const [editorValue, setEditorValue] = useState('{}')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setPage(1)
  }, [table, search])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadExplorerRecords({ table, search, page, pageSize: PAGE_SIZE })
        .then((result) => {
          setRows(result.rows)
          setTotal(result.total)
          setTableConfig(result.config)
          const nextSelected = result.rows[0] || null
          setSelected(nextSelected)
          setEditorValue(JSON.stringify(nextSelected || {}, null, 2))
          setError('')
        })
        .catch((err) => setError(err.message || 'Could not load table.'))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [table, search, page])

  const columns = useMemo(() => Object.keys(rows[0] || {}).slice(0, 8), [rows])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function selectExplorerRow(row) {
    setSelected(row)
    setEditorValue(JSON.stringify(row || {}, null, 2))
  }

  async function saveExplorerRow() {
    const parsed = parseJsonEditor(editorValue)
    if (parsed.error) {
      setError(parsed.error)
      return
    }

    setIsSaving(true)
    try {
      const saved = await updateExplorerRecord({ table, record: selected, patch: parsed.data })
      const nextRows = rows.map((row) => row === selected ? saved : row)
      setRows(nextRows)
      setSelected(saved)
      setEditorValue(JSON.stringify(saved || {}, null, 2))
      setError('')
    } catch (err) {
      setError(err.message || 'Could not save record.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="admin-grid-two explorer-grid">
      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <p className="admin-kicker">Supabase admin explorer</p>
            <h2>Data Explorer</h2>
          </div>
          <span className={tableConfig?.editable ? 'admin-readonly editable' : 'admin-readonly'}>{tableConfig?.editable ? 'EDITABLE' : 'READ ONLY'}</span>
        </div>
        <div className="admin-filters">
          <select value={table} onChange={(event) => setTable(event.target.value)}>
            {ADMIN_EXPLORER_TABLES.map((entry) => <option key={entry.table} value={entry.table}>{entry.label}</option>)}
          </select>
          <label className="admin-search">
            <Search size={16} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search supported text/id fields..." />
          </label>
        </div>
        <div className="admin-table-note">{formatNumber(total)} records</div>
        {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
        <div className="admin-table-wrap">
          <table className="admin-table compact">
            <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
            <tbody>
              {rows.map((row, index) => (
                <tr className={selected === row ? 'selected' : ''} key={row.id || row.item_id || index} onClick={() => selectExplorerRow(row)}>
                  {columns.map((column) => <td key={column}>{String(row[column] ?? '—').slice(0, 90)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length ? <EmptyAdminState text="No rows visible for this table." /> : null}
        </div>
        <PaginationControls page={page} totalPages={totalPages} total={total} onPage={setPage} />
      </section>
      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <p className="admin-kicker">Record detail</p>
            <h2>All Columns</h2>
          </div>
        </div>
        <div className="admin-editor explorer-editor">
          <div className="admin-editor-header">
            <strong>{tableConfig?.label || table}</strong>
            <span>{tableConfig?.editable ? `Primary key: ${tableConfig.pk}` : 'This source is a view or protected read-only dataset.'}</span>
          </div>
          <textarea value={editorValue} onChange={(event) => setEditorValue(event.target.value)} spellCheck="false" disabled={!selected || !tableConfig?.editable} />
          <div className="admin-button-row">
            <button className="admin-gold-button" type="button" onClick={saveExplorerRow} disabled={!selected || !tableConfig?.editable || isSaving}>{isSaving ? 'Saving...' : 'Save Record'}</button>
            <button className="admin-secondary-button" type="button" onClick={() => setEditorValue(JSON.stringify(selected || {}, null, 2))}>Reset</button>
          </div>
        </div>
      </section>
    </div>
  )
}

function ScanIntake({ onCreateDraft }) {
  const [category, setCategory] = useState('Trading Cards')
  const [mode, setMode] = useState('Create Catalogue Items')
  const [frontImage, setFrontImage] = useState(null)
  const [backImage, setBackImage] = useState(null)
  const [scannerMessage, setScannerMessage] = useState('')
  const [scannerError, setScannerError] = useState('')
  const [colourMode, setColourMode] = useState('Colour')
  const [busy, setBusy] = useState('')
  const [metadata, setMetadata] = useState({
    cardName: '',
    set: '',
    seriesBlock: '',
    franchiseGame: '',
    manufacturerPublisher: '',
    releaseDate: '',
    rarity: '',
    variantParallel: '',
    finish: '',
    edition: '',
    cardType: '',
    characterSubject: '',
    cardAttributes: '',
    artist: '',
    promo: 'No',
    promoNumber: '',
    errorVariation: '',
    tcgplayerId: '',
    ebayExternalIds: '',
    player: '',
    cardNumber: '',
    year: '',
    brand: '',
    productSet: '',
    subsetInsertSet: '',
    sport: '',
    league: '',
    team: '',
    position: '',
    rookieCard: 'No',
    baseInsert: 'Base',
    parallel: '',
    parallelColour: '',
    variation: '',
    serialNumbered: 'No',
    serialNumber: '',
    printRun: '',
    autograph: 'No',
    autographType: '',
    memorabiliaRelic: 'No',
    memorabiliaType: '',
    memorabiliaSource: '',
    patchType: '',
    rookiePatchAuto: 'No',
    shortPrint: 'No',
    superShortPrint: 'No',
    caseHit: 'No',
    errorCorrection: '',
    multiPlayerCard: 'No',
    otherPlayers: '',
    draftTeam: '',
    collegeJuniorTeam: '',
    country: '',
    gradingCompany: '',
    grade: '',
    subgrades: '',
    certificationNumber: '',
    rawCondition: '',
    marketValue: '',
    lastSale: '',
    priceUpdated: '',
    externalIds: '',
    description: '',
    
    // Legacy aliases remain available for older drafts and matching code.
    name: '',
    subject: '',
    subcategory: '',
    franchise: '',
    subfranchise: '',
    property: '',
    itemType: '',
    collection: '',
    idNumber: '',
    publisherManufacturer: '',
    retailPrice: '',
    releaseYear: '',
    availability: 'Available',
    barcodes: '',
    includes: '',
    includedIn: '',
    setNumber: '',
    catalogueNumber: '',
    barcode: '',
    setName: '',
    manufacturer: '',
    variant: '',
    language: '',
    country: '',
    notes: '',
  })
  const [error, setError] = useState('')

  async function pickImage(side) {
    setScannerError('')
    setScannerMessage('Choose a saved scan image.')
    try {
      const files = await adminDesktopApi().selectScanImages()
      const image = files?.[0]
      if (!image) {
        setScannerMessage('No scan image selected.')
        return
      }
      if (side === 'front') setFrontImage(image)
      if (side === 'back') setBackImage(image)
      setScannerMessage(`${side === 'front' ? 'Front' : 'Back'} image imported.`)
    } catch (error) {
      setScannerError(error.message || 'Could not import the scan image.')
    }
  }

  async function scanFromDevice(side) {
    if (busy) return
    setBusy('scan')
    setScannerError('')
    setScannerMessage('Detecting scanner...')
    const waitingTimer = window.setTimeout(() => {
      setScannerMessage('Waiting for the scanner transfer window...')
    }, 1500)
    try {
      const image = await adminDesktopApi().scanImage({ colourMode })
      window.clearTimeout(waitingTimer)
      if (image?.needsSelection) {
        const names = (image.scanners || []).map((scanner) => scanner.name).filter(Boolean)
        setScannerMessage(names.length ? `${image.message} Found: ${names.join(', ')}` : image.message || 'Choose a WIA scanner before scanning.')
        return
      }
      if (!image || image.canceled) {
        setScannerMessage('Scan canceled.')
        return
      }
      if (side === 'front') setFrontImage(image)
      if (side === 'back') setBackImage(image)
      setScannerMessage(`${side === 'front' ? 'Front' : 'Back'} scan captured${image.cropped ? ' and auto-cropped' : ''}.`)
    } catch (error) {
      window.clearTimeout(waitingTimer)
      setScannerMessage('')
      setScannerError(error.message || 'Could not connect to the Canon scanner.')
    } finally {
      setBusy('')
    }
  }

  async function createDraft() {
    if (busy) return
    if (!frontImage && !backImage) {
      setError('Add at least one scanned image before creating a draft.')
      return
    }

    setBusy('draft')
    setError('')
    setScannerMessage('Reading card text and searching the catalogue...')
    try {
      await onCreateDraft({
        type: 'Scanned catalogue draft',
        scanner: frontImage?.scannerName || backImage?.scannerName || 'Imported image',
        category,
        mode,
        confidence: null,
        possibleMatch: null,
        frontImage,
        backImage,
        metadata,
      })
    } catch (error) {
      setScannerMessage('')
      setError(error.message || 'Could not create the review draft.')
      setBusy('')
    }
  }

  function textField(key, label, placeholder = '') {
    return <label key={key}>{label}<input value={metadata[key] || ''} onChange={(event) => setMetadata((current) => ({ ...current, [key]: event.target.value }))} placeholder={placeholder} /></label>
  }

  function choiceField(key, label, options) {
    return <label key={key}>{label}<select value={metadata[key] || options[0]} onChange={(event) => setMetadata((current) => ({ ...current, [key]: event.target.value }))}>{options.map((option) => <option key={option}>{option}</option>)}</select></label>
  }

  return (
    <div className="admin-grid-two scan-intake-grid">
      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <p className="admin-kicker">Scanner</p>
            <h2>Canon flatbed scanner</h2>
          </div>
          <span className="admin-status-pill"><span /> {busy === 'scan' ? 'Scanning...' : busy === 'draft' ? 'Analysing...' : (frontImage?.scannerName || backImage?.scannerName || 'Ready')}</span>
        </div>
        {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
        {scannerMessage ? <p className="admin-success">{scannerMessage}</p> : null}
        {scannerError ? <AdminDismissibleAlert onDismiss={() => setScannerError('')}>{scannerError}</AdminDismissibleAlert> : null}
        <div className="scan-controls">
          <label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option>Trading Cards</option><option>Sports Cards</option><option>Coins</option><option>LEGO / Building Blocks</option><option>Comics</option><option>Video Games</option></select></label>
          <label>Scan Mode<select value={mode} onChange={(event) => setMode(event.target.value)}><option>Create Catalogue Items</option><option>Match Existing Catalogue</option><option>Image Capture Only</option></select></label>
          <label>Colour Mode<select value={colourMode} onChange={(event) => setColourMode(event.target.value)}><option>Colour</option><option>Greyscale</option></select></label>
        </div>
        <div className="scan-image-grid">
          <ScanImageSlot label="Front Image" image={frontImage} onPick={() => pickImage('front')} />
          <ScanImageSlot label="Back Image" image={backImage} onPick={() => pickImage('back')} />
        </div>
        {category === 'Trading Cards' ? <>
        <div className="scan-field-group"><strong>Trading card identity</strong><div className="scan-metadata-grid">
          {textField('cardName', 'Card name', 'Charizard ex')}{textField('cardNumber', 'Card number', '199/165')}{textField('set', 'Set', 'Scarlet & Violet—151')}{textField('seriesBlock', 'Series / block', 'Scarlet & Violet')}{textField('franchiseGame', 'Franchise / game', 'Pokémon')}{textField('manufacturerPublisher', 'Manufacturer / publisher', 'The Pokémon Company')}{textField('year', 'Release year', '2023')}{textField('releaseDate', 'Release date', '22 September 2023')}{textField('rarity', 'Rarity', 'Special Illustration Rare')}{textField('variantParallel', 'Variant / parallel', 'Reverse Holo')}{textField('finish', 'Finish', 'Holofoil')}{textField('language', 'Language', 'English')}{textField('edition', 'Edition', '1st Edition / Unlimited')}{textField('cardType', 'Card type', 'Pokémon / Trainer / Energy')}{textField('characterSubject', 'Character / subject', 'Charizard')}{textField('cardAttributes', 'Card attributes', 'Fire, Stage 2, ex')}{textField('artist', 'Artist', 'miki kudo')}
        </div></div>
        <div className="scan-field-group"><strong>Trading card attributes</strong><div className="scan-metadata-grid">
          {textField('serialNumber', 'Serial number', '12/25')}{textField('printRun', 'Print run', '25')}{choiceField('promo', 'Promo', ['No', 'Yes'])}{textField('promoNumber', 'Promo number', 'SWSH260')}{choiceField('autograph', 'Autograph', ['No', 'Yes'])}{choiceField('memorabiliaRelic', 'Memorabilia / relic', ['No', 'Yes'])}{choiceField('rookieCard', 'Rookie card', ['No', 'Yes'])}{choiceField('shortPrint', 'Short print / SSP', ['No', 'Yes'])}{textField('errorVariation', 'Error / variation', 'Error, corrected version, image variation')}
        </div></div>
        </> : category === 'Sports Cards' ? <>
        <div className="scan-field-group"><strong>Sports card identity</strong><div className="scan-metadata-grid">
          {textField('cardName', 'Card name', 'Drake Maye')}{textField('player', 'Player(s) ; separated', 'Drake Maye; Jayden Daniels')}{textField('cardNumber', 'Card number', '101')}{textField('year', 'Year', '2024')}{textField('brand', 'Brand', 'Panini')}{textField('productSet', 'Product / set', 'Contenders Football')}{textField('subsetInsertSet', 'Subset / insert set', 'Rookie Ticket')}{textField('sport', 'Sport', 'Football')}{textField('league', 'League', 'NFL')}{textField('team', 'Team', 'New England Patriots')}{textField('position', 'Position', 'QB')}
        </div></div>
        <div className="scan-field-group"><strong>Card attributes</strong><div className="scan-metadata-grid">
          {choiceField('rookieCard', 'Rookie card', ['No', 'Yes'])}{choiceField('baseInsert', 'Base / insert', ['Base', 'Insert'])}{textField('parallel', 'Parallel', 'Cracked Ice')}{textField('parallelColour', 'Parallel colour', 'Blue')}{textField('variation', 'Variation', 'Photo Variation')}{choiceField('serialNumbered', 'Serial numbered', ['No', 'Yes'])}{textField('serialNumber', 'Serial number', '12/25')}{textField('printRun', 'Print run', '25')}{choiceField('shortPrint', 'Short print', ['No', 'Yes'])}{choiceField('superShortPrint', 'Super short print', ['No', 'Yes'])}{choiceField('caseHit', 'Case hit', ['No', 'Yes'])}{textField('errorCorrection', 'Error / correction', 'Error or Corrected')}
        </div></div>
        <div className="scan-field-group"><strong>Autograph and memorabilia</strong><div className="scan-metadata-grid">
          {choiceField('autograph', 'Autograph', ['No', 'Yes'])}{textField('autographType', 'Autograph type', 'On-card / Sticker')}{choiceField('memorabiliaRelic', 'Memorabilia / relic', ['No', 'Yes'])}{textField('memorabiliaType', 'Memorabilia type', 'Jersey / Patch / Football')}{textField('memorabiliaSource', 'Memorabilia source', 'Game-Worn')}{textField('patchType', 'Patch type', '1 Colour / Logo Patch')}{choiceField('rookiePatchAuto', 'Rookie patch auto', ['No', 'Yes'])}
        </div></div>
        </> : <div className="scan-category-note">Category-specific scanner fields are not configured yet.</div>}
        <div className="admin-quick-actions">
          <button className="admin-gold-button" type="button" disabled={Boolean(busy)} onClick={() => scanFromDevice('front')}>Scan Front with Canon</button>
          <button className="admin-gold-button" type="button" disabled={Boolean(busy)} onClick={() => scanFromDevice('back')}>Scan Back with Canon</button>
          <button type="button" disabled={Boolean(busy)} onClick={() => pickImage('front')}>Import Front File</button>
          <button type="button" disabled={Boolean(busy)} onClick={() => pickImage('back')}>Import Back File</button>
          <button type="button" disabled={Boolean(busy)} onClick={createDraft}>{busy === 'draft' ? 'Analysing...' : 'Create Review Draft'}</button>
        </div>
      </section>
      <section className="admin-panel scan-workflow-panel">
        <div className="admin-panel-header"><div><p className="admin-kicker">Quick status</p><h2>Scan Workflow</h2></div></div>
        <ol className="admin-flow">
          <li>Click Scan Front with Canon or Scan Back with Canon</li>
          <li>Windows opens the Canon WIA scan control</li>
          <li>Captured images are saved into the Desktop local scan cache</li>
          <li>Catalogue search / recognition</li>
          <li>Possible match + confidence score</li>
          <li>Review queue: match existing, create draft, or publish after admin review</li>
        </ol>
      </section>
    </div>
  )
}

function ScanImageSlot({ label, image, onPick }) {
  return (
    <button className="scan-image-slot" type="button" onClick={onPick}>
      {image?.url ? <img src={image.url} alt="" /> : <span><Image size={24} />{label}</span>}
      <strong>{image?.fileName || 'Choose image'}</strong>
      {image?.cropped ? <small>Auto-cropped</small> : null}
    </button>
  )
}

function PendingReview({ drafts, onUpdateDraft, onDeleteDraft, onCreateMore }) {
  const rows = drafts || []
  const [busyId, setBusyId] = useState('')

  async function analyze(draft) {
    setBusyId(draft.id)
    try {
      const ocrDraft = await enrichDraftWithOcr(draft)
      const scanAnalysis = await identifyScannedDraft(ocrDraft)
      await onUpdateDraft(draft.id, { category: ocrDraft.category, metadata: ocrDraft.metadata, ocr: ocrDraft.ocr, scanAnalysis, status: scanAnalysis.status, analysisError: '' })
    } catch (error) {
      await onUpdateDraft(draft.id, { analysisError: error.message || 'Scan analysis failed.' })
    } finally {
      setBusyId('')
    }
  }

  async function createItem(draft) {
    setBusyId(draft.id)
    try {
      const item = await createCatalogueItemFromScan(draft)
      await onUpdateDraft(draft.id, {
        status: 'Catalogue Item Created',
        createdItemId: item?.item_id || null,
        audit: [...(draft.audit || []), { action: 'create', itemId: item?.item_id, at: new Date().toISOString() }],
      })
    } catch (error) {
      await onUpdateDraft(draft.id, { analysisError: error.message || 'Could not create catalogue item.' })
    } finally {
      setBusyId('')
    }
  }

  function setFieldDecision(draft, field, decision) {
    const comparisons = (draft.scanAnalysis?.bestMatch?.comparisons || []).map((comparison) => (
      comparison.field === field ? { ...comparison, decision } : comparison
    ))
    onUpdateDraft(draft.id, {
      scanAnalysis: {
        ...draft.scanAnalysis,
        bestMatch: { ...draft.scanAnalysis.bestMatch, comparisons },
      },
    })
  }

  function setAllDecisions(draft, decision) {
    const comparisons = (draft.scanAnalysis?.bestMatch?.comparisons || []).map((comparison) => (
      comparison.differs ? { ...comparison, decision } : comparison
    ))
    onUpdateDraft(draft.id, {
      scanAnalysis: {
        ...draft.scanAnalysis,
        bestMatch: { ...draft.scanAnalysis.bestMatch, comparisons },
      },
    })
  }

  async function applyApprovedChanges(draft) {
    const match = draft.scanAnalysis?.bestMatch
    const approved = (match?.comparisons || []).filter((comparison) => comparison.differs && comparison.decision === 'approve')
    if (!match?.item?.item_id || !approved.length) return
    setBusyId(draft.id)
    try {
      const dynamicFields = { ...(match.item.dynamic_fields || {}) }
      const patch = {}
      approved.forEach((comparison) => {
        if (comparison.field === 'name') patch.name = comparison.proposedValue
        if (comparison.field === 'year') patch.release_year = Number(comparison.proposedValue) || null
        if (comparison.field === 'card_number') patch.card_number = comparison.proposedValue
        if (comparison.field === 'barcode') patch.upc = comparison.proposedValue
        if (comparison.field === 'manufacturer') dynamicFields.manufacturer = comparison.proposedValue
        if (comparison.field === 'set_or_series') dynamicFields.set_name = comparison.proposedValue
        if (comparison.field === 'variant') dynamicFields.variant = comparison.proposedValue
        if (comparison.field === 'language') dynamicFields.language = comparison.proposedValue
        if (comparison.field === 'country') dynamicFields.country = comparison.proposedValue
      })
      patch.dynamic_fields = dynamicFields
      await updateCatalogueItemRecord(match.item.item_id, patch)
      await onUpdateDraft(draft.id, {
        status: 'Matched and Updated',
        audit: [...(draft.audit || []), { action: 'approve_scan_changes', itemId: match.item.item_id, fields: approved.map((entry) => entry.field), at: new Date().toISOString() }],
      })
    } catch (error) {
      await onUpdateDraft(draft.id, { analysisError: error.message || 'Could not apply approved changes.' })
    } finally {
      setBusyId('')
    }
  }

  return (
    <section className="admin-panel">
      <div className="admin-panel-header">
        <div>
          <p className="admin-kicker">Exception-based review</p>
          <h2>Pending Review Queue</h2>
        </div>
        <button className="admin-gold-button" type="button" onClick={onCreateMore}>Scan New Item</button>
      </div>
      {!rows.length ? <EmptyAdminState text="No scanned drafts yet. Import front/back scanner images from Scan Intake to create review drafts." /> : null}
      <div className="review-draft-list">
        {rows.map((draft) => {
          const title = scanDraftTitle(draft)
          const metadataRows = meaningfulScanMetadata(draft.metadata)
          const route = scanRouteLabel(draft.scanAnalysis?.route)
          const confidence = Number(draft.scanAnalysis?.confidence || 0)
          return (
          <div className="review-draft-card" key={draft.id}>
            <div className="review-draft-images">
              {draft.frontImage?.url ? <img src={draft.frontImage.url} alt="" /> : <span>Front</span>}
              {draft.backImage?.url ? <img src={draft.backImage.url} alt="" /> : <span>Back</span>}
            </div>
            <div>
              <strong>{title}</strong>
              <span>{draft.category} · {draft.mode}</span>
              <small>{formatDate(draft.createdAt)}</small>
              <div className="scan-analysis">
                <span className="confidence-badge">{draft.scanAnalysis ? `${confidence}% confidence` : 'Not analyzed'}</span>
                <strong>{route}</strong>
                {draft.status ? <small>Status: {draft.status}</small> : null}
                {draft.scanAnalysis?.bestMatch ? <small>Best match: {draft.scanAnalysis.bestMatch.item?.name || draft.scanAnalysis.bestMatch.item?.subject || draft.scanAnalysis.bestMatch.item?.item_id}</small> : null}
                {draft.scanAnalysis?.bestMatch?.reasons?.length ? <small>{draft.scanAnalysis.bestMatch.reasons.join(' · ')}</small> : null}
                {draft.ocr?.confidenceNotes?.length ? <small>OCR: {draft.ocr.confidenceNotes.join(' · ')}</small> : null}
                {draft.ocr?.rejectedNames?.length ? <small>Ignored uncertain OCR name: {draft.ocr.rejectedNames[0]}</small> : null}
                {!metadataRows.length ? <small>No item identity fields were captured yet. Add card/player/set details before creating a catalogue item.</small> : null}
              </div>
              {metadataRows.length ? (
                <div className="scan-metadata-summary">
                  {metadataRows.map(([key, value]) => (
                    <span key={key}><strong>{key.replace(/([A-Z])/g, ' $1').replaceAll('_', ' ')}</strong>{String(value)}</span>
                  ))}
                </div>
              ) : null}
              {draft.scanAnalysis?.bestMatch?.comparisons?.length ? (
                <div className="review-comparison">
                  <div className="review-comparison-header"><strong>Current vs scanned</strong><span><button type="button" onClick={() => setAllDecisions(draft, 'approve')}>Approve all</button><button type="button" onClick={() => setAllDecisions(draft, 'deny')}>Deny all</button></span></div>
                  {draft.scanAnalysis.bestMatch.comparisons.map((comparison) => (
                    <div className={comparison.differs ? 'review-comparison-row changed' : 'review-comparison-row'} key={comparison.field}>
                      <span>{comparison.field.replaceAll('_', ' ')}</span>
                      <small>{comparison.currentValue || '—'} → {comparison.proposedValue || '—'}</small>
                      {comparison.differs ? <button type="button" onClick={() => setFieldDecision(draft, comparison.field, comparison.decision === 'approve' ? 'deny' : 'approve')}>{comparison.decision === 'approve' ? 'Keep existing' : 'Approve scanned'}</button> : <em>Same</em>}
                    </div>
                  ))}
                </div>
              ) : null}
              {draft.analysisError ? <p className="admin-error">{draft.analysisError}</p> : null}
              <details className="review-raw-details">
                <summary>Raw scan details</summary>
                <JsonBlock value={{ metadata: draft.metadata, scanner: draft.scanner, status: draft.status, ocr: draft.ocr, analysis: draft.scanAnalysis }} />
              </details>
            </div>
            <div className="review-actions">
              <button type="button" onClick={() => analyze(draft)} disabled={busyId === draft.id}>{busyId === draft.id ? 'Working...' : 'Analyze Scan'}</button>
              {draft.scanAnalysis?.route === 'new_item_proposal' ? <button type="button" onClick={() => createItem(draft)} disabled={busyId === draft.id}>Create Catalogue Item</button> : null}
              {draft.scanAnalysis?.route === 'existing_match' ? <button type="button" onClick={() => onUpdateDraft(draft.id, { status: 'Matched', matchedItemId: draft.scanAnalysis.bestMatch.item.item_id })}>Match Existing</button> : null}
              {draft.scanAnalysis?.route === 'manual_review_existing_item' ? <button type="button" onClick={() => applyApprovedChanges(draft)} disabled={busyId === draft.id}>Apply Approved Changes</button> : null}
              {draft.scanAnalysis?.route === 'possible_duplicate' ? <><button type="button" onClick={() => onUpdateDraft(draft.id, { status: 'Confirmed Same Item', matchedItemId: draft.scanAnalysis.bestMatch.item.item_id })}>Same Item</button><button type="button" onClick={() => createItem(draft)} disabled={busyId === draft.id}>Create New</button></> : null}
              <button type="button" onClick={() => onUpdateDraft(draft.id, { status: 'Rejected' })}>Reject</button>
              <button type="button" onClick={() => onUpdateDraft(draft.id, { status: 'Review Later' })}>Review Later</button>
              <button className="danger" type="button" onClick={() => {
                if (window.confirm('Delete this scan draft from the pending review queue?')) onDeleteDraft?.(draft.id)
              }}>Delete</button>
            </div>
          </div>
          )
        })}
      </div>
    </section>
  )
}

function TaxonomyAdmin() {
  const [taxonomy, setTaxonomy] = useState(null)
  const [activeSection, setActiveSection] = useState('categories')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    loadTaxonomyData()
      .then((data) => {
        if (!cancelled) {
          setTaxonomy(data)
          setError('')
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load taxonomy.')
      })
    return () => { cancelled = true }
  }, [])

  const sections = taxonomy?.sections || []
  const selected = sections.find((section) => section.key === activeSection) || sections[0]
  const query = search.trim().toLowerCase()
  const filteredRows = (selected?.rows || []).filter((row) => (
    !query || [row.name, row.parent, row.type, row.id].some((value) => String(value || '').toLowerCase().includes(query))
  ))
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE))
  const rows = filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  useEffect(() => {
    setPage(1)
  }, [activeSection, search])

  return (
    <div className="admin-grid-two taxonomy-grid">
      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <p className="admin-kicker">Real catalogue taxonomy</p>
            <h2>Taxonomy</h2>
          </div>
        </div>
        {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
        <div className="taxonomy-section-list">
          {sections.map((section) => (
            <button className={selected?.key === section.key ? 'active' : ''} type="button" key={section.key} onClick={() => setActiveSection(section.key)}>
              <span>{section.title}</span>
              <strong>{formatNumber(section.rows.length)}</strong>
            </button>
          ))}
        </div>
      </section>

      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <p className="admin-kicker">{selected?.title || 'Taxonomy'}</p>
            <h2>Parent / Child Relationships</h2>
          </div>
        </div>
        {selected?.error ? <p className="admin-error">{selected.error}</p> : null}
        <div className="admin-filters">
          <label className="admin-search">
            <Search size={16} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search taxonomy..." />
          </label>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table compact">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Parent</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.type}-${row.id}`}>
                  <td><strong>{row.name || 'Unnamed'}</strong></td>
                  <td>{row.type}</td>
                  <td>{row.parent || '—'}</td>
                  <td><code>{row.id}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length ? <EmptyAdminState text="No taxonomy records found for this section." /> : null}
        </div>
        <PaginationControls page={page} totalPages={totalPages} total={filteredRows.length} onPage={setPage} />
      </section>
    </div>
  )
}

function AdminSectionBrowser({ title, kicker, loader }) {
  const [data, setData] = useState(null)
  const [activeSection, setActiveSection] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    loader()
      .then((nextData) => {
        if (!cancelled) {
          setData(nextData)
          setActiveSection(nextData.sections?.[0]?.key || '')
          setSelected(nextData.sections?.[0]?.rows?.[0] || null)
          setError('')
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || `Could not load ${title}.`)
      })
    return () => { cancelled = true }
  }, [loader, title])

  const sections = data?.sections || []
  const current = sections.find((section) => section.key === activeSection) || sections[0]
  const query = search.trim().toLowerCase()
  const filteredRows = (current?.rows || []).filter((row) => (
    !query || [row.title, row.detail, row.status, row.id].some((value) => String(value || '').toLowerCase().includes(query))
  ))
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE))
  const rows = filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  useEffect(() => {
    setPage(1)
  }, [activeSection, search])

  function chooseSection(section) {
    setActiveSection(section.key)
    setSelected(section.rows[0] || null)
    setSearch('')
    setPage(1)
  }

  return (
    <div className="admin-grid-two taxonomy-grid">
      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <p className="admin-kicker">{kicker}</p>
            <h2>{title}</h2>
          </div>
        </div>
        {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
        <div className="taxonomy-section-list">
          {sections.map((section) => (
            <button className={current?.key === section.key ? 'active' : ''} type="button" key={section.key} onClick={() => chooseSection(section)}>
              <span>{section.title}</span>
              <strong>{formatNumber(section.rows.length)}</strong>
            </button>
          ))}
        </div>
      </section>

      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <p className="admin-kicker">{current?.title || title}</p>
            <h2>Records</h2>
          </div>
        </div>
        {current?.error ? <p className="admin-error">{current.error}</p> : null}
        <div className="admin-filters">
          <label className="admin-search">
            <Search size={16} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${current?.title || title}...`} />
          </label>
        </div>
        <div className="admin-split-records">
          <div className="admin-table-wrap">
            <table className="admin-table compact">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Detail</th>
                  <th>Status</th>
                  <th>ID</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr className={selected?.id === row.id ? 'selected' : ''} key={`${current?.key}-${row.id}`} onClick={() => setSelected(row)}>
                    <td><strong>{row.title || 'Unnamed'}</strong></td>
                    <td>{row.detail || '—'}</td>
                    <td>{String(row.status ?? '—')}</td>
                    <td><code>{row.id}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length ? <EmptyAdminState text="No records found for this section." /> : null}
          </div>
          <PaginationControls page={page} totalPages={totalPages} total={filteredRows.length} onPage={setPage} />
          <div className="admin-record-summary">
            <h3>Selected Record</h3>
            <JsonBlock value={selected || {}} />
          </div>
        </div>
      </section>
    </div>
  )
}

function PaginationControls({ page, totalPages, total, onPage }) {
  const start = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const end = Math.min(total, page * PAGE_SIZE)
  return (
    <div className="admin-pagination">
      <span>{formatNumber(start)}-{formatNumber(end)} of {formatNumber(total)}</span>
      <div>
        <button type="button" onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1}>Previous</button>
        <strong>Page {page} of {totalPages}</strong>
        <button type="button" onClick={() => onPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages}>Next</button>
      </div>
    </div>
  )
}

function AdminSystem({ syncStatus }) {
  return (
    <section className="admin-panel">
      <div className="admin-panel-header">
        <div>
          <p className="admin-kicker">System health</p>
          <h2>System / Sync</h2>
        </div>
      </div>
      <div className="admin-detail-grid">
        <AdminField label="Supabase connection" value={syncStatus?.online ? 'Online' : 'Offline'} />
        <AdminField label="Desktop local cache" value="Available" />
        <AdminField label="Last sync" value={formatDate(syncStatus?.lastSyncAt)} />
        <AdminField label="Pending local changes" value={syncStatus?.pendingLocalChanges || 0} />
        <AdminField label="Failed syncs" value={syncStatus?.error || 'None'} />
        <AdminField label="Scanner service" value="Disconnected" />
      </div>
    </section>
  )
}

function AdminMetric({ label, value, accent, warning }) {
  return (
    <div className={warning ? 'admin-metric warning' : accent ? 'admin-metric accent' : 'admin-metric'}>
      <span>{label}</span>
      <strong>{formatNumber(value)}</strong>
    </div>
  )
}

function AdminPanel({ title, children }) {
  return (
    <section className="admin-panel">
      <div className="admin-panel-header"><h2>{title}</h2></div>
      {children}
    </section>
  )
}

function CompactItemList({ rows }) {
  if (!rows.length) return <EmptyAdminState text="No catalogue changes visible." />
  return rows.map((row) => (
    <p className="admin-list-line" key={row.item_id}>
      <strong>{row.displayName}</strong>
      <span>{row.categoryName || 'Uncategorised'} · {row.pricingStatus}</span>
    </p>
  ))
}

function RecordList({ rows }) {
  if (!rows.length) return <EmptyAdminState text="No recent imports or image search jobs visible." />
  return rows.map((row, index) => (
    <p className="admin-list-line" key={row.id || index}>
      <strong>{row.status || row.trigger || row.id}</strong>
      <span>{formatDate(row.created_at || row.started_at || row.completed_at)}</span>
    </p>
  ))
}

function DynamicCategoryFields({ fields }) {
  const entries = Object.entries(fields || {})
  if (!entries.length) return <EmptyAdminState text="No category-specific fields found for this record." />
  return (
    <div className="admin-detail-grid">
      {entries.map(([key, value]) => <AdminField key={key} label={key.replace(/_/g, ' ')} value={typeof value === 'object' ? JSON.stringify(value) : value} />)}
    </div>
  )
}

function MediaRows({ rows }) {
  if (!rows.length) return <EmptyAdminState text="No approved catalogue images are attached to this item." />
  return (
    <div className="media-grid">
      {rows.map((row) => <JsonBlock key={row.id || row.image_path} value={row} />)}
    </div>
  )
}

function AdminField({ label, value, mono }) {
  return (
    <div className="admin-field">
      <span>{label}</span>
      <strong className={mono ? 'mono' : ''}>{value ?? '—'}</strong>
    </div>
  )
}

function EmptyAdminState({ text }) {
  return <p className="admin-empty">{text}</p>
}

function AdminPlaceholder({ icon: Icon, title, copy }) {
  return (
    <section className="admin-panel admin-placeholder">
      <Icon size={34} />
      <h2>{title}</h2>
      <p>{copy}</p>
    </section>
  )
}
