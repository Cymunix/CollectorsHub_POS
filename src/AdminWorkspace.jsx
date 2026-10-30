import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  Boxes,
  ClipboardCheck,
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
  Scale,
} from 'lucide-react'
import {
  ADMIN_EXPLORER_TABLES,
  loadAdminCategories,
  loadAdminOverview,
  loadCatalogueItemRecord,
  loadCatalogueItems,
  loadCatalogueItemIds,
  loadFranchiseOptions,
  loadSubfranchiseOptions,
  updateCatalogueItems,
  loadBulkEditItems,
  saveBulkCatalogueEdits,
  deleteCatalogueItems,
  loadExplorerRecords,
  loadImagesMediaData,
  loadPricingData,
  loadMarketDataAdmin,
  fetchMarketSales,
  approveMarketSales,
  generateMarketSearchQuery,
  loadTaxonomyData,
  loadUsersData,
  identifyScannedDraft,
  analyseRecognizedCard,
  recognizedCardKey,
  TRADING_DYNAMIC_KEYS,
  swapItemFrontBack,
  parseChecklist,
  checklistItemKey,
  checklistItemNumber,
  parseChecklistTable,
  groupChecklistRows,
  checklistGroupLabel,
  resolveChecklistGroup,
  parseSetRefs,
  isLegoCategory,
  categoryHasSeries,
  propertyParentKey,
  taxonomyChildren,
  loadSetItems,
  loadItemTypeNames,
  loadTargetSetItems,
  matchScanInTargetSet,
  targetSetKey,
  createChecklistPlaceholders,
  isChecklistPlaceholder,
  alreadyInCatalogueMatch,
  seasonKey,
  seasonStartYear,
  withoutSeason,
  catalogueFrontPhotoUrl,
  loadCatalogueItemRow,
  fillChecklistPlaceholder,
  CATALOGUE_EDIT_CHILDREN,
  CATALOGUE_EDIT_GROUPS,
  catalogueEditValues,
  loadCatalogueTaxonomyOptions,
  loadScanSetOptions,
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
  findItemsByCardNumber,
  loadScanFinderCollections,
  updateCatalogueItemFromReview,
  updateCatalogueItemRecord,
  updateExplorerRecord,
} from './lib/adminData'
import {
  cloudReviewAvailable,
  cloudReviewDraftIds,
  deleteCloudReviewDraft,
  downloadCloudImage,
  mergeCloudRow,
  pullReviewDrafts,
  pushReviewDraft,
  removeCloudImages,
  signRemoteImages,
} from './lib/scanReviewCloud'
import { looseCardKey, scanConfidence } from './lib/scanConfidence'
import UpdateCheck from './UpdateCheck'
import IdentityReviews from './identity/IdentityReviews'
import PawnJurisdictions from './pawn/PawnJurisdictions'
import StoreManagement from './org/StoreManagement'
import OnboardingAdmin from './onboarding/OnboardingAdmin'
import { SUPABASE_PUBLIC_CONFIG } from './lib/supabaseClient'
import { needsSideCheck, needsUprightCheck, readScannerPref, writeScannerPref } from './lib/scanHelpers'

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
  { key: 'stores', label: 'Store Management', icon: Store },
  { key: 'onboarding', label: 'Onboarding', icon: ClipboardCheck },
  { key: 'users', label: 'Users', icon: Users },
  { key: 'identity', label: 'Identity Reviews', icon: Users },
  { key: 'pawn', label: 'Pawn Jurisdictions', icon: Scale },
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

// ---- Photograph a set: matching within the set chosen at Scan Intake ----------

// The number expected for this scan: one on from the previous scan of the same set
// (one back when the stack is running in descending order).
function expectedSetNumber(draft, drafts = []) {
  const key = targetSetKey(draft.target)
  const numberOf = (other) => checklistItemNumber(other.scanAnalysis?.bestMatch?.item || {}) || other.scanAnalysis?.setCheck?.number || ''
  const earlier = drafts
    .filter((other) => other.id !== draft.id && other.target && targetSetKey(other.target) === key
      && String(other.createdAt || '') < String(draft.createdAt || '') && numberOf(other))
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
  if (!earlier.length) return ''
  const last = numberOf(earlier[0])
  const before = earlier[1] ? numberOf(earlier[1]) : ''
  const descending = before && Number(String(before).match(/\d+/)?.[0]) - Number(String(last).match(/\d+/)?.[0]) === 1
  return stepCardNumber(last, descending ? -1 : 1)
}

function stepCardNumber(value, step) {
  const match = String(value || '').trim().match(/^(.*?)(\d+)(\D*)$/)
  return match && Number(match[2]) + step > 0 ? `${match[1]}${Number(match[2]) + step}${match[3]}` : ''
}

// Printings that share a card number: the one whose photo looks like the scan; else,
// when exactly one printing has no photo yet and the scan looks like none of the
// others, that one.
async function pickPrintingByPhoto(scanAnalysis, frontImage) {
  const compare = adminDesktopApi().compareScanWithPhoto
  if (typeof compare !== 'function' || !frontImage) return
  const similar = []
  const withoutPhoto = []
  for (const candidate of scanAnalysis.candidates) {
    const url = candidate.item.imageUrl || await catalogueFrontPhotoUrl(candidate.item.item_id).catch(() => '')
    if (!url) { withoutPhoto.push(candidate); continue }
    const check = await compare(frontImage, url).catch(() => null)
    if (check?.ok && check.similar) similar.push({ candidate, overall: check.overall })
  }
  similar.sort((left, right) => left.overall - right.overall)
  const pick = similar[0]?.candidate || (withoutPhoto.length === 1 ? withoutPhoto[0] : null)
  if (!pick) return
  pick.reasons = [...pick.reasons, similar.length ? 'Photo matches this printing' : 'The only printing without a photo yet']
  scanAnalysis.bestMatch = pick
  scanAnalysis.candidates = [pick, ...scanAnalysis.candidates.filter((candidate) => candidate !== pick)]
  scanAnalysis.matchStatus = 'exact'
  scanAnalysis.route = 'existing_match'
  scanAnalysis.status = 'Exact catalogue match'
  scanAnalysis.setCheck = { ...scanAnalysis.setCheck, variantBy: similar.length ? 'photo' : 'elimination' }
}

// Matches a scan's AI reading: within its set when it was scanned in "Photograph a
// set" mode, otherwise against the whole catalogue.
async function analyseScanReading(draft, result, { drafts = [], frontImage = null } = {}) {
  const target = draft.target
  if (!target?.categoryId) return analyseRecognizedCard(result, draft.category)
  const items = await loadTargetSetItems(target)
  const scanAnalysis = matchScanInTargetSet({
    result,
    target,
    items,
    ocrText: [draft.feed?.ocrText?.front, draft.feed?.ocrText?.back].filter(Boolean).join('\n'),
    expectedNumber: expectedSetNumber(draft, drafts),
  })
  if (scanAnalysis.matchStatus === 'multiple') await pickPrintingByPhoto(scanAnalysis, frontImage || draft.frontImage)
  return {
    scanAnalysis,
    taxonomy: {
      category: target.category,
      categoryId: target.categoryId,
      ids: { subcategory_id: target.subcategoryId || '', franchise_id: target.franchiseId || '', subset_id: target.subsetId || '', property_id: target.propertyId || '', item_type_id: target.itemTypeId || '' },
      names: target.names || {},
      unresolved: {},
    },
  }
}

// Item Type names by id, so catalogue matches say "Card" or "Sticker" (items that
// share a name and number) before images are linked.
function useItemTypeNames() {
  const [names, setNames] = useState(() => new Map())
  useEffect(() => {
    let alive = true
    loadItemTypeNames().then((map) => { if (alive) setNames(map) })
    return () => { alive = false }
  }, [])
  return names
}
const itemTypeLabel = (names, item) => (item?.item_type_id ? names.get(item.item_type_id) || '' : '')

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

// Lists show small cached copies of scans: thousands of full-size scans on
// one page run the window out of memory. (File URLs in dev stay full size.)
function thumbUrl(url, width = 360) {
  return /^collectorshub-pos:\/\/scan-images\//.test(String(url || '')) ? `${url}?thumb=${width}` : url
}

function createLocalId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

export default function AdminWorkspace({ session, syncStatus, onLogout }) {
  const [activeView, setActiveView] = useState('overview')
  // Item to open in Market Data (from Pricing / Sales Data's "Add sales data").
  const [marketItemId, setMarketItemId] = useState('')
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

  // fromCloud: applying changes pulled from the cloud queue (not re-uploaded).
  function saveScanDrafts(updateDrafts, { fromCloud = false } = {}) {
    const previous = scanDraftsRef.current
    const nextDrafts = updateDrafts(previous)
    scanDraftsRef.current = nextDrafts
    if (!fromCloud) noteCloudChanges(previous, nextDrafts)
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
    const draft = scanDraftsRef.current.find((entry) => entry.id === draftId)
    await saveScanDrafts((drafts) => drafts.filter((entry) => entry.id !== draftId), { fromCloud: true })
    if (draft?.cloud) deleteCloudReviewDraft(draft).catch(() => {})
  }

  // Deletes several review drafts at once (one save), and their cloud copies so other
  // computers don't pull them back. Scan image files stay until "Delete unused files".
  async function deleteScanDrafts(draftIds) {
    const ids = new Set(draftIds)
    const removed = scanDraftsRef.current.filter((entry) => ids.has(entry.id))
    await saveScanDrafts((drafts) => drafts.filter((entry) => !ids.has(entry.id)), { fromCloud: true })
    await Promise.allSettled(removed.filter((draft) => draft.cloud).map((draft) => deleteCloudReviewDraft(draft)))
    return removed.length
  }

  // ---- Local scan archive: once a card is approved (its photos are in the
  // catalogue) its large local files are replaced by one small JPEG per side.
  // Runs in the background, one card at a time; cards in review are untouched.
  const compactingRef = useRef(false)

  async function compactApprovedScans() {
    const api = adminDesktopApi()
    if (compactingRef.current || typeof api.compactScans !== 'function') return
    compactingRef.current = true
    try {
      for (;;) {
        const draft = scanDraftsRef.current.find((entry) => (
          COMPLETED_SCAN_REVIEW_STATUSES.has(entry.status)
          && [entry.frontImage, entry.backImage].some((image) => image?.path && !image.archived)
        ))
        if (!draft) break
        let result = null
        try { result = await api.compactScans({ front: draft.frontImage || null, back: draft.backImage || null }) } catch { result = null }
        // Marked archived even if a file couldn't be compacted (e.g. already
        // missing), so a card is only ever tried once.
        const archived = (before, after) => {
          if (!before) return before
          const next = { ...(after || before), archived: true }
          delete next.freedBytes
          // Already uploaded to the cloud queue: don't upload the archive copy.
          if (before.cloudPath) { next.cloudPath = before.cloudPath; next.cloudSource = next.path }
          return next
        }
        await saveScanDrafts((drafts) => drafts.map((entry) => (
          entry.id === draft.id
            ? { ...entry, frontImage: archived(entry.frontImage, result?.frontImage), backImage: archived(entry.backImage, result?.backImage) }
            : entry
        )), { fromCloud: true })
      }
    } finally {
      compactingRef.current = false
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(compactApprovedScans, 4000)
    return () => window.clearTimeout(timer)
  }, [scanDrafts])

  // ---- Cloud review queue: analysed cards are uploaded so they can be
  // reviewed from any machine signed in as a platform admin; changes made on
  // one machine reach the others within ~30 s.
  const [cloudState, setCloudState] = useState({ available: null, syncing: false, error: '', lastSync: '' })
  const cloudDirtyRef = useRef(new Set())
  const cloudPushTimerRef = useRef(0)
  const cloudPushingRef = useRef(false)
  const cloudPullingRef = useRef(false)
  const cloudSinceRef = useRef('')

  // Machines start uploading cards scanned from the moment the queue is
  // available here; earlier cards can be uploaded with Upload queue.
  function cloudStartedAt() {
    try {
      let value = window.localStorage.getItem('collectorshub-cloud-review-since')
      if (!value) {
        value = new Date().toISOString()
        window.localStorage.setItem('collectorshub-cloud-review-since', value)
      }
      return value
    } catch {
      return ''
    }
  }

  function cloudEligible(draft) {
    if (!draft || ['queued', 'analysing', 'failed'].includes(draft.recognition?.status)) return false
    if (draft.cloud || draft.cloudUpload) return true
    const since = cloudStartedAt()
    return Boolean(since) && String(draft.createdAt || '') >= since && Boolean(draft.recognition || draft.scanAnalysis)
  }

  function noteCloudChanges(previous, next) {
    const before = new Map(previous.map((draft) => [draft.id, draft]))
    let any = false
    for (const draft of next) {
      if (before.get(draft.id) !== draft && cloudEligible(draft)) {
        cloudDirtyRef.current.add(draft.id)
        any = true
      }
    }
    if (any) scheduleCloudPush()
  }

  function scheduleCloudPush(delay = 1200) {
    window.clearTimeout(cloudPushTimerRef.current)
    cloudPushTimerRef.current = window.setTimeout(pushCloudDrafts, delay)
  }

  async function pushCloudDrafts() {
    if (cloudPushingRef.current) { scheduleCloudPush(2000); return }
    if (!(await cloudReviewAvailable())) return
    cloudPushingRef.current = true
    setCloudState((current) => ({ ...current, available: true, syncing: true }))
    const api = adminDesktopApi()
    const readImage = (image) => {
      if (typeof api.readScanImage !== 'function') throw new Error('Scan files can only be uploaded from the desktop app.')
      return api.readScanImage(image)
    }
    let error = ''
    try {
      while (cloudDirtyRef.current.size) {
        const [id] = cloudDirtyRef.current
        cloudDirtyRef.current.delete(id)
        const draft = scanDraftsRef.current.find((entry) => entry.id === id)
        if (!draft || !cloudEligible(draft)) continue
        try {
          const result = await pushReviewDraft(draft, { readImage })
          if (result.conflict) {
            // Changed on another machine first: take that copy.
            await pullCloudDrafts({ full: false, onlyIds: new Set([id]) })
            continue
          }
          await saveScanDrafts((drafts) => drafts.map((entry) => (
            entry.id === id
              ? {
                  ...entry,
                  frontImage: entry.frontImage && result.images.frontImage && entry.frontImage.path === result.images.frontImage.path ? { ...entry.frontImage, cloudPath: result.images.frontImage.cloudPath, cloudSource: result.images.frontImage.cloudSource } : entry.frontImage,
                  backImage: entry.backImage && result.images.backImage && entry.backImage.path === result.images.backImage.path ? { ...entry.backImage, cloudPath: result.images.backImage.cloudPath, cloudSource: result.images.backImage.cloudSource } : entry.backImage,
                  cloud: { version: result.version, updatedAt: result.updatedAt },
                }
              : entry
          )), { fromCloud: true })
          // Reviewed: free the uploaded scans (once).
          if (COMPLETED_SCAN_REVIEW_STATUSES.has(draft.status) && !draft.cloudImagesRemoved) {
            try {
              await removeCloudImages(draft)
              await saveScanDrafts((drafts) => drafts.map((entry) => (entry.id === id ? { ...entry, cloudImagesRemoved: true } : entry)), { fromCloud: true })
            } catch {}
          }
        } catch (pushError) {
          error = pushError.message || 'Could not upload a card to the cloud review queue.'
          // Try again later.
          cloudDirtyRef.current.add(id)
          break
        }
      }
    } finally {
      cloudPushingRef.current = false
      setCloudState((current) => ({ ...current, syncing: false, error, lastSync: error ? current.lastSync : new Date().toISOString() }))
      if (error) scheduleCloudPush(30000)
      else if (cloudDirtyRef.current.size) scheduleCloudPush(500)
    }
  }

  // Brings in cards and changes from other machines. A full pull also drops
  // local copies of cards deleted elsewhere.
  async function pullCloudDrafts({ full = false, onlyIds = null } = {}) {
    if (cloudPullingRef.current && !onlyIds) return
    const ok = await cloudReviewAvailable({ refresh: cloudState.available === false })
    setCloudState((current) => (current.available === ok ? current : { ...current, available: ok }))
    if (!ok) return
    cloudPullingRef.current = true
    try {
      const since = full || onlyIds ? '' : cloudSinceRef.current
      let rows = await pullReviewDrafts(since)
      if (onlyIds) rows = rows.filter((row) => onlyIds.has(row.id))
      const liveIds = full ? await cloudReviewDraftIds() : null
      let merged = null
      await saveScanDrafts((drafts) => {
        const byId = new Map(drafts.map((draft) => [draft.id, draft]))
        let next = [...drafts]
        for (const row of rows) {
          const local = byId.get(row.id)
          if (local?.cloud && local.cloud.version >= row.version) continue
          // A local change not uploaded yet wins until it is uploaded.
          if (local && cloudDirtyRef.current.has(row.id) && local.cloud) continue
          const draft = mergeCloudRow(local, row)
          next = local ? next.map((entry) => (entry.id === row.id ? draft : entry)) : [draft, ...next]
        }
        if (liveIds) next = next.filter((draft) => !draft.cloud || liveIds.has(draft.id) || cloudDirtyRef.current.has(draft.id))
        merged = next
        return next
      }, { fromCloud: true })
      // Viewable links for cards whose images only exist in the cloud.
      const signed = await signRemoteImages(merged || scanDraftsRef.current)
      if (signed.some((draft, index) => draft !== (merged || scanDraftsRef.current)[index])) {
        const byId = new Map(signed.map((draft) => [draft.id, draft]))
        await saveScanDrafts((drafts) => drafts.map((draft) => byId.get(draft.id) || draft), { fromCloud: true })
      }
      const newest = rows.reduce((latest, row) => (row.updated_at > latest ? row.updated_at : latest), cloudSinceRef.current)
      if (!onlyIds) cloudSinceRef.current = newest
      setCloudState((current) => ({ ...current, available: true, error: '', lastSync: new Date().toISOString() }))
    } catch (pullError) {
      setCloudState((current) => ({ ...current, error: pullError.message || 'Could not load the cloud review queue.' }))
    } finally {
      if (!onlyIds) cloudPullingRef.current = false
    }
  }

  // Uploads cards from before this machine started using the cloud queue.
  async function uploadExistingQueue() {
    const ids = scanDraftsRef.current
      .filter((draft) => !draft.cloud && !['queued', 'analysing', 'failed'].includes(draft.recognition?.status) && draft.status !== 'Rejected' && !COMPLETED_SCAN_REVIEW_STATUSES.has(draft.status) && (draft.recognition || draft.scanAnalysis))
      .map((draft) => draft.id)
    if (!ids.length) return
    await saveScanDrafts((drafts) => drafts.map((draft) => (ids.includes(draft.id) ? { ...draft, cloudUpload: true } : draft)))
  }

  useEffect(() => {
    let cancelled = false
    let timer = 0
    const tick = async (full) => {
      if (cancelled) return
      await pullCloudDrafts({ full })
      if (!cancelled) timer = window.setTimeout(() => tick(false), 30000)
    }
    // After the local queue has loaded.
    const start = window.setTimeout(() => tick(true), 1500)
    const onFocus = () => { pullCloudDrafts({ full: true }) }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearTimeout(start)
      window.clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    if (activeView === 'review') pullCloudDrafts({ full: true })
  }, [activeView])

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
      const response = await api.recognizeCard({ jobId, front: draft.frontImage || null, back: draft.backImage || null, checkSides: needsSideCheck(draft), checkUpright: needsUprightCheck(draft), category: draft.category })
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
        const { taxonomy, scanAnalysis } = await analyseScanReading(draft, response.result, { drafts: scanDraftsRef.current, frontImage: response.orientation?.images?.front || null })
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
        ...(options.target ? { target: options.target } : {}),
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
      result = await api.feedStack({ loadFaceDown: options.loadFaceDown, category: options.category })
    } catch (error) {
      result = { ok: false, code: 'FEED_FAILED', message: error.message || 'The FastFoto scan failed.' }
    }
    setFeedState((current) => ({ ...current, running: false, stopping: false, result }))
    return result
  }

  // The FastFoto, if connected (for the top bar's Scan stack button).
  const [quickFeeder, setQuickFeeder] = useState('')
  useEffect(() => {
    const api = adminDesktopApi()
    const update = (status) => { if (status && 'feederName' in status) setQuickFeeder(status.feederName || '') }
    api.getScannerStatus?.().then(update).catch(() => {})
    api.refreshFeeder?.().then(update).catch(() => {})
    return api.onScannerStatus?.(update)
  }, [])

  function quickScanStack() {
    setActiveView('scan')
    startFeed({
      category: readScannerPref('category', 'Trading Cards'),
      mode: readScannerPref('mode', 'Create Catalogue Items'),
      autoAnalyse: readScannerPref('feedAutoAnalyse', true),
      loadFaceDown: readScannerPref('feedFaceDown', true),
      target: activeSetTarget(readScannerPref('photoTarget', null)),
    })
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
  // Analysed cards waiting in Review (shown while the rest are still analysing).
  const reviewReadyCount = scanDrafts.filter((draft) => (
    !['queued', 'analysing', 'failed'].includes(draft.recognition?.status)
    && draft.status !== 'Rejected'
    && !COMPLETED_SCAN_REVIEW_STATUSES.has(draft.status)
  )).length

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
            <button className={activeView === key ? 'admin-nav-button active' : 'admin-nav-button'} type="button" key={key} onClick={() => { setMarketItemId(''); setActiveView(key) }}>
              <Icon size={17} />
              <span>{label}</span>
              {key === 'review' && reviewReadyCount ? <em className="admin-nav-badge" title="Cards ready to review">{reviewReadyCount}</em> : null}
            </button>
          ))}
        </nav>

        <div className="admin-user-card">
          <strong>{session?.displayName || 'Platform Admin'}</strong>
          <span>{session?.email || 'CollectorsHub admin'}</span>
          <small>Role: platform_admin</small>
          <small>{syncStatus?.online ? 'Online' : 'Offline'} · Supabase authenticated</small>
          <UpdateCheck compact />
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
          <div className="admin-topbar-actions">
            {feedState?.running ? (
              <button type="button" className="admin-quick-scan running" onClick={() => setActiveView('scan')} title="A FastFoto stack is scanning">
                <ScanLine size={16} /> Scanning stack… {Math.floor((feedState.pages || 0) / 2)} card{Math.floor((feedState.pages || 0) / 2) === 1 ? '' : 's'}
              </button>
            ) : (
              <>
                {quickFeeder ? (
                  <button type="button" className="admin-quick-scan" onClick={quickScanStack} title={`Feed the loaded stack through the ${quickFeeder} (uses your last Scan Intake settings)`}>
                    <ScanLine size={16} /> Scan stack
                  </button>
                ) : null}
                {activeView !== 'scan' ? (
                  <button type="button" className="admin-quick-scan primary" onClick={() => setActiveView('scan')}>
                    <ScanLine size={16} /> Scan
                  </button>
                ) : null}
              </>
            )}
            <span className="admin-status-pill">
              <span />
              {syncStatus?.online ? 'Online' : 'Offline'}
            </span>
          </div>
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
              // File names every card in the queue uses (kept by the clean-up).
              referencedScanFiles: () => scanDraftsRef.current.flatMap((draft) => [draft.frontImage, draft.backImage]).flatMap((image) => [image?.path, image?.rawPath, image?.displayPath]).filter(Boolean).map((file) => String(file).split(/[\\/]/).pop()),
              onRemove: deleteScanDraft,
              onAnalyse: analyseCards,
              onCancel: cancelAnalysis,
              onRetry: retryAi,
              onOpenReview: () => setActiveView('review'),
              reviewReadyCount,
            }}
          />
        ) : null}
        {activeView === 'review' ? <PendingReview cloud={{ ...cloudState, pendingUpload: scanDrafts.filter((draft) => !draft.cloud && !draft.cloudUpload && !['queued', 'analysing', 'failed'].includes(draft.recognition?.status) && draft.status !== 'Rejected' && !COMPLETED_SCAN_REVIEW_STATUSES.has(draft.status) && (draft.recognition || draft.scanAnalysis)).length, onUploadExisting: uploadExistingQueue, onRefresh: () => pullCloudDrafts({ full: true }) }} drafts={scanDrafts} onUpdateDraft={updateScanDraft} onDeleteDraft={deleteScanDraft} onDeleteDrafts={deleteScanDrafts} onCreateMore={() => setActiveView('scan')} onRetryAi={retryAi} aiBusy={Boolean(aiAnalysis)} queuedCount={aiQueue.length} /> : null}
        {activeView === 'explorer' ? <DataExplorer /> : null}
        {activeView === 'taxonomy' ? <TaxonomyAdmin /> : null}
        {activeView === 'media' ? <AdminSectionBrowser title="Images & Media" kicker="Catalogue media administration" loader={loadImagesMediaData} /> : null}
        {activeView === 'pricing' ? (
          <AdminSectionBrowser
            title="Pricing / Sales Data"
            kicker="Valuation and sales inputs"
            loader={loadPricingData}
            serverSearch
            rowAction={{ label: 'Add sales data', show: (row) => Boolean(row.itemId), run: (row) => { setMarketItemId(row.itemId); setActiveView('market') } }}
          />
        ) : null}
        {activeView === 'market' ? <MarketDataAdmin key={marketItemId} initialItemId={marketItemId} storeContext={storeContext} /> : null}
        {activeView === 'stores' ? <StoreManagement /> : null}
        {activeView === 'onboarding' ? <OnboardingAdmin session={session} /> : null}
        {activeView === 'users' ? <AdminSectionBrowser title="Users" kicker="Profiles and memberships" loader={loadUsersData} /> : null}
        {activeView === 'identity' ? <IdentityReviews /> : null}
        {activeView === 'pawn' ? <PawnJurisdictions /> : null}
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

