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
  X,
} from 'lucide-react'
import {
  ADMIN_EXPLORER_TABLES,
  loadAdminCategories,
  loadAdminOverview,
  loadCatalogueItemRecord,
  loadCatalogueItems,
  loadCatalogueItemIds,
  loadFranchiseOptions,
  deleteCatalogueItems,
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
  analyseRecognizedCard,
  recognizedCardKey,
  swapItemFrontBack,
  CATALOGUE_EDIT_CHILDREN,
  CATALOGUE_EDIT_GROUPS,
  catalogueEditValues,
  loadCatalogueTaxonomyOptions,
  loadCatalogueValueNames,
  saveCatalogueItemEdits,
  SPORTS_CARD_TYPE_OPTIONS,
  stableJson,
  attachScanImagesToItem,
  countItemImages,
  findSpecDuplicates,
  AI_FIELD_FOR_REVIEW_KEY,
  recognitionResult,
  catalogueCategoryName,
  catalogueFieldValue,
  categoryIdForName,
  createCatalogueItemFromReview,
  createTaxonomyOption,
  isSpecCategory,
  loadItemPropertyId,
  loadSportsTaxonomyOptions,
  loadTaxonomyNames,
  matchTaxonomyOption,
  findDuplicateCatalogueItems,
  scanReviewGroups,
  scannedFieldValue,
  searchScanCandidates,
  updateCatalogueItemFromReview,
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

// Stack scans decide front/back from how much text each side has. When that
// was a close call (or fell back to feed order) the AI double-checks it.
function needsSideCheck(draft) {
  const feed = draft.feed
  if (!feed || feed.singleSided || feed.adjusted || !draft.frontImage || !draft.backImage) return false
  if (feed.frontBackBy !== 'text' || !feed.words) return true
  return feed.words.back < feed.words.front * 2 + 5
}

// Sides whose text-based orientation was weak get the AI upright check:
// photo-heavy fronts (often with the name printed sideways) and backs whose
// text didn't read well (light text on colour).
function needsUprightCheck(draft) {
  const feed = draft.feed
  if (!feed || feed.uprightChecked || feed.adjusted) return null
  const weak = (words) => feed.checkRotation || !feed.words || words == null || words < 15
  return { front: Boolean(draft.frontImage) && weak(feed.words?.front), back: Boolean(draft.backImage) && weak(feed.words?.back) }
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
        // A card that was mid-analysis when the app closed goes back to the
        // queue so it can be analysed again; nothing in the batch is lost.
        scanDraftsRef.current = (store?.admin?.scanDrafts || []).map((draft) => (
          draft.recognition?.status === 'analysing' ? { ...draft, recognition: { ...draft.recognition, status: 'queued' } } : draft
        ))
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

  // ---- Local AI card recognition (scan batch -> analyse -> review) ----
  const [aiStatus, setAiStatus] = useState({ state: 'checking', label: 'Qwen3-VL 8B', message: 'Checking…' })
  const [aiInstall, setAiInstall] = useState(null)
  const [aiAnalysis, setAiAnalysis] = useState(null)
  const aiRunRef = useRef({ cancelled: false, jobId: '' })
  // Cards queued while a batch is running (FastFoto stack scans) join that
  // batch instead of waiting for another Analyse press.
  const analysingRef = useRef(false)
  const pendingAnalysisRef = useRef([])

  async function refreshAiStatus() {
    const api = adminDesktopApi()
    if (typeof api.getAiStatus !== 'function') {
      setAiStatus({ state: 'unsupported', label: 'Qwen3-VL 8B', message: 'Local AI is only available in the installed desktop app.' })
      return
    }
    setAiStatus((current) => ({ ...current, state: current.state === 'ready' ? 'ready' : 'checking' }))
    try {
      setAiStatus(await api.getAiStatus())
    } catch (error) {
      setAiStatus({ state: 'error', label: 'Qwen3-VL 8B', message: error.message || 'Local AI status check failed.' })
    }
  }

  useEffect(() => { refreshAiStatus() }, [])
  useEffect(() => { if (activeView === 'scan') refreshAiStatus() }, [activeView])

  useEffect(() => {
    const api = adminDesktopApi()
    if (typeof api.onAiInstallProgress !== 'function') return undefined
    return api.onAiInstallProgress((progress) => setAiInstall((current) => (current ? { ...current, ...progress } : current)))
  }, [])

  async function installAiModel() {
    if (aiInstall?.active) return
    setAiInstall({ active: true, status: 'Starting download…', percent: null, error: '' })
    const result = await adminDesktopApi().installAiModel()
    setAiInstall(result.ok ? null : { active: false, error: result.code === 'CANCELLED' ? '' : result.message, status: '', percent: null })
    await refreshAiStatus()
  }

  function cancelAiInstall() {
    adminDesktopApi().cancelAiModelInstall?.()
  }

  function patchRecognition(draftId, patch, extra = {}) {
    return saveScanDrafts((drafts) => drafts.map((draft) => (
      draft.id === draftId ? { ...draft, ...extra, recognition: { ...(draft.recognition || {}), ...patch }, updatedAt: new Date().toISOString() } : draft
    )))
  }

  async function addCardToQueue(card) {
    const id = createLocalId('scan_draft')
    await saveScanDrafts((drafts) => [{
      id,
      status: 'Queued for AI',
      createdBy: session?.userId || session?.email || 'admin',
      createdAt: new Date().toISOString(),
      recognition: { status: 'queued' },
      ...card,
    }, ...drafts])
    return id
  }

  function analyseSoon(draftId) {
    if (analysingRef.current) pendingAnalysisRef.current.push(draftId)
    else analyseCards([draftId])
  }

  // Cards are analysed one at a time: parallel vision requests could exhaust a
  // 12 GB GPU. A failed card is marked retryable and the batch carries on.
  async function analyseCards(draftIds) {
    if (analysingRef.current) {
      pendingAnalysisRef.current.push(...draftIds)
      return
    }
    const api = adminDesktopApi()
    const ids = draftIds.filter((id) => scanDraftsRef.current.some((draft) => draft.id === id))
    if (!ids.length) return
    analysingRef.current = true
    aiRunRef.current = { cancelled: false, jobId: '' }
    const matching = []
    for (let index = 0; index < ids.length || pendingAnalysisRef.current.length; index += 1) {
      while (pendingAnalysisRef.current.length) {
        const next = pendingAnalysisRef.current.shift()
        if (!ids.includes(next)) ids.push(next)
      }
      if (index >= ids.length) break
      if (aiRunRef.current.cancelled) break
      const draft = scanDraftsRef.current.find((entry) => entry.id === ids[index])
      if (!draft) continue
      setAiAnalysis({ index: index + 1, total: ids.length, draftId: draft.id })
      await patchRecognition(draft.id, { status: 'analysing', error: '', code: '' })
      const jobId = createLocalId('ai_job')
      aiRunRef.current.jobId = jobId
      const response = await api.recognizeCard({ jobId, front: draft.frontImage || null, back: draft.backImage || null, checkSides: needsSideCheck(draft), checkUpright: needsUprightCheck(draft) })
        .catch((error) => ({ ok: false, code: 'AI_ERROR', message: error.message }))

      if (!response.ok) {
        if (response.code === 'CANCELLED') {
          await patchRecognition(draft.id, { status: 'queued' })
          break
        }
        await patchRecognition(draft.id, { status: 'failed', code: response.code, error: response.message }, { status: 'AI Analysis Failed' })
        // Without Ollama or the model every remaining card would fail the same way.
        if (['OLLAMA_UNAVAILABLE', 'MODEL_MISSING'].includes(response.code)) {
          await refreshAiStatus()
          break
        }
        continue
      }

      // The catalogue lookup runs while the AI starts on the next card.
      matching.push((async () => {
      if (response.orientation) {
        const fixed = response.orientation.images
        await saveScanDrafts((drafts) => drafts.map((entry) => (
          entry.id === draft.id
            ? { ...entry, ...(fixed ? { frontImage: fixed.front, backImage: fixed.back } : {}), feed: { ...(entry.feed || {}), uprightChecked: true, swappedByAi: Boolean(response.sidesSwapped || entry.feed?.swappedByAi) } }
            : entry
        )))
      }
      try {
        const { taxonomy, scanAnalysis } = await analyseRecognizedCard(response.result, draft.category)
        await patchRecognition(draft.id, {
          status: 'done',
          result: response.result,
          provider: response.provider,
          providerLabel: response.providerLabel,
          model: response.model,
          durationMs: response.durationMs,
          analysedAt: new Date().toISOString(),
          taxonomy,
        }, { category: taxonomy.category || draft.category, scanAnalysis, status: scanAnalysis.status, review: null, analysisError: '' })
      } catch (error) {
        // Recognition succeeded; only the catalogue lookup failed. Keep the AI
        // result and let the reviewer continue in the catalogue form.
        await patchRecognition(draft.id, {
          status: 'done',
          result: response.result,
          provider: response.provider,
          providerLabel: response.providerLabel,
          model: response.model,
          analysedAt: new Date().toISOString(),
        }, { scanAnalysis: null, status: 'AI Review', analysisError: `Catalogue matching failed: ${error.message || 'unknown error'}` })
      }
      })())
    }
    await Promise.all(matching)
    analysingRef.current = false
    // Cards that arrived while the last lookups finished start a new run.
    const leftover = pendingAnalysisRef.current.splice(0)
    setAiAnalysis(null)
    if (leftover.length && !aiRunRef.current.cancelled) analyseCards(leftover)
  }

  // ---- Epson FastFoto stack scanning. Lives at this level (not in the scan
  // page) so a stack keeps feeding and queuing if the admin opens Review.
  const [feedState, setFeedState] = useState(null)
  const feedOptionsRef = useRef({})
  const aiStatusRef = useRef(aiStatus)
  aiStatusRef.current = aiStatus

  useEffect(() => {
    const api = adminDesktopApi()
    const offCard = api.onFeedCard?.(async (card) => {
      const options = feedOptionsRef.current
      const id = await addCardToQueue({
        type: 'Scanned catalogue draft',
        scanner: card.frontImage?.scannerName || 'Epson FastFoto',
        category: options.category || 'Sports Cards',
        mode: options.mode || 'Create Catalogue Items',
        frontImage: card.frontImage,
        backImage: card.backImage,
        metadata: {},
        feed: card.feed,
      })
      setFeedState((current) => (current ? { ...current, queued: (current.queued || 0) + 1 } : current))
      if (options.autoAnalyse && aiStatusRef.current.state === 'ready') analyseSoon(id)
    })
    const offProgress = api.onFeedProgress?.((progress) => {
      setFeedState((current) => (current ? { ...current, pages: progress.pages, warning: progress.error || current.warning } : current))
    })
    return () => { offCard?.(); offProgress?.() }
  }, [])

  async function startFeed(options) {
    if (feedState?.running) return null
    const api = adminDesktopApi()
    feedOptionsRef.current = options
    setFeedState({ running: true, pages: 0, queued: 0, stopping: false, startedAt: Date.now() })
    // Load the model while the first card feeds.
    if (options.autoAnalyse && aiStatusRef.current.state === 'ready') api.warmUpAi?.()
    let result
    try {
      result = await api.feedStack({ loadFaceDown: options.loadFaceDown })
    } catch (error) {
      result = { ok: false, code: 'FEED_FAILED', message: error.message || 'The FastFoto scan failed.' }
    }
    setFeedState((current) => ({ ...current, running: false, stopping: false, result }))
    return result
  }

  async function stopFeed() {
    setFeedState((current) => (current ? { ...current, stopping: true } : current))
    await adminDesktopApi().cancelFeed?.()
  }

  function cancelAnalysis() {
    aiRunRef.current.cancelled = true
    if (aiRunRef.current.jobId) adminDesktopApi().cancelCardRecognition?.(aiRunRef.current.jobId)
  }

  async function retryAi(draftId) {
    await patchRecognition(draftId, { status: 'queued', error: '', code: '' }, { status: 'Queued for AI' })
    await analyseCards([draftId])
  }

  const aiQueue = scanDrafts.filter((draft) => ['queued', 'analysing', 'failed'].includes(draft.recognition?.status))

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
        {activeView === 'scan' ? (
          <ScanIntake
            onCreateDraft={createScanDraft}
            ai={{
              status: aiStatus,
              install: aiInstall,
              analysis: aiAnalysis,
              queue: aiQueue,
              onRefresh: refreshAiStatus,
              onInstall: installAiModel,
              onCancelInstall: cancelAiInstall,
              onAddToQueue: addCardToQueue,
              onAnalyseSoon: analyseSoon,
              feeder: { state: feedState, start: startFeed, stop: stopFeed },
              onRemove: deleteScanDraft,
              onAnalyse: analyseCards,
              onCancel: cancelAnalysis,
              onRetry: retryAi,
              onOpenReview: () => setActiveView('review'),
            }}
          />
        ) : null}
        {activeView === 'review' ? <PendingReview drafts={scanDrafts} onUpdateDraft={updateScanDraft} onDeleteDraft={deleteScanDraft} onCreateMore={() => setActiveView('scan')} onRetryAi={retryAi} aiBusy={Boolean(aiAnalysis)} queuedCount={aiQueue.length} /> : null}
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
  const [franchiseId, setFranchiseId] = useState('')
  const [releaseYear, setReleaseYear] = useState('')
  const [missingImages, setMissingImages] = useState(false)
  const [missingPricing, setMissingPricing] = useState(false)
  const [categories, setCategories] = useState([])
  const [franchises, setFranchises] = useState([])
  const [rows, setRows] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  // Ticked rows for bulk actions (kept across pages).
  const [checked, setChecked] = useState(() => new Set())
  const [selectingAll, setSelectingAll] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState('')
  const filters = { search, categoryId, franchiseId, releaseYear, missingImages, missingPricing }

  useEffect(() => {
    loadAdminCategories().then(setCategories).catch(() => setCategories([]))
    loadFranchiseOptions().then(setFranchises).catch(() => setFranchises([]))
  }, [])

  useEffect(() => {
    setPage(1)
    setChecked(new Set())
  }, [search, categoryId, franchiseId, releaseYear, missingImages, missingPricing])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLoading(true)
      loadCatalogueItems({ ...filters, page, limit: PAGE_SIZE })
        .then((result) => {
          setRows(result.rows)
          setTotal(result.total)
          setError('')
        })
        .catch((err) => setError(err.message || 'Catalogue search failed.'))
        .finally(() => setLoading(false))
    }, 220)
    return () => window.clearTimeout(timer)
  }, [search, categoryId, franchiseId, releaseYear, missingImages, missingPricing, page, reloadToken])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function toggleRow(itemId) {
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  function togglePage(select) {
    setChecked((current) => {
      const next = new Set(current)
      rows.forEach((row) => { if (select) next.add(row.item_id); else next.delete(row.item_id) })
      return next
    })
  }

  async function selectAllMatching() {
    setSelectingAll(true)
    setError('')
    try {
      setChecked(new Set(await loadCatalogueItemIds(filters)))
    } catch (err) {
      setError(err.message || 'Could not select the matching items.')
    } finally {
      setSelectingAll(false)
    }
  }

  const filterSummary = [
    categories.find((category) => category.category_id === categoryId)?.name,
    franchises.find((franchise) => franchise.id === franchiseId)?.name,
    releaseYear ? `Year ${releaseYear}` : '',
    search ? `"${search}"` : '',
    missingImages ? 'missing images' : '',
    missingPricing ? 'missing pricing' : '',
  ].filter(Boolean).join(' · ')

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
          <select value={franchiseId} onChange={(event) => setFranchiseId(event.target.value)}>
            <option value="">All Franchises</option>
            {franchises.map((franchise) => <option key={franchise.id} value={franchise.id}>{franchise.name}</option>)}
          </select>
          <input className="admin-year-filter" type="number" min="1800" max="2100" value={releaseYear} onChange={(event) => setReleaseYear(event.target.value)} placeholder="Year" />
          <label className="admin-check"><input type="checkbox" checked={missingImages} onChange={(event) => setMissingImages(event.target.checked)} /> Missing Images</label>
          <label className="admin-check"><input type="checkbox" checked={missingPricing} onChange={(event) => setMissingPricing(event.target.checked)} /> Missing Pricing</label>
        </div>
        <div className="admin-table-note catalogue-bulk-bar">
          <span>{loading ? 'Loading...' : `${formatNumber(total)} matching records`}{checked.size ? ` · ${formatNumber(checked.size)} selected` : ''}</span>
          {total > 0 && checked.size < total ? (
            <button type="button" onClick={selectAllMatching} disabled={selectingAll || loading}>{selectingAll ? 'Selecting…' : `Select all ${formatNumber(total)} matching`}</button>
          ) : null}
          {checked.size ? <button type="button" onClick={() => setChecked(new Set())}>Clear selection</button> : null}
          {checked.size ? <button type="button" className="danger" onClick={() => setDeleting(true)}>Delete Selected ({formatNumber(checked.size)})</button> : null}
        </div>
        {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
        {notice ? <AdminDismissibleAlert className="admin-success" onDismiss={() => setNotice('')}>{notice}</AdminDismissibleAlert> : null}
        <CatalogueTable rows={rows} onSelect={setSelectedId} selectedId={selectedId} checked={checked} onToggle={toggleRow} onTogglePage={togglePage} />
        <PaginationControls page={page} totalPages={totalPages} total={total} onPage={setPage} />
      </section>

      {selectedId ? <CatalogueItemRecord itemId={selectedId} onClose={() => setSelectedId('')} /> : null}
      {deleting ? (
        <BulkDeleteDialog
          itemIds={[...checked]}
          filterSummary={filterSummary}
          onClose={() => setDeleting(false)}
          onDone={(result) => {
            setDeleting(false)
            setChecked(new Set())
            if (result.deleted.includes(selectedId)) setSelectedId('')
            setNotice(`Deleted ${formatNumber(result.deleted.length)} catalogue item${result.deleted.length === 1 ? '' : 's'}.`
              + (result.skipped.length ? ` Skipped ${formatNumber(result.skipped.length)} still in use.` : '')
              + (result.failed.length ? ` ${formatNumber(result.failed.length)} could not be deleted.` : ''))
            setReloadToken((token) => token + 1)
          }}
        />
      ) : null}
    </div>
  )
}