function MarketDataAdmin({ storeContext = {}, initialItemId = '' }) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [selectedId, setSelectedId] = useState(initialItemId)
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

// Local catalogue backup: a second copy of the catalogue (and our own photos)
// in a folder, written as items are saved and checked against Supabase daily.
function CatalogueBackupPanel() {
  const api = adminDesktopApi()
  const supported = typeof api.getCatalogueBackupStatus === 'function'
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!supported) return undefined
    api.configureCatalogueBackup?.(SUPABASE_PUBLIC_CONFIG).then(setStatus).catch(() => api.getCatalogueBackupStatus().then(setStatus).catch(() => {}))
    return api.onCatalogueBackupStatus?.((next) => setStatus(next))
  }, [])

  if (!supported) return null

  async function chooseFolder() {
    setError('')
    try { setStatus(await api.chooseCatalogueBackupFolder()) } catch (chooseError) { setError(chooseError.message || 'Could not use that folder.') }
  }

  async function verifyNow() {
    setError('')
    try {
      const result = await api.verifyCatalogueBackup()
      setStatus(result.status)
      setOpen(true)
    } catch (verifyError) {
      setError(verifyError.message || 'The backup check failed.')
    }
  }

  const last = status?.last
  const problems = last ? (last.missingFromSupabase || 0) + (last.failedWrites || 0) + (last.photos?.notFoundInSupabase || 0) : 0
  const progress = status?.progress
  return (
    <section className={`admin-panel catalogue-backup${problems ? ' attention' : ''}`}>
      <div className="catalogue-backup-head">
        <div>
          <strong>Catalogue backup</strong>
          <small>
            {!status?.dir ? 'Not set up: choose a folder to keep a second copy of the catalogue and your photos.'
              : status.verifying ? `${progress?.stage || 'Checking'}${progress?.done ? ` · ${progress.done.toLocaleString()}${progress.total ? ` of ${progress.total.toLocaleString()}` : ''}` : ''}…`
                : last ? `${status.dir} · last checked ${new Date(last.finishedAt).toLocaleString()} · ${last.supabaseItems.toLocaleString()} items${problems ? ` · ${problems} to look at` : ' · everything matches'}`
                  : `${status.dir} · not checked yet`}
          </small>
        </div>
        <div className="catalogue-backup-actions">
          {status?.dir ? <button type="button" onClick={verifyNow} disabled={status?.verifying}>{status?.verifying ? 'Checking…' : 'Verify now'}</button> : null}
          {status?.dir ? <button type="button" onClick={() => api.openCatalogueBackupFolder?.()}>Open folder</button> : null}
          <button type="button" onClick={chooseFolder} disabled={status?.verifying}>{status?.dir ? 'Change folder…' : 'Choose folder…'}</button>
          {last ? <button type="button" onClick={() => setOpen((current) => !current)}>{open ? 'Hide report' : 'Report'}</button> : null}
        </div>
      </div>
      {error ? <p className="admin-error">{error}</p> : null}
      {open && last ? (
        <div className="catalogue-backup-report">
          <p>
            {last.firstSnapshot ? 'First full copy taken. ' : `${last.newInSupabase} new and ${last.changedInSupabase} changed item${last.changedInSupabase === 1 ? '' : 's'} copied from Supabase (added or edited on the website, by imports or here). `}
            Photos: {last.photos.own} of your own ({last.photos.downloaded} newly saved); photos from public card databases are kept as links.
          </p>
          {last.failedWrites ? (
            <div><strong>{last.failedWrites} save{last.failedWrites === 1 ? '' : 's'} Supabase refused</strong> (kept in the backup journal):
              <ul>{last.failedSamples.map((entry) => <li key={entry.at}>{new Date(entry.at).toLocaleString()} · {entry.action} · {entry.error}</li>)}</ul>
            </div>
          ) : null}
          {last.missingFromSupabase ? (
            <div><strong>{last.missingFromSupabase} item{last.missingFromSupabase === 1 ? ' is' : 's are'} in the backup but no longer in Supabase</strong> (saved in missing-from-supabase.jsonl):
              <ul>{last.missingSamples.map((entry) => <li key={entry.item_id}>{entry.name || 'Unnamed'} <code>{entry.item_id}</code></li>)}</ul>
            </div>
          ) : null}
          {last.photos.notFoundInSupabase ? <p><strong>{last.photos.notFoundInSupabase} photo record{last.photos.notFoundInSupabase === 1 ? ' points' : 's point'} to a file that isn't in Supabase storage.</strong></p> : null}
          {!problems ? <p className="admin-success">Supabase and the backup match.</p> : null}
        </div>
      ) : null}
    </section>
  )
}