// Confirmation + progress for deleting catalogue items. Nothing is deleted
// until the admin types DELETE; items still in use are skipped, not unlinked.
function BulkDeleteDialog({ itemIds, filterSummary, onClose, onDone }) {
  const [confirmText, setConfirmText] = useState('')
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const running = Boolean(progress) && !result

  async function run() {
    setError('')
    setProgress({ phase: 'checking', done: 0, total: itemIds.length })
    try {
      setResult(await deleteCatalogueItems(itemIds, setProgress))
    } catch (err) {
      setError(err.message || 'Delete failed.')
      setProgress(null)
    }
  }

  const reasons = result ? result.skipped.reduce((acc, entry) => ({ ...acc, [entry.reason]: (acc[entry.reason] || 0) + 1 }), {}) : {}
  return (
    <div className="register-modal update-prompt" role="dialog" aria-modal="true" aria-labelledby="bulk-delete-title">
      <section className="bulk-delete-dialog">
        <p className="update-prompt-kicker">Delete catalogue items</p>
        <h2 id="bulk-delete-title">{result ? 'Delete finished' : `Delete ${formatNumber(itemIds.length)} catalogue item${itemIds.length === 1 ? '' : 's'}?`}</h2>
        {!result ? (
          <>
            {filterSummary ? <p>Selected from: <strong>{filterSummary}</strong></p> : null}
            <p>This permanently removes the items and their photo links, properties, wishlists and favourites. It cannot be undone.</p>
            <p>Items still used by store inventory, sales, pre-orders, in-store sales history or customer collections are <strong>skipped</strong>, never unlinked.</p>
            {progress ? (
              <div className="local-ai-progress">
                <div className="local-ai-progress-bar"><span style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} /></div>
                <small>{progress.phase === 'checking' ? 'Checking which items are in use' : 'Deleting'}: {formatNumber(progress.done)} of {formatNumber(progress.total)}</small>
              </div>
            ) : (
              <label className="bulk-delete-confirm"><span>Type <strong>DELETE</strong> to confirm</span>
                <input autoFocus value={confirmText} onChange={(event) => setConfirmText(event.target.value)} />
              </label>
            )}
          </>
        ) : (
          <div className="bulk-delete-result">
            <p><strong>{formatNumber(result.deleted.length)}</strong> deleted.</p>
            {result.skipped.length ? <p><strong>{formatNumber(result.skipped.length)}</strong> skipped because they are in use: {Object.entries(reasons).map(([reason, count]) => `${reason} (${count})`).join(', ')}.</p> : null}
            {result.failed.length ? <p><strong>{formatNumber(result.failed.length)}</strong> could not be deleted: {result.failed[0].message}</p> : null}
          </div>
        )}
        {error ? <p className="admin-error">{error}</p> : null}
        <div className="modal-actions">
          {result ? (
            <button className="update-prompt-primary" type="button" onClick={() => onDone(result)}>Done</button>
          ) : (
            <>
              <button type="button" onClick={onClose} disabled={running}>Cancel</button>
              <button className="bulk-delete-button" type="button" onClick={run} disabled={running || !itemIds.length || confirmText.trim() !== 'DELETE'}>{running ? 'Deleting…' : `Delete ${formatNumber(itemIds.length)}`}</button>
            </>
          )}
        </div>
      </section>
    </div>
  )
}

function CatalogueTable({ rows, selectedId, onSelect, checked = new Set(), onToggle = () => {}, onTogglePage = () => {} }) {
  const pageChecked = rows.length > 0 && rows.every((row) => checked.has(row.item_id))
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th className="admin-check-cell"><input type="checkbox" aria-label="Select this page" checked={pageChecked} onChange={(event) => onTogglePage(event.target.checked)} /></th>
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
            <tr className={[selectedId === row.item_id ? 'selected' : '', checked.has(row.item_id) ? 'checked' : ''].filter(Boolean).join(' ')} key={row.item_id} onClick={() => onSelect(row.item_id)}>
              <td className="admin-check-cell" onClick={(event) => event.stopPropagation()}>
                <input type="checkbox" aria-label={`Select ${row.displayName}`} checked={checked.has(row.item_id)} onChange={() => onToggle(row.item_id)} />
              </td>
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

// dynamic_fields keys with fixed choices (the website's Sports Cards form).
const DYNAMIC_FIELD_CHOICES = {
  card_type: SPORTS_CARD_TYPE_OPTIONS,
  rookie: ['Yes', 'No'],
  autograph: ['Yes', 'No'],
  relic: ['Yes', 'No'],
}
// Sports Cards card-metadata keys shown even when the item has no value yet.
const SPORTS_DYNAMIC_KEYS = ['collection', 'card_type', 'team', 'rookie', 'parallel', 'variation', 'serial_numbering', 'autograph', 'autograph_type', 'relic', 'finish', 'source']
const TAXONOMY_PARENT = {
  subcategory: 'category_id',
  franchise: 'subcategory_id',
  subset: 'franchise_id',
  property: 'franchise_id',
  item_type: 'subcategory_id',
  collectible_set: 'franchise_id',
}

function dynamicFieldLabel(key) {
  const text = String(key).replaceAll('_', ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function dynamicRowKind(value) {
  if (value !== null && typeof value === 'object') return 'json'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  return 'text'
}

function dynamicRowsFrom(dynamicFields = {}, isSports = false) {
  const rows = Object.entries(dynamicFields || {}).map(([key, value]) => {
    const kind = dynamicRowKind(value)
    return { key, kind, value: kind === 'json' ? JSON.stringify(value, null, 2) : value == null ? '' : String(value), existed: true }
  })
  if (isSports) {
    SPORTS_DYNAMIC_KEYS.filter((key) => !rows.some((row) => row.key === key)).forEach((key) => rows.push({ key, kind: 'text', value: '', existed: false }))
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key))
}

// Rebuilds dynamic_fields from the editor rows. New keys left empty are not
// added; existing keys keep their type (JSON must parse).
function dynamicFieldsFromRows(rows) {
  const result = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    if (row.kind === 'json') {
      try {
        result[key] = JSON.parse(row.value || 'null')
      } catch {
        throw new Error(`"${key}" is not valid JSON.`)
      }
    } else if (row.kind === 'boolean') {
      result[key] = row.value === 'true'
    } else if (row.kind === 'number') {
      if (row.value.trim() === '') result[key] = null
      else if (Number.isFinite(Number(row.value))) result[key] = Number(row.value)
      else throw new Error(`"${key}" must be a number.`)
    } else if (row.value.trim() !== '' || row.existed) {
      result[key] = row.value
    }
  }
  return result
}

// Table editor for every value of a catalogue item: dropdowns of existing
// records for the linked fields (cascading like the website form) and typed
// inputs for everything else, including the item's dynamic_fields.
function CatalogueItemEditor({ record, onSaved, onCancel }) {
  const item = record.raw || {}
  const [propertyId, setPropertyId] = useState(null)
  const [values, setValues] = useState(null)
  const [options, setOptions] = useState({})
  const [names, setNames] = useState({})
  const [dynamicRows, setDynamicRows] = useState([])
  const [newKey, setNewKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    loadItemPropertyId(item.item_id)
      .catch(() => '')
      .then(async (pid) => {
        if (cancelled) return
        const start = catalogueEditValues(item, pid || '')
        setPropertyId(pid || '')
        setValues(start)
        setNames(await loadCatalogueValueNames(start).catch(() => ({})))
      })
    return () => { cancelled = true }
  }, [item.item_id])

  const categoryName = (options.category || []).find((option) => option.id === values?.category_id)?.name
    || names[`category:${values?.category_id}`] || ''
  const isSports = categoryName.toLowerCase() === 'sports cards'

  useEffect(() => {
    if (values) setDynamicRows(dynamicRowsFrom(item.dynamic_fields, isSports))
  }, [item.item_id, isSports, values === null])

  useEffect(() => {
    if (!values) return undefined
    let cancelled = false
    loadCatalogueTaxonomyOptions({ categoryId: values.category_id, subcategoryId: values.subcategory_id, franchiseId: values.franchise_id, subsetId: values.subset_id })
      .then((next) => { if (!cancelled) setOptions(next) })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load the catalogue choices.') })
    return () => { cancelled = true }
  }, [values?.category_id, values?.subcategory_id, values?.franchise_id, values?.subset_id])

  if (!values) return <div className="admin-editor"><p className="scan-mode-note">Loading item…</p></div>

  const original = catalogueEditValues(item, propertyId || '')
  const originalDynamic = stableJson(item.dynamic_fields || {})
  let dynamicPreview = null
  let dynamicError = ''
  try { dynamicPreview = dynamicFieldsFromRows(dynamicRows) } catch (err) { dynamicError = err.message }
  const dynamicChanged = dynamicPreview !== null && stableJson(dynamicPreview) !== originalDynamic
  const changedKeys = Object.keys(values).filter((key) => String(values[key] ?? '').trim() !== String(original[key] ?? '').trim())
  const changeCount = changedKeys.length + (dynamicChanged ? 1 : 0)

  function setValue(key, value) {
    setValues((current) => {
      const next = { ...current, [key]: value }
      if (current[key] !== value) (CATALOGUE_EDIT_CHILDREN[key] || []).forEach((child) => { next[child] = '' })
      return next
    })
  }

  function setDynamic(index, patch) {
    setDynamicRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function addDynamicField() {
    const key = newKey.trim().toLowerCase().replace(/\s+/g, '_')
    if (!key || dynamicRows.some((row) => row.key === key)) return
    setDynamicRows((rows) => [...rows, { key, kind: 'text', value: '', existed: false }])
    setNewKey('')
  }

  async function save() {
    setSaving(true)
    setError('')
    try {
      const dynamicFields = dynamicFieldsFromRows(dynamicRows)
      const result = await saveCatalogueItemEdits({ item, propertyId: propertyId || '', values, dynamicFields })
      await onSaved(result)
    } catch (err) {
      setError(err.message || 'Could not save the catalogue item.')
      setSaving(false)
    }
  }

  function renderInput(field) {
    const value = values[field.key] ?? ''
    if (field.taxonomy) {
      const list = options[field.taxonomy] || []
      const parent = TAXONOMY_PARENT[field.taxonomy]
      const ready = !parent || Boolean(values[parent])
      const choices = value && !list.some((option) => option.id === value)
        ? [{ id: value, name: names[`${field.taxonomy}:${value}`] || 'Current value' }, ...list]
        : list
      return (
        <select value={value} onChange={(event) => setValue(field.key, event.target.value)} disabled={!ready && !value}>
          <option value="">{ready ? 'None' : 'Select the level above first'}</option>
          {choices.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      )
    }
    if (field.type === 'boolean') {
      return (
        <select value={value} onChange={(event) => setValue(field.key, event.target.value)}>
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      )
    }
    if (field.multiline) return <textarea rows={3} value={value} onChange={(event) => setValue(field.key, event.target.value)} />
    return <input type={field.type === 'number' ? 'number' : 'text'} value={value} onChange={(event) => setValue(field.key, event.target.value)} />
  }

  function renderDynamicInput(row, index) {
    const choices = DYNAMIC_FIELD_CHOICES[row.key]
    if (row.kind === 'json') return <textarea className="catalogue-editor-json" rows={Math.min(8, row.value.split('\n').length + 1)} value={row.value} onChange={(event) => setDynamic(index, { value: event.target.value })} spellCheck="false" />
    if (row.kind === 'boolean') {
      return (
        <select value={row.value} onChange={(event) => setDynamic(index, { value: event.target.value })}>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      )
    }
    if (choices && row.kind === 'text') {
      const list = row.value && !choices.includes(row.value) ? [row.value, ...choices] : choices
      return (
        <select value={row.value} onChange={(event) => setDynamic(index, { value: event.target.value })}>
          <option value="">—</option>
          {list.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      )
    }
    return <input type={row.kind === 'number' ? 'number' : 'text'} value={row.value} onChange={(event) => setDynamic(index, { value: event.target.value })} />
  }

  const originalRows = dynamicRowsFrom(item.dynamic_fields, isSports)
  return (
    <div className="catalogue-editor">
      {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
      <table className="scan-review-table catalogue-editor-table">
        {CATALOGUE_EDIT_GROUPS.map((group) => (
          <tbody key={group.id}>
            <tr className="scan-review-group"><th colSpan={2}>{group.label}</th></tr>
            {group.fields.map((field) => (
              <tr key={field.key} className={changedKeys.includes(field.key) ? 'edited' : ''}>
                <th scope="row">{field.label}</th>
                <td>{renderInput(field)}</td>
              </tr>
            ))}
          </tbody>
        ))}
        <tbody>
          <tr className="scan-review-group"><th colSpan={2}>{isSports ? 'Card Metadata & Other Data' : 'Category Data'} <small>(dynamic_fields)</small></th></tr>
          {dynamicRows.map((row, index) => {
            const before = originalRows.find((entry) => entry.key === row.key)
            const edited = !before || before.value !== row.value
            return (
              <tr key={row.key} className={edited && (row.existed || row.value) ? 'edited' : ''}>
                <th scope="row">{dynamicFieldLabel(row.key)}<small className="catalogue-editor-key">{row.key}</small></th>
                <td>
                  <div className="catalogue-editor-dynamic">
                    {renderDynamicInput(row, index)}
                    <button type="button" className="catalogue-editor-remove" onClick={() => setDynamicRows((rows) => rows.filter((_, i) => i !== index))} aria-label={`Remove ${row.key}`}>×</button>
                  </div>
                </td>
              </tr>
            )
          })}
          <tr>
            <th scope="row">Add field</th>
            <td>
              <div className="catalogue-editor-dynamic">
                <input value={newKey} onChange={(event) => setNewKey(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addDynamicField() } }} placeholder="field_name" />
                <button type="button" onClick={addDynamicField} disabled={!newKey.trim()}>Add</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      {dynamicError ? <p className="admin-error">{dynamicError}</p> : null}
      <div className="catalogue-editor-footer">
        <span>{changeCount ? `${changeCount} change${changeCount === 1 ? '' : 's'}` : 'No changes'}</span>
        <button type="button" onClick={() => { setValues(original); setDynamicRows(originalRows) }} disabled={saving || !changeCount}>Reset</button>
        <button type="button" onClick={onCancel} disabled={saving}>Cancel</button>
        <button className="admin-gold-button" type="button" onClick={save} disabled={saving || !changeCount || Boolean(dynamicError)}>{saving ? 'Saving…' : 'Save Changes'}</button>
      </div>
    </div>
  )
}

function CatalogueItemRecord({ itemId, onClose, initialEditMode = '' }) {
  const [activeTab, setActiveTab] = useState('Overview')
  const [record, setRecord] = useState(null)
  const [error, setError] = useState('')
  const [editorValue, setEditorValue] = useState('')
  // '' (view) | 'table' (field editor) | 'json' (raw JSON, advanced)
  const [editMode, setEditMode] = useState(initialEditMode)
  const [isSaving, setIsSaving] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let cancelled = false
    loadCatalogueItemRecord(itemId)
      .then((data) => {
        if (!cancelled) {
          setRecord(data)
          setEditorValue(JSON.stringify(data.raw || {}, null, 2))
          setEditMode('')
          setNotice('')
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
      setEditMode('')
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
          {editMode ? (
            <button className="admin-secondary-button" type="button" onClick={() => setEditMode('')}>View Record</button>
          ) : (
            <>
              <button className="admin-gold-button" type="button" onClick={() => { setNotice(''); setEditMode('table') }} disabled={!record}>Edit Values</button>
              <button className="admin-secondary-button" type="button" onClick={() => setEditMode('json')} disabled={!record}>Edit JSON</button>
            </>
          )}
          <button className="admin-secondary-button" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
      {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
      {notice ? <p className="admin-success">{notice}</p> : null}
      {editMode === 'table' && record ? (
        <CatalogueItemEditor
          key={record.raw?.item_id}
          record={record}
          onCancel={() => setEditMode('')}
          onSaved={async (result) => {
            const refreshed = await loadCatalogueItemRecord(itemId)
            setRecord(refreshed)
            setEditorValue(JSON.stringify(refreshed.raw || {}, null, 2))
            setEditMode('')
            setNotice(result.warnings?.length ? `Saved with warnings: ${result.warnings.join(' ')}` : `Saved ${result.changed.length} change${result.changed.length === 1 ? '' : 's'}.`)
          }}
        />
      ) : null}
      {editMode === 'json' ? (
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
        {activeTab === 'Images' ? (
          <>
            {(record?.images || []).some((image) => image.position === 0) && (record?.images || []).some((image) => image.position === 1) ? (
              <div className="item-images-actions">
                <button type="button" disabled={isSaving} onClick={async () => {
                  setIsSaving(true)
                  setError('')
                  try {
                    await swapItemFrontBack(itemId)
                    setRecord(await loadCatalogueItemRecord(itemId))
                    setNotice('Front and back photos swapped.')
                  } catch (swapError) {
                    setError(swapError.message || 'Could not swap the photos.')
                  } finally {
                    setIsSaving(false)
                  }
                }}>Swap front/back photos</button>
              </div>
            ) : null}
            <MediaRows rows={record?.images || []} />
          </>
        ) : null}
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

function ScanIntake({ onCreateDraft, ai }) {
  const [category, setCategory] = useState('Trading Cards')
  const [mode, setMode] = useState('Create Catalogue Items')
  const [frontImage, setFrontImage] = useState(null)
  const [backImage, setBackImage] = useState(null)
  const [scannerMessage, setScannerMessage] = useState('')
  const [scannerError, setScannerError] = useState('')
  const [scanMode, setScanMode] = useState(() => readScannerPref('scanMode', 'card'))
  const [cardPosition, setCardPosition] = useState(() => readScannerPref('cardPosition', 'top-left'))
  const [customPosition, setCustomPosition] = useState(() => readScannerPref('customPosition', { x: 0, y: 0 }))
  const [displayCopy, setDisplayCopy] = useState(() => readScannerPref('displayCopy', false))
  const [scannerStatus, setScannerStatus] = useState({ state: 'connecting' })
  const [scanNotice, setScanNotice] = useState(null)
  const [inspecting, setInspecting] = useState('')
  const [busy, setBusy] = useState('')
  const autoQueuedPairRef = useRef('')
  const metadata = useMemo(() => ({}), [])
  // Epson FastFoto stack scanning (runs at the workspace level, see startFeed).
  const feed = ai.feeder?.state || null
  const feeding = Boolean(feed?.running)
  const [feedAutoAnalyse, setFeedAutoAnalyse] = useState(() => readScannerPref('feedAutoAnalyse', true))
  const [feedFaceDown, setFeedFaceDown] = useState(() => readScannerPref('feedFaceDown', true))
  useEffect(() => { writeScannerPref('feedAutoAnalyse', feedAutoAnalyse) }, [feedAutoAnalyse])
  useEffect(() => { writeScannerPref('feedFaceDown', feedFaceDown) }, [feedFaceDown])

  async function scanStack() {
    if (busy || feeding) return
    setScannerError('')
    setScannerMessage('')
    await ai.feeder.start({ category, mode, autoAnalyse: feedAutoAnalyse, loadFaceDown: feedFaceDown })
  }

  const feedResult = feed && !feed.running ? feed.result : null
  const feedSummary = (() => {
    if (!feedResult?.cards) return ''
    const seconds = Math.round((feedResult.totalMs || 0) / 1000)
    return `${feedResult.cards} card${feedResult.cards === 1 ? '' : 's'} scanned in ${seconds}s (about ${Math.round(seconds / feedResult.cards)}s each)${feedResult.cancelled ? ', stopped early' : ''}.`
  })()

  async function checkFeeder() {
    const status = await adminDesktopApi().refreshFeeder?.().catch(() => null)
    if (status) setScannerStatus((current) => ({ ...current, ...status }))
  }

  useEffect(() => { writeScannerPref('scanMode', scanMode) }, [scanMode])
  useEffect(() => { writeScannerPref('cardPosition', cardPosition) }, [cardPosition])
  useEffect(() => { writeScannerPref('customPosition', customPosition) }, [customPosition])
  useEffect(() => { writeScannerPref('displayCopy', displayCopy) }, [displayCopy])

  // The scanner initialises once when the scanning page opens and the same
  // session is reused for every front/back/next-card scan; leaving the page
  // releases the scanner for other programs.
  useEffect(() => {
    const api = adminDesktopApi()
    if (typeof api.openScannerSession !== 'function') {
      setScannerStatus({ state: 'unsupported' })
      return undefined
    }
    const unsubscribe = api.onScannerStatus?.((status) => setScannerStatus(status))
    api.openScannerSession().then((status) => { if (status?.state) setScannerStatus(status) }).catch(() => setScannerStatus({ state: 'unavailable' }))
    return () => {
      unsubscribe?.()
      api.closeScannerSession?.()
    }
  }, [])
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

  async function scanFromDevice(side, modeOverride = '') {
    if (busy) return
    const useMode = modeOverride || scanMode
    setBusy('scan')
    setScannerError('')
    setScanNotice(null)
    setScannerMessage(useMode === 'card' ? 'Scanning card…' : 'Scanning the full scanner bed…')
    const waitingTimer = 0
    try {
      const image = await adminDesktopApi().scanImage({ scanMode: useMode, cardPosition, customPosition, displayCopy })
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
      setScannerMessage(`${side === 'front' ? 'Front' : 'Back'} scan captured${image.cropped ? ' and auto-cropped' : ''}${image.fallback ? ' (using the Windows scan window)' : ''}.`)
      // The image is always kept; these only offer a better next step.
      if (['oversize', 'no_card', 'low_confidence'].includes(image.cardStatus)) setScanNotice({ side, status: image.cardStatus })
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

  // Local AI path: queue the front/back pair; analysis is a separate action.
  async function addToQueue() {
    if (busy) return
    if (!frontImage || !backImage) {
      setError(!frontImage ? 'Scan or import the front of the card first.' : 'Scan or import the back of the card first.')
      return
    }
    setError('')
    await ai.onAddToQueue({
      type: 'Scanned catalogue draft',
      scanner: frontImage?.scannerName || backImage?.scannerName || 'Imported image',
      category,
      mode,
      frontImage,
      backImage,
      metadata,
    })
    setFrontImage(null)
    setBackImage(null)
    setScannerMessage(`Card added to the queue (${ai.queue.length + 1} waiting). Scan the next card, or press Analyse when ready.`)
  }

  useEffect(() => {
    if (busy || !frontImage || !backImage) return
    const pairKey = [frontImage.path || frontImage.url || '', backImage.path || backImage.url || ''].join('|')
    if (!pairKey || autoQueuedPairRef.current === pairKey) return
    autoQueuedPairRef.current = pairKey
    addToQueue()
  }, [busy, frontImage, backImage])

  return (
    <div className="admin-grid-two scan-intake-grid">
      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <p className="admin-kicker">Scanner</p>
            <h2>Scan Intake</h2>
          </div>
          <span className={`admin-status-pill scanner-state-${scannerStatus.state}`}><span /> {busy === 'draft' ? 'Analysing...' : SCANNER_STATE_TEXT[scannerStatus.state] || 'Ready'}</span>
        </div>
        {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
        {scannerMessage ? <p className="admin-success">{scannerMessage}</p> : null}
        {scannerError ? <AdminDismissibleAlert onDismiss={() => setScannerError('')}>{scannerError}</AdminDismissibleAlert> : null}
        <div className="scan-controls">
          <label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option>Trading Cards</option><option>Sports Cards</option><option>Coins</option><option>LEGO / Building Blocks</option><option>Comics</option><option>Video Games</option></select></label>
          <label>Intake Mode<select value={mode} onChange={(event) => setMode(event.target.value)}><option>Create Catalogue Items</option><option>Match Existing Catalogue</option><option>Image Capture Only</option></select></label>
        </div>
        {typeof adminDesktopApi().feedStack === 'function' ? (
          <div className={`feeder-panel${scannerStatus.feederName ? '' : ' missing'}`}>
            <div className="feeder-panel-head">
              <div>
                <strong>Epson FastFoto · stack scanning</strong>
                <small>{scannerStatus.feederName ? `${scannerStatus.feederName} connected. Both sides of every card in one pass.` : 'FastFoto not detected. Turn it on and connect it, then check again.'}</small>
              </div>
              {scannerStatus.feederName ? null : <button type="button" onClick={checkFeeder} disabled={Boolean(busy) || feeding}>Check again</button>}
            </div>
            {scannerStatus.feederName ? (
              <>
                <p className="scan-mode-note">Load the cards {feedFaceDown ? 'face down' : 'face up'}, top edge first, straight against the centre guide. Thick relic cards, sleeved cards and slabs go on the Canon.</p>
                <div className="feeder-options">
                  <label className="admin-check"><input type="checkbox" checked={feedAutoAnalyse} onChange={(event) => setFeedAutoAnalyse(event.target.checked)} disabled={Boolean(busy) || feeding} /> Analyse with local AI as each card is scanned</label>
                  <label className="admin-check"><input type="checkbox" checked={feedFaceDown} onChange={(event) => setFeedFaceDown(event.target.checked)} disabled={Boolean(busy) || feeding} /> Cards loaded face down</label>
                </div>
                {feedAutoAnalyse && ai.status.state !== 'ready' ? <p className="scan-mode-note">The local AI isn't ready, so scanned cards will wait in the queue.</p> : null}
                <div className="feeder-actions">
                  <button className="admin-gold-button" type="button" onClick={scanStack} disabled={Boolean(busy) || feeding}>{feeding ? 'Scanning stack…' : 'Scan Stack'}</button>
                  {feeding ? <button type="button" onClick={ai.feeder.stop} disabled={feed?.stopping}>{feed?.stopping ? 'Stopping after this card…' : 'Stop'}</button> : null}
                  {feed ? (
                    <span className="feeder-progress">
                      {feed.running ? `${Math.floor((feed.pages || 0) / 2)} card${Math.floor((feed.pages || 0) / 2) === 1 ? '' : 's'} scanned` : ''}
                      {feed.queued ? `${feed.running ? ' · ' : ''}${feed.queued} queued for AI` : ''}
                    </span>
                  ) : null}
                </div>
                {feed?.warning ? <p className="admin-error">{feed.warning}</p> : null}
                {feedSummary ? <p className="admin-success">{feedSummary}{feedResult.code ? '' : feed?.queued ? ' Every card is in the AI queue.' : ''}</p> : null}
                {feedResult?.code ? <p className="admin-error">{feedResult.message || 'The FastFoto scan failed.'}</p> : null}
              </>
            ) : null}
          </div>
        ) : null}
        <p className="scan-section-label">Canon flatbed · single cards and large items</p>
        <div className="scan-mode-picker" role="radiogroup" aria-label="Scan Mode">
          <span className="scan-mode-label">Scan Mode</span>
          {SCAN_MODES.map((option) => (
            <button key={option.id} type="button" role="radio" aria-checked={scanMode === option.id} className={scanMode === option.id ? 'active' : ''} onClick={() => setScanMode(option.id)} disabled={Boolean(busy) || feeding}>
              <strong>{option.title}</strong>
              <small>{option.hint}</small>
            </button>
          ))}
        </div>
        {scanMode === 'card' ? (
          <p className="scan-mode-note">Place the card in the {CARD_POSITIONS.find((entry) => entry.id === cardPosition)?.hint || 'calibrated position'} of the scanner glass, portrait or landscape.</p>
        ) : null}
        <details className="scanner-calibration">
          <summary>Scanner calibration</summary>
          <div className="scanner-calibration-grid">
            <label>Card position
              <select value={cardPosition} onChange={(event) => setCardPosition(event.target.value)}>
                {CARD_POSITIONS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
            </label>
            {cardPosition === 'custom' ? (
              <>
                <label>From left edge (in)<input type="number" min="0" step="0.05" value={customPosition.x} onChange={(event) => setCustomPosition((current) => ({ ...current, x: Number(event.target.value) || 0 }))} /></label>
                <label>From top edge (in)<input type="number" min="0" step="0.05" value={customPosition.y} onChange={(event) => setCustomPosition((current) => ({ ...current, y: Number(event.target.value) || 0 }))} /></label>
              </>
            ) : null}
            <label className="admin-check"><input type="checkbox" checked={displayCopy} onChange={(event) => setDisplayCopy(event.target.checked)} /> Also create an enhanced display copy (the master stays unaltered)</label>
          </div>
        </details>
        {scanNotice ? (
          <div className={`scan-notice ${scanNotice.status}`}>
            <span>
              {scanNotice.status === 'oversize' ? 'This item looks larger than a standard 2.5 × 3.5 in card, so it was not cropped. The scan was kept.'
                : scanNotice.status === 'no_card' ? 'No card was found in the card area. Check the card is in the calibrated corner. The scan was kept.'
                  : 'The card edges were unclear, so the whole card area was kept instead of cropping into the card.'}
            </span>
            {scanNotice.status !== 'low_confidence' ? (
              <button type="button" disabled={Boolean(busy) || feeding} onClick={() => { setScanMode('full'); scanFromDevice(scanNotice.side, 'full') }}>Try Full Bed / Large Item</button>
            ) : null}
            <button type="button" className="scan-notice-dismiss" onClick={() => setScanNotice(null)}>Dismiss</button>
          </div>
        ) : null}
        <div className="scan-image-grid">
          <div className="scan-slot-wrap">
            <ScanImageSlot label="Front Image" image={frontImage} onPick={() => pickImage('front')} />
            {frontImage ? <button type="button" className="scan-inspect-link" onClick={() => setInspecting('front')}>Inspect / adjust crop</button> : null}
          </div>
          <div className="scan-slot-wrap">
            <ScanImageSlot label="Back Image" image={backImage} onPick={() => pickImage('back')} />
            {backImage ? <button type="button" className="scan-inspect-link" onClick={() => setInspecting('back')}>Inspect / adjust crop</button> : null}
          </div>
        </div>
        {inspecting ? (
          <ScanInspector
            image={inspecting === 'front' ? frontImage : backImage}
            label={inspecting === 'front' ? 'Front' : 'Back'}
            onClose={() => setInspecting('')}
            onApply={(next) => {
              if (inspecting === 'front') setFrontImage(next)
              else setBackImage(next)
              setInspecting('')
              setScannerMessage(`${inspecting === 'front' ? 'Front' : 'Back'} crop adjusted.`)
            }}
          />
        ) : null}
        <div className="admin-quick-actions">
          <button className="admin-gold-button" type="button" disabled={Boolean(busy) || feeding} onClick={() => scanFromDevice('front')}>Scan Front with Canon</button>
          <button className="admin-gold-button" type="button" disabled={Boolean(busy) || feeding} onClick={() => scanFromDevice('back')}>Scan Back with Canon</button>
          <button type="button" disabled={Boolean(busy) || feeding} onClick={() => pickImage('front')}>Import Front File</button>
          <button type="button" disabled={Boolean(busy) || feeding} onClick={() => pickImage('back')}>Import Back File</button>
          <button type="button" disabled={Boolean(busy) || feeding} onClick={createDraft} title="Legacy text recognition (OCR), analysed immediately">{busy === 'draft' ? 'Analysing...' : 'Analyse Now with OCR'}</button>
        </div>
      </section>
      <LocalAiPanel ai={ai} />
    </div>
  )
}

const AI_STATUS_TEXT = {
  checking: ['Checking…', ''],
  ready: ['Ready', 'ready'],
  'model-missing': ['Model required', 'warning'],
  unavailable: ['Unavailable', 'error'],
  error: ['Error', 'error'],
  unsupported: ['Desktop app only', 'warning'],
}

function formatBytes(bytes) {
  if (!bytes) return ''
  const gb = bytes / (1024 ** 3)
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / (1024 ** 2))} MB`
}

function LocalAiPanel({ ai }) {
  const { status, install, analysis, queue } = ai
  const [label, tone] = AI_STATUS_TEXT[status.state] || AI_STATUS_TEXT.error
  const ready = status.state === 'ready'
  const pending = queue.filter((draft) => draft.recognition?.status !== 'analysing')
  const analysable = queue.filter((draft) => ['queued', 'failed'].includes(draft.recognition?.status)).map((draft) => draft.id)

  return (
    <section className="admin-panel local-ai-panel">
      <div className={`local-ai-status ${tone}`}>
        <div>
          <p className="admin-kicker">Local AI</p>
          <strong>{status.label || 'Qwen3-VL 8B'}</strong>
        </div>
        <span className="local-ai-pill"><span />{label}</span>
      </div>

      {status.state === 'unavailable' ? (
        <div className="local-ai-callout">
          <strong>Local AI unavailable</strong>
          <span>CollectorsHub could not connect to Ollama. Make sure Ollama is installed and running on this computer.</span>
          <button type="button" onClick={ai.onRefresh}>Retry</button>
        </div>
      ) : null}

      {status.state === 'error' ? (
        <div className="local-ai-callout">
          <strong>Local AI error</strong>
          <span>{status.message}</span>
          <button type="button" onClick={ai.onRefresh}>Retry</button>
        </div>
      ) : null}

      {status.state === 'model-missing' ? (
        <div className="local-ai-callout">
          <strong>Local AI Model Required</strong>
          <span>Qwen3-VL 8B runs locally on this computer. Card images do not need to leave the machine.</span>
          {install?.active ? (
            <div className="local-ai-progress">
              <div className="local-ai-progress-bar"><span style={{ width: `${install.percent ?? 2}%` }} /></div>
              <small>
                {install.percent != null ? `${install.percent}%` : ''} {install.total ? `of ${formatBytes(install.total)}` : ''} · {install.status || 'Downloading…'}
              </small>
              <button type="button" onClick={ai.onCancelInstall}>Cancel</button>
            </div>
          ) : (
            <button className="admin-gold-button" type="button" onClick={ai.onInstall}>Install Model</button>
          )}
          {install?.error ? <p className="admin-error">{install.error}</p> : null}
        </div>
      ) : null}

      {status.state === 'unsupported' ? (
        <div className="local-ai-callout"><span>{status.message}</span></div>
      ) : null}

      <div className="local-ai-queue">
        <div className="local-ai-queue-header">
          <strong>Scanned Cards</strong>
          <span>{queue.length ? `${queue.length} in queue` : 'Queue empty'}</span>
        </div>
        {!queue.length ? (
          <p className="local-ai-empty">Scan the front and back of a card, then press Add Card to Queue. Nothing is analysed until you press Analyse.</p>
        ) : (
          <ol className="local-ai-queue-list">
            {queue.map((draft, index) => {
              const state = draft.recognition?.status
              return (
                <li key={draft.id} className={state}>
                  <div className="local-ai-thumbs">
                    {draft.frontImage?.url ? <img src={draft.frontImage.url} alt="" /> : <span />}
                    {draft.backImage?.url ? <img src={draft.backImage.url} alt="" /> : <span />}
                  </div>
                  <div>
                    <strong>Card {queue.length - index}</strong>
                    <small>Front {draft.frontImage ? '✓' : '—'} · Back {draft.backImage ? '✓' : '—'}</small>
                    {state === 'analysing' ? <small className="local-ai-state">Analysing…</small> : null}
                    {state === 'failed' ? <small className="local-ai-state failed">{draft.recognition?.error || 'Analysis failed.'}</small> : null}
                  </div>
                  <div className="local-ai-row-actions">
                    {state === 'failed' ? <button type="button" onClick={() => ai.onRetry(draft.id)} disabled={Boolean(analysis) || !ready}>Retry</button> : null}
                    {state !== 'analysing' ? (
                      <button type="button" className="danger" onClick={() => {
                        const confirmed = window.confirm('Remove this card from the queue? The scanned images will be discarded.')
                        adminDesktopApi().refocusWindow?.()
                        if (confirmed) ai.onRemove(draft.id)
                      }} disabled={Boolean(analysis)}>Remove</button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
        {analysis ? (
          <div className="local-ai-progress">
            <div className="local-ai-progress-bar"><span style={{ width: `${Math.round(((analysis.index - 1) / analysis.total) * 100)}%` }} /></div>
            <small>Analysing {analysis.index} of {analysis.total} card{analysis.total === 1 ? '' : 's'}…</small>
            <button type="button" onClick={ai.onCancel}>Cancel</button>
          </div>
        ) : (
          <div className="local-ai-actions">
            <button className="admin-gold-button" type="button" disabled={!ready || !analysable.length} onClick={() => ai.onAnalyse([...analysable].reverse())}>
              Analyse {analysable.length || ''} Card{analysable.length === 1 ? '' : 's'}
            </button>
            <button type="button" onClick={ai.onOpenReview}>Go to Review</button>
          </div>
        )}
        {pending.length && !ready && status.state !== 'checking' ? <small className="local-ai-note">Cards stay in the queue until Local AI is ready.</small> : null}
      </div>
    </section>
  )
}

function ScanImageSlot({ label, image, onPick }) {
  return (
    <button className="scan-image-slot" type="button" onClick={onPick}>
      {image?.url ? <img src={image.displayUrl || image.url} alt="" /> : <span><Image size={24} />{label}</span>}
      <strong>{image?.fileName || 'Choose image'}</strong>
      {image?.cropped ? <small>{image.manualCrop ? 'Manually cropped' : 'Auto-cropped'}</small> : null}
    </button>
  )
}

const SCAN_MODES = [
  { id: 'card', title: 'Standard Trading Card', hint: 'Fast scan for 2.5 × 3.5 in cards' },
  { id: 'full', title: 'Full Bed / Large Item', hint: 'Scan the entire scanner bed' },
]

const CARD_POSITIONS = [
  { id: 'top-left', label: 'Top-left corner (default)', hint: 'top-left corner' },
  { id: 'top-right', label: 'Top-right corner', hint: 'top-right corner' },
  { id: 'bottom-left', label: 'Bottom-left corner', hint: 'bottom-left corner' },
  { id: 'bottom-right', label: 'Bottom-right corner', hint: 'bottom-right corner' },
  { id: 'custom', label: 'Custom position', hint: 'calibrated position' },
]

const SCANNER_STATE_TEXT = {
  connecting: 'Connecting…',
  ready: 'Ready',
  scanning: 'Scanning',
  processing: 'Processing',
  unavailable: 'Scanner unavailable',
  closed: 'Ready',
  unsupported: 'Desktop app only',
}

// Per-computer scanner preferences (scan mode, card position): remembered in
// this browser profile only; the app works the same without them.
function readScannerPref(key, fallback) {
  try {
    const raw = window.localStorage.getItem(`collectorshub-scanner-${key}`)
    return raw == null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeScannerPref(key, value) {
  try {
    window.localStorage.setItem(`collectorshub-scanner-${key}`, JSON.stringify(value))
  } catch {}
}

// Temporary test tool: raw scanner output vs the processed images side by
// side (to see whether dark-area problems come from the scanner/driver, the
// processing, or compression), plus manual crop correction from the raw scan.
function ScanInspector({ image, label, onClose, onApply }) {
  const [tab, setTab] = useState(image?.rawUrl ? 'compare' : 'compare')
  const [actualSize, setActualSize] = useState(false)
  const [rect, setRect] = useState(null)
  const [dragStart, setDragStart] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const rawRef = useRef(null)
  const canCrop = Boolean(image?.rawPath) && typeof adminDesktopApi().recropScan === 'function'
  const panels = [
    image?.rawUrl ? { key: 'raw', title: 'Raw scanner output', note: 'Lossless PNG, exactly as the scanner returned it', url: image.rawUrl } : null,
    image?.url ? { key: 'master', title: 'Cropped master', note: `${image.fileName?.endsWith('.png') ? 'Lossless PNG' : 'Imported file'}, colours unaltered`, url: image.url } : null,
    image?.displayUrl ? { key: 'display', title: 'Enhanced display copy', note: 'Mild levels only, JPEG', url: image.displayUrl } : null,
  ].filter(Boolean)

  useEffect(() => {
    function onKey(event) { if (event.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saving, onClose])

  function pointFromEvent(event) {
    const box = rawRef.current.getBoundingClientRect()
    return {
      x: Math.min(Math.max(0, event.clientX - box.left), box.width),
      y: Math.min(Math.max(0, event.clientY - box.top), box.height),
    }
  }

  async function applyCrop() {
    const img = rawRef.current
    if (!rect || !img || rect.w < 10 || rect.h < 10) return
    const scale = img.naturalWidth / img.getBoundingClientRect().width
    setSaving(true)
    setError('')
    try {
      const next = await adminDesktopApi().recropScan(image, { x: rect.x * scale, y: rect.y * scale, width: rect.w * scale, height: rect.h * scale })
      onApply(next)
    } catch (err) {
      setError(err.message || 'Could not apply the crop.')
      setSaving(false)
    }
  }

  return (
    <div className="scan-review-modal scan-inspector" role="dialog" aria-modal="true" aria-label={`${label} scan inspector`}>
      <section>
        <header className="scan-inspector-header">
          <div>
            <p className="admin-kicker">{label} scan</p>
            <h2>Inspect scan</h2>
          </div>
          <div className="scan-inspector-tabs">
            <button type="button" className={tab === 'compare' ? 'active' : ''} onClick={() => setTab('compare')}>Raw vs processed</button>
            {canCrop ? <button type="button" className={tab === 'crop' ? 'active' : ''} onClick={() => setTab('crop')}>Adjust crop</button> : null}
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
        {tab === 'compare' ? (
          <>
            <label className="admin-check scan-inspector-zoom"><input type="checkbox" checked={actualSize} onChange={(event) => setActualSize(event.target.checked)} /> Actual size (100%) to inspect dark areas</label>
            {!image?.rawUrl ? <p className="scan-mode-note">No raw scan is stored for this image (imported file or older scan).</p> : null}
            <div className={`scan-inspector-compare${actualSize ? ' actual' : ''}`} style={{ gridTemplateColumns: `repeat(${panels.length}, minmax(0, 1fr))` }}>
              {panels.map((panel) => (
                <figure key={panel.key}>
                  <figcaption><strong>{panel.title}</strong><small>{panel.note}</small></figcaption>
                  <div className="scan-inspector-frame"><img src={panel.url} alt={panel.title} /></div>
                </figure>
              ))}
            </div>
          </>
        ) : (
          <div className="scan-inspector-crop">
            <p className="scan-mode-note">Drag on the original scan to draw the crop. The original scan is never changed.</p>
            <div
              className="scan-inspector-crop-stage"
              onMouseDown={(event) => { const point = pointFromEvent(event); setDragStart(point); setRect({ x: point.x, y: point.y, w: 0, h: 0 }) }}
              onMouseMove={(event) => {
                if (!dragStart) return
                const point = pointFromEvent(event)
                setRect({ x: Math.min(point.x, dragStart.x), y: Math.min(point.y, dragStart.y), w: Math.abs(point.x - dragStart.x), h: Math.abs(point.y - dragStart.y) })
              }}
              onMouseUp={() => setDragStart(null)}
              onMouseLeave={() => setDragStart(null)}
            >
              <img ref={rawRef} src={image.rawUrl} alt="Original scan" draggable={false} />
              {rect ? <span className="scan-inspector-rect" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} /> : null}
            </div>
            <footer className="scan-review-footer">
              <button type="button" onClick={() => setRect(null)} disabled={saving}>Clear</button>
              <button className="admin-gold-button" type="button" onClick={applyCrop} disabled={saving || !rect || rect.w < 10 || rect.h < 10}>{saving ? 'Saving…' : 'Use This Crop'}</button>
            </footer>
          </div>
        )}
      </section>
    </div>
  )
}

// Name + (number or year) identifies "the same item" across drafts in the queue.
function draftIdentityKey(draft) {
  const result = draft.recognition?.result
  if (result) {
    // AI-analysed card: the reviewer's edits (if any) win over the AI reading.
    const values = draft.review?.values || {}
    const edited = Object.keys(values).length > 0
    const card = edited
      ? {
          ...result,
          subject: values.subject || result.subject,
          id_number: values.card_number || result.id_number,
          release_year: values.release_year || result.release_year,
          parallel: values.parallel ?? result.parallel,
          variation: values.variation ?? result.variation,
          serial_numbering: values.serial_numbering ?? result.serial_numbering,
          autograph: values.autograph ?? result.autograph,
          memorabilia_relic: values.relic ?? result.memorabilia_relic,
        }
      : result
    const ids = edited && (values.subset_id || values.property_id)
      ? { subset_id: values.subset_id || '', property_id: values.property_id || '' }
      : draft.recognition?.taxonomy?.ids || {}
    const key = recognizedCardKey(card, ids)
    return key ? String(draft.category || '').toLowerCase() + '|' + key : ''
  }
  const values = draft.review?.values || {}
  const meta = draft.metadata || {}
  const name = String(values.name || values.subject || meta.cardName || meta.player || meta.name || '').trim().toLowerCase()
  const number = String(values.card_number || meta.cardNumber || '').trim().toLowerCase()
  const year = String(values.release_year || meta.year || meta.releaseYear || '').trim()
  if (!name || !(number || year)) return ''
  return [name, number, year].join('|')
}

const COMPLETED_SCAN_REVIEW_STATUSES = new Set(['Catalogue Item Created', 'Matched and Updated', 'Matched'])

function PendingReview({ drafts, onUpdateDraft, onDeleteDraft, onCreateMore, onRetryAi, aiBusy = false, queuedCount = 0 }) {
  // Cards still waiting for (or being retried by) local AI live in the Scan
  // Intake queue; every analysed card comes here for review.
  const rows = (drafts || []).filter((draft) => (
    !['queued', 'analysing', 'failed'].includes(draft.recognition?.status)
    && !COMPLETED_SCAN_REVIEW_STATUSES.has(draft.status)
  ))
  // Copies of the same card across the whole queue, including scans already
  // added or linked (those tell the rest which catalogue item they are).
  const draftsByIdentity = useMemo(() => {
    const groups = new Map()
    ;(drafts || []).filter((draft) => draft.status !== 'Rejected' && !['queued', 'analysing', 'failed'].includes(draft.recognition?.status)).forEach((draft) => {
      const key = draftIdentityKey(draft)
      if (key) groups.set(key, [...(groups.get(key) || []), draft])
    })
    return groups
  }, [drafts])
  const [bulkWork, setBulkWork] = useState(null)
  const [busyId, setBusyId] = useState('')
  const [reviewDraftId, setReviewDraftId] = useState('')
  // category_id -> name, so matches stored from before the category filter
  // (or for a different category) are not shown as this draft's match.
  const [categoryNames, setCategoryNames] = useState(null)

  useEffect(() => {
    loadAdminCategories()
      .then((rows) => setCategoryNames(Object.fromEntries(rows.map((row) => [row.category_id, String(row.name || '').toLowerCase()]))))
      .catch(() => setCategoryNames({}))
  }, [])

  function inDraftCategory(draft, candidate) {
    if (!categoryNames || !candidate?.item) return Boolean(candidate)
    return categoryNames[candidate.item.category_id] === catalogueCategoryName(draft.category).toLowerCase()
  }
  const reviewDraft = rows.find((draft) => draft.id === reviewDraftId) || null

  const [openItemId, setOpenItemId] = useState('')

  function catalogedSiblingOf(draft) {
    const key = draftIdentityKey(draft)
    if (!key) return null
    return (draftsByIdentity.get(key) || [])
      .find((other) => other.id !== draft.id && COMPLETED_SCAN_REVIEW_STATUSES.has(other.status) && (other.createdItemId || other.matchedItemId)) || null
  }

  // A match pointing at the item a copy of this card was already added as.
  function siblingMatch(sibling) {
    return {
      item: {
        item_id: sibling.createdItemId || sibling.matchedItemId,
        name: sibling.recognition?.result
          ? [
              [sibling.recognition.result.subject, sibling.recognition.result.id_number ? '#' + String(sibling.recognition.result.id_number).replace(/^(no\.?|#)\s*/i, '') : ''].filter(Boolean).join(' '),
              [sibling.recognition.result.release_year, sibling.recognition.result.property || sibling.recognition.result.subfranchise].filter(Boolean).join(' '),
              sibling.recognition.result.parallel,
            ].filter(Boolean).join(' · ')
          : scanDraftTitle(sibling),
        imageUrl: sibling.frontImage?.url || '',
      },
      score: 100,
      exact: true,
      fromSibling: true,
      reasons: ['Same card as another scan you added'],
    }
  }

  // Fresh check at Approve/Edit time: a copy added from this queue, or the
  // live catalogue (it may have gained the card since this scan was analysed).
  async function findExistingFor(draft) {
    const sibling = catalogedSiblingOf(draft)
    if (sibling) return siblingMatch(sibling)
    if (!draft.recognition?.result) return null
    const { taxonomy, scanAnalysis } = await analyseRecognizedCard(draft.recognition.result, draft.category)
    if (scanAnalysis.matchStatus !== draft.scanAnalysis?.matchStatus || scanAnalysis.bestMatch?.item?.item_id !== draft.scanAnalysis?.bestMatch?.item?.item_id) {
      await onUpdateDraft(draft.id, { scanAnalysis, status: scanAnalysis.status, recognition: { ...draft.recognition, taxonomy } })
    }
    return scanAnalysis.matchStatus === 'exact' && inDraftCategory(draft, scanAnalysis.bestMatch) ? scanAnalysis.bestMatch : null
  }

  const aiRows = rows.filter((draft) => draft.recognition?.status === 'done' && draft.status !== 'Rejected')
  const linkableCopies = aiRows.filter((draft) => catalogedSiblingOf(draft))
  const recheckable = aiRows.filter((draft) => draft.scanAnalysis?.matchStatus !== 'exact' && !catalogedSiblingOf(draft))
  const bulkRunning = Boolean(bulkWork && !bulkWork.finished)

  // Links every waiting copy of an already-added card to that item. The
  // item's photos stay as they are (they came from the first copy).
  async function linkAllCopies() {
    const targets = linkableCopies.map((draft) => ({ draft, sibling: catalogedSiblingOf(draft) }))
    setBulkWork({ label: 'Linking copies', done: 0, total: targets.length })
    for (const [index, { draft, sibling }] of targets.entries()) {
      const itemId = sibling.createdItemId || sibling.matchedItemId
      await onUpdateDraft(draft.id, {
        status: 'Matched',
        matchedItemId: itemId,
        audit: [...(draft.audit || []), { action: 'match', source: 'queue-copy', itemId, copyOf: sibling.id, at: new Date().toISOString() }],
      })
      setBulkWork({ label: 'Linking copies', done: index + 1, total: targets.length })
    }
    setBulkWork({ label: 'Linked ' + targets.length + (targets.length === 1 ? ' copy' : ' copies') + ' to their catalogue items.', finished: true })
  }

  // Stack scans from before the AI orientation check: check them now. Cards
  // already added whose scans became the catalogue photos get the corrected
  // photos uploaded too.
  const orientationTargets = (drafts || []).filter((draft) => (
    draft.feed && !draft.feed.uprightChecked && !draft.feed.adjusted && draft.status !== 'Rejected'
    && !['queued', 'analysing', 'failed'].includes(draft.recognition?.status) && draft.frontImage?.path
  ))

  async function fixOrientation() {
    const api = adminDesktopApi()
    if (typeof api.checkCardOrientation !== 'function') return
    const targets = [...orientationTargets]
    let fixed = 0
    let photos = 0
    let failed = 0
    setBulkWork({ label: 'Checking card orientation', done: 0, total: targets.length })
    for (const [index, draft] of targets.entries()) {
      const result = await api.checkCardOrientation({
        front: draft.frontImage,
        back: draft.backImage || null,
        checkSides: needsSideCheck(draft),
        checkUpright: needsUprightCheck(draft) || { front: true, back: Boolean(draft.backImage) },
      }).catch((error) => ({ ok: false, message: error.message }))
      if (!result.ok) {
        failed += 1
        if (['OLLAMA_UNAVAILABLE', 'MODEL_MISSING'].includes(result.code)) {
          setBulkWork({ label: result.message || 'The local AI is not available.', finished: true })
          return
        }
      } else {
        const next = result.changed ? { frontImage: result.images.front, backImage: result.images.back } : {}
        await onUpdateDraft(draft.id, { ...next, feed: { ...(draft.feed || {}), uprightChecked: true, swappedByAi: Boolean(result.sidesSwapped || draft.feed?.swappedByAi) } })
        if (result.changed) {
          fixed += 1
          // Only the scan that supplied the item's photos re-uploads them.
          const itemId = draft.createdItemId || (draft.imagesAttached ? draft.matchedItemId : '')
          if (itemId && COMPLETED_SCAN_REVIEW_STATUSES.has(draft.status)) {
            try {
              const images = await loadScanImageBlobs({ ...draft, ...next })
              if (images.length) {
                const upload = await attachScanImagesToItem(itemId, images)
                if (upload.attached) photos += 1
              }
            } catch {}
          }
        }
      }
      setBulkWork({ label: 'Checking card orientation', done: index + 1, total: targets.length })
    }
    setBulkWork({
      label: `Checked ${targets.length} card${targets.length === 1 ? '' : 's'}: ${fixed} corrected${photos ? `, ${photos} catalogue item${photos === 1 ? '' : 's'} given the corrected photos` : ''}${failed ? `, ${failed} could not be checked` : ''}.`,
      finished: true,
    })
  }

  // Cards analysed before their catalogue item existed: look them up again.
  async function recheckMatches() {
    const targets = [...recheckable]
    const total = targets.length
    let done = 0
    let found = 0
    setBulkWork({ label: 'Re-checking the catalogue', done: 0, total })
    const worker = async () => {
      while (targets.length) {
        const draft = targets.shift()
        try {
          const { taxonomy, scanAnalysis } = await analyseRecognizedCard(draft.recognition.result, draft.category)
          if (scanAnalysis.matchStatus === 'exact') found += 1
          await onUpdateDraft(draft.id, { scanAnalysis, status: scanAnalysis.status, recognition: { ...draft.recognition, taxonomy } })
        } catch {}
        done += 1
        setBulkWork({ label: 'Re-checking the catalogue', done, total })
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
    setBulkWork({ label: 'Re-checked ' + done + (done === 1 ? ' card: ' : ' cards: ') + found + ' now match an existing catalogue item.', finished: true })
  }

  async function analyze(draft) {
    setBusyId(draft.id)
    try {
      const ocrDraft = await enrichDraftWithOcr(draft)
      const scanAnalysis = await identifyScannedDraft(ocrDraft)
      // A fresh analysis can change the candidates, so drop any saved review table.
      await onUpdateDraft(draft.id, { category: ocrDraft.category, metadata: ocrDraft.metadata, ocr: ocrDraft.ocr, scanAnalysis, status: scanAnalysis.status, analysisError: '', review: null })
    } catch (error) {
      await onUpdateDraft(draft.id, { analysisError: error.message || 'Scan analysis failed.' })
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
      {queuedCount ? (
        <div className="review-queue-note">
          <span>{queuedCount} scanned card{queuedCount === 1 ? ' is' : 's are'} waiting in the Scan Intake queue for analysis.</span>
          <button type="button" onClick={onCreateMore}>Open Scan Queue</button>
        </div>
      ) : null}
      {aiRows.length || orientationTargets.length ? (
        <div className="review-bulk-bar">
          {orientationTargets.length ? <button type="button" onClick={fixOrientation} disabled={bulkRunning || aiBusy} title="Stack scans from before the AI orientation check: turn them the right way up and the right way round (uses the local AI, ~4 s per card)">Fix orientation ({orientationTargets.length})</button> : null}
          {linkableCopies.length ? (
            <span className="review-bulk-copies"><strong>{linkableCopies.length}</strong> {linkableCopies.length === 1 ? 'scan is a copy' : 'scans are copies'} of cards you already added.</span>
          ) : null}
          {linkableCopies.length ? <button className="admin-gold-button" type="button" onClick={linkAllCopies} disabled={bulkRunning}>Link all copies</button> : null}
          <button type="button" onClick={recheckMatches} disabled={!recheckable.length || bulkRunning} title="Look up cards again that were analysed before their catalogue item existed">Re-check catalogue matches{recheckable.length ? ' (' + recheckable.length + ')' : ''}</button>
          {bulkWork ? <span className="review-bulk-status">{bulkWork.finished ? bulkWork.label : bulkWork.label + '… ' + bulkWork.done + ' of ' + bulkWork.total}</span> : null}
        </div>
      ) : null}
      {!rows.length ? <EmptyAdminState text="No scanned drafts yet. Import front/back scanner images from Scan Intake to create review drafts." /> : null}
      <div className="review-draft-list">
        {rows.map((draft) => {
          const title = scanDraftTitle(draft)
          const metadataRows = meaningfulScanMetadata(draft.metadata)
          const route = scanRouteLabel(draft.scanAnalysis?.route)
          const confidence = Number(draft.scanAnalysis?.confidence || 0)
          const bestMatch = inDraftCategory(draft, draft.scanAnalysis?.bestMatch) ? draft.scanAnalysis.bestMatch : null
          const candidateCount = (draft.scanAnalysis?.candidates || []).filter((candidate) => inDraftCategory(draft, candidate)).length
          const finished = COMPLETED_SCAN_REVIEW_STATUSES.has(draft.status)
          const siblings = (draftsByIdentity.get(draftIdentityKey(draft)) || []).filter((other) => other.id !== draft.id)
          const catalogedSibling = catalogedSiblingOf(draft)
          const pendingCopies = siblings.filter((other) => !COMPLETED_SCAN_REVIEW_STATUSES.has(other.status))
          if (['done', 'declined'].includes(draft.recognition?.status)) {
            const ownExact = draft.scanAnalysis?.matchStatus === 'exact' && inDraftCategory(draft, draft.scanAnalysis?.bestMatch) ? draft.scanAnalysis.bestMatch : null
            return (
              <AiReviewCard
                key={draft.id}
                draft={draft}
                finished={finished}
                exactMatch={ownExact || (catalogedSibling ? siblingMatch(catalogedSibling) : null)}
                findExisting={() => findExistingFor(draft)}
                onOpenItem={(itemId) => setOpenItemId(itemId)}
                siblingNote={!finished && catalogedSibling
                  ? 'Copy of a card you already added from this queue. Approve links it to that item (no duplicate is created).'
                  : !finished && pendingCopies.length ? `${pendingCopies.length + 1} copies of this card are in the queue. Approve one and the rest will link to it.` : ''}
                aiBusy={aiBusy}
                onEdit={() => setReviewDraftId(draft.id)}
                onUpdateDraft={onUpdateDraft}
                onRetry={() => onRetryAi?.(draft.id)}
                onRemove={() => {
                  const confirmed = window.confirm('Remove this scan? The scanned images will be discarded.')
                  adminDesktopApi().refocusWindow?.()
                  if (confirmed) onDeleteDraft?.(draft.id)
                }}
              />
            )
          }
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
                {draft.ocr?.confidenceNotes?.length ? <small>OCR: {draft.ocr.confidenceNotes.join(' · ')}</small> : null}
                {!metadataRows.length ? <small>No item identity fields were captured yet. Open Review &amp; Edit Fields to fill them in.</small> : null}
              </div>
              {!finished && catalogedSibling ? (
                <p className="scan-queue-duplicate">Already added to the catalogue from another scan in this queue. Approving will offer to link to it instead of creating a duplicate.</p>
              ) : !finished && siblings.length ? (
                <p className="scan-queue-duplicate">{siblings.length + 1} scans of this item are in the queue. Approve one, then link the others to it.</p>
              ) : null}
              {draft.scanAnalysis ? (
                <div className={bestMatch ? 'scan-match-banner found' : 'scan-match-banner'}>
                  {bestMatch?.item?.imageUrl ? <img src={bestMatch.item.imageUrl} alt="" /> : null}
                  <div>
                    <strong>{bestMatch ? 'Catalogue match found' : 'No catalogue match found'}</strong>
                    {bestMatch ? (
                      <>
                        <span>{bestMatch.item?.name || bestMatch.item?.subject || bestMatch.item?.item_id} · {bestMatch.score}% match</span>
                        {bestMatch.reasons?.length ? <small>{bestMatch.reasons.join(' · ')}</small> : null}
                        {candidateCount > 1 ? <small>{candidateCount - 1} other possible {candidateCount === 2 ? 'match' : 'matches'}</small> : null}
                      </>
                    ) : <span>Review the fields and add it to the catalogue as a new item.</span>}
                  </div>
                </div>
              ) : null}
              {metadataRows.length ? (
                <div className="scan-metadata-summary">
                  {metadataRows.map(([key, value]) => (
                    <span key={key}><strong>{key.replace(/([A-Z])/g, ' $1').replaceAll('_', ' ')}</strong>{String(value)}</span>
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
              <button className="admin-gold-button" type="button" onClick={() => setReviewDraftId(draft.id)} disabled={busyId === draft.id || finished}>
                {bestMatch ? 'Compare & Edit Fields' : 'Review & Edit Fields'}
              </button>
              <button type="button" onClick={() => analyze(draft)} disabled={busyId === draft.id}>{busyId === draft.id ? 'Working...' : 'Analyze Scan'}</button>
              <button type="button" onClick={() => onUpdateDraft(draft.id, { status: 'Rejected' })}>Reject</button>
              <button type="button" onClick={() => onUpdateDraft(draft.id, { status: 'Review Later' })}>Review Later</button>
              <button className="danger" type="button" onClick={() => {
                const confirmed = window.confirm('Delete this scan draft from the pending review queue?')
                adminDesktopApi().refocusWindow?.()
                if (confirmed) onDeleteDraft?.(draft.id)
              }}>Delete</button>
            </div>
          </div>
          )
        })}
      </div>
      {reviewDraft ? <ScanReviewEditor key={reviewDraft.id} draft={reviewDraft} onUpdateDraft={onUpdateDraft} onClose={() => setReviewDraftId('')} /> : null}
      {openItemId ? (
        <div className="register-modal existing-item-modal" role="dialog" aria-modal="true">
          <div className="existing-item-modal-body">
            <CatalogueItemRecord itemId={openItemId} initialEditMode="table" onClose={() => setOpenItemId('')} />
          </div>
        </div>
      ) : null}
    </section>
  )
}

const AI_MATCH_TEXT = {
  exact: ['Exact match found', 'Approve links this scan to the existing catalogue item (no duplicate is created) and makes the scans its catalogue photos.'],
  likely: ['Likely match', 'Approve opens the catalogue form so you can confirm the match.'],
  multiple: ['Several possible matches', 'Approve opens the catalogue form so you can choose the right one.'],
  none: ['No catalogue match', 'Approve opens the catalogue form pre-filled with this card, ready to add.'],
}

// Summary of one AI-analysed card. Only fields the model flagged as uncertain
// are highlighted, so the reviewer checks those instead of every field.
function AiReviewCard({ draft, finished, exactMatch, siblingNote, aiBusy, onEdit, onUpdateDraft, onRetry, onRemove, findExisting, onOpenItem }) {
  const recognition = draft.recognition || {}
  const result = recognition.result || {}
  const taxonomy = recognition.taxonomy || { names: {}, unresolved: {} }
  const uncertain = new Set((result.uncertain_fields || []).map((field) => String(field).toLowerCase()))
  const declined = recognition.status === 'declined'
  const matchStatus = draft.scanAnalysis?.matchStatus || 'none'
  const [matchTitle, matchHelp] = AI_MATCH_TEXT[matchStatus] || AI_MATCH_TEXT.none
  const shownMatch = exactMatch || draft.scanAnalysis?.bestMatch || null

  const flag = (key) => (uncertain.has(key) ? ' uncertain' : '')
  const yesNoText = (value) => (value == null ? '—' : value ? 'Yes' : 'No')
  const taxonomyName = (level, aiKey) => taxonomy.names?.[level] || result[aiKey] || ''
  const title = `${result.subject || 'Unidentified card'}${result.id_number ? ` #${result.id_number}` : ''}`
  const path = [draft.category, taxonomyName('subcategory', 'subcategory'), taxonomyName('franchise', 'franchise'), taxonomyName('subset', 'subfranchise')].filter(Boolean)
  const unresolved = Object.entries(taxonomy.unresolved || {})
  const fields = [
    ['Team', result.team, 'team'],
    ['Publisher', taxonomyName('publisher', 'publisher_manufacturer'), 'publisher_manufacturer'],
    ['Card Type', result.card_type, 'card_type'],
    ['Rookie', yesNoText(result.rookie), 'rookie'],
    ['Parallel', result.parallel, 'parallel'],
    ['Variation', result.variation, 'variation'],
    ['Serial Number', result.serial_numbering, 'serial_numbering'],
    ['Autograph', result.autograph ? `Yes${result.autograph_type ? ` (${result.autograph_type})` : ''}` : yesNoText(result.autograph), 'autograph'],
    ['Memorabilia', yesNoText(result.memorabilia_relic), 'memorabilia_relic'],
    ['Finish', result.finish, 'finish'],
  ]

  const [working, setWorking] = useState('')
  const [cardError, setCardError] = useState('')
  const linkedItemId = draft.matchedItemId || draft.createdItemId || ''
  const hasScans = Boolean(draft.frontImage?.path || draft.backImage?.path)
  const attachedCount = scanImagesAttached(draft)

  // Admin scans replace the catalogue item's photos (front, then back).
  async function attachScans(itemId) {
    const existing = await countItemImages(itemId).catch(() => null)
    const images = await loadScanImageBlobs(draft)
    if (!images.length) return { attached: 0, existing, warnings: ['The scan files for this card could not be found on this computer.'] }
    return { ...(await attachScanImagesToItem(itemId, images)), existing }
  }

  // "This card already exists" prompt: { match, action: 'approve' | 'edit' }.
  const [existing, setExisting] = useState(null)

  // Approve and Edit look the card up again first: a copy may have been added
  // from this queue, or the catalogue may have gained it since the analysis.
  async function checkThen(action) {
    // Approving a card that already shows an exact match just links it.
    if (!findExisting || (action === 'approve' && exactMatch)) { if (action === 'edit') onEdit(); else approve(); return }
    setWorking(action === 'edit' ? 'checking-edit' : 'checking')
    setCardError('')
    let match = null
    try { match = await findExisting() } catch { match = null }
    setWorking('')
    if (match) { setExisting({ match, action }); return }
    if (action === 'edit') onEdit()
    else approve()
  }

  async function approve(matchOverride = null) {
    const match = matchOverride || exactMatch
    if (!match) {
      onEdit()
      return
    }
    setWorking('approve')
    setCardError('')
    try {
      const itemId = match.item.item_id
      // A copy of a card added from this queue keeps the photos of the first
      // copy; any other exact match gets these scans as its photos.
      const images = match.fromSibling ? { attached: 0, existing: null, warnings: [] } : await attachScans(itemId)
      await onUpdateDraft(draft.id, {
        status: 'Matched',
        matchedItemId: itemId,
        imagesAttached: images.attached,
        analysisError: images.warnings.join(' '),
        audit: [...(draft.audit || []), { action: 'match', source: 'local-ai', itemId, images: images.attached, existingImages: images.existing, at: new Date().toISOString() }],
      })
    } catch (error) {
      setCardError(error.message || 'Could not approve this card.')
    } finally {
      setWorking('')
    }
  }

  async function addScansToItem() {
    setWorking('images')
    setCardError('')
    try {
      const images = await attachScans(linkedItemId)
      await onUpdateDraft(draft.id, {
        imagesAttached: images.attached,
        analysisError: images.warnings.join(' '),
        audit: [...(draft.audit || []), { action: 'attach_scans', itemId: linkedItemId, images: images.attached, existingImages: images.existing, at: new Date().toISOString() }],
      })
    } catch (error) {
      setCardError(error.message || 'Could not add the scans to the catalogue item.')
    } finally {
      setWorking('')
    }
  }

  // Orientation fixes for stack scans (turned the wrong way, or front and
  // back the wrong way round). Re-analysing afterwards is offered.
  async function rotateSide(side) {
    setWorking(`rotate-${side}`)
    setCardError('')
    try {
      const next = await adminDesktopApi().rotateScanImage(draft[side], 90)
      await onUpdateDraft(draft.id, { [side]: next, feed: { ...(draft.feed || {}), checkRotation: false, adjusted: true } })
    } catch (error) {
      setCardError(error.message || 'Could not rotate the scan.')
    } finally {
      setWorking('')
    }
  }

  function swapSides() {
    onUpdateDraft(draft.id, { frontImage: draft.backImage, backImage: draft.frontImage, feed: { ...(draft.feed || {}), adjusted: true } })
  }

  function decline() {
    onUpdateDraft(draft.id, {
      status: 'Needs Manual Identification',
      recognition: { ...recognition, status: 'declined', declinedAt: new Date().toISOString() },
    })
  }

  return (
    <div className={`review-draft-card ai-review-card${declined ? ' declined' : ''}`}>
      <div className="ai-review-media">
        <div className="review-draft-images">
          {draft.frontImage?.url ? <img src={draft.frontImage.url} alt="Front" /> : <span>Front</span>}
          {draft.backImage?.url ? <img src={draft.backImage.url} alt="Back" /> : <span>Back</span>}
        </div>
        {hasScans && typeof adminDesktopApi().rotateScanImage === 'function' ? (
          <div className="ai-review-orient">
            {draft.feed?.checkRotation ? <span className="ai-review-orient-flag">Check rotation</span> : null}
            <button type="button" onClick={() => rotateSide('frontImage')} disabled={Boolean(working) || !draft.frontImage} title="Rotate the front 90° clockwise">↻ Front</button>
            <button type="button" onClick={() => rotateSide('backImage')} disabled={Boolean(working) || !draft.backImage} title="Rotate the back 90° clockwise">↻ Back</button>
            <button type="button" onClick={swapSides} disabled={Boolean(working) || !draft.frontImage || !draft.backImage}>Swap front/back</button>
            {draft.feed?.adjusted && !finished ? <button type="button" onClick={() => { onUpdateDraft(draft.id, { feed: { ...(draft.feed || {}), adjusted: false } }); onRetry(draft.id) }} disabled={Boolean(working) || aiBusy}>Re-analyse</button> : null}
            {draft.feed?.adjusted && finished && linkedItemId ? <button type="button" className="admin-gold-button" onClick={async () => { await addScansToItem(); await onUpdateDraft(draft.id, { feed: { ...(draft.feed || {}), adjusted: false } }) }} disabled={Boolean(working)}>{working === 'images' ? 'Uploading…' : 'Update catalogue photos'}</button> : null}
          </div>
        ) : null}
      </div>
      <div>
        <p className="ai-review-source">Local AI · {recognition.providerLabel || 'Qwen3-VL 8B'}</p>
        <strong className={`ai-review-title${flag('subject')}${flag('id_number')}`}>{title}</strong>
        {taxonomyName('property', 'property') || result.collection ? (
          <span className={`ai-review-release${flag('property')}${flag('collection')}`}>
            {[taxonomyName('property', 'property'), result.collection].filter(Boolean).join(' · ')}
          </span>
        ) : null}
        {path.length ? <small className={`ai-review-path${flag('subcategory')}${flag('franchise')}${flag('subfranchise')}`}>{path.join(' › ')}</small> : null}
        <dl className="ai-review-fields">
          {fields.map(([label, value, key]) => (
            <div key={label} className={flag(key).trim()}>
              <dt>{label}</dt>
              <dd>{value || '—'}</dd>
            </div>
          ))}
        </dl>
        {uncertain.size ? <small className="ai-review-uncertain-note">Highlighted fields were uncertain. Check those before approving.</small> : null}
        {unresolved.length ? (
          <small className="ai-review-unresolved">
            Not in the catalogue taxonomy yet: {unresolved.map(([level, text]) => `${level.replace('_', ' ')} “${text}”`).join(', ')}. Choose or create these in Edit.
          </small>
        ) : null}
        {siblingNote ? <p className="scan-queue-duplicate">{siblingNote}</p> : null}
        {declined ? (
          <div className="ai-review-match declined">
            <strong>Needs Manual Identification</strong>
            <span>The AI result was declined. Retry the AI, identify the card manually, or remove the scan.</span>
          </div>
        ) : finished ? (
          <div className="ai-review-match exact">
            <div>
              <strong>{draft.status}</strong>
              <span>{draft.matchedItemId ? 'Linked to an existing catalogue item.' : draft.createdItemId ? 'Added to the catalogue.' : ''}</span>
              {attachedCount > 0 ? <small>Scans saved to the catalogue item ({attachedCount} image{attachedCount === 1 ? '' : 's'}).</small>
                : hasScans && linkedItemId ? <small>The scans have not been added to the catalogue item yet.</small> : null}
            </div>
          </div>
        ) : (
          <div className={`ai-review-match ${matchStatus}`}>
            {shownMatch?.item?.imageUrl ? <img src={shownMatch.item.imageUrl} alt="" /> : null}
            <div>
              <strong>Catalogue match: {matchTitle}</strong>
              {shownMatch && matchStatus !== 'multiple' ? (
                <span>
                  {shownMatch.item.name}
                  {shownMatch.item.card_number ? ` #${shownMatch.item.card_number}` : ''}
                  {[shownMatch.item.dynamic_fields?.collection, shownMatch.item.dynamic_fields?.parallel].filter(Boolean).length
                    ? ` · ${[shownMatch.item.dynamic_fields?.collection, shownMatch.item.dynamic_fields?.parallel].filter(Boolean).join(' · ')}`
                    : ''}
                </span>
              ) : null}
              {shownMatch?.differences?.length && matchStatus === 'likely' ? <small>Differs on: {shownMatch.differences.join(', ')}</small> : null}
              <small>{matchHelp}</small>
            </div>
          </div>
        )}
        {draft.analysisError ? <p className="admin-error">{draft.analysisError}</p> : null}
        {cardError ? <p className="admin-error">{cardError}</p> : null}
        <details className="review-raw-details">
          <summary>Raw AI result</summary>
          <JsonBlock value={{ result, taxonomy, match: { status: matchStatus, best: shownMatch?.item?.item_id || null }, model: recognition.model, durationMs: recognition.durationMs }} />
        </details>
      </div>
      <div className="review-actions">
        {declined ? (
          <>
            <button className="admin-gold-button" type="button" onClick={onRetry} disabled={aiBusy}>Retry AI</button>
            <button type="button" onClick={onEdit}>Edit Manually</button>
            <button className="danger" type="button" onClick={onRemove}>Remove Scan</button>
          </>
        ) : finished ? (
          <>
            {hasScans && linkedItemId && attachedCount === 0 ? (
              <button className="admin-gold-button" type="button" onClick={addScansToItem} disabled={Boolean(working)}>
                {working === 'images' ? 'Uploading…' : 'Save Scans to Catalogue Item'}
              </button>
            ) : null}
            <button className="danger" type="button" onClick={onRemove} disabled={Boolean(working)}>Remove</button>
          </>
        ) : (
          <>
            <button className="admin-gold-button" type="button" onClick={() => checkThen('approve')} disabled={Boolean(working)}>{working === 'approve' ? 'Saving…' : working === 'checking' ? 'Checking…' : 'Approve'}</button>
            <button type="button" onClick={() => checkThen('edit')} disabled={Boolean(working)}>{working === 'checking-edit' ? 'Checking…' : 'Edit'}</button>
            <button type="button" onClick={decline} disabled={Boolean(working)}>Decline</button>
          </>
        )}
      </div>
      {existing && !finished ? (
        <div className="existing-card-prompt" role="alert">
          {existing.match.item?.imageUrl ? <img src={existing.match.item.imageUrl} alt="" /> : null}
          <div>
            <strong>This card already exists{existing.match.fromSibling ? ' (you added a copy from this queue)' : ' in the catalogue'}</strong>
            <span>{existing.match.item?.name || existing.match.item?.subject || existing.match.item?.item_id}</span>
            <div className="existing-card-actions">
              <button className="admin-gold-button" type="button" disabled={Boolean(working)} onClick={async () => { const match = existing.match; setExisting(null); await approve(match) }}>Link this scan to it</button>
              <button type="button" disabled={Boolean(working)} onClick={() => onOpenItem?.(existing.match.item.item_id)}>Edit that item's values</button>
              <button type="button" disabled={Boolean(working)} onClick={() => { setExisting(null); onEdit() }}>{existing.action === 'edit' ? 'Edit this scan anyway' : 'Create a new item anyway'}</button>
              <button type="button" disabled={Boolean(working)} onClick={() => setExisting(null)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// Images this draft put on its catalogue item: the recorded count, else the
// latest audit entry that uploaded images (older drafts).
function uploadedCount(images = [], warnings = []) {
  // Uploads are all-or-nothing: a failed upload keeps the existing photos.
  return (warnings || []).some((warning) => String(warning).startsWith('Image upload failed')) ? 0 : images.length
}

function scanImagesAttached(draft) {
  if (Number.isFinite(draft?.imagesAttached)) return draft.imagesAttached
  const withImages = [...(draft?.audit || [])].reverse().find((entry) => Number.isFinite(entry.images))
  return withImages?.images || 0
}

// A name match alone scores 28, + year 36; number + year alone is 26.
const REVIEW_CANDIDATE_MIN_SCORE = 30
const MATCH_PICK_MIN_SCORE = 40
const SCAN_REVIEW_CATEGORIES = ['Trading Cards', 'Sports Cards', 'Coins', 'LEGO / Building Blocks', 'Comics', 'Video Games']
// Scan Intake form defaults; not a real reading when the catalogue is blank.
const SCAN_PLACEHOLDER_VALUES = new Set(['No', 'Base', 'Available'])
// Changing a taxonomy level invalidates the levels scoped beneath it.
const TAXONOMY_CHILDREN = {
  subcategory_id: ['franchise_id', 'subset_id', 'property_id', 'item_type_id'],
  franchise_id: ['subset_id', 'property_id'],
  subset_id: ['property_id'],
}
const TAXONOMY_PARENT_READY = {
  subcategory: () => true,
  franchise: (values) => Boolean(values.subcategory_id),
  subset: (values) => Boolean(values.franchise_id),
  property: (values) => Boolean(values.franchise_id),
  item_type: (values) => Boolean(values.subcategory_id),
  publisher: () => true,
}

function sameReviewValue(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()
}

function reviewFields(category) {
  return scanReviewGroups(category).flatMap((group) => group.fields)
}

function reviewItemName(category, values) {
  return String((isSpecCategory(category) ? values.subject : values.name) || '').trim()
}

// Keep what the catalogue already has; fill blanks from the scan. Taxonomy
// levels start empty for new items and are resolved against the live
// taxonomy once its options load.
function initialReviewValues(draft, category, matchItem) {
  return Object.fromEntries(reviewFields(category).map((field) => {
    const current = catalogueFieldValue(matchItem, field)
    if (field.taxonomy) return [field.key, matchItem ? current : '']
    // Provenance describes how a record was created; never re-stamp an existing item.
    if (field.key === 'source' && matchItem) return [field.key, current]
    const scanned = scannedFieldValue(draft, field)
    if (!matchItem) return [field.key, scanned]
    return [field.key, current || (SCAN_PLACEHOLDER_VALUES.has(scanned) ? '' : scanned)]
  }))
}

async function loadScanImageBlobs(draft) {
  const api = adminDesktopApi()
  if (typeof api.readScanImage !== 'function') return []
  const images = []
  for (const [image, position] of [[draft.frontImage, 0], [draft.backImage, 1]]) {
    if (!image?.path) continue
    const file = await api.readScanImage(image)
    images.push({ position, ext: file.ext, blob: new Blob([file.data], { type: file.mime }) })
  }
  return images
}

function ScanReviewEditor({ draft, onUpdateDraft, onClose }) {
  const saved = draft.review || null
  // Items found by the approval-time duplicate check join the match picker.
  const [extraCandidates, setExtraCandidates] = useState(saved?.extraCandidates || [])
  const [duplicates, setDuplicates] = useState(null)
  const [category, setCategory] = useState(saved?.category || draft.category || 'Trading Cards')
  // Matches are limited to the selected category: its id plus a live search
  // within it (stored candidates can predate the category filter or a change
  // of category here).
  const [categoryScope, setCategoryScope] = useState({ category: '', categoryId: undefined, live: [] })
  const scopeReady = categoryScope.category === category
  const [matchId, setMatchId] = useState(saved ? saved.matchId || '' : draft.scanAnalysis?.bestMatch?.item?.item_id || '')
  const candidatePool = new Map()
  ;[...(draft.scanAnalysis?.candidates || []), ...extraCandidates, ...(scopeReady ? categoryScope.live : [])].forEach((candidate) => {
    if (!candidatePool.has(candidate.item.item_id)) candidatePool.set(candidate.item.item_id, candidate)
  })
  // Only real candidates are listed (a shared card number or year alone is not
  // one), plus whichever item is currently selected.
  const candidates = [...candidatePool.values()]
    .filter((candidate) => !scopeReady || candidate.item.category_id === categoryScope.categoryId)
    .filter((candidate) => candidate.score >= REVIEW_CANDIDATE_MIN_SCORE || candidate.likelyDuplicate || candidate.item.item_id === matchId)
    .sort((a, b) => b.score - a.score)
  // AI-analysed cards keep the catalogue matcher's verdict (it may be "several
  // possible matches"); only plain scans auto-pick the top candidate.
  const autoMatchedRef = useRef(Boolean(saved) || ['done', 'declined'].includes(draft.recognition?.status))
  const uncertainFields = new Set((recognitionResult(draft)?.uncertain_fields || []).map((field) => String(field).toLowerCase()))
  const matchCandidate = candidates.find((candidate) => candidate.item.item_id === matchId) || null
  const matchItem = matchCandidate?.item || null
  const [values, setValues] = useState(() => saved?.values || initialReviewValues(draft, category, matchItem))
  const [showAll, setShowAll] = useState(!matchItem)
  const [attachImages, setAttachImages] = useState(saved?.attachImages ?? true)
  // Admin scans replace the catalogue photos by default.
  const [matchImageCount, setMatchImageCount] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const spec = isSpecCategory(category)
  const groups = scanReviewGroups(category)
  // Taxonomy picks the reviewer made; auto-selection never overrides these.
  const touchedRef = useRef(new Set(saved ? Object.keys(saved.values || {}) : []))
  const [options, setOptions] = useState({})
  const [creating, setCreating] = useState(null)
  const [matchExtras, setMatchExtras] = useState({ itemId: '', propertyId: '', names: {} })
  const extrasReady = !matchItem || matchExtras.itemId === matchItem.item_id
  const reviewItem = matchItem ? { ...matchItem, _property_id: extrasReady ? matchExtras.propertyId : '' } : null
  const hasScanImages = Boolean(draft.frontImage?.path || draft.backImage?.path)

  // Opening the review often follows the WIA scan window or a native confirm(),
  // after which Electron on Windows can stop delivering keystrokes to inputs.
  useEffect(() => {
    adminDesktopApi().refocusWindow?.()
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([categoryIdForName(category), searchScanCandidates(draft, category)])
      .then(([categoryId, live]) => { if (!cancelled) setCategoryScope({ category, categoryId, live }) })
      .catch((err) => {
        if (cancelled) return
        setCategoryScope({ category, categoryId: null, live: [] })
        setError(err.message || 'Could not search the catalogue for matches.')
      })
    return () => { cancelled = true }
  }, [category])

  // A match outside the selected category is dropped; if nothing is selected
  // yet, the best in-category candidate is picked once (never after the
  // reviewer has chosen, and never over a saved review).
  useEffect(() => {
    if (!scopeReady) return
    if (matchId && !candidates.some((candidate) => candidate.item.item_id === matchId)) {
      chooseMatch('')
      return
    }
    if (!matchId && !autoMatchedRef.current) {
      autoMatchedRef.current = true
      const top = candidates[0]
      if (top && (top.score >= MATCH_PICK_MIN_SCORE || top.likelyDuplicate)) chooseMatch(top.item.item_id)
    }
  }, [scopeReady, categoryScope, matchId])

  useEffect(() => {
    function onKey(event) { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  // Options for each taxonomy level, scoped by the levels above it.
  useEffect(() => {
    if (!spec) return undefined
    let cancelled = false
    loadSportsTaxonomyOptions({ category, subcategoryId: values.subcategory_id, franchiseId: values.franchise_id, subsetId: values.subset_id })
      .then((next) => { if (!cancelled) setOptions(next) })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load the catalogue taxonomy.') })
    return () => { cancelled = true }
  }, [spec, category, values.subcategory_id, values.franchise_id, values.subset_id])

  // How many catalogue photos the matched item has (shown on the Images option;
  // admin scans replace them).
  useEffect(() => {
    if (!matchItem) {
      setMatchImageCount(null)
      return undefined
    }
    let cancelled = false
    countItemImages(matchItem.item_id)
      .then((count) => {
        if (cancelled) return
        setMatchImageCount(count)
      })
      .catch(() => { if (!cancelled) setMatchImageCount(null) })
    return () => { cancelled = true }
  }, [matchItem?.item_id])

  // The matched item's Property link and taxonomy names.
  useEffect(() => {
    if (!spec || !matchItem) return undefined
    let cancelled = false
    loadItemPropertyId(matchItem.item_id).then(async (propertyId) => {
      const names = await loadTaxonomyNames({ ...matchItem, _property_id: propertyId })
      if (cancelled) return
      setMatchExtras({ itemId: matchItem.item_id, propertyId, names })
      if (propertyId) {
        setValues((current) => (current.property_id || touchedRef.current.has('property_id') ? current : { ...current, property_id: propertyId }))
      }
    }).catch(() => {
      if (!cancelled) setMatchExtras({ itemId: matchItem.item_id, propertyId: '', names: {} })
    })
    return () => { cancelled = true }
  }, [spec, matchItem?.item_id])

  // Fill empty taxonomy levels from the scan ("NFL", "Contenders Football", ...)
  // or pick the only option, like the website's auto-select rule.
  useEffect(() => {
    if (!spec || !extrasReady) return
    setValues((current) => {
      let next = current
      groups.flatMap((group) => group.fields).filter((field) => field.taxonomy).forEach((field) => {
        const list = options[field.taxonomy]
        if (!list || next[field.key] || touchedRef.current.has(field.key) || !TAXONOMY_PARENT_READY[field.taxonomy](next)) return
        const pick = matchTaxonomyOption(list, scannedFieldValue(draft, field)) || (list.length === 1 && field.taxonomy !== 'publisher' ? list[0].id : '')
        if (pick) next = { ...next, [field.key]: pick }
      })
      return next
    })
  }, [spec, options, extrasReady])

  function taxonomyName(level, id) {
    if (!id) return ''
    return options[level]?.find((option) => option.id === id)?.name
      || (reviewItem && catalogueFieldValue(reviewItem, { taxonomy: level, column: `${level}_id`, key: `${level}_id` }) === id ? matchExtras.names[level] : '')
      || 'Unknown'
  }

  function chooseMatch(nextId, nextCandidate = null) {
    const nextItem = nextCandidate?.item || candidates.find((candidate) => candidate.item.item_id === nextId)?.item || null
    if (nextCandidate && !candidates.some((candidate) => candidate.item.item_id === nextId)) {
      setExtraCandidates((current) => [...current, nextCandidate])
    }
    touchedRef.current = new Set()
    setDuplicates(null)
    setMatchId(nextId)
    setValues(initialReviewValues(draft, category, nextItem))
    setShowAll(!nextItem)
    setAttachImages(true)
  }

  function chooseCategory(nextCategory) {
    setCategory(nextCategory)
    setOptions({})
    // Keep edits already made; seed any fields the new category adds.
    setValues((current) => ({ ...initialReviewValues(draft, nextCategory, matchItem), ...current }))
  }

  function setValue(key, value) {
    touchedRef.current.add(key)
    setValues((current) => {
      const next = { ...current, [key]: value }
      if (TAXONOMY_CHILDREN[key] && current[key] !== value) {
        TAXONOMY_CHILDREN[key].forEach((child) => {
          next[child] = ''
          touchedRef.current.delete(child)
        })
      }
      return next
    })
  }

  async function createOption(field, name) {
    setError('')
    try {
      const created = await createTaxonomyOption(field.taxonomy, name, {
        category,
        subcategoryId: values.subcategory_id,
        franchiseId: values.franchise_id,
        subsetId: values.subset_id,
      })
      setOptions((current) => ({
        ...current,
        [field.taxonomy]: [...(current[field.taxonomy] || []).filter((option) => option.id !== created.id), created].sort((a, b) => a.name.localeCompare(b.name)),
      }))
      setValue(field.key, created.id)
      setCreating(null)
    } catch (err) {
      setError(err.message || `Could not create ${field.label}.`)
    }
  }

  const rows = groups.map((group) => ({
    ...group,
    rows: group.fields.map((field) => {
      const current = catalogueFieldValue(reviewItem, field)
      const scanned = scannedFieldValue(draft, field)
      const finalValue = String(values[field.key] ?? '')
      if (field.taxonomy) {
        const resolved = matchTaxonomyOption(options[field.taxonomy] || [], scanned)
        const currentName = taxonomyName(field.taxonomy, current)
        const scanAgrees = !scanned || !current || resolved === current || Boolean(matchTaxonomyOption([{ id: 'current', name: currentName }], scanned))
        return {
          field,
          current,
          currentLabel: currentName,
          scanned,
          resolved,
          finalValue,
          conflict: Boolean(reviewItem && extrasReady && !scanAgrees),
          fills: Boolean(reviewItem && scanned && !current && (resolved || scanned)),
          edited: Boolean(reviewItem) && finalValue !== current,
        }
      }
      const scanIsReading = scanned && !(SCAN_PLACEHOLDER_VALUES.has(scanned) && !current)
      return {
        field,
        current,
        currentLabel: current,
        scanned,
        finalValue,
        conflict: Boolean(reviewItem && scanIsReading && current && current.toLowerCase() !== scanned.toLowerCase()),
        fills: Boolean(reviewItem && scanIsReading && !current),
        edited: Boolean(reviewItem) && finalValue.trim() !== current,
      }
    }).filter((row) => showAll || row.conflict || row.fills || row.edited),
  })).filter((group) => group.rows.length)

  const allRows = rows.flatMap((group) => group.rows)
  const changeCount = reviewItem ? reviewFields(category).filter((field) => String(values[field.key] ?? '').trim() !== catalogueFieldValue(reviewItem, field)).length : 0
  const conflictCount = allRows.filter((row) => row.conflict).length
  const itemName = reviewItemName(category, values)
  const missingRequired = !itemName || (spec && !values.subcategory_id)

  function reviewSnapshot(extra = {}) {
    return { category, matchId, values, extraCandidates, attachImages, savedAt: new Date().toISOString(), ...extra }
  }

  async function saveForLater() {
    await onUpdateDraft(draft.id, { category, review: reviewSnapshot() })
    onClose()
  }

  async function run(label, action) {
    setBusy(label)
    setError('')
    try {
      // An action returns false to keep the editor open (e.g. duplicates found).
      if (await action() === false) {
        setBusy('')
        return
      }
      onClose()
    } catch (err) {
      setError(err.message || 'Could not save to the catalogue.')
      setBusy('')
    }
  }

  function duplicateCheckValues() {
    if (!spec) return values
    return {
      name: values.subject,
      card_number: values.card_number,
      release_year: values.release_year,
      upc: values.upc,
      set_name: taxonomyName('property', values.property_id) || taxonomyName('subset', values.subset_id),
      manufacturer: taxonomyName('publisher', values.publisher_id),
    }
  }

  function addAsNewItem({ skipDuplicateCheck = false } = {}) {
    return run('create', async () => {
      if (!skipDuplicateCheck) {
        // Checked live: another scan in the queue may have added this item
        // since this draft was analysed. The selected match is excluded when
        // the reviewer deliberately chose "Add as New Item Instead".
        const found = (spec ? await findSpecDuplicates({ category, values }) : await findDuplicateCatalogueItems(duplicateCheckValues(), { category })).filter((candidate) => candidate.item.item_id !== matchId)
        if (found.length) {
          setDuplicates(found)
          return false
        }
      }
      const images = attachImages ? await loadScanImageBlobs(draft) : []
      const item = await createCatalogueItemFromReview({ category, values, confidence: draft.scanAnalysis?.confidence ?? null, images })
      await onUpdateDraft(draft.id, {
        category,
        status: 'Catalogue Item Created',
        createdItemId: item?.item_id || null,
        imagesAttached: uploadedCount(images, item?.warnings),
        analysisError: item?.warnings?.length ? item.warnings.join(' ') : '',
        review: reviewSnapshot({ matchId: '' }),
        audit: [...(draft.audit || []), { action: 'create', itemId: item?.item_id, images: images.length, at: new Date().toISOString() }],
      })
    })
  }

  function updateMatchedItem() {
    return run('update', async () => {
      const images = attachImages ? await loadScanImageBlobs(draft) : []
      const result = await updateCatalogueItemFromReview({ item: reviewItem, category, values, images })
      const updated = result.changed.length || images.length
      await onUpdateDraft(draft.id, {
        category,
        status: updated ? 'Matched and Updated' : 'Matched',
        matchedItemId: reviewItem.item_id,
        imagesAttached: uploadedCount(images, result.warnings),
        analysisError: result.warnings?.length ? result.warnings.join(' ') : '',
        review: reviewSnapshot(),
        audit: [...(draft.audit || []), { action: updated ? 'update_from_scan' : 'match', itemId: reviewItem.item_id, fields: result.changed, images: images.length, at: new Date().toISOString() }],
      })
    })
  }

  function linkToItem(item) {
    return run('link', async () => {
      await onUpdateDraft(draft.id, {
        category,
        status: 'Matched',
        matchedItemId: item.item_id,
        audit: [...(draft.audit || []), { action: 'match', itemId: item.item_id, at: new Date().toISOString() }],
      })
    })
  }

  function renderFinalInput(row) {
    const { field, finalValue } = row
    if (field.taxonomy) {
      const list = options[field.taxonomy] || []
      const choices = finalValue && !list.some((option) => option.id === finalValue)
        ? [...list, { id: finalValue, name: taxonomyName(field.taxonomy, finalValue) }]
        : list
      const ready = TAXONOMY_PARENT_READY[field.taxonomy](values)
      return (
        <div className="scan-review-taxonomy">
          <select value={finalValue} onChange={(event) => setValue(field.key, event.target.value)} disabled={!ready}>
            <option value="">{ready ? 'None' : 'Select the level above first'}</option>
            {choices.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
          {creating?.key === field.key ? (
            <span className="scan-review-inline-create">
              <input autoFocus value={creating.name} onChange={(event) => setCreating({ ...creating, name: event.target.value })} onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); createOption(field, creating.name) }
                if (event.key === 'Escape') { event.stopPropagation(); setCreating(null) }
              }} placeholder={`New ${field.label}`} />
              <button type="button" onClick={() => createOption(field, creating.name)} disabled={!creating.name.trim()}>Save</button>
              <button type="button" onClick={() => setCreating(null)}>Cancel</button>
            </span>
          ) : ready ? (
            <button type="button" className="scan-review-link-button" onClick={() => setCreating({ key: field.key, name: row.resolved ? '' : row.scanned })}>+ New</button>
          ) : null}
        </div>
      )
    }
    if (field.options) {
      const choices = finalValue && !field.options.includes(finalValue) ? [...field.options, finalValue] : field.options
      return (
        <select value={finalValue} onChange={(event) => setValue(field.key, event.target.value)}>
          <option value="">— Select —</option>
          {choices.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      )
    }
    return field.multiline
      ? <textarea value={finalValue} onChange={(event) => setValue(field.key, event.target.value)} rows={2} />
      : <input value={finalValue} onChange={(event) => setValue(field.key, event.target.value)} type={field.type === 'number' ? 'number' : 'text'} />
  }

  function renderScanned(row) {
    const { field, scanned, finalValue } = row
    if (!scanned) return <span className="scan-review-value">—</span>
    if (field.taxonomy) {
      const ready = TAXONOMY_PARENT_READY[field.taxonomy](values)
      return (
        <>
          <span className="scan-review-value">{scanned}</span>
          {row.resolved && row.resolved !== finalValue ? <button type="button" onClick={() => setValue(field.key, row.resolved)}>Use scanned</button> : null}
          {!row.resolved && ready ? (
            <>
              <small className="scan-review-note">Not in the catalogue yet</small>
              <button type="button" onClick={() => createOption(field, scanned)}>+ Create “{scanned}”</button>
            </>
          ) : null}
        </>
      )
    }
    return (
      <>
        <span className="scan-review-value">{scanned}</span>
        {!sameReviewValue(finalValue, scanned) ? <button type="button" onClick={() => setValue(field.key, scanned)}>Use scanned</button> : null}
      </>
    )
  }

  return (
    <div className="scan-review-modal" role="dialog" aria-modal="true" aria-labelledby="scan-review-title">
      <section>
        <header className="scan-review-header">
          <div className="scan-review-images">
            {draft.frontImage?.url ? <img src={draft.frontImage.url} alt="Front scan" /> : null}
            {draft.backImage?.url ? <img src={draft.backImage.url} alt="Back scan" /> : null}
          </div>
          <div>
            <p className="admin-kicker">Scan review{spec ? ` · ${category} spec` : ''}</p>
            <h2 id="scan-review-title">{itemName || scanDraftTitle(draft)}</h2>
            <div className="scan-review-controls">
              <label>Category
                <select value={category} onChange={(event) => chooseCategory(event.target.value)}>
                  {SCAN_REVIEW_CATEGORIES.map((option) => <option key={option}>{option}</option>)}
                </select>
              </label>
              <label>Catalogue match
                <select value={matchId} onChange={(event) => chooseMatch(event.target.value)}>
                  <option value="">No match – add as a new item</option>
                  {candidates.map((candidate) => (
                    <option key={candidate.item.item_id} value={candidate.item.item_id}>
                      {candidate.item.name || candidate.item.subject || candidate.item.item_id}
                      {candidate.item.card_number ? ` #${candidate.item.card_number}` : ''}
                      {candidate.item.release_year ? ` (${candidate.item.release_year})` : ''} · {candidate.score}%
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          {matchItem?.imageUrl ? <img className="scan-review-match-image" src={matchItem.imageUrl} alt="Catalogue item" /> : null}
          <button className="modal-close" type="button" onClick={onClose} disabled={Boolean(busy)} aria-label="Close"><X size={18} /></button>
        </header>

        <div className="scan-review-summary">
          {matchItem ? (
            <span>
              Comparing with <strong>{matchItem.name || matchItem.subject}</strong>
              {matchCandidate?.reasons?.length ? ` · ${matchCandidate.reasons.join(' · ')}` : ''}
              {' · '}{conflictCount ? `${conflictCount} field${conflictCount === 1 ? '' : 's'} differ` : 'no conflicting fields'}
            </span>
          ) : <span>No catalogue item selected. The final values below will be added as a new catalogue item.</span>}
          {matchItem ? (
            <label className="admin-check"><input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} /> Show all fields</label>
          ) : null}
        </div>

        {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}

        {duplicates ? (
          <div className="scan-review-duplicates" role="alert">
            <strong>This item may already be in the catalogue</strong>
            <span>Adding it again would create a duplicate. Link this scan to the existing item, compare with it, or create a new item anyway (for example, a different parallel).</span>
            {duplicates.map((candidate) => (
              <div className="scan-review-duplicate" key={candidate.item.item_id}>
                {candidate.item.imageUrl ? <img src={candidate.item.imageUrl} alt="" /> : null}
                <div>
                  <strong>
                    {candidate.item.name || candidate.item.subject || candidate.item.item_id}
                    {candidate.item.card_number ? ` #${candidate.item.card_number}` : ''}
                    {candidate.item.release_year ? ` (${candidate.item.release_year})` : ''}
                  </strong>
                  <small>{[candidate.item.dynamic_fields?.set_name, ...(candidate.reasons || [])].filter(Boolean).join(' · ')}</small>
                </div>
                <button type="button" onClick={() => chooseMatch(candidate.item.item_id, candidate)} disabled={Boolean(busy)}>Compare</button>
                <button className="admin-gold-button" type="button" onClick={() => linkToItem(candidate.item)} disabled={Boolean(busy)}>Link to This Item</button>
              </div>
            ))}
            <div className="scan-review-duplicate-actions">
              <button type="button" onClick={() => setDuplicates(null)} disabled={Boolean(busy)}>Cancel</button>
              <button type="button" onClick={() => addAsNewItem({ skipDuplicateCheck: true })} disabled={Boolean(busy)}>{busy === 'create' ? 'Adding...' : 'Create New Item Anyway'}</button>
            </div>
          </div>
        ) : null}

        <div className="scan-review-table-wrap">
          <table className="scan-review-table">
            <thead>
              <tr>
                <th>Field</th>
                {matchItem ? <th>In catalogue</th> : null}
                <th>Scanned</th>
                <th>Final value</th>
              </tr>
            </thead>
            {rows.map((group) => (
              <tbody key={group.id}>
                <tr className="scan-review-group"><th colSpan={matchItem ? 4 : 3}>{group.label}</th></tr>
                {group.rows.map((row) => (
                  <tr key={row.field.key} className={[row.conflict ? 'conflict' : row.fills ? 'fills' : '', uncertainFields.has(AI_FIELD_FOR_REVIEW_KEY[row.field.key]) ? 'uncertain' : ''].filter(Boolean).join(' ')}>
                    <th scope="row">{row.field.label}{row.field.required ? ' *' : ''}</th>
                    {matchItem ? (
                      <td>
                        <span className="scan-review-value">{row.currentLabel || '—'}</span>
                        {row.conflict && !sameReviewValue(row.finalValue, row.current) ? <button type="button" onClick={() => setValue(row.field.key, row.current)}>Keep catalogue</button> : null}
                      </td>
                    ) : null}
                    <td>{renderScanned(row)}</td>
                    <td>{renderFinalInput(row)}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
          {!allRows.length ? <EmptyAdminState text="The scan agrees with the catalogue item. Tick Show all fields to edit anything else." /> : null}
          {hasScanImages ? (
            <label className="scan-review-images-option">
              <input type="checkbox" checked={attachImages} onChange={(event) => setAttachImages(event.target.checked)} />
              <span>
                <strong>Images</strong>
                {!matchItem ? 'Use the front and back scans as the catalogue images'
                  : matchImageCount > 0 ? `Replace the item's ${matchImageCount} current photo${matchImageCount === 1 ? '' : 's'} with the front and back scans`
                    : "Use the front and back scans as this item's catalogue photos"}
              </span>
            </label>
          ) : null}
        </div>

        <footer className="scan-review-footer">
          <button type="button" onClick={saveForLater} disabled={Boolean(busy)}>Save &amp; Close</button>
          {matchItem ? (
            <>
              <button type="button" onClick={() => addAsNewItem()} disabled={Boolean(busy) || missingRequired}>{busy === 'create' ? 'Checking...' : 'Add as New Item Instead'}</button>
              <button type="button" onClick={() => linkToItem(matchItem)} disabled={Boolean(busy)}>{busy === 'link' ? 'Linking...' : 'Link Without Changes'}</button>
              <button className="admin-gold-button" type="button" onClick={updateMatchedItem} disabled={Boolean(busy) || !extrasReady}>
                {busy === 'update' ? 'Saving...' : changeCount ? `Approve & Update Item (${changeCount})` : attachImages && hasScanImages ? 'Approve & Add Images' : 'Approve Match'}
              </button>
            </>
          ) : (
            <button className="admin-gold-button" type="button" onClick={() => addAsNewItem()} disabled={Boolean(busy) || missingRequired} title={missingRequired ? (spec ? 'Subject (player) and Subcategory (sport) are required.' : 'A name is required.') : undefined}>
              {busy === 'create' ? 'Checking...' : 'Approve & Add to Catalogue'}
            </button>
          )}
        </footer>
      </section>
    </div>
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