function AdminCatalogue() {
  const [checklistOpen, setChecklistOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [franchiseId, setFranchiseId] = useState('')
  const [subsetId, setSubsetId] = useState('')
  const [releaseYear, setReleaseYear] = useState('')
  const [missingImages, setMissingImages] = useState(false)
  const [missingPricing, setMissingPricing] = useState(false)
  const [categories, setCategories] = useState([])
  const [franchises, setFranchises] = useState([])
  const [subfranchises, setSubfranchises] = useState([])
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
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState('')
  const filters = { search, categoryId, franchiseId, subsetId, releaseYear, missingImages, missingPricing }

  useEffect(() => {
    loadAdminCategories().then(setCategories).catch(() => setCategories([]))
  }, [])

  // The franchise list follows the category filter; a franchise from another category is cleared.
  useEffect(() => {
    let alive = true
    loadFranchiseOptions(categoryId)
      .then((list) => {
        if (!alive) return
        setFranchises(list)
        setFranchiseId((current) => (current && !list.some((franchise) => franchise.id === current) ? '' : current))
      })
      .catch(() => { if (alive) setFranchises([]) })
    return () => { alive = false }
  }, [categoryId])

  // The subfranchise list follows the franchise filter; changing franchise clears it.
  useEffect(() => {
    let alive = true
    setSubsetId('')
    setSubfranchises([])
    if (!franchiseId) return undefined
    loadSubfranchiseOptions(franchiseId)
      .then((list) => { if (alive) setSubfranchises(list) })
      .catch(() => { if (alive) setSubfranchises([]) })
    return () => { alive = false }
  }, [franchiseId])

  useEffect(() => {
    setPage(1)
    setChecked(new Set())
  }, [search, categoryId, franchiseId, subsetId, releaseYear, missingImages, missingPricing])

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
  }, [search, categoryId, franchiseId, subsetId, releaseYear, missingImages, missingPricing, page, reloadToken])

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
    subfranchises.find((subset) => subset.id === subsetId)?.name,
    releaseYear ? `Year ${releaseYear}` : '',
    search ? `"${search}"` : '',
    missingImages ? 'missing images' : '',
    missingPricing ? 'missing pricing' : '',
  ].filter(Boolean).join(' · ')

  return (
    <div className="admin-stack">
      <CatalogueBackupPanel />
      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <p className="admin-kicker">Real Supabase catalogue</p>
            <h2>Catalogue Administration</h2>
          </div>
          <div className="admin-panel-actions">
            <button type="button" onClick={() => setChecklistOpen(true)}>Import set checklist</button>
            <button className="admin-gold-button" type="button">+ Add Catalogue Item</button>
          </div>
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
          <select value={subsetId} onChange={(event) => setSubsetId(event.target.value)} disabled={!franchiseId || !subfranchises.length} title={franchiseId ? '' : 'Choose a franchise first'}>
            <option value="">{franchiseId && !subfranchises.length ? 'No Subfranchises' : 'All Subfranchises'}</option>
            {subfranchises.map((subset) => <option key={subset.id} value={subset.id}>{subset.name}</option>)}
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
          {checked.size ? <button type="button" onClick={() => setEditing(true)}>Edit Selected ({formatNumber(checked.size)})</button> : null}
          {checked.size ? <button type="button" className="danger" onClick={() => setDeleting(true)}>Delete Selected ({formatNumber(checked.size)})</button> : null}
        </div>
        {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
        {notice ? <AdminDismissibleAlert className="admin-success" onDismiss={() => setNotice('')}>{notice}</AdminDismissibleAlert> : null}
        <CatalogueTable rows={rows} onSelect={setSelectedId} selectedId={selectedId} checked={checked} onToggle={toggleRow} onTogglePage={togglePage} />
        <PaginationControls page={page} totalPages={totalPages} total={total} onPage={setPage} />
      </section>

      {selectedId ? <CatalogueItemRecord itemId={selectedId} onClose={() => setSelectedId('')} /> : null}
      {checklistOpen ? <ChecklistImportDialog onClose={() => { setChecklistOpen(false); setReloadToken((token) => token + 1) }} /> : null}
      {editing ? (
        <BulkEditDialog
          itemIds={[...checked]}
          filterSummary={filterSummary}
          onClose={() => setEditing(false)}
          onDone={(result, label) => {
            setEditing(false)
            setNotice(`Updated ${label} on ${formatNumber(result.updated.length)} catalogue item${result.updated.length === 1 ? '' : 's'}.`
              + (result.failed.length ? ` ${formatNumber(result.failed.length)} could not be updated.` : ''))
            setReloadToken((token) => token + 1)
          }}
        />
      ) : null}
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

// Edits the selected catalogue items together: every field the item editor
// has, showing the value they share (or "Mixed"). Only the fields changed
// here are written; category data is merged key by key into each item's own.
const BULK_KEEP = '__keep__'
export function BulkEditDialog({ itemIds, filterSummary, onClose, onDone }) {
  const [loaded, setLoaded] = useState(null)
  // Field key -> new text, for the fields changed here only.
  const [edits, setEdits] = useState({})
  // dynamic_fields key -> { kind, value } or { remove: true }.
  const [dynamicEdits, setDynamicEdits] = useState({})
  const [newKey, setNewKey] = useState('')
  const [options, setOptions] = useState({})
  const [names, setNames] = useState({})
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const running = Boolean(progress) && !result
  const count = formatNumber(itemIds.length)
  const plural = itemIds.length === 1 ? '' : 's'
  const fields = CATALOGUE_EDIT_GROUPS.flatMap((group) => group.fields)

  useEffect(() => {
    let cancelled = false
    loadBulkEditItems(itemIds)
      .then(async (rows) => {
        if (cancelled) return
        setLoaded(rows)
        const first = rows[0]?.values || {}
        const common = Object.fromEntries(Object.entries(first).filter(([key, value]) => rows.every((row) => row.values[key] === value)))
        setNames(await loadCatalogueValueNames(common).catch(() => ({})))
      })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load the selected items.') })
    return () => { cancelled = true }
  }, [])

  // Each field's value when every selected item has the same one, else null (mixed).
  const shared = useMemo(() => {
    if (!loaded?.length) return {}
    return Object.fromEntries(fields.map((field) => {
      const values = new Set(loaded.map((row) => row.values[field.key]))
      return [field.key, values.size === 1 ? [...values][0] : null]
    }))
  }, [loaded])
  const current = (key) => (key in edits ? edits[key] : shared[key])

  useEffect(() => {
    if (!loaded) return undefined
    let cancelled = false
    loadCatalogueTaxonomyOptions({ categoryId: current('category_id') || '', subcategoryId: current('subcategory_id') || '', franchiseId: current('franchise_id') || '', subsetId: current('subset_id') || '' })
      .then((next) => { if (!cancelled) setOptions(next) })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load the catalogue choices.') })
    return () => { cancelled = true }
  }, [loaded, current('category_id'), current('subcategory_id'), current('franchise_id'), current('subset_id')])

  const categoryId = current('category_id')
  const categoryName = ((options.category || []).find((option) => option.id === categoryId)?.name || names[`category:${categoryId}`] || '').toLowerCase()
  const presetKeys = categoryName === 'sports cards' ? SPORTS_DYNAMIC_KEYS : categoryName === 'trading cards' ? TRADING_EDITOR_KEYS : []

  // Every dynamic_fields key on any selected item, with the shared value or null.
  const dynamicKeys = useMemo(() => {
    if (!loaded) return []
    const byKey = new Map()
    loaded.forEach(({ item }) => Object.entries(item.dynamic_fields || {}).forEach(([key, value]) => {
      const entry = byKey.get(key) || { key, count: 0, values: new Set(), sample: value }
      entry.count += 1
      entry.values.add(stableJson(value))
      byKey.set(key, entry)
    }))
    presetKeys.filter((key) => !byKey.has(key)).forEach((key) => byKey.set(key, { key, count: 0, values: new Set(), sample: LIST_DYNAMIC_KEYS.has(key) ? [] : '' }))
    Object.keys(dynamicEdits).filter((key) => !byKey.has(key)).forEach((key) => byKey.set(key, { key, count: 0, values: new Set(), sample: '' }))
    return [...byKey.values()].map((entry) => {
      const kind = dynamicRowKind(entry.sample)
      const same = entry.count === loaded.length && entry.values.size === 1
      return { key: entry.key, count: entry.count, kind, value: same ? dynamicValueText(kind, entry.sample) : entry.count ? null : '' }
    }).sort((a, b) => a.key.localeCompare(b.key))
  }, [loaded, presetKeys, dynamicEdits])

  function setValue(key, value) {
    setEdits((currentEdits) => {
      const next = { ...currentEdits }
      const children = taxonomyChildren(key, categoryName)
      if (value === BULK_KEEP || value === shared[key]) {
        delete next[key]
        children.forEach((child) => { delete next[child] })
      } else {
        const changed = next[key] !== value
        next[key] = value
        // A new parent clears the levels below it (their choices depend on it).
        if (changed) children.forEach((child) => { if (shared[child] === '') delete next[child]; else next[child] = '' })
      }
      return next
    })
  }

  function setDynamic(row, value) {
    setDynamicEdits((currentEdits) => {
      const next = { ...currentEdits }
      if (value === BULK_KEEP || (value === row.value && row.count)) delete next[row.key]
      else next[row.key] = { kind: row.kind, value }
      return next
    })
  }

  function toggleRemove(row) {
    setDynamicEdits((currentEdits) => {
      const next = { ...currentEdits }
      if (next[row.key]?.remove) delete next[row.key]
      else next[row.key] = { remove: true }
      return next
    })
  }

  function addDynamicField() {
    const key = newKey.trim().toLowerCase().replace(/\s+/g, '_')
    if (!key || dynamicKeys.some((row) => row.key === key)) return
    setDynamicEdits((currentEdits) => ({ ...currentEdits, [key]: { kind: 'text', value: '' } }))
    setNewKey('')
  }

  const changedLabels = [
    ...fields.filter((field) => field.key in edits).map((field) => field.label),
    ...Object.keys(dynamicEdits).map((key) => dynamicFieldLabel(key)),
  ]

  async function run() {
    setError('')
    const dynamicSet = {}
    const dynamicRemove = []
    try {
      Object.entries(dynamicEdits).forEach(([key, edit]) => {
        if (edit.remove) dynamicRemove.push(key)
        else Object.assign(dynamicSet, dynamicFieldsFromRows([{ key, kind: edit.kind, value: edit.value, existed: true }]))
      })
    } catch (err) {
      setError(err.message)
      return
    }
    setProgress({ phase: 'Updating', done: 0, total: itemIds.length })
    try {
      setResult(await saveBulkCatalogueEdits({ items: loaded, values: edits, dynamicSet, dynamicRemove, onProgress: setProgress }))
    } catch (err) {
      setError(err.message || 'Update failed.')
      setProgress(null)
    }
  }

  function renderInput(field) {
    const value = current(field.key)
    const mixed = value === null && !(field.key in edits)
    const keep = mixed ? <option value={BULK_KEEP}>Mixed (keep each item's)</option> : null
    if (field.taxonomy) {
      const list = options[field.taxonomy] || []
      const parent = field.taxonomy === 'property' ? propertyParentKey(categoryName) : TAXONOMY_PARENT[field.taxonomy]
      const parentValue = parent ? current(parent) : 'none'
      const ready = !parent || Boolean(parentValue)
      const choices = value && !list.some((option) => option.id === value)
        ? [{ id: value, name: names[`${field.taxonomy}:${value}`] || 'Current value' }, ...list]
        : list
      const blocked = parent && parentValue === null
      return (
        <select value={mixed ? BULK_KEEP : value} onChange={(event) => setValue(field.key, event.target.value)} disabled={running || Boolean(blocked && mixed)} title={blocked ? 'The selected items have different values in the level above: set it first.' : ''}>
          {keep}
          <option value="">{ready ? 'None' : blocked ? 'Mixed above: set the level above first' : 'Select the level above first'}</option>
          {ready ? choices.map((option) => <option key={option.id} value={option.id}>{option.name}</option>) : null}
        </select>
      )
    }
    if (field.type === 'boolean') {
      return (
        <select value={mixed ? BULK_KEEP : value} onChange={(event) => setValue(field.key, event.target.value)} disabled={running}>
          {keep}
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      )
    }
    const props = { value: value ?? '', onChange: (event) => setValue(field.key, event.target.value), placeholder: mixed ? "Mixed (keep each item's)" : '', disabled: running }
    if (field.multiline) return <textarea rows={3} {...props} />
    return <input type={field.type === 'number' ? 'number' : 'text'} {...props} />
  }

  function renderDynamicInput(row) {
    const edit = dynamicEdits[row.key]
    const value = edit && !edit.remove ? edit.value : row.value
    const mixed = !edit && row.value === null
    const choices = DYNAMIC_FIELD_CHOICES[row.key]
    const disabled = running || Boolean(edit?.remove)
    const onChange = (event) => setDynamic(row, event.target.value)
    if (row.kind === 'boolean' || (choices && row.kind === 'text')) {
      const list = row.kind === 'boolean' ? [['true', 'Yes'], ['false', 'No']] : (value && !choices.includes(value) ? [value, ...choices] : choices).map((choice) => [choice, choice])
      return (
        <select value={mixed ? BULK_KEEP : value} onChange={onChange} disabled={disabled}>
          {mixed ? <option value={BULK_KEEP}>Mixed (keep each item's)</option> : null}
          {row.kind === 'boolean' ? null : <option value="">—</option>}
          {list.map(([choice, label]) => <option key={choice} value={choice}>{label}</option>)}
        </select>
      )
    }
    const placeholder = mixed ? `Mixed (keep each item's)` : row.kind === 'list' ? 'One per line' : ''
    if (row.kind === 'list' || row.kind === 'json') return <textarea className={row.kind === 'json' ? 'catalogue-editor-json' : ''} rows={Math.min(8, String(value ?? '').split('\n').length + 1)} value={value ?? ''} onChange={onChange} placeholder={placeholder} spellCheck={row.kind === 'json' ? 'false' : undefined} disabled={disabled} />
    return <input type={row.kind === 'number' ? 'number' : 'text'} value={value ?? ''} onChange={onChange} placeholder={placeholder} disabled={disabled} />
  }

  const total = loaded?.length || 0
  return (
    <div className="register-modal update-prompt" role="dialog" aria-modal="true" aria-labelledby="bulk-edit-title">
      <section className="bulk-edit-dialog">
        <p className="update-prompt-kicker">Edit catalogue items</p>
        <h2 id="bulk-edit-title">{result ? 'Update finished' : `Edit ${count} catalogue item${plural}`}</h2>
        {!result ? (
          <>
            {filterSummary ? <p>Selected from: <strong>{filterSummary}</strong></p> : null}
            {progress ? (
              <div className="local-ai-progress">
                <div className="local-ai-progress-bar"><span style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} /></div>
                <small>{progress.phase}: {formatNumber(progress.done)} of {formatNumber(progress.total)}</small>
              </div>
            ) : null}
            {!loaded && !error ? <p className="scan-mode-note">Loading the selected items…</p> : null}
            {loaded ? (
              <>
                <small>Change any field to set it on all {count} item{plural}. Fields you leave alone keep each item's own value.</small>
                <table className="scan-review-table catalogue-editor-table">
                  {CATALOGUE_EDIT_GROUPS.map((group) => (
                    <tbody key={group.id}>
                      <tr className="scan-review-group"><th colSpan={2}>{group.label}</th></tr>
                      {group.fields.filter((field) => !field.seriesOnly || categoryHasSeries(categoryName)).map((field) => (
                        <tr key={field.key} className={field.key in edits ? 'edited' : ''}>
                          <th scope="row">{field.label}</th>
                          <td>
                            <div className="catalogue-editor-dynamic">
                              {renderInput(field)}
                              {field.key in edits ? <button type="button" onClick={() => setValue(field.key, BULK_KEEP)} disabled={running} title="Undo this change">Undo</button> : null}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
                  <tbody>
                    <tr className="scan-review-group"><th colSpan={2}>{presetKeys.length ? 'Card Metadata & Other Data' : 'Category Data'} <small>(dynamic_fields)</small></th></tr>
                    {dynamicKeys.map((row) => {
                      const edit = dynamicEdits[row.key]
                      return (
                        <tr key={row.key} className={edit ? 'edited' : ''}>
                          <th scope="row">
                            {dynamicFieldLabel(row.key)}
                            <small className="catalogue-editor-key">{row.key}{row.count && row.count < total ? ` · on ${formatNumber(row.count)} of ${formatNumber(total)}` : ''}{edit?.remove ? ' · will be removed' : ''}</small>
                          </th>
                          <td>
                            <div className="catalogue-editor-dynamic">
                              {renderDynamicInput(row)}
                              {edit && !edit.remove ? <button type="button" onClick={() => setDynamicEdits((currentEdits) => { const next = { ...currentEdits }; delete next[row.key]; return next })} disabled={running} title="Undo this change">Undo</button> : null}
                              {row.count ? <button type="button" className="catalogue-editor-remove" onClick={() => toggleRemove(row)} disabled={running} aria-label={edit?.remove ? `Keep ${row.key}` : `Remove ${row.key} from every item`} title={edit?.remove ? 'Keep this field' : 'Remove this field from every selected item'}>{edit?.remove ? '↺' : '×'}</button> : null}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                    <tr>
                      <th scope="row">Add field</th>
                      <td>
                        <div className="catalogue-editor-dynamic">
                          <input value={newKey} onChange={(event) => setNewKey(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addDynamicField() } }} placeholder="field_name" disabled={running} />
                          <button type="button" onClick={addDynamicField} disabled={!newKey.trim() || running}>Add</button>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </>
            ) : null}
          </>
        ) : (
          <div className="bulk-delete-result">
            <p><strong>{formatNumber(result.updated.length)}</strong> updated: {changedLabels.join(', ')}.</p>
            {result.failed.length ? <p><strong>{formatNumber(result.failed.length)}</strong> could not be updated: {result.failed[0].message}</p> : null}
          </div>
        )}
        {error ? <p className="admin-error">{error}</p> : null}
        <div className="modal-actions">
          {result ? (
            <button className="update-prompt-primary" type="button" onClick={() => onDone(result, changedLabels.length === 1 ? changedLabels[0] : `${changedLabels.length} fields`)}>Done</button>
          ) : (
            <>
              <span className="bulk-edit-count">{changedLabels.length ? `${changedLabels.length} field${changedLabels.length === 1 ? '' : 's'} to change` : 'No changes'}</span>
              <button type="button" onClick={onClose} disabled={running}>Cancel</button>
              <button className="update-prompt-primary" type="button" onClick={run} disabled={running || !loaded?.length || !changedLabels.length}>{running ? 'Updating…' : `Update ${count}`}</button>
            </>
          )}
        </div>
      </section>
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
// Trading Cards: the website's card-metadata keys (traits/abilities are lists).
const TRADING_EDITOR_KEYS = ['collection', 'includes', 'included_in', 'source', ...TRADING_DYNAMIC_KEYS]
const LIST_DYNAMIC_KEYS = new Set(['traits', 'abilities'])
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
  // A list of words/sentences (traits, abilities): edited one per line.
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return 'list'
  if (value !== null && typeof value === 'object') return 'json'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  return 'text'
}

function dynamicValueText(kind, value) {
  return kind === 'json' ? JSON.stringify(value, null, 2) : kind === 'list' ? value.join('\n') : value == null ? '' : String(value)
}

// presetKeys: the category's card-metadata keys, shown even when empty.
function dynamicRowsFrom(dynamicFields = {}, presetKeys = []) {
  const rows = Object.entries(dynamicFields || {}).map(([key, value]) => {
    const kind = dynamicRowKind(value)
    return { key, kind, value: dynamicValueText(kind, value), existed: true }
  })
  presetKeys.filter((key) => !rows.some((row) => row.key === key)).forEach((key) => rows.push({ key, kind: LIST_DYNAMIC_KEYS.has(key) ? 'list' : 'text', value: '', existed: false }))
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
    } else if (row.kind === 'list') {
      const entries = row.value.split('\n').map((entry) => entry.trim()).filter(Boolean)
      if (entries.length || row.existed) result[key] = entries
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
  const isTrading = categoryName.toLowerCase() === 'trading cards'
  const presetKeys = isSports ? SPORTS_DYNAMIC_KEYS : isTrading ? TRADING_EDITOR_KEYS : []

  useEffect(() => {
    if (values) setDynamicRows(dynamicRowsFrom(item.dynamic_fields, presetKeys))
  }, [item.item_id, isSports, isTrading, values === null])

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
      if (current[key] !== value) taxonomyChildren(key, categoryName).forEach((child) => { next[child] = '' })
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
      const parent = field.taxonomy === 'property' ? propertyParentKey(categoryName) : TAXONOMY_PARENT[field.taxonomy]
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
    if (row.kind === 'list') return <textarea rows={Math.min(6, row.value.split('\n').length + 1)} value={row.value} onChange={(event) => setDynamic(index, { value: event.target.value })} placeholder="One per line" />
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

  const originalRows = dynamicRowsFrom(item.dynamic_fields, presetKeys)
  return (
    <div className="catalogue-editor">
      {error ? <AdminDismissibleAlert onDismiss={() => setError('')}>{error}</AdminDismissibleAlert> : null}
      <table className="scan-review-table catalogue-editor-table">
        {CATALOGUE_EDIT_GROUPS.map((group) => (
          <tbody key={group.id}>
            <tr className="scan-review-group"><th colSpan={2}>{group.label}</th></tr>
            {group.fields.filter((field) => !field.seriesOnly || categoryHasSeries(categoryName)).map((field) => (
              <tr key={field.key} className={changedKeys.includes(field.key) ? 'edited' : ''}>
                <th scope="row">{field.label}</th>
                <td>{renderInput(field)}</td>
              </tr>
            ))}
          </tbody>
        ))}
        <tbody>
          <tr className="scan-review-group"><th colSpan={2}>{isSports || isTrading ? 'Card Metadata & Other Data' : 'Category Data'} <small>(dynamic_fields)</small></th></tr>
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

// "Photograph a set": the set a stack comes from, so each scan is matched among that
// set's items (number first) to give them their photos. value is saved with the
// scanner preferences; onChange(next) receives { enabled, ...target } (see
// matchScanInTargetSet for the target fields).
function SetTargetPicker({ category, value, onChange, disabled = false }) {
  const [categories, setCategories] = useState([])
  const [options, setOptions] = useState({})
  const [progress, setProgress] = useState(null)
  const target = value || {}
  const categoryName = catalogueCategoryName(category)
  const categoryRow = categories.find((row) => row.name === categoryName)
  const sports = categoryName === 'Sports Cards'
  const cards = /cards/i.test(categoryName)
  const ready = Boolean(target.enabled && categoryRow && target.subcategoryId && (target.subsetId || target.propertyId || (!sports && target.franchiseId)) && (!sports || seasonKey(target.season)))

  useEffect(() => { loadAdminCategories().then(setCategories).catch(() => setCategories([])) }, [])
  // A target chosen under another category doesn't carry over.
  useEffect(() => {
    if (categoryRow && target.categoryId && target.categoryId !== categoryRow.category_id) onChange({ enabled: target.enabled })
  }, [categoryRow?.category_id])

  useEffect(() => {
    if (!target.enabled || !categoryRow) return undefined
    let cancelled = false
    loadScanSetOptions({ category: categoryName, categoryId: categoryRow.category_id, subcategoryId: target.subcategoryId || '', franchiseId: target.franchiseId || '', subsetId: target.subsetId || '' })
      .then((next) => { if (!cancelled) setOptions(next) })
      .catch(() => { if (!cancelled) setOptions({}) })
    return () => { cancelled = true }
  }, [target.enabled, categoryRow?.category_id, target.subcategoryId, target.franchiseId, target.subsetId])

  // How much of the set has photos, and the numbers still missing one.
  const refreshProgress = (refresh = false) => {
    if (!ready) { setProgress(null); return () => {} }
    let cancelled = false
    setProgress((current) => ({ ...(current || {}), loading: true }))
    loadTargetSetItems(target, { refresh })
      .then((items) => {
        if (cancelled) return
        const missing = items.filter((item) => !item.image_path)
        setProgress({ total: items.length, photographed: items.length - missing.length, missing: missing.map((item) => checklistItemNumber(item) || item.name).filter(Boolean) })
      })
      .catch((loadError) => { if (!cancelled) setProgress({ error: loadError.message || 'Could not load the set.' }) })
    return () => { cancelled = true }
  }
  useEffect(() => refreshProgress(), [ready, targetSetKey(target)])

  // The Collections in the chosen set (blank is Base), for the Collection dropdown.
  const [collections, setCollections] = useState([])
  const wholeSet = { ...target, collection: '' }
  useEffect(() => {
    if (!ready) { setCollections([]); return undefined }
    let cancelled = false
    loadTargetSetItems(wholeSet)
      .then((items) => {
        if (cancelled) return
        const counts = new Map()
        for (const item of items) {
          const raw = String(item.dynamic_fields?.collection || '').trim()
          const name = !raw || raw.toLowerCase() === 'base' ? 'Base' : raw
          counts.set(name, (counts.get(name) || 0) + 1)
        }
        setCollections([...counts.entries()].map(([name, count]) => ({ name, count }))
          .sort((left, right) => (left.name !== 'Base') - (right.name !== 'Base') || left.name.localeCompare(right.name)))
      })
      .catch(() => { if (!cancelled) setCollections([]) })
    return () => { cancelled = true }
  }, [ready, targetSetKey(wholeSet)])

  const names = (key, id) => (options[key] || []).find((option) => option.id === id)?.name || ''
  function update(changes) {
    const next = { ...target, ...changes }
    // A level changed: the levels under it no longer apply.
    for (const [key, children] of Object.entries({ subcategoryId: ['franchiseId', 'subsetId', 'propertyId', 'itemTypeId'], franchiseId: ['subsetId', 'propertyId'], subsetId: ['propertyId'] })) {
      if (key in changes && changes[key] !== target[key]) children.forEach((child) => { if (!(child in changes)) next[child] = '' })
    }
    next.category = categoryName
    next.categoryId = categoryRow?.category_id || ''
    next.names = {
      subcategory: names('subcategory', next.subcategoryId), franchise: names('franchise', next.franchiseId),
      subset: names('subset', next.subsetId), property: names('property', next.propertyId), item_type: names('item_type', next.itemTypeId),
    }
    next.label = [next.names.subcategory, next.names.franchise, next.names.subset, next.names.property, next.series, sports ? next.season : next.releaseYear]
      .filter(Boolean).join(' › ') + (next.collection ? ` · ${next.collection}` : '')
    onChange(next)
  }
  const select = (key, optionKey, label, needs = true) => (
    <label>{label}
      <select value={target[key] || ''} onChange={(event) => update({ [key]: event.target.value })} disabled={disabled || !needs}>
        <option value="">{needs ? 'Any' : '—'}</option>
        {(options[optionKey] || []).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
    </label>
  )

  return (
    <div className={`set-target-panel${target.enabled ? ' active' : ''}`}>
      <label className="admin-check">
        <input type="checkbox" checked={Boolean(target.enabled)} onChange={(event) => update({ enabled: event.target.checked })} disabled={disabled} />
        <strong>Photograph a set</strong>
        <small>Match each card among one set's items, card number first, to give them their photos.</small>
      </label>
      {target.enabled ? (
        categoryRow ? (
          <>
            <div className="set-target-fields">
              {select('subcategoryId', 'subcategory', 'Subcategory')}
              {select('franchiseId', 'franchise', 'Franchise', Boolean(target.subcategoryId))}
              {select('subsetId', 'subset', 'Subfranchise', Boolean(target.franchiseId))}
              {select('propertyId', 'property', 'Property', Boolean(target.subcategoryId))}
              {cards ? <label>Series<input value={target.series || ''} onChange={(event) => update({ series: event.target.value })} placeholder="Optional" disabled={disabled} /></label> : null}
              {sports
                ? <label>Season<input value={target.season || ''} onChange={(event) => update({ season: event.target.value })} placeholder="2023-24 or 2024" disabled={disabled} /></label>
                : <label>Year<input type="number" value={target.releaseYear || ''} onChange={(event) => update({ releaseYear: event.target.value })} placeholder="Optional" disabled={disabled} /></label>}
              <label>Collection
                <select value={target.collection || ''} onChange={(event) => update({ collection: event.target.value })} disabled={disabled || !ready}>
                  <option value="">{ready ? 'All collections' : '—'}</option>
                  {/* A saved choice no longer in the set stays visible until changed. */}
                  {target.collection && !collections.some((option) => option.name === target.collection) ? <option value={target.collection}>{target.collection}</option> : null}
                  {collections.map((option) => <option key={option.name} value={option.name}>{option.name} ({option.count})</option>)}
                </select>
              </label>
              {select('itemTypeId', 'item_type', 'Item Type', Boolean(target.subcategoryId))}
            </div>
            {!ready ? <p className="scan-mode-note">Choose at least the Subcategory and the Subfranchise or Property{sports ? ', and enter the Season' : ''}.</p> : null}
            {ready && progress ? (
              <div className="set-target-progress">
                {progress.error ? <span className="admin-error">{progress.error}</span>
                  : progress.loading && progress.total == null ? <span>Loading the set…</span>
                  : (
                    <>
                      <span><strong>{progress.photographed} of {progress.total}</strong> have photos{progress.total && !progress.missing.length ? ' · the set is done' : ''}</span>
                      {progress.missing.length ? <small title={progress.missing.join(', ')}>Still needed: {progress.missing.slice(0, 40).map((number) => `#${number}`).join(', ')}{progress.missing.length > 40 ? ` and ${progress.missing.length - 40} more` : ''}</small> : null}
                      <button type="button" className="link" onClick={() => refreshProgress(true)} disabled={progress.loading}>Refresh</button>
                    </>
                  )}
              </div>
            ) : null}
          </>
        ) : <p className="scan-mode-note">{categories.length ? `"${category}" isn't a catalogue category, so it can't be photographed as a set.` : 'Loading categories…'}</p>
      ) : null}
    </div>
  )
}

// Pending Review, "Photograph a set" tab: one set's scans as a grid (scan beside the
// item it matched), its photo progress, and one action for every confident card.
function SetPhotoGroup({ group, confidenceOf, itemTypeNames, alreadyPhotographed, busy, onOpen, onAttach }) {
  const [progress, setProgress] = useState(null)
  const [showDone, setShowDone] = useState(false)
  // Reloaded when a bulk action finishes, so the counts include photos just attached.
  useEffect(() => {
    if (busy) return undefined
    let cancelled = false
    loadTargetSetItems(group.target, { refresh: true })
      .then((items) => {
        if (cancelled) return
        const missing = items.filter((item) => !item.image_path)
        setProgress({ total: items.length, photographed: items.length - missing.length, missing: missing.map((item) => checklistItemNumber(item) || item.name).filter(Boolean) })
      })
      .catch(() => { if (!cancelled) setProgress(null) })
    return () => { cancelled = true }
  }, [busy, group.key])

  const tiles = showDone ? group.drafts : group.open
  const statusOf = (draft) => {
    if (COMPLETED_SCAN_REVIEW_STATUSES.has(draft.status)) return ['done', draft.imagesAttached ? 'Photos attached' : 'Linked']
    if (alreadyPhotographed.has(draft.id)) return ['done', 'Already has this photo']
    if (group.ready.includes(draft)) return ['ready', 'Ready']
    if (draft.scanAnalysis?.matchStatus === 'none') return ['problem', 'Not in this set']
    if (draft.scanAnalysis?.matchStatus === 'multiple') return ['check', 'Pick the printing']
    return ['check', 'Check']
  }

  return (
    <section className="set-photo-group">
      <div className="set-photo-head">
        <div>
          <strong>{group.target.label || 'Chosen set'}</strong>
          {progress ? (
            <small>
              {progress.photographed} of {progress.total} have photos
              {progress.missing.length ? ` · still needed: ${progress.missing.slice(0, 25).map((number) => `#${number}`).join(', ')}${progress.missing.length > 25 ? ` and ${progress.missing.length - 25} more` : ''}` : ' · the set is done'}
            </small>
          ) : <small>Loading the set…</small>}
        </div>
        <div className="set-photo-actions">
          <label className="admin-check"><input type="checkbox" checked={showDone} onChange={(event) => setShowDone(event.target.checked)} /> Show finished</label>
          <button className="admin-gold-button" type="button" onClick={() => onAttach(group.ready)} disabled={busy || !group.ready.length}>
            Attach photos to {group.ready.length} ready card{group.ready.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
      <div className="set-photo-grid">
        {tiles.map((draft) => {
          const match = draft.scanAnalysis?.bestMatch?.item
          const check = draft.scanAnalysis?.setCheck || {}
          const [tone, label] = statusOf(draft)
          const confidence = confidenceOf(draft)
          const warnings = (confidence?.reasons || []).filter((reason) => !reason.good && reason.delta < 0).map((reason) => reason.text)
          return (
            <button type="button" key={draft.id} className={`set-photo-tile ${tone}`} onClick={() => onOpen(draft)} title={warnings.join('\n') || 'Open to review'}>
              <span className="set-photo-images">
                {draft.frontImage?.url ? <img src={thumbUrl(draft.frontImage.url)} alt="Scan" loading="lazy" decoding="async" /> : <span className="set-photo-noimage">Scan</span>}
                {match?.imageUrl ? <img src={thumbUrl(match.imageUrl)} alt="Catalogue photo" loading="lazy" decoding="async" /> : <span className="set-photo-noimage">{match ? 'No photo yet' : '?'}</span>}
              </span>
              <span className="set-photo-name">
                {match ? `#${checklistItemNumber(match)} ${match.name || match.subject || ''}` : check.readNumber ? `Read #${check.readNumber}` : 'No number read'}
              </span>
              <small>{[match ? itemTypeLabel(itemTypeNames, match) : '', match?.dynamic_fields?.collection, match?.dynamic_fields?.parallel].filter(Boolean).join(' · ') || (draft.recognition?.result?.subject || '')}</small>
              <span className={`set-photo-status ${tone}`}>{label}{confidence ? ` · ${confidence.score}%` : ''}</span>
              {warnings.length && tone !== 'done' ? <small className="set-photo-warning">{warnings[0]}</small> : null}
            </button>
          )
        })}
        {!tiles.length ? <p className="scan-mode-note">Every scan of this set is finished. Tick "Show finished" to see them.</p> : null}
      </div>
    </section>
  )
}

// The chosen set as stored on each scan (only when the picker is on and complete).
function activeSetTarget(value) {
  const target = value || {}
  if (!target.enabled || !target.categoryId || !target.subcategoryId || !(target.subsetId || target.propertyId || target.franchiseId)) return null
  if (target.category === 'Sports Cards' && (!(target.subsetId || target.propertyId) || !seasonKey(target.season))) return null
  const { enabled: _enabled, ...rest } = target
  return rest
}

function ScanIntake({ onCreateDraft, ai }) {
  const [category, setCategory] = useState(() => readScannerPref('category', 'Trading Cards'))
  const [mode, setMode] = useState(() => readScannerPref('mode', 'Create Catalogue Items'))
  // "Photograph a set": the set this stack comes from (see SetTargetPicker).
  const [setTarget, setSetTarget] = useState(() => readScannerPref('photoTarget', null))
  useEffect(() => { writeScannerPref('photoTarget', setTarget) }, [setTarget])
  const target = activeSetTarget(setTarget)
  useEffect(() => { writeScannerPref('category', category) }, [category])
  useEffect(() => { writeScannerPref('mode', mode) }, [mode])
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
    await ai.feeder.start({ category, mode, autoAnalyse: feedAutoAnalyse, loadFaceDown: feedFaceDown, target })
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
        ...(target ? { target } : {}),
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
      ...(target ? { target } : {}),
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
        <SetTargetPicker category={category} value={setTarget} onChange={setSetTarget} disabled={Boolean(busy) || feeding} />
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
        <ScanStorageSettings getReferenced={ai.referencedScanFiles} />
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

function formatStorageBytes(bytes) {
  if (bytes == null) return '—'
  const gb = bytes / (1024 ** 3)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.max(0, Math.round(bytes / (1024 ** 2)))} MB`
}

// Where scan images are saved, with a way to move them to another drive.
function ScanStorageSettings({ getReferenced = () => [] }) {
  const api = adminDesktopApi()
  const supported = typeof api.getScanStorage === 'function'
  const [info, setInfo] = useState(null)
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [unused, setUnused] = useState(null)

  async function checkUnused() {
    if (typeof api.unusedScans !== 'function') return
    try { setUnused(await api.unusedScans({ referencedNames: getReferenced() })) } catch { setUnused(null) }
  }

  useEffect(() => {
    if (!supported) return undefined
    api.getScanStorage().then(setInfo).catch(() => setInfo(null))
    checkUnused()
    return api.onMoveScansProgress?.((next) => setProgress(next))
  }, [])

  if (!supported) return null

  async function choose() {
    setBusy('choose')
    setError('')
    setMessage('')
    try {
      const next = await api.chooseScanStorage()
      setInfo(next)
      if (!next.canceled) setMessage(`New scans will be saved in ${next.dir}.`)
    } catch (chooseError) {
      setError(chooseError.message || 'Could not use that folder.')
    } finally {
      setBusy('')
    }
  }

  async function deleteUnused() {
    if (!unused?.files) return
    const confirmed = window.confirm(`Delete ${unused.files} scan file${unused.files === 1 ? '' : 's'} (${formatStorageBytes(unused.bytes)}) that no card uses? Cards in review and approved cards are not affected. This can't be undone.`)
    adminDesktopApi().refocusWindow?.()
    if (!confirmed) return
    setBusy('unused')
    setError('')
    setMessage('')
    try {
      const result = await api.unusedScans({ referencedNames: getReferenced(), remove: true })
      setMessage(`Deleted ${result.deleted} unused scan file${result.deleted === 1 ? '' : 's'}, freeing ${formatStorageBytes(result.freedBytes)}.`)
      setInfo(await api.getScanStorage())
      await checkUnused()
    } catch (unusedError) {
      setError(unusedError.message || 'Could not delete the unused files.')
    } finally {
      setBusy('')
    }
  }

  async function move() {
    setBusy('move')
    setError('')
    setMessage('')
    setProgress({ done: 0, total: info?.elsewhereFiles || 0 })
    try {
      const result = await api.moveScans()
      setInfo(result)
      setMessage(`Moved ${result.moved} scan file${result.moved === 1 ? '' : 's'} to ${result.dir}.${result.failed ? ` ${result.failed} could not be moved (they stay where they were and still work).` : ''}`)
    } catch (moveError) {
      setError(moveError.message || 'The move failed. Scans that were not moved still work from their old folder.')
    } finally {
      setBusy('')
      setProgress(null)
    }
  }

  return (
    <details className="scanner-calibration scan-storage">
      <summary>Scan image storage</summary>
      <div className="scan-storage-body">
        <p>
          Saving scans to <code>{info?.dir || '…'}</code>
          {info ? <> · {info.files} file{info.files === 1 ? '' : 's'}, {formatStorageBytes(info.bytes)} · {formatStorageBytes(info.freeBytes)} free on that drive</> : null}
        </p>
        {info?.elsewhereFiles ? (
          <p className="scan-mode-note">{info.elsewhereFiles} earlier scan file{info.elsewhereFiles === 1 ? '' : 's'} ({formatStorageBytes(info.elsewhereBytes)}) {info.elsewhereFiles === 1 ? 'is' : 'are'} still in a previous folder. They keep working there; move them to free up that drive.</p>
        ) : null}
        {unused?.files ? (
          <p className="scan-mode-note">{unused.files} scan file{unused.files === 1 ? '' : 's'} ({formatStorageBytes(unused.bytes)}) {unused.files === 1 ? "isn't" : "aren't"} used by any card (removed or declined cards, old versions from rotating or re-cropping, interrupted stacks).</p>
        ) : null}
        <div className="scan-storage-actions">
          <button type="button" onClick={choose} disabled={Boolean(busy)}>{busy === 'choose' ? 'Choosing…' : 'Change folder…'}</button>
          {unused?.files ? <button type="button" onClick={deleteUnused} disabled={Boolean(busy)}>{busy === 'unused' ? 'Deleting…' : `Delete unused files (${formatStorageBytes(unused.bytes)})`}</button> : null}
          {info?.elsewhereFiles ? (
            <button type="button" onClick={move} disabled={Boolean(busy)}>
              {busy === 'move' ? `Moving… ${progress?.done || 0} of ${progress?.total || info.elsewhereFiles}` : `Move ${info.elsewhereFiles} earlier scan${info.elsewhereFiles === 1 ? '' : 's'} here`}
            </button>
          ) : null}
        </div>
        {busy === 'move' && progress?.total ? (
          <div className="local-ai-progress">
            <div className="local-ai-progress-bar"><span style={{ width: `${Math.round(((progress.done || 0) / progress.total) * 100)}%` }} /></div>
            <small>Copying each file, checking it, then removing the original. Scanning can continue meanwhile.</small>
          </div>
        ) : null}
        {message ? <p className="admin-success">{message}</p> : null}
        {error ? <p className="admin-error">{error}</p> : null}
      </div>
    </details>
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

      {ai.reviewReadyCount ? (
        <div className="local-ai-review-ready">
          <span><strong>{ai.reviewReadyCount}</strong> card{ai.reviewReadyCount === 1 ? ' is' : 's are'} ready to review{analysis ? ' while the rest analyse' : ''}.</span>
          <button className="admin-gold-button" type="button" onClick={ai.onOpenReview}>Review now</button>
        </div>
      ) : null}

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
                    {draft.frontImage?.url ? <img src={thumbUrl(draft.frontImage.url)} alt="" loading="lazy" decoding="async" /> : <span />}
                    {draft.backImage?.url ? <img src={thumbUrl(draft.backImage.url)} alt="" loading="lazy" decoding="async" /> : <span />}
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

export function PendingReview({ cloud = null, drafts, onUpdateDraft, onDeleteDraft, onDeleteDrafts, onCreateMore, onRetryAi, aiBusy = false, queuedCount = 0 }) {
  const itemTypeNames = useItemTypeNames()
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
  const [deletingAll, setDeletingAll] = useState('')
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false)
  const [confirmText, setConfirmText] = useState('')
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
    const { taxonomy, scanAnalysis } = await analyseScanReading(draft, draft.recognition.result, { drafts })
    if (scanAnalysis.matchStatus !== draft.scanAnalysis?.matchStatus || scanAnalysis.bestMatch?.item?.item_id !== draft.scanAnalysis?.bestMatch?.item?.item_id) {
      await onUpdateDraft(draft.id, { scanAnalysis, status: scanAnalysis.status, recognition: { ...draft.recognition, taxonomy } })
    }
    return scanAnalysis.matchStatus === 'exact' && inDraftCategory(draft, scanAnalysis.bestMatch) ? scanAnalysis.bestMatch : null
  }

  const aiRows = rows.filter((draft) => draft.recognition?.status === 'done' && draft.status !== 'Rejected')
  const linkableCopies = aiRows.filter((draft) => catalogedSiblingOf(draft))
  const recheckable = aiRows.filter((draft) => draft.scanAnalysis?.matchStatus !== 'exact' && !catalogedSiblingOf(draft))
  const bulkRunning = Boolean(bulkWork && !bulkWork.finished)

  // ---- Already in catalogue: scans of cards the catalogue already has (with
  // photos) that also look like the item's photo are set aside from review,
  // into their own list to glance over and link in one go. See
  // alreadyInCatalogueMatch for the rule.
  const [reviewView, setReviewView] = useState('review')
  const photoCheckRef = useRef(false)
  const [photoCheckTick, setPhotoCheckTick] = useState(0)
  const setAsideMatch = (draft) => {
    const match = alreadyInCatalogueMatch(draft)
    return match && draft.catalogueCheck?.itemId === match.item.item_id && draft.catalogueCheck.similar ? match : null
  }
  const cataloguedRows = rows.filter((draft) => !catalogedSiblingOf(draft) && setAsideMatch(draft))
  const cataloguedIds = new Set(cataloguedRows.map((draft) => draft.id))
  const needsPhotoCheck = rows.filter((draft) => {
    const match = alreadyInCatalogueMatch(draft)
    return match && draft.catalogueCheck?.itemId !== match.item.item_id
  })
  useEffect(() => {
    if (photoCheckRef.current || !needsPhotoCheck.length) return
    const api = adminDesktopApi()
    if (typeof api.compareScanWithPhoto !== 'function') return
    photoCheckRef.current = true
    ;(async () => {
      try {
        // A few at a time; each finished check re-renders and the next batch follows.
        for (const draft of needsPhotoCheck.slice(0, 10)) {
          const match = alreadyInCatalogueMatch(draft)
          if (!match || !draft.frontImage) continue
          // No photo yet: it can't be compared, so it stays in review.
          const photoUrl = await catalogueFrontPhotoUrl(match.item.item_id).catch(() => '')
          const check = photoUrl ? await api.compareScanWithPhoto(draft.frontImage, photoUrl).catch(() => null) : { ok: false, message: 'The catalogue item has no photo yet' }
          await onUpdateDraft(draft.id, {
            catalogueCheck: { itemId: match.item.item_id, similar: Boolean(check?.ok && check.similar), overall: check?.overall ?? null, frame: check?.frame ?? null, error: check?.ok ? '' : check?.message || 'Could not compare', checkedAt: new Date().toISOString() },
          })
        }
      } finally {
        photoCheckRef.current = false
        setPhotoCheckTick((tick) => tick + 1)
      }
    })()
  }, [needsPhotoCheck.map((draft) => draft.id).join(','), photoCheckTick])

  async function linkCatalogued() {
    const targets = [...cataloguedRows]
    const outcome = await linkHighConfidence(targets, { quiet: true, attachImages: false })
    setBulkWork({ label: `Linked ${outcome.linked} card${outcome.linked === 1 ? '' : 's'} to the catalogue items they already match${outcome.failed ? `; ${outcome.failed} could not be linked` : ''}.`, finished: true })
    setReviewView('review')
  }

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
          const { taxonomy, scanAnalysis } = await analyseScanReading(draft, draft.recognition.result, { drafts })
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

  // ---- Confidence: score every analysed card, sort/filter by it, and act on
  // the confident ones in bulk.
  const [sortBy, setSortBy] = useState('confidence-desc')
  const [tierFilter, setTierFilter] = useState('all')
  // Find a card in the queue by name, number or set (every word must appear).
  const [reviewSearch, setReviewSearch] = useState('')
  const searchWords = reviewSearch.toLowerCase().split(/\s+/).filter(Boolean)
  const matchesSearch = (draft) => {
    if (!searchWords.length) return true
    const result = draft.recognition?.result || {}
    const values = draft.review?.values || {}
    const haystack = [scanDraftTitle(draft), result.subject, result.id_number, result.property, result.subfranchise, result.release_year, values.name, values.subject, values.card_number, values.collection, draft.scanAnalysis?.bestMatch?.item?.name]
      .filter(Boolean).join(' ').toLowerCase()
    return searchWords.every((word) => haystack.includes(word))
  }
  const [bulkAdd, setBulkAdd] = useState(null)
  const [setSetup, setSetSetup] = useState(null)
  const [checklistOpen, setChecklistOpen] = useState(false)

  const copiesByCard = new Map()
  ;(drafts || []).filter((draft) => draft.recognition?.result && draft.status !== 'Rejected').forEach((draft) => {
    const key = looseCardKey(draft.recognition.result)
    copiesByCard.set(key, [...(copiesByCard.get(key) || []), draft])
  })
  const confidenceById = new Map()
  for (const draft of rows) {
    if (draft.recognition?.status !== 'done') continue
    const sibling = catalogedSiblingOf(draft)
    confidenceById.set(draft.id, scanConfidence(draft, {
      copies: copiesByCard.get(looseCardKey(draft.recognition.result)) || [],
      exactMatch: sibling ? siblingMatch(sibling) : null,
    }))
  }
  const confidenceOf = (draft) => confidenceById.get(draft.id) || null
  const tierCounts = { high: 0, medium: 0, low: 0 }
  // A scan with no AI result has no confidence; skip it rather than break the whole queue.
  confidenceById.forEach((entry) => { if (entry?.tier in tierCounts) tierCounts[entry.tier] += 1 })

  const sortedRows = (reviewView === 'set' ? [] : reviewView === 'catalogued' ? cataloguedRows : rows.filter((draft) => !cataloguedIds.has(draft.id)))
    .filter((draft) => (tierFilter === 'all' || confidenceOf(draft)?.tier === tierFilter) && matchesSearch(draft))
    .sort((a, b) => {
      if (sortBy === 'newest') return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      const scoreA = confidenceOf(a)?.score ?? -1
      const scoreB = confidenceOf(b)?.score ?? -1
      return sortBy === 'confidence-asc' ? scoreA - scoreB : scoreB - scoreA
    })

  // A steady list while the AI is still finishing cards: the cards on screen
  // keep their places, and newly finished ones wait behind a "show" bar
  // instead of being slotted in among (or above) the ones being reviewed.
  // Changing the sort/filter or pressing Show re-sorts everything.
  const orderRef = useRef({ key: '', ids: [] })
  const [orderTick, setOrderTick] = useState(0)
  // Cards are shown a page at a time (each has two scans to draw).
  const REVIEW_PAGE = 40
  const [shownCount, setShownCount] = useState(REVIEW_PAGE)
  useEffect(() => { setShownCount(REVIEW_PAGE) }, [sortBy, tierFilter, reviewSearch])
  const orderKey = `${sortBy}|${tierFilter}|${reviewSearch}|${orderTick}`
  const sortedIds = sortedRows.map((draft) => draft.id)
  let displayRows = sortedRows
  let heldCount = 0
  if (orderRef.current.key !== orderKey || !orderRef.current.ids.length) {
    orderRef.current = { key: orderKey, ids: sortedIds }
  } else {
    const byId = new Map(sortedRows.map((draft) => [draft.id, draft]))
    const known = new Set(orderRef.current.ids)
    displayRows = orderRef.current.ids.filter((id) => byId.has(id)).map((id) => byId.get(id))
    heldCount = sortedIds.filter((id) => !known.has(id)).length
  }

  // Scored 100% with nothing left to decide: link or add.
  const perfectRows = aiRows.filter((draft) => confidenceOf(draft)?.score === 100 && ['link', 'add'].includes(confidenceOf(draft)?.readiness))
  const perfectWaitingForSet = aiRows.filter((draft) => confidenceOf(draft)?.score === 100 && confidenceOf(draft)?.readiness === 'needs-set').length

  // Approves the chosen cards in one go: exact matches are linked, new cards
  // added (see linkHighConfidence / addConfidentCards for the details).
  async function approveCards(ids) {
    const chosen = rows.filter((draft) => ids.includes(draft.id))
    const links = chosen.filter((draft) => confidenceOf(draft)?.readiness === 'link')
    const adds = chosen.filter((draft) => confidenceOf(draft)?.readiness === 'add')
    const linkResult = links.length ? await linkHighConfidence(links, { quiet: true }) : { linked: 0, failed: 0 }
    const addResult = adds.length ? await addConfidentCards(adds.map((draft) => draft.id), { quiet: true }) : { created: 0, linked: 0, problems: [] }
    const linked = linkResult.linked + addResult.linked
    const problems = linkResult.failed + addResult.problems.length
    setBulkWork({
      label: `Approved ${linked + addResult.created} card${linked + addResult.created === 1 ? '' : 's'}: ${addResult.created} added as new items, ${linked} linked to existing items${problems ? `. ${problems} need a look${addResult.problems.length ? `: ${addResult.problems.slice(0, 3).join('; ')}` : ''}` : '.'}`,
      finished: true,
    })
  }

  const highRows = aiRows.filter((draft) => confidenceOf(draft)?.tier === 'high')
  // Linking replaces the item's photos, so a match whose item already has one waits
  // for the photo check (same picture: "Already in catalogue"; different: held back).
  const photoChecked = (draft) => {
    const item = draft.scanAnalysis?.bestMatch?.item
    return !item?.image_path || draft.catalogueCheck?.itemId === item.item_id
  }
  const highLinks = highRows.filter((draft) => confidenceOf(draft)?.readiness === 'link' && photoChecked(draft))
  const highAdds = highRows.filter((draft) => confidenceOf(draft)?.readiness === 'add')

  // "Photograph a set" scans, by the set chosen at Scan Intake (newest set first).
  const setPhotoGroups = (() => {
    const byKey = new Map()
    for (const draft of rows) {
      if (draft.scanAnalysis?.source !== 'target-set' || !draft.target) continue
      const key = targetSetKey(draft.target)
      if (!byKey.has(key)) byKey.set(key, { key, target: draft.target, drafts: [] })
      byKey.get(key).drafts.push(draft)
    }
    return [...byKey.values()].map((group) => {
      const open = group.drafts.filter((draft) => !COMPLETED_SCAN_REVIEW_STATUSES.has(draft.status))
      const ready = open.filter((draft) => !cataloguedIds.has(draft.id) && confidenceOf(draft)?.tier === 'high' && confidenceOf(draft)?.readiness === 'link' && photoChecked(draft))
      return { ...group, open, ready, latest: group.drafts.reduce((latest, draft) => (String(draft.createdAt || '') > latest ? String(draft.createdAt) : latest), '') }
    }).sort((left, right) => right.latest.localeCompare(left.latest))
  })()
  const setPhotoCount = setPhotoGroups.reduce((sum, group) => sum + group.open.length, 0)

  // Cards whose set isn't in the catalogue yet, grouped by the set the AI
  // read (wording variants such as "Panini - Donruss" and "Panini Donruss"
  // are the same set).
  const setGroups = []
  {
    const byKey = new Map()
    for (const draft of aiRows) {
      if (confidenceOf(draft)?.readiness !== 'needs-set') continue
      const taxonomy = draft.recognition.taxonomy || {}
      const propertyText = taxonomy.unresolved?.property || draft.recognition.result.property || ''
      const key = [taxonomy.ids?.franchise_id || '', propertyText.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()].join('|')
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          label: propertyText.replace(/\s+-\s+/g, ' ').trim() || 'Unknown set',
          subsetText: taxonomy.unresolved?.subset || draft.recognition.result.subfranchise || '',
          taxonomy,
          drafts: [],
        })
      }
      byKey.get(key).drafts.push(draft)
    }
    setGroups.push(...[...byKey.values()].sort((a, b) => b.drafts.length - a.drafts.length))
  }

  // Applies a set chosen once to every card of a group.
  async function applySetToGroup(group, choice) {
    for (const draft of group.drafts) {
      const taxonomy = draft.recognition.taxonomy || {}
      await onUpdateDraft(draft.id, {
        recognition: {
          ...draft.recognition,
          taxonomy: {
            ...taxonomy,
            ids: { ...(taxonomy.ids || {}), subcategory_id: choice.subcategory.id, franchise_id: choice.franchise.id, subset_id: choice.subset.id, property_id: choice.property.id },
            names: { ...(taxonomy.names || {}), subcategory: choice.subcategory.name, franchise: choice.franchise.name, subset: choice.subset.name, property: choice.property.name },
            unresolved: {},
          },
        },
      })
    }
    setBulkWork({ label: `Set "${choice.property.name}" applied to ${group.drafts.length} card${group.drafts.length === 1 ? '' : 's'}.`, finished: true })
  }

  // Links the confident exact matches. A copy of a card added from this
  // queue keeps the first copy's photos; other matches get these scans.
  // attachImages: false for cards the catalogue already has photos of.
  async function linkHighConfidence(chosen = null, { quiet = false, attachImages = true } = {}) {
    const targets = [...(chosen || highLinks)]
    let done = 0
    let failed = 0
    setBulkWork({ label: 'Linking matches', done: 0, total: targets.length })
    for (const draft of targets) {
      const sibling = catalogedSiblingOf(draft)
      const match = sibling ? siblingMatch(sibling) : draft.scanAnalysis?.bestMatch
      const itemId = match?.item?.item_id
      if (!itemId) { failed += 1; continue }
      try {
        let attached = 0
        let warnings = []
        if (!sibling) {
          const images = attachImages ? await loadScanImageBlobs(draft) : []
          if (images.length) {
            const upload = await attachScanImagesToItem(itemId, images)
            attached = upload.attached
            warnings = upload.warnings || []
          }
          await completePlaceholderFromDraft(match.item, draft)
        }
        await onUpdateDraft(draft.id, {
          status: 'Matched',
          matchedItemId: itemId,
          imagesAttached: attached,
          analysisError: warnings.join(' '),
          audit: [...(draft.audit || []), { action: 'match', source: sibling ? 'queue-copy' : 'bulk-confident', itemId, images: attached, at: new Date().toISOString() }],
        })
      } catch {
        failed += 1
      }
      done += 1
      setBulkWork({ label: 'Linking matches', done, total: targets.length })
    }
    if (!quiet) setBulkWork({ label: `Linked ${done - failed} card${done - failed === 1 ? '' : 's'}${failed ? `; ${failed} could not be linked` : ''}.`, finished: true })
    return { linked: done - failed, failed }
  }

  // Adds the chosen confident new cards to the catalogue from their AI
  // reading, exactly as the review form would. A card that turns out to exist
  // (e.g. a copy added earlier in the same run) is linked instead.
  async function addConfidentCards(ids, { quiet = false } = {}) {
    const targets = rows.filter((draft) => ids.includes(draft.id))
    let created = 0
    let linked = 0
    const problems = []
    setBulkWork({ label: 'Adding cards to the catalogue', done: 0, total: targets.length })
    for (const [index, draft] of targets.entries()) {
      const category = draft.recognition.taxonomy?.category || draft.category
      const values = bulkReviewValues(draft, category)
      try {
        const found = await findSpecDuplicates({ category, values })
        if (found.length) {
          const itemId = found[0].item.item_id
          // A checklist placeholder for this card: fill it and give it the scans.
          if (isChecklistPlaceholder(found[0].item)) {
            await fillChecklistPlaceholder({ item: found[0].item, category, values })
            const images = await loadScanImageBlobs(draft)
            if (images.length) await attachScanImagesToItem(itemId, images)
          }
          await onUpdateDraft(draft.id, {
            category,
            status: 'Matched',
            matchedItemId: itemId,
            audit: [...(draft.audit || []), { action: 'match', source: 'bulk-add-duplicate', itemId, at: new Date().toISOString() }],
          })
          linked += 1
        } else {
          const images = await loadScanImageBlobs(draft)
          const item = await createCatalogueItemFromReview({ category, values, confidence: confidenceOf(draft)?.score ?? null, images })
          await onUpdateDraft(draft.id, {
            category,
            status: 'Catalogue Item Created',
            createdItemId: item?.item_id || null,
            imagesAttached: uploadedCount(images, item?.warnings),
            analysisError: item?.warnings?.length ? item.warnings.join(' ') : '',
            review: { category, values, matchId: '', attachImages: true, savedAt: new Date().toISOString() },
            audit: [...(draft.audit || []), { action: 'create', source: 'bulk-confident', itemId: item?.item_id, images: images.length, at: new Date().toISOString() }],
          })
          created += 1
        }
      } catch (error) {
        problems.push(`${draft.recognition.result.subject || 'Card'}: ${error.message || 'could not be added'}`)
      }
      setBulkWork({ label: 'Adding cards to the catalogue', done: index + 1, total: targets.length })
    }
    if (!quiet) {
      setBulkWork({
        label: `Added ${created} new item${created === 1 ? '' : 's'}${linked ? `, linked ${linked} that already existed` : ''}${problems.length ? `. ${problems.length} need a look: ${problems.slice(0, 3).join('; ')}` : '.'}`,
        finished: true,
      })
    }
    return { created, linked, problems }
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
        <div className="review-header-actions">
          {onDeleteDrafts ? (
            <button className="danger" type="button" disabled={!rows.length || Boolean(deletingAll)} onClick={() => { setConfirmText(''); setConfirmingDeleteAll(true) }}>
              {deletingAll && deletingAll.startsWith('Deleting') ? deletingAll : `Delete all pending (${rows.length})`}
            </button>
          ) : null}
          <button className="admin-gold-button" type="button" onClick={onCreateMore}>Scan New Item</button>
        </div>
      </div>
      {confirmingDeleteAll ? (
        <form className="review-delete-all" onSubmit={async (event) => {
          event.preventDefault()
          if (confirmText.trim().toUpperCase() !== 'DELETE') return
          const ids = rows.map((draft) => draft.id)
          setConfirmingDeleteAll(false)
          setDeletingAll(`Deleting ${ids.length}…`)
          try {
            const removed = await onDeleteDrafts(ids)
            setDeletingAll(`Deleted ${removed} pending scan${removed === 1 ? '' : 's'}.`)
          } catch (error) {
            setDeletingAll(`Couldn't delete them: ${error?.message || error}`)
          }
          setTimeout(() => setDeletingAll(''), 5000)
        }}>
          <p>
            <strong>Delete all {rows.length} pending scan{rows.length === 1 ? '' : 's'} from the review queue?</strong>
            <span>Cards already added or linked to the catalogue, and cards still waiting for AI, aren't affected. This can't be undone.</span>
          </p>
          <label>Type DELETE to confirm <input autoFocus value={confirmText} onChange={(event) => setConfirmText(event.target.value)} /></label>
          <button className="danger" type="submit" disabled={confirmText.trim().toUpperCase() !== 'DELETE'}>Delete {rows.length}</button>
          <button type="button" onClick={() => setConfirmingDeleteAll(false)}>Cancel</button>
        </form>
      ) : null}
      {deletingAll && !deletingAll.startsWith('Deleting') ? <div className="review-queue-note"><span>{deletingAll}</span></div> : null}
      {queuedCount ? (
        <div className="review-queue-note">
          <span>{queuedCount} scanned card{queuedCount === 1 ? ' is' : 's are'} waiting in the Scan Intake queue for analysis.</span>
          <button type="button" onClick={onCreateMore}>Open Scan Queue</button>
        </div>
      ) : null}
      {cloud ? (
        <div className={`cloud-review-bar${cloud.available === false ? ' off' : ''}`}>
          {cloud.available === false ? (
            <span>Cloud review queue is not set up yet (run supabase/scan_review_queue.sql in Supabase). Reviews stay on this computer.</span>
          ) : (
            <>
              <span>
                <strong>Cloud review queue</strong>
                {cloud.syncing ? ' · uploading…' : cloud.lastSync ? ` · synced ${new Date(cloud.lastSync).toLocaleTimeString()}` : ' · connecting…'}
                {cloud.error ? <em> · {cloud.error}</em> : null}
              </span>
              <button type="button" onClick={cloud.onRefresh}>Refresh</button>
              {cloud.pendingUpload ? <button type="button" onClick={cloud.onUploadExisting} title="Upload cards scanned before the cloud queue was turned on, so they can be reviewed on other computers">Upload {cloud.pendingUpload} earlier card{cloud.pendingUpload === 1 ? '' : 's'}</button> : null}
            </>
          )}
        </div>
      ) : null}
      {aiRows.length || orientationTargets.length || setGroups.length ? (
        <div className="review-bulk-bar">
          <button type="button" onClick={() => setChecklistOpen(true)} title="Create placeholders for every card in a set, filled in as you scan them">Import set checklist</button>
          {perfectRows.length ? (
            <button className="admin-gold-button review-approve-perfect" type="button" onClick={() => setBulkAdd({ ids: perfectRows.map((draft) => draft.id), mode: 'approve' })} disabled={bulkRunning} title={perfectWaitingForSet ? `${perfectWaitingForSet} more 100% card${perfectWaitingForSet === 1 ? '' : 's'} need their set set up first` : 'Link exact matches and add new cards, after a quick look at the thumbnails'}>
              Approve all 100% ({perfectRows.length})
            </button>
          ) : perfectWaitingForSet ? <span className="review-bulk-copies">{perfectWaitingForSet} card{perfectWaitingForSet === 1 ? '' : 's'} at 100% need their set set up before they can be approved.</span> : null}
          {highLinks.length ? <button className="admin-gold-button" type="button" onClick={() => linkHighConfidence()} disabled={bulkRunning}>Link {highLinks.length} high-confidence match{highLinks.length === 1 ? '' : 'es'}</button> : null}
          {highAdds.length ? <button className="admin-gold-button" type="button" onClick={() => setBulkAdd({ ids: highAdds.map((draft) => draft.id) })} disabled={bulkRunning}>Add {highAdds.length} high-confidence new card{highAdds.length === 1 ? '' : 's'}…</button> : null}
          {setGroups.map((group) => (
            <span className="review-set-group" key={group.key}>
              <span><strong>{group.drafts.length}</strong> need the set <em>{group.label}</em></span>
              <button type="button" onClick={() => setSetSetup(group)} disabled={bulkRunning}>Set up set</button>
            </span>
          ))}
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
      {cataloguedRows.length || setPhotoGroups.length || reviewView !== 'review' ? (
        <div className="review-view-tabs" role="tablist" aria-label="Review lists">
          <button type="button" role="tab" aria-selected={reviewView === 'review'} className={reviewView === 'review' ? 'active' : ''} onClick={() => setReviewView('review')}>To review ({rows.length - cataloguedRows.length})</button>
          <button type="button" role="tab" aria-selected={reviewView === 'catalogued'} className={reviewView === 'catalogued' ? 'active' : ''} onClick={() => setReviewView('catalogued')}>Already in catalogue ({cataloguedRows.length})</button>
          {setPhotoGroups.length || reviewView === 'set' ? <button type="button" role="tab" aria-selected={reviewView === 'set'} className={reviewView === 'set' ? 'active' : ''} onClick={() => setReviewView('set')}>Photograph a set ({setPhotoCount})</button> : null}
        </div>
      ) : null}
      {reviewView === 'set' ? (
        setPhotoGroups.length ? setPhotoGroups.map((group) => (
          <SetPhotoGroup
            key={group.key}
            group={group}
            confidenceOf={confidenceOf}
            itemTypeNames={itemTypeNames}
            alreadyPhotographed={cataloguedIds}
            busy={bulkRunning}
            onOpen={(draft) => setReviewDraftId(draft.id)}
            onAttach={(drafts) => linkHighConfidence(drafts)}
          />
        )) : <EmptyAdminState text={'No scans from "Photograph a set" yet. Turn it on in Scan Intake, choose the set, and scan its cards.'} />
      ) : null}
      {reviewView === 'catalogued' ? (
        <div className="review-catalogued-bar">
          <span>These scans exactly match a catalogue item that already has photos, and look the same as its photo. Linking records them against that item without adding more photos. Anything that looks off: open it and edit, and it goes back to the review list.</span>
          <button className="admin-gold-button" type="button" onClick={linkCatalogued} disabled={!cataloguedRows.length || bulkRunning}>Link all {cataloguedRows.length}</button>
        </div>
      ) : null}
      {confidenceById.size ? (
        <div className="review-confidence-bar">
          <div className="review-tier-filter" role="radiogroup" aria-label="Confidence">
            {[['all', `All (${rows.length})`], ['high', `High (${tierCounts.high})`], ['medium', `Medium (${tierCounts.medium})`], ['low', `Low (${tierCounts.low})`]].map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={tierFilter === id} className={`tier-${id}${tierFilter === id ? ' active' : ''}`} onClick={() => setTierFilter(id)}>{label}</button>
            ))}
          </div>
          <label className="review-search">
            <Search size={15} />
            <input type="search" value={reviewSearch} onChange={(event) => setReviewSearch(event.target.value)} placeholder="Find a card: name, number or set" aria-label="Find a card in the queue" />
          </label>
          <label className="review-sort">Sort
            <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
              <option value="confidence-desc">Highest confidence first</option>
              <option value="confidence-asc">Lowest confidence first</option>
              <option value="newest">Newest first</option>
            </select>
          </label>
        </div>
      ) : null}
      {heldCount ? (
        <div className="review-new-cards">
          <span><strong>{heldCount}</strong> more card{heldCount === 1 ? ' has' : 's have'} finished analysing.</span>
          <button type="button" onClick={() => setOrderTick((tick) => tick + 1)}>Show {heldCount === 1 ? 'it' : 'them'}</button>
        </div>
      ) : null}
      {searchWords.length && !displayRows.length ? <p className="scan-mode-note">No cards in the queue match "{reviewSearch}".</p> : null}
      <div className="review-draft-list">
        {displayRows.slice(0, shownCount).map((draft) => {
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
                confidence={confidenceOf(draft)}
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
              {draft.frontImage?.url ? <img src={thumbUrl(draft.frontImage.url)} alt="" loading="lazy" decoding="async" /> : <span>Front</span>}
              {draft.backImage?.url ? <img src={thumbUrl(draft.backImage.url)} alt="" loading="lazy" decoding="async" /> : <span>Back</span>}
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
                        <span>{[bestMatch.item?.name || bestMatch.item?.subject || bestMatch.item?.item_id, bestMatch.item?.card_number ? `#${bestMatch.item.card_number}` : '', itemTypeLabel(itemTypeNames, bestMatch.item)].filter(Boolean).join(' · ')} · {bestMatch.score}% match</span>
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
      {displayRows.length > shownCount ? (
        <div className="review-show-more">
          <span>Showing {shownCount} of {displayRows.length} cards</span>
          <button type="button" onClick={() => setShownCount((count) => count + REVIEW_PAGE)}>Show {Math.min(REVIEW_PAGE, displayRows.length - shownCount)} more</button>
        </div>
      ) : null}
      {bulkAdd ? (
        <BulkAddDialog
          drafts={rows.filter((draft) => bulkAdd.ids.includes(draft.id))}
          confidenceOf={confidenceOf}
          onClose={() => setBulkAdd(null)}
          mode={bulkAdd.mode || 'add'}
          onConfirm={(ids) => {
            const mode = bulkAdd.mode
            setBulkAdd(null)
            if (mode === 'approve') approveCards(ids)
            else addConfidentCards(ids)
          }}
        />
      ) : null}
      {setSetup ? (
        <SetSetupDialog
          group={setSetup}
          onClose={() => setSetSetup(null)}
          onApply={async (choice) => { const group = setSetup; setSetSetup(null); await applySetToGroup(group, choice) }}
        />
      ) : null}
      {checklistOpen ? <ChecklistImportDialog onClose={() => setChecklistOpen(false)} /> : null}
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

// Catalogue values for a card added in bulk: the AI reading as the review
// form would fill it, with the taxonomy the AI's set resolved to (or the set
// chosen for its group).
function bulkReviewValues(draft, category) {
  const ids = draft.recognition?.taxonomy?.ids || {}
  const values = initialReviewValues(draft, category, null)
  reviewFields(category).forEach((field) => {
    if (field.taxonomy) values[field.key] = ids[field.key] || ''
  })
  return values
}

// Taxonomy names compared loosely: case, punctuation and maker names
// ("Panini", "Topps"...) aside. Exact first, then one containing the other.
function looseTaxonomyName(value) {
  return String(value || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word && !['panini', 'topps', 'upper', 'deck', 'the'].includes(word))
    .join(' ')
}

function closestTaxonomyOption(options, text) {
  const wanted = looseTaxonomyName(text)
  if (!wanted) return null
  return options.find((option) => looseTaxonomyName(option.name) === wanted)
    || options.find((option) => {
      const name = looseTaxonomyName(option.name)
      return name && (name.includes(wanted) || wanted.includes(name))
    })
    || null
}

// Spot-check before adding confident cards in bulk: untick anything that
// looks wrong (it stays in the queue).
function BulkAddDialog({ drafts, confidenceOf, onClose, onConfirm, mode = 'add' }) {
  const approving = mode === 'approve'
  const [selected, setSelected] = useState(() => new Set(drafts.map((draft) => draft.id)))
  const toggle = (id) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  return (
    <div className="register-modal bulk-add-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-add-title">
      <section>
        <div className="bulk-add-head">
          <div>
            <p className="admin-kicker">{approving ? 'Quick approve' : 'Add to catalogue'}</p>
            <h2 id="bulk-add-title">{approving ? `Approve ${selected.size} card${selected.size === 1 ? '' : 's'} scored 100%` : `Add ${selected.size} high-confidence card${selected.size === 1 ? '' : 's'}`}</h2>
            <small>{approving
              ? 'Exact matches are linked to their catalogue item; new cards become catalogue items from their AI reading, with their scans as photos. Untick anything that looks wrong; it stays in the queue.'
              : 'Each becomes a catalogue item from its AI reading, with its scans as photos. Cards that already exist are linked instead. Untick anything that looks wrong; it stays in the queue.'}</small>
          </div>
          <div className="bulk-add-select">
            <button type="button" onClick={() => setSelected(new Set(drafts.map((draft) => draft.id)))}>Select all</button>
            <button type="button" onClick={() => setSelected(new Set())}>Select none</button>
          </div>
        </div>
        <div className="bulk-add-grid">
          {drafts.map((draft) => {
            const result = draft.recognition.result
            const on = selected.has(draft.id)
            return (
              <label key={draft.id} className={`bulk-add-card${on ? '' : ' off'}`}>
                <input type="checkbox" checked={on} onChange={() => toggle(draft.id)} />
                {draft.frontImage?.url ? <img src={thumbUrl(draft.frontImage.url)} alt="" loading="lazy" decoding="async" /> : <span className="bulk-add-noimage" />}
                <strong>{result.subject}</strong>
                <small>#{String(result.id_number || '').replace(/^(no\.?|#)\s*/i, '')} · {result.release_year}</small>
                <small>{[result.team, result.collection, result.parallel].filter(Boolean).join(' · ')}</small>
                <small className={`confidence-chip tier-${confidenceOf(draft)?.tier}`}>{confidenceOf(draft)?.score}%</small>
              </label>
            )
          })}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="update-prompt-primary" type="button" disabled={!selected.size} onClick={() => onConfirm([...selected])}>{approving ? 'Approve' : 'Add'} {selected.size} card{selected.size === 1 ? '' : 's'}</button>
        </div>
      </section>
    </div>
  )
}

// Chooses (or creates) the catalogue product line and set for a group of
// cards whose set the catalogue doesn't have yet, once for the whole group.
function SetSetupDialog({ group, onClose, onApply }) {
  const taxonomy = group.taxonomy || {}
  const ids = taxonomy.ids || {}
  const unresolved = taxonomy.unresolved || {}
  const trading = taxonomy.category === 'Trading Cards'
  const NEW = '__new__'
  // Each level: the chosen option id (or NEW), and the name for a new one.
  const LEVELS = [
    { level: 'subcategory', label: trading ? 'Subcategory (brand)' : 'Subcategory (sport)', text: unresolved.subcategory || taxonomy.names?.subcategory || '' },
    { level: 'franchise', label: trading ? 'Franchise' : 'Franchise (league)', text: unresolved.franchise || taxonomy.names?.franchise || '' },
    { level: 'subset', label: trading ? 'Subfranchise (era / storyline)' : 'Product line (subfranchise)', text: unresolved.subset || group.subsetText || '' },
    // Sports sets are named without their season (it's its own field).
    { level: 'property', label: trading ? 'Property (release)' : 'Set (property)', text: trading ? unresolved.property || group.label || '' : withoutSeason(unresolved.property || group.label || '') },
  ]
  const [chosen, setChosen] = useState(() => ({
    subcategory: ids.subcategory_id || '',
    franchise: ids.franchise_id || '',
    subset: ids.subset_id || '',
    property: '',
  }))
  const [names, setNames] = useState(() => Object.fromEntries(LEVELS.map((entry) => [entry.level, entry.text])))
  const [options, setOptions] = useState({ subcategory: [], franchise: [], subset: [], property: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const real = (id) => (id && id !== NEW ? id : '')

  useEffect(() => {
    let cancelled = false
    loadCatalogueTaxonomyOptions({ categoryId: taxonomy.categoryId, subcategoryId: real(chosen.subcategory), franchiseId: real(chosen.franchise), subsetId: real(chosen.subset) })
      .then((next) => {
        if (cancelled) return
        setOptions({ subcategory: next.subcategory || [], franchise: next.franchise || [], subset: next.subset || [], property: next.property || [] })
        // Fill each undecided level whose parent is decided: an existing
        // option close to the AI's wording, else "new" (so nothing is created
        // twice under a slightly different name).
        setChosen((current) => {
          const result = { ...current }
          const parentDecided = { subcategory: true, franchise: Boolean(result.subcategory), subset: Boolean(result.franchise), property: Boolean(result.subset) }
          for (const entry of LEVELS) {
            if (result[entry.level] || !parentDecided[entry.level]) continue
            const list = { subcategory: next.subcategory, franchise: next.franchise, subset: next.subset, property: next.property }[entry.level] || []
            // Only fill one level per load: the next level needs this one's options.
            result[entry.level] = closestTaxonomyOption(list, entry.text)?.id || NEW
            break
          }
          return result
        })
      })
      .catch((loadError) => { if (!cancelled) setError(loadError.message || 'Could not load the catalogue taxonomy.') })
    return () => { cancelled = true }
  }, [chosen.subcategory, chosen.franchise, chosen.subset])

  function choose(level, value) {
    const order = ['subcategory', 'franchise', 'subset', 'property']
    setChosen((current) => {
      const next = { ...current, [level]: value }
      // Changing a level resets the levels under it.
      order.slice(order.indexOf(level) + 1).forEach((child) => { next[child] = '' })
      return next
    })
  }

  async function apply() {
    setBusy(true)
    setError('')
    try {
      const category = taxonomy.category || 'Sports Cards'
      const pick = (level) => options[level].find((option) => option.id === chosen[level])
      const subcategory = chosen.subcategory === NEW ? await createTaxonomyOption('subcategory', names.subcategory, { category }) : pick('subcategory')
      if (!subcategory) throw new Error('Choose a subcategory.')
      const franchise = chosen.franchise === NEW ? await createTaxonomyOption('franchise', names.franchise, { category, subcategoryId: subcategory.id }) : pick('franchise')
      if (!franchise) throw new Error('Choose a franchise.')
      const subset = chosen.subset === NEW ? await createTaxonomyOption('subset', names.subset, { category, subcategoryId: subcategory.id, franchiseId: franchise.id }) : pick('subset')
      if (!subset) throw new Error('Choose a subfranchise.')
      const property = chosen.property === NEW ? await createTaxonomyOption('property', names.property, { category, subcategoryId: subcategory.id, franchiseId: franchise.id, subsetId: subset.id }) : pick('property')
      if (!property) throw new Error('Choose a property.')
      await onApply({ subcategory, franchise, subset, property })
    } catch (applyError) {
      setError(applyError.message || 'Could not set up the set.')
      setBusy(false)
    }
  }

  const ready = LEVELS.every((entry) => chosen[entry.level] && (chosen[entry.level] !== NEW || String(names[entry.level] || '').trim()))
  return (
    <div className="register-modal set-setup-modal" role="dialog" aria-modal="true" aria-labelledby="set-setup-title">
      <section>
        <p className="admin-kicker">Set up a set · {group.drafts.length} card{group.drafts.length === 1 ? '' : 's'}</p>
        <h2 id="set-setup-title">{group.label}</h2>
        <small>{taxonomy.category || 'Catalogue'} · choose each level once for all these cards. Existing entries with similar names are picked automatically.</small>
        {LEVELS.map((entry, index) => {
          const parentReady = index === 0 || Boolean(chosen[LEVELS[index - 1].level])
          const parentIsNew = index > 0 && LEVELS.slice(0, index).some((parent) => chosen[parent.level] === NEW)
          return (
            <React.Fragment key={entry.level}>
              <label>{entry.label}
                <select value={chosen[entry.level]} onChange={(event) => choose(entry.level, event.target.value)} disabled={busy || !parentReady}>
                  <option value="">—</option>
                  {!parentIsNew ? options[entry.level].map((option) => <option key={option.id} value={option.id}>{option.name}</option>) : null}
                  <option value={NEW}>+ New {entry.label.split(' (')[0].toLowerCase()}…</option>
                </select>
              </label>
              {chosen[entry.level] === NEW ? (
                <input value={names[entry.level]} onChange={(event) => setNames((current) => ({ ...current, [entry.level]: event.target.value }))} placeholder={entry.text || 'Name'} disabled={busy} />
              ) : null}
            </React.Fragment>
          )
        })}
        {error ? <p className="admin-error">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="update-prompt-primary" type="button" onClick={apply} disabled={busy || !ready}>{busy ? 'Saving…' : `Use for ${group.drafts.length} card${group.drafts.length === 1 ? '' : 's'}`}</button>
        </div>
      </section>
    </div>
  )
}

const CONFIDENCE_READINESS_TEXT = {
  link: 'Ready to link to the catalogue',
  add: 'Ready to add as a new item',
  'needs-set': 'Needs its set set up',
  check: 'Compare with a similar item',
}

// What each spreadsheet column fills in (checklist import).
const CHECKLIST_COLUMN_LABELS = {
  number: 'number', name: 'name', team: 'team', collection: 'Collection', parallel: 'parallel', serial: 'print run',
  rookie: 'rookie', shortPrint: 'short print', sets: 'in sets', subcategory: 'Subcategory', franchise: 'Franchise / Theme',
  subset: 'Subfranchise / Subtheme', property: 'Property', series: 'Series', year: 'Year', season: 'Season',
  item_type: 'Item Type', publisher: 'Publisher',
}

// Set checklist import: choose a set, paste its checklist, preview against
// what the catalogue already has, and create placeholders for the rest.
function ChecklistImportDialog({ onClose }) {
  const [categories, setCategories] = useState([])
  const [category, setCategory] = useState('Sports Cards')
  const [chosen, setChosen] = useState({ subcategory_id: '', franchise_id: '', subset_id: '', property_id: '', item_type_id: '', publisher_id: '' })
  const [options, setOptions] = useState({})
  const [releaseYear, setReleaseYear] = useState('')
  // Sports cards: the season (2023-24, or 2024), in place of the release year.
  const [season, setSeason] = useState('')
  // Collection for lines that don't name their own (e.g. a numbered insert set).
  const [collection, setCollection] = useState('')
  const [text, setText] = useState('')
  const [existing, setExisting] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const categoryRow = categories.find((row) => row.name === category)
  // Sports Cards list a team and pick a season; every other category is
  // number + name with a release year (Trading Cards, comics, LEGO, ...).
  const trading = category !== 'Sports Cards'
  const cards = category === 'Sports Cards' || category === 'Trading Cards'
  // LEGO: lines (or the In set box) can name the sets each item comes in.
  const lego = /lego|building block/i.test(category)
  const [inSetText, setInSetText] = useState('')
  const [seriesText, setSeriesText] = useState('')
  const inSets = lego ? parseSetRefs(inSetText) : []
  // A spreadsheet with a header row can name each line's set (Theme, Subtheme, Year…),
  // so one paste covers many sets; plain lines all go to the set chosen above.
  const table = useMemo(() => parseChecklistTable(text), [text])
  const rows = useMemo(() => (table ? table.rows : parseChecklist(text, { teams: !trading, sets: lego }))
    .map((row) => (row.error || row.collection ? row : { ...row, collection: collection.trim() })), [text, table, trading, lego, collection])
  const good = useMemo(() => rows.filter((row) => !row.error), [rows])
  const bad = useMemo(() => rows.filter((row) => row.error), [rows])

  // Spreadsheet mode: the sets the rows belong to (blank cells use the choices above).
  const optionName = (key, id) => (options[key] || []).find((option) => option.id === id)?.name || ''
  const tableGroups = useMemo(() => (table ? groupChecklistRows(good, {
    ids: { subcategory: chosen.subcategory_id, franchise: chosen.franchise_id, subset: chosen.subset_id, property: chosen.property_id, item_type: chosen.item_type_id, publisher: chosen.publisher_id },
    names: { subcategory: optionName('subcategory', chosen.subcategory_id), franchise: optionName('franchise', chosen.franchise_id), subset: optionName('subset', chosen.subset_id), property: optionName('property', chosen.property_id), item_type: optionName('item_type', chosen.item_type_id), publisher: optionName('publisher', chosen.publisher_id) },
    year: trading ? releaseYear : '',
    season: trading ? '' : season,
    series: categoryHasSeries(category) ? seriesText : '',
  }) : []), [table, good, chosen, options, releaseYear, season, seriesText, trading, category])
  // Per set, after "Check": { [key]: { ids, missing, existing, error } }.
  const [groupChecks, setGroupChecks] = useState(null)
  useEffect(() => { setGroupChecks(null) }, [tableGroups])
  // Enough of a set to find its cards: LEGO a Theme or Property; cards a product
  // line or set under the Franchise; sports a season too; and an Item Type.
  const groupProblem = (spec) => {
    if (!spec.subcategory) return 'Needs a Subcategory'
    if (lego ? !(spec.property || spec.franchise) : !(spec.franchise && (spec.subset || spec.property))) return lego ? 'Needs a Theme or Property' : 'Needs a Franchise and a Subfranchise or Property'
    if (!trading && !seasonKey(spec.season)) return 'Needs a Season'
    if (!spec.item_type) return 'Needs an Item Type'
    return ''
  }
  const groupIdsFor = (ids) => ({ subcategory_id: ids.subcategory || '', franchise_id: ids.franchise || '', subset_id: ids.subset || '', property_id: ids.property || '', item_type_id: ids.item_type || '', publisher_id: ids.publisher || '' })

  async function checkGroups({ preserveResult = false } = {}) {
    if (!categoryRow) return
    setBusy('check')
    setError('')
    if (!preserveResult) setResult(null)
    const cache = new Map()
    const checks = {}
    try {
      for (const [index, group] of tableGroups.entries()) {
        setBusy(`check:${index + 1}/${tableGroups.length}`)
        try {
          const problem = groupProblem(group.spec)
          if (problem) { checks[group.key] = { error: problem }; continue }
          const { ids, missing } = await resolveChecklistGroup({ category, categoryId: categoryRow.category_id, spec: group.spec, cache })
          // A set level that doesn't exist yet: none of its cards can be in the catalogue.
          const existingItems = missing.some((entry) => ['subcategory', 'franchise', 'subset', 'property', 'item_type'].includes(entry.level)) ? [] : await loadSetItems({
            categoryId: categoryRow.category_id, subcategoryId: ids.subcategory, franchiseId: ids.franchise, subsetId: ids.subset, propertyId: ids.property,
            itemTypeId: ids.item_type, releaseYear: trading ? group.spec.year : '', season: trading ? '' : group.spec.season,
          })
          checks[group.key] = { ids, missing, existing: existingItems }
        } catch (checkError) {
          checks[group.key] = { error: checkError.message || 'Could not check this set.' }
        }
      }
      setGroupChecks(checks)
    } catch (checkError) {
      setError(checkError.message || 'Could not check the sets.')
    } finally {
      setBusy('')
    }
  }

  async function createGroups() {
    if (!categoryRow || !groupChecks) return
    setBusy('create')
    setError('')
    const cache = new Map()
    const totals = { created: [], skipped: 0, linked: 0, missingSets: [], sets: 0, problems: [] }
    try {
      const ready = tableGroups.filter((group) => groupChecks[group.key] && !groupChecks[group.key].error)
      for (const [index, group] of ready.entries()) {
        setBusy(`create:${index + 1}/${ready.length}`)
        try {
          const { ids } = await resolveChecklistGroup({ category, categoryId: categoryRow.category_id, spec: group.spec, create: true, cache })
          const outcome = await createChecklistPlaceholders({
            category, ids: groupIdsFor(ids), itemTypeName: group.spec.item_type?.name || '',
            releaseYear: trading ? group.spec.year : '', season: trading ? '' : group.spec.season,
            series: categoryHasSeries(category) ? group.spec.series : '',
            rows: group.rows, existing: groupChecks[group.key].existing || [], inSets,
          })
          totals.created.push(...outcome.created)
          totals.skipped += outcome.skipped || 0
          totals.linked += outcome.linked || 0
          totals.missingSets.push(...(outcome.missingSets || []))
          totals.sets += 1
        } catch (groupError) {
          totals.problems.push(`${checklistGroupLabel(group.spec)}: ${groupError.message || 'failed'}`)
        }
      }
      totals.missingSets = [...new Set(totals.missingSets)]
      setResult(totals)
      await checkGroups({ preserveResult: true })
    } catch (createError) {
      setError(createError.message || 'Could not create the placeholders.')
    } finally {
      setBusy('')
    }
  }

  const groupCounts = (group) => {
    const check = groupChecks?.[group.key]
    if (!check || check.error) return null
    const byKey = new Map((check.existing || []).map((item) => [checklistItemKey({ number: checklistItemNumber(item), collection: item.dynamic_fields?.collection, parallel: item.dynamic_fields?.parallel }), item]))
    const counts = { new: 0, placeholder: 0, scanned: 0 }
    group.rows.forEach((row) => {
      const item = byKey.get(checklistItemKey(row))
      counts[!item ? 'new' : isChecklistPlaceholder(item) ? 'placeholder' : 'scanned'] += 1
    })
    return counts
  }
  const tableTotals = tableGroups.reduce((sum, group) => {
    const counts = groupCounts(group)
    const check = groupChecks?.[group.key]
    if (counts) sum.new += counts.new
    if (check?.missing?.length) sum.taxonomy += check.missing.length
    if (check?.error) sum.blocked += 1
    if (lego && check && !check.error) sum.links += group.rows.filter((row) => row.sets?.length || inSets.length).length
    return sum
  }, { new: 0, taxonomy: 0, blocked: 0, links: 0 })

  useEffect(() => {
    loadAdminCategories().then((list) => setCategories(list)).catch(() => setCategories([]))
  }, [])

  useEffect(() => {
    if (!categoryRow) return undefined
    let cancelled = false
    loadCatalogueTaxonomyOptions({ categoryId: categoryRow.category_id, subcategoryId: chosen.subcategory_id, franchiseId: chosen.franchise_id, subsetId: chosen.subset_id })
      .then((next) => {
        if (cancelled) return
        setOptions(next)
        // Item type defaults to "Card".
        if (!chosen.item_type_id) {
          const card = (next.item_type || []).find((option) => option.name.toLowerCase() === 'card')
          if (card) setChosen((current) => (current.item_type_id ? current : { ...current, item_type_id: card.id }))
        }
      })
      .catch((loadError) => { if (!cancelled) setError(loadError.message || 'Could not load the catalogue taxonomy.') })
    return () => { cancelled = true }
  }, [categoryRow?.category_id, chosen.subcategory_id, chosen.franchise_id, chosen.subset_id])

  function choose(key, value) {
    const children = taxonomyChildren(key, category, { subcategory_id: ['franchise_id', 'subset_id', 'property_id', 'item_type_id'], franchise_id: ['subset_id', 'property_id'], subset_id: ['property_id'] })
    setChosen((current) => {
      const next = { ...current, [key]: value }
      children.forEach((child) => { next[child] = '' })
      return next
    })
    setExisting(null)
    setResult(null)
    if (key === 'property_id') {
      // Older sets still named with their year/season.
      const name = (options.property || []).find((option) => option.id === value)?.name || ''
      if (seasonKey(name)) { setSeason(seasonKey(name)); setReleaseYear(String(seasonStartYear(name))) }
    }
  }

  // Sports sets span seasons: the season picks one year's cards.
  // LEGO: a Property (under the Subcategory) is enough on its own.
  const setChosenEnough = Boolean(chosen.subcategory_id && (lego ? chosen.property_id || (chosen.franchise_id && chosen.subset_id) : chosen.franchise_id && (chosen.subset_id || chosen.property_id)) && (trading || seasonKey(season)))

  async function checkSet() {
    setBusy('check')
    setError('')
    try {
      setExisting(await loadSetItems({ categoryId: categoryRow.category_id, subcategoryId: chosen.subcategory_id, franchiseId: chosen.franchise_id, subsetId: chosen.subset_id, propertyId: chosen.property_id, itemTypeId: chosen.item_type_id, releaseYear: trading ? releaseYear : '', season: trading ? '' : season }))
    } catch (checkError) {
      setError(checkError.message || 'Could not load the set.')
    } finally {
      setBusy('')
    }
  }

  async function create() {
    setBusy('create')
    setError('')
    try {
      const itemTypeName = (options.item_type || []).find((option) => option.id === chosen.item_type_id)?.name || ''
      const outcome = await createChecklistPlaceholders({ category, ids: chosen, itemTypeName, releaseYear: trading ? releaseYear : '', season: trading ? '' : season, series: categoryHasSeries(category) ? seriesText : '', rows: good, existing: existing || [], inSets })
      setResult(outcome)
      await checkSet()
    } catch (createError) {
      setError(createError.message || 'Could not create the placeholders.')
    } finally {
      setBusy('')
    }
  }

  // Same card = same number in the same collection.
  const byNumber = new Map((existing || []).map((item) => [checklistItemKey({ number: checklistItemNumber(item), collection: item.dynamic_fields?.collection, parallel: item.dynamic_fields?.parallel }), item]))
  const status = (row) => {
    const item = byNumber.get(checklistItemKey(row))
    if (!item) return 'new'
    return isChecklistPlaceholder(item) ? 'placeholder' : 'scanned'
  }
  const counts = { new: 0, placeholder: 0, scanned: 0 }
  good.forEach((row) => { if (existing) counts[status(row)] += 1 })
  // Rows to link to LEGO sets (their own sets, or the In set box).
  const linkCount = lego ? good.filter((row) => row.sets?.length || inSets.length).length : 0
  const showSets = lego && good.some((row) => row.sets?.length)
  const scannedInSet = (existing || []).filter((item) => !isChecklistPlaceholder(item)).length
  const missingNumbers = existing ? good.filter((row) => status(row) !== 'scanned').map((row) => (row.collection ? `${row.number} (${row.collection})` : row.number)) : []
  const showCollection = good.some((row) => row.collection)
  const showSerial = good.some((row) => row.serial)
  // "+ New …" on each level: type the name, Add creates it under the levels
  // chosen above and selects it.
  const NEW = '__new__'
  const [adding, setAdding] = useState(null)
  async function addOption() {
    const level = adding.key.replace(/_id$/, '')
    setBusy('add')
    setError('')
    try {
      const created = await createTaxonomyOption(level, adding.name, { category, subcategoryId: chosen.subcategory_id, franchiseId: chosen.franchise_id, subsetId: chosen.subset_id })
      setOptions((current) => ({ ...current, [level]: [...(current[level] || []).filter((option) => option.id !== created.id), created].sort((a, b) => a.name.localeCompare(b.name)) }))
      choose(adding.key, created.id)
      setAdding(null)
    } catch (addError) {
      setError(addError.message || 'Could not add it.')
    } finally {
      setBusy('')
    }
  }
  const select = (key, label, list, disabled) => (
    <label>{label}
      <select value={adding?.key === key ? NEW : chosen[key]} onChange={(event) => { if (event.target.value === NEW) setAdding({ key, name: '' }); else { if (adding?.key === key) setAdding(null); choose(key, event.target.value) } }} disabled={disabled || Boolean(busy)}>
        <option value="">—</option>
        {(list || []).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        <option value={NEW}>+ New {label.split(' (')[0].toLowerCase()}…</option>
      </select>
      {adding?.key === key ? (
        <span className="checklist-add-new">
          <input autoFocus value={adding.name} onChange={(event) => setAdding({ key, name: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter' && adding.name.trim()) { event.preventDefault(); addOption() } }} placeholder={`New ${label.split(' (')[0].toLowerCase()} name`} disabled={Boolean(busy)} />
          <button type="button" onClick={addOption} disabled={!adding.name.trim() || Boolean(busy)}>{busy === 'add' ? 'Adding…' : 'Add'}</button>
          <button type="button" onClick={() => setAdding(null)} disabled={Boolean(busy)}>Cancel</button>
        </span>
      ) : null}
    </label>
  )

  return (
    <div className="register-modal checklist-modal" role="dialog" aria-modal="true" aria-labelledby="checklist-title">
      <section>
        <div className="checklist-head">
          <div>
            <p className="admin-kicker">Set checklist</p>
            <h2 id="checklist-title">Import a set checklist</h2>
            <small>Creates a placeholder for every card in the set that isn't in the catalogue yet (shown on the website). Scanning a card later fills its placeholder in when you approve it.</small>
          </div>
          <button type="button" className="modal-close" onClick={onClose} disabled={Boolean(busy)} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="checklist-grid">
          <label>Category
            <select value={category} onChange={(event) => { setCategory(event.target.value); setChosen({ subcategory_id: '', franchise_id: '', subset_id: '', property_id: '', item_type_id: '', publisher_id: '' }); setExisting(null) }} disabled={Boolean(busy)}>
              {categories.map((row) => <option key={row.category_id}>{row.name}</option>)}
            </select>
          </label>
          {select('subcategory_id', !cards ? 'Subcategory' : trading ? 'Subcategory (brand)' : 'Subcategory (sport)', options.subcategory, false)}
          {select('franchise_id', trading ? 'Franchise' : 'Franchise (league)', options.franchise, !chosen.subcategory_id)}
          {select('subset_id', !cards ? 'Subfranchise' : trading ? 'Subfranchise (set / era)' : 'Subfranchise (product line)', options.subset, !chosen.franchise_id)}
          {select('property_id', !cards ? 'Property' : trading ? 'Property (release)' : 'Property (set)', options.property, lego ? !chosen.subcategory_id : !chosen.franchise_id)}
          {trading ? (
            <label>Release year
              <input type="number" value={releaseYear} onChange={(event) => { setReleaseYear(event.target.value); setExisting(null) }} placeholder="e.g. 2025" disabled={Boolean(busy)} />
            </label>
          ) : (
            <label>Season
              <input value={season} onChange={(event) => { setSeason(event.target.value); setExisting(null) }} placeholder="2023-24, or 2024" disabled={Boolean(busy)} />
            </label>
          )}
          <label>Collection
            <input value={collection} onChange={(event) => setCollection(event.target.value)} placeholder="Base (leave blank for Base), or e.g. Moments" disabled={Boolean(busy)} />
          </label>
          {select('item_type_id', 'Item type', options.item_type, !chosen.subcategory_id)}
          {select('publisher_id', 'Publisher', options.publisher, false)}
          {categoryHasSeries(category) ? (
            <label>Series (optional)
              <input value={seriesText} onChange={(event) => setSeriesText(event.target.value)} placeholder={lego ? 'e.g. Agents 1.0' : 'e.g. Series 1'} disabled={Boolean(busy)} />
            </label>
          ) : null}
          {lego ? (
            <label>In set (LEGO set numbers)
              <input value={inSetText} onChange={(event) => { setInSetText(event.target.value); setResult(null) }} placeholder="e.g. 7306, links every line to it" disabled={Boolean(busy)} />
              {inSetText.trim() && !inSets.length ? <small className="admin-error">Set numbers only, e.g. 7306 or 7306-1 7326</small> : null}
            </label>
          ) : null}
        </div>
        <label className="checklist-paste">Checklist (one card per line: number, name{trading ? '' : ', team'}; RC marks a rookie; a collection or parallel in [brackets] overrides the Collection box and /99 sets the print run, so one card can be listed once per parallel. Lists copied from a price guide ("Aaron Jones [Cracked Ice Ticket] #64 /25") work too{lego ? '. LEGO: end a line with the sets it comes in to link it to them ("pha009, Mummy Warrior, 7306 7326", "x2" for two in a set)' : ''}. Many sets at once: paste a spreadsheet whose first row names the columns, e.g. Number, Name, {lego ? 'Theme, Subtheme, Year, Item Type, In Set' : trading ? 'Franchise, Subfranchise, Property, Series, Year, Collection' : 'Team, Franchise, Subfranchise, Property, Season, Collection'}; each row goes to the set its columns name)
          <textarea rows={8} value={text} onChange={(event) => { setText(event.target.value); setResult(null) }} placeholder={!cards ? '75192 Millennium Falcon\npha009, Mummy Warrior\nsw0001a, Battle Droid' : trading ? '1 Bulbasaur\n2 Ivysaur\nBLLR-EN033 Sadion, the Timelord' : '1 Josh Allen - Buffalo Bills\n2 Patrick Mahomes II - Kansas City Chiefs\n3 Jayden Daniels - Washington Commanders RC'} disabled={Boolean(busy)} />
        </label>
        {table ? (
          <p className="scan-mode-note">
            Spreadsheet with columns: {table.columns.map((column) => `${column.header} (${CHECKLIST_COLUMN_LABELS[column.field] || column.field})`).join(', ')}
            {table.unknown.length ? `. Not used: ${table.unknown.join(', ')}` : ''}. Blank cells use the choices above.
          </p>
        ) : null}
        <div className="checklist-summary">
          <span>{good.length} card{good.length === 1 ? '' : 's'} read{table ? ` in ${tableGroups.length} set${tableGroups.length === 1 ? '' : 's'}` : ''}{bad.length ? ` · ${bad.length} line${bad.length === 1 ? '' : 's'} skipped` : ''}</span>
          {table ? (
            <>
              <button type="button" onClick={checkGroups} disabled={!categoryRow || !good.length || Boolean(busy)}>{String(busy).startsWith('check') ? `Checking ${busy.split(':')[1] || ''}…` : 'Check every set against the catalogue'}</button>
              {groupChecks ? <span><strong>{tableTotals.new}</strong> to create{tableTotals.taxonomy ? ` · ${tableTotals.taxonomy} new set level${tableTotals.taxonomy === 1 ? '' : 's'} to add` : ''}{tableTotals.blocked ? ` · ${tableTotals.blocked} set${tableTotals.blocked === 1 ? '' : 's'} can't be imported` : ''}</span> : null}
            </>
          ) : (
            <>
              <button type="button" onClick={checkSet} disabled={!setChosenEnough || !good.length || Boolean(busy)}>{busy === 'check' ? 'Checking…' : 'Check against the catalogue'}</button>
              {existing ? <span><strong>{scannedInSet}</strong> scanned in this set · {counts.placeholder} placeholder{counts.placeholder === 1 ? '' : 's'} · <strong>{counts.new}</strong> to create</span> : null}
            </>
          )}
        </div>
        {!table && existing && missingNumbers.length ? <p className="scan-mode-note">Not scanned yet: {missingNumbers.slice(0, 60).join(', ')}{missingNumbers.length > 60 ? ` and ${missingNumbers.length - 60} more` : ''}</p> : null}
        {bad.length ? <p className="scan-mode-note">Skipped: {bad.slice(0, 5).map((row) => `"${row.raw}" (${row.error})`).join('; ')}</p> : null}
        {table && tableGroups.length ? (
          <div className="checklist-preview">
            <table className="admin-table">
              <thead><tr><th>Set</th><th>Cards</th>{lego ? <th>Linked to sets</th> : null}<th>Catalogue</th></tr></thead>
              <tbody>
                {tableGroups.map((group) => {
                  const check = groupChecks?.[group.key]
                  const counts = groupCounts(group)
                  const problem = check?.error || (!groupChecks ? groupProblem(group.spec) : '')
                  return (
                    <tr key={group.key}>
                      <td>
                        {checklistGroupLabel(group.spec) || 'The set chosen above'}
                        {group.spec.item_type?.name ? <small> · {group.spec.item_type.name}</small> : null}
                        {group.duplicates.length ? <small className="admin-error"> · {group.duplicates.length} repeated line{group.duplicates.length === 1 ? '' : 's'} left out</small> : null}
                      </td>
                      <td>{group.rows.length}</td>
                      {lego ? <td>{group.rows.filter((row) => row.sets?.length || inSets.length).length || '—'}</td> : null}
                      <td className={`checklist-status ${problem ? 'problem' : counts?.new ? 'new' : counts ? 'scanned' : ''}`}>
                        {problem || (counts
                          ? [`${counts.new} to create`, counts.placeholder ? `${counts.placeholder} placeholder${counts.placeholder === 1 ? '' : 's'}` : '', counts.scanned ? `${counts.scanned} scanned` : ''].filter(Boolean).join(' · ')
                          : 'Check to see')}
                        {check?.missing?.length ? <small> · will add {check.missing.map((entry) => `${CHECKLIST_COLUMN_LABELS[entry.level] || entry.level} "${entry.name}"`).join(', ')}</small> : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {!table && good.length ? (
          <div className="checklist-preview">
            <table className="admin-table">
              <thead><tr><th>#</th><th>{!cards ? 'Name' : trading ? 'Card' : 'Player'}</th>{trading ? null : <th>Team</th>}{showCollection ? <th>Collection</th> : null}{showSerial ? <th>Numbered</th> : null}{showSets ? <th>In sets</th> : null}<th>Flags</th>{existing ? <th>Catalogue</th> : null}</tr></thead>
              <tbody>
                {good.slice(0, 400).map((row, index) => (
                  <tr key={`${index}-${row.number}`}>
                    <td>{row.number}</td>
                    <td>{row.name}</td>
                    {trading ? null : <td>{row.team || '—'}</td>}
                    {showCollection ? <td>{row.collection || 'Base'}</td> : null}
                    {showSerial ? <td>{row.serial || ''}</td> : null}
                    {showSets ? <td>{(row.sets || []).map((ref) => (ref.quantity > 1 ? `${ref.number} ×${ref.quantity}` : ref.number)).join(', ')}</td> : null}
                    <td>{[row.rookie ? 'RC' : '', row.shortPrint ? 'SP' : ''].filter(Boolean).join(' ') || ''}</td>
                    {existing ? <td className={`checklist-status ${status(row)}`}>{{ new: 'Will be created', placeholder: 'Placeholder', scanned: 'Scanned' }[status(row)]}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {result ? <p className="admin-success">Created {result.created.length} placeholder{result.created.length === 1 ? '' : 's'}{result.sets != null ? ` across ${result.sets} set${result.sets === 1 ? '' : 's'}` : ''}{result.skipped ? ` (${result.skipped} already in the catalogue)` : ''}.{result.linked ? ` Linked ${result.linked} to their set${result.linked === 1 ? '' : 's'}.` : ''}</p> : null}
        {result?.problems?.length ? <p className="admin-error">Not imported: {result.problems.slice(0, 5).join('; ')}{result.problems.length > 5 ? ` and ${result.problems.length - 5} more` : ''}</p> : null}
        {result?.missingSets?.length ? <p className="scan-mode-note">Not linked: set{result.missingSets.length === 1 ? '' : 's'} {result.missingSets.slice(0, 20).join(', ')}{result.missingSets.length > 20 ? ` and ${result.missingSets.length - 20} more` : ''} {result.missingSets.length === 1 ? 'is' : 'are'} not in the catalogue yet. Add {result.missingSets.length === 1 ? 'it' : 'them'}, then run this again to link.</p> : null}
        {error ? <p className="admin-error">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={Boolean(busy)}>Close</button>
          {table ? (
            <button className="update-prompt-primary" type="button" onClick={createGroups} disabled={!groupChecks || !(tableTotals.new || tableTotals.links) || Boolean(busy)}>
              {String(busy).startsWith('create') ? `Saving set ${busy.split(':')[1] || ''}…` : [
                `Create ${tableTotals.new} placeholder${tableTotals.new === 1 ? '' : 's'}`,
                tableTotals.taxonomy ? `add ${tableTotals.taxonomy} set level${tableTotals.taxonomy === 1 ? '' : 's'}` : '',
                tableTotals.links ? `link ${tableTotals.links} to sets` : '',
              ].filter(Boolean).join(', ')}
            </button>
          ) : (
            <button className="update-prompt-primary" type="button" onClick={create} disabled={!existing || !(counts.new || linkCount) || Boolean(busy) || !chosen.item_type_id}>{busy === 'create' ? 'Saving…' : [counts.new || !linkCount ? `Create ${counts.new} placeholder${counts.new === 1 ? '' : 's'}` : '', linkCount ? `${counts.new ? 'link' : 'Link'} ${linkCount} to sets` : ''].filter(Boolean).join(' and ')}</button>
          )}
        </div>
      </section>
    </div>
  )
}

// A scan approved against a set-checklist placeholder fills its blank fields
// from the card's reviewed values and marks it scanned.
async function completePlaceholderFromDraft(item, draft) {
  if (!isChecklistPlaceholder(item)) return
  const category = draft.recognition?.taxonomy?.category || draft.category
  try { await fillChecklistPlaceholder({ item, category, values: bulkReviewValues(draft, category) }) } catch {}
}

const AI_MATCH_TEXT = {
  exact: ['Exact match found', 'Approve links this scan to the existing catalogue item (no duplicate is created) and makes the scans its catalogue photos.'],
  likely: ['Likely match', 'Approve opens the catalogue form so you can confirm the match.'],
  multiple: ['Several possible matches', 'Approve opens the catalogue form so you can choose the right one.'],
  none: ['No catalogue match', 'Approve opens the catalogue form pre-filled with this card, ready to add.'],
}

// Summary of one AI-analysed card. Only fields the model flagged as uncertain
// are highlighted, so the reviewer checks those instead of every field.
function AiReviewCard({ draft, finished, exactMatch, siblingNote, aiBusy, onEdit, onUpdateDraft, onRetry, onRemove, findExisting, onOpenItem, confidence = null }) {
  const recognition = draft.recognition || {}
  const result = recognition.result || {}
  const taxonomy = recognition.taxonomy || { names: {}, unresolved: {} }
  const uncertain = new Set((result.uncertain_fields || []).map((field) => String(field).toLowerCase()))
  // Both scans full size, for reading names and small print.
  const [zoomed, setZoomed] = useState(false)
  useEffect(() => {
    if (!zoomed) return undefined
    const close = (event) => { if (event.key === 'Escape') setZoomed(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [zoomed])
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
  const hasScans = Boolean(draft.frontImage?.path || draft.backImage?.path || draft.frontImage?.cloudPath || draft.backImage?.cloudPath)
  // Rotating and re-running the AI need the original scan files, which only
  // the scanning computer has.
  const hasLocalScans = Boolean(draft.frontImage?.path || draft.backImage?.path)
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
      if (!match.fromSibling) await completePlaceholderFromDraft(match.item, draft)
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
        <div className="review-draft-images ai-review-images" title="Click to see the scans full size">
          {draft.frontImage?.url ? <img src={thumbUrl(draft.frontImage.url, 640)} alt="Front" loading="lazy" decoding="async" onClick={() => setZoomed(true)} /> : <span>Front</span>}
          {draft.backImage?.url ? <img src={thumbUrl(draft.backImage.url, 640)} alt="Back" loading="lazy" decoding="async" onClick={() => setZoomed(true)} /> : <span>Back</span>}
        </div>
        {zoomed ? (
          <div className="scan-zoom" role="dialog" aria-modal="true" aria-label="Full-size scans" onClick={() => setZoomed(false)}>
            {draft.frontImage?.url ? <img src={draft.frontImage.url} alt="Front, full size" /> : null}
            {draft.backImage?.url ? <img src={draft.backImage.url} alt="Back, full size" /> : null}
            <span className="scan-zoom-hint">Click anywhere or press Esc to close</span>
          </div>
        ) : null}
        {hasScans && typeof adminDesktopApi().rotateScanImage === 'function' ? (
          <div className="ai-review-orient">
            {draft.feed?.checkRotation ? <span className="ai-review-orient-flag">Check rotation</span> : null}
            {hasLocalScans ? <button type="button" onClick={() => rotateSide('frontImage')} disabled={Boolean(working) || !draft.frontImage?.path} title="Rotate the front 90° clockwise">↻ Front</button> : null}
            {hasLocalScans ? <button type="button" onClick={() => rotateSide('backImage')} disabled={Boolean(working) || !draft.backImage?.path} title="Rotate the back 90° clockwise">↻ Back</button> : null}
            <button type="button" onClick={swapSides} disabled={Boolean(working) || !draft.frontImage || !draft.backImage}>Swap front/back</button>
            {draft.feed?.adjusted && !finished && hasLocalScans ? <button type="button" onClick={() => { onUpdateDraft(draft.id, { feed: { ...(draft.feed || {}), adjusted: false } }); onRetry(draft.id) }} disabled={Boolean(working) || aiBusy}>Re-analyse</button> : null}
            {draft.feed?.adjusted && finished && linkedItemId ? <button type="button" className="admin-gold-button" onClick={async () => { await addScansToItem(); await onUpdateDraft(draft.id, { feed: { ...(draft.feed || {}), adjusted: false } }) }} disabled={Boolean(working)}>{working === 'images' ? 'Uploading…' : 'Update catalogue photos'}</button> : null}
          </div>
        ) : null}
      </div>
      <div>
        <p className="ai-review-source">Local AI · {recognition.providerLabel || 'Qwen3-VL 8B'}</p>
        {confidence && !finished ? (
          <div className={`confidence-badge-row tier-${confidence.tier}`}>
            <span className={`confidence-chip tier-${confidence.tier}`}>{confidence.tier === 'high' ? 'High' : confidence.tier === 'medium' ? 'Medium' : 'Low'} · {confidence.score}%</span>
            <span className="confidence-ready">{CONFIDENCE_READINESS_TEXT[confidence.readiness]}</span>
            {confidence.reasons.length ? (
              <span className="confidence-reasons">
                {confidence.reasons.map((reason) => <span key={reason.text} className={reason.good ? 'good' : 'bad'}>{reason.good ? '✓' : '!'} {reason.text}</span>)}
              </span>
            ) : null}
          </div>
        ) : null}
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
  property: (values, category) => Boolean(values[propertyParentKey(category)]),
  item_type: (values) => Boolean(values.subcategory_id),
  publisher: () => true,
}

// Always shown when approving against a match, so the card's identity (name,
// number, set, season, year, collection) can be checked at a glance.
const KEY_REVIEW_FIELDS = new Set(['subject', 'name', 'card_number', 'subset_id', 'property_id', 'season', 'release_year', 'collection'])

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
  // Taxonomy the card's set already resolved to (AI analysis, Re-check
  // catalogue matches, or Set up set), when reviewing in that category.
  const taxonomy = draft?.recognition?.taxonomy
  const knownIds = taxonomy && (taxonomy.category || draft.category) === category ? taxonomy.ids || {} : {}
  return Object.fromEntries(reviewFields(category).map((field) => {
    const current = catalogueFieldValue(matchItem, field)
    if (field.taxonomy) return [field.key, matchItem ? current : knownIds[field.key] || '']
    // Provenance describes how a record was created; never re-stamp an existing item.
    if (field.key === 'source' && matchItem) return [field.key, current]
    const scanned = scannedFieldValue(draft, field)
    if (!matchItem) return [field.key, scanned]
    return [field.key, current || (SCAN_PLACEHOLDER_VALUES.has(scanned) ? '' : scanned)]
  }))
}

async function loadScanImageBlobs(draft) {
  const api = adminDesktopApi()
  const images = []
  for (const [image, position] of [[draft.frontImage, 0], [draft.backImage, 1]]) {
    if (image?.path && typeof api.readScanImage === 'function') {
      const file = await api.readScanImage(image)
      images.push({ position, ext: file.ext, blob: new Blob([file.data], { type: file.mime }) })
    } else if (image?.cloudPath) {
      // Reviewing on another computer: the uploaded copy of the scan.
      const file = await downloadCloudImage(image)
      images.push({ position, ext: file.ext, blob: file.blob })
    }
  }
  return images
}

function ScanReviewEditor({ draft, onUpdateDraft, onClose }) {
  const itemTypeNames = useItemTypeNames()
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
  // The matched item as it is now in the catalogue (the stored match is a copy
  // from when the scan was analysed).
  const [freshItem, setFreshItem] = useState(null)
  const matchItem = matchCandidate?.item ? (freshItem?.item_id === matchCandidate.item.item_id ? { ...matchCandidate.item, ...freshItem } : matchCandidate.item) : null
  const [values, setValues] = useState(() => saved?.values || initialReviewValues(draft, category, matchItem))
  // A placeholder is being filled in by this scan: every field is shown.
  const [showAll, setShowAll] = useState(!matchItem || isChecklistPlaceholder(matchItem))
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
  // Find catalogue items by number, name and collection within a franchise/subfranchise.
  const [finder, setFinder] = useState({ open: false, franchiseId: '', subsetId: '', number: '', name: '', collection: '' })
  const [finderCollections, setFinderCollections] = useState([])
  const [finderCollectionsBusy, setFinderCollectionsBusy] = useState(false)
  const [finderOptions, setFinderOptions] = useState({ franchises: [], subsets: [], franchisesFor: null })
  const [finderResults, setFinderResults] = useState(null)
  const [finderBusy, setFinderBusy] = useState(false)

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

  // Load the matched item as it is now; fields the reviewer hasn't touched
  // take its current values (e.g. the season, or a placeholder's set details).
  useEffect(() => {
    const itemId = matchCandidate?.item?.item_id
    if (!itemId) return undefined
    let cancelled = false
    loadCatalogueItemRow(itemId).then((row) => {
      if (cancelled || !row) return
      setFreshItem(row)
      const fresh = initialReviewValues(draft, category, { ...matchCandidate.item, ...row })
      // Untouched fields take the item's current value; an empty one never
      // overwrites (the set link, for one, is loaded separately).
      const keep = (key) => touchedRef.current.has(key) || saved?.values || fresh[key] == null || fresh[key] === ''
      setValues((current) => Object.fromEntries(Object.entries({ ...fresh, ...current }).map(([key, value]) => [key, keep(key) ? value : fresh[key]])))
      if (isChecklistPlaceholder(row)) setShowAll(true)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [matchCandidate?.item?.item_id])

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
        if (!list || next[field.key] || touchedRef.current.has(field.key) || !TAXONOMY_PARENT_READY[field.taxonomy](next, category)) return
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
    setShowAll(!nextItem || isChecklistPlaceholder(nextItem))
    setAttachImages(true)
  }

  // Franchises for the finder follow the review's category; subfranchises follow the franchise.
  useEffect(() => {
    if (!finder.open || !scopeReady || !categoryScope.categoryId) return undefined
    let cancelled = false
    loadFranchiseOptions(categoryScope.categoryId)
      .then((franchises) => {
        if (cancelled) return
        setFinderOptions((current) => ({ ...current, franchises, franchisesFor: categoryScope.categoryId }))
        setFinder((current) => {
          if (current.franchiseId && franchises.some((franchise) => franchise.id === current.franchiseId)) return current
          const fromReview = franchises.find((franchise) => franchise.id === values.franchise_id)
          return { ...current, franchiseId: fromReview ? fromReview.id : '', subsetId: '', collection: '' }
        })
      })
      .catch(() => { if (!cancelled) setFinderOptions((current) => ({ ...current, franchises: [], franchisesFor: categoryScope.categoryId })) })
    return () => { cancelled = true }
  }, [finder.open, scopeReady, categoryScope.categoryId])

  useEffect(() => {
    if (!finder.open) return undefined
    let cancelled = false
    setFinderOptions((current) => ({ ...current, subsets: [] }))
    if (!finder.franchiseId) return undefined
    loadSubfranchiseOptions(finder.franchiseId)
      .then((subsets) => { if (!cancelled) setFinderOptions((current) => ({ ...current, subsets })) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [finder.open, finder.franchiseId])

  function openFinder() {
    setFinder((current) => ({ ...current, open: !current.open, number: current.number || String(values.card_number || draft.scanAnalysis?.proposed?.card_number || '').trim() }))
  }

  useEffect(() => {
    if (!finder.open || !scopeReady || !categoryScope.categoryId) return undefined
    let cancelled = false
    setFinderCollections([])
    setFinderCollectionsBusy(true)
    const timer = setTimeout(() => {
      loadScanFinderCollections({ categoryId: categoryScope.categoryId, franchiseId: finder.franchiseId, subsetId: finder.subsetId, cardNumber: finder.number, name: finder.name })
        .then((collections) => {
          if (cancelled) return
          setFinderCollections(collections)
          setFinder((current) => current.collection && !collections.includes(current.collection) ? { ...current, collection: '' } : current)
        })
        .catch((err) => { if (!cancelled) setError(err.message || 'Could not load collections.') })
        .finally(() => { if (!cancelled) setFinderCollectionsBusy(false) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [finder.open, scopeReady, categoryScope.categoryId, finder.franchiseId, finder.subsetId, finder.number, finder.name])

  async function runFinder(event) {
    event?.preventDefault?.()
    if (finderBusy || (!finder.number.trim() && !finder.name.trim() && !finder.collection)) return
    setFinderBusy(true)
    setError('')
    try {
      setFinderResults(await findItemsByCardNumber(draft, category, { franchiseId: finder.franchiseId, subsetId: finder.subsetId, cardNumber: finder.number, name: finder.name, collection: finder.collection }))
    } catch (err) {
      setError(err.message || 'Could not search the catalogue by card number.')
    } finally {
      setFinderBusy(false)
    }
  }

  function chooseCategory(nextCategory) {
    setFinderResults(null)
    setFinder((current) => ({ ...current, franchiseId: '', subsetId: '', collection: '' }))
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
        taxonomyChildren(key, category, TAXONOMY_CHILDREN).forEach((child) => {
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
    }).filter((row) => showAll || KEY_REVIEW_FIELDS.has(row.field.key) || row.conflict || row.fills || row.edited),
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
      if (isChecklistPlaceholder(reviewItem)) await fillChecklistPlaceholder({ item: reviewItem, category, values })
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
      if (isChecklistPlaceholder(item)) {
        await fillChecklistPlaceholder({ item, category, values })
        const images = attachImages ? await loadScanImageBlobs(draft) : []
        if (images.length) await attachScanImagesToItem(item.item_id, images)
      }
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
      const ready = TAXONOMY_PARENT_READY[field.taxonomy](values, category)
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
      const ready = TAXONOMY_PARENT_READY[field.taxonomy](values, category)
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
                      {candidate.item.release_year ? ` (${candidate.item.release_year})` : ''}
                      {itemTypeLabel(itemTypeNames, candidate.item) ? ` · ${itemTypeLabel(itemTypeNames, candidate.item)}` : ''} · {candidate.score}%
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
              Comparing with <strong>{matchItem.name || matchItem.subject}{itemTypeLabel(itemTypeNames, matchItem) ? ` (${itemTypeLabel(itemTypeNames, matchItem)})` : ''}</strong>
              {matchCandidate?.reasons?.length ? ` · ${matchCandidate.reasons.join(' · ')}` : ''}
              {' · '}{conflictCount ? `${conflictCount} field${conflictCount === 1 ? '' : 's'} differ` : 'no conflicting fields'}
            </span>
          ) : <span>No catalogue item selected. The final values below will be added as a new catalogue item.</span>}
          <div className="scan-review-summary-actions">
            <button type="button" className={finder.open ? 'active' : ''} onClick={openFinder} disabled={Boolean(busy)}>Find by card number</button>
            {matchItem ? (
              <label className="admin-check"><input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} /> Show all fields</label>
            ) : null}
          </div>
        </div>

        {finder.open ? (
          <div className="scan-review-finder">
            <form className="scan-review-finder-controls" onSubmit={runFinder}>
              <label>Franchise
                <select value={finder.franchiseId} onChange={(event) => { setFinderResults(null); setFinder((current) => ({ ...current, franchiseId: event.target.value, subsetId: '', collection: '' })) }} disabled={finderBusy}>
                  <option value="">{finderOptions.franchisesFor === categoryScope.categoryId ? `All ${category} franchises` : 'Loading franchises…'}</option>
                  {finderOptions.franchises.map((franchise) => <option key={franchise.id} value={franchise.id}>{franchise.name}</option>)}
                </select>
              </label>
              <label>Subfranchise
                <select value={finder.subsetId} onChange={(event) => { setFinderResults(null); setFinder((current) => ({ ...current, subsetId: event.target.value, collection: '' })) }} disabled={finderBusy || !finder.franchiseId || !finderOptions.subsets.length}>
                  <option value="">{finder.franchiseId && !finderOptions.subsets.length ? 'No subfranchises' : 'All subfranchises'}</option>
                  {finderOptions.subsets.map((subset) => <option key={subset.id} value={subset.id}>{subset.name}</option>)}
                </select>
              </label>
              <label>Card number
                <input autoFocus value={finder.number} onChange={(event) => { setFinderResults(null); setFinder((current) => ({ ...current, number: event.target.value })) }} placeholder="e.g. 12" disabled={finderBusy} />
              </label>
              <label>Name
                <input className="scan-review-finder-name" value={finder.name} onChange={(event) => { setFinderResults(null); setFinder((current) => ({ ...current, name: event.target.value })) }} placeholder="Player or card name" disabled={finderBusy} />
              </label>
              <label>Collection
                <select value={finder.collection} onChange={(event) => { setFinderResults(null); setFinder((current) => ({ ...current, collection: event.target.value })) }} disabled={finderBusy || finderCollectionsBusy}>
                  <option value="">{finderCollectionsBusy ? 'Loading collections…' : 'All collections'}</option>
                  {finderCollections.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
              <button type="submit" className="admin-gold-button" disabled={finderBusy || (!finder.number.trim() && !finder.name.trim() && !finder.collection)}>{finderBusy ? 'Searching…' : 'Search'}</button>
            </form>
            {finderResults ? (
              finderResults.length ? (
                <ul className="scan-review-finder-results">
                  {finderResults.map((candidate) => (
                    <li key={candidate.item.item_id} className={candidate.item.item_id === matchId ? 'selected' : ''}>
                      {candidate.item.imageUrl ? <img src={candidate.item.imageUrl} alt="" /> : <span className="scan-review-finder-noimage" />}
                      <div>
                        <strong>
                          {candidate.item.name || candidate.item.subject || candidate.item.item_id}
                          {candidate.item.card_number ? ` #${candidate.item.card_number}` : ''}
                          {candidate.item.release_year ? ` (${candidate.item.release_year})` : ''}
                        </strong>
                        <small>{[itemTypeLabel(itemTypeNames, candidate.item), candidate.subsetName, String(candidate.item.dynamic_fields?.collection || '').trim() ? `Collection: ${candidate.item.dynamic_fields.collection}` : /card/i.test(category) ? 'Collection: Base' : '', isChecklistPlaceholder(candidate.item) ? 'Placeholder' : '', candidate.score ? `${candidate.score}% match` : ''].filter(Boolean).join(' · ')}</small>
                      </div>
                      <button type="button" onClick={() => chooseMatch(candidate.item.item_id, candidate)} disabled={Boolean(busy) || candidate.item.item_id === matchId}>
                        {candidate.item.item_id === matchId ? 'Selected' : 'Match to this'}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="scan-review-finder-empty">No {category} items match these search filters.</p>
            ) : null}
          </div>
        ) : null}

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
              <strong>{formatNumber(section.total ?? section.rows.length)}</strong>
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

// serverSearch: the loader takes { search } and searches the database, so a search
// covers every record rather than only the rows loaded. rowAction: a button for the
// selected record ({ label, show(row), run(row) }).
function AdminSectionBrowser({ title, kicker, loader, serverSearch = false, rowAction = null }) {
  const [data, setData] = useState(null)
  const [activeSection, setActiveSection] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const serverQuery = serverSearch ? search.trim() : ''

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      loader(serverSearch ? { search: serverQuery } : undefined)
        .then((nextData) => {
          if (!cancelled) {
            setData(nextData)
            setActiveSection((currentKey) => (nextData.sections || []).some((section) => section.key === currentKey) ? currentKey : nextData.sections?.[0]?.key || '')
            setSelected(serverSearch ? null : nextData.sections?.[0]?.rows?.[0] || null)
            setError('')
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err.message || `Could not load ${title}.`)
        })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, serverQuery ? 350 : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [loader, title, serverQuery])

  const sections = data?.sections || []
  const current = sections.find((section) => section.key === activeSection) || sections[0]
  const query = serverSearch ? '' : search.trim().toLowerCase()
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
    // A database search applies to every section, so it stays when switching.
    if (!serverSearch) setSearch('')
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
              <strong>{formatNumber(section.total ?? section.rows.length)}</strong>
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
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={serverSearch ? 'Search the whole catalogue: name, card number, set number, UPC…' : `Search ${current?.title || title}...`} />
          </label>
        </div>
        {serverSearch ? (
          <div className="admin-table-note">
            {loading ? 'Searching…' : current?.total != null && current.total > (current.rows || []).length
              ? `Showing ${formatNumber((current.rows || []).length)} of ${formatNumber(current.total)}${serverQuery ? '' : ' (most recent)'}; search to find any item.`
              : `${formatNumber((current?.rows || []).length)} record${(current?.rows || []).length === 1 ? '' : 's'}`}
          </div>
        ) : null}
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
            {selected && rowAction?.show(selected) ? (
              <button type="button" className="admin-gold-button" onClick={() => rowAction.run(selected)}>{rowAction.label}</button>
            ) : null}
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
