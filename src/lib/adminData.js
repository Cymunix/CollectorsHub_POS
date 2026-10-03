import { supabase } from './supabaseClient'

const IMAGE_BUCKET = 'item-images'

export const ADMIN_EXPLORER_TABLES = [
  { label: 'Catalogue Items', table: 'items', order: 'name', pk: 'item_id', editable: true },
  { label: 'Catalogue Details View', table: 'item_details', order: 'subject', pk: 'item_id', editable: false },
  { label: 'Categories', table: 'categories', order: 'name', pk: 'category_id', editable: true },
  { label: 'Subcategories', table: 'subcategories', order: 'name', pk: 'subcategory_id', editable: true },
  { label: 'Franchises', table: 'franchises', order: 'name', pk: 'franchise_id', editable: true },
  { label: 'Brands', table: 'brands', order: 'name', pk: 'brand_id', editable: true },
  { label: 'Collectible Sets', table: 'collectible_sets', order: 'name', pk: 'collectible_set_id', editable: true },
  { label: 'Item Images', table: 'item_images', order: 'created_at', pk: 'id', editable: true },
  { label: 'Image Candidates', table: 'image_candidates', order: 'created_at', pk: 'id', editable: true },
  { label: 'Image Search Jobs', table: 'image_search_jobs', order: 'created_at', pk: 'id', editable: true },
  { label: 'Market Prices', table: 'item_market_prices', order: 'updated_at', pk: 'item_id', editable: true },
  { label: 'Condition Prices', table: 'item_condition_prices', order: 'price_date', pk: 'id', editable: true },
  { label: 'Market Sales', table: 'market_sales', order: 'sold_at', pk: 'sale_id', editable: true },
  { label: 'Market Sales Imports', table: 'market_sales_imports', order: 'started_at', pk: 'id', editable: true },
  { label: 'Stores', table: 'store_settings', order: 'created_at', pk: 'store_id', editable: true },
  { label: 'Store Locations', table: 'store_locations', order: 'created_at', pk: 'id', editable: true },
  { label: 'Organisations', table: 'organizations', order: 'created_at', pk: 'id', editable: true },
  { label: 'Profiles', table: 'profiles', order: 'created_at', pk: 'id', editable: true },
]

// PostgREST `or=(...)` values containing , . : ( ) break the filter unless
// double-quoted; inside quotes only \ and " need escaping.
function orValue(value) {
  return `"${String(value).replace(/[\\"]/g, '\\$&')}"`
}

function orEq(column, value) {
  return `${column}.eq.${orValue(value)}`
}

// Case-insensitive "contains" with LIKE wildcards in the user's text escaped.
function orContains(column, value) {
  return `${column}.ilike.${orValue(`%${String(value).replace(/[\\%_]/g, '\\$&')}%`)}`
}

const LEGO_EXCLUDE_PHRASES = [
  'replica',
  'generic',
  'compatible',
  'moc',
  'light kit',
  'lighting kit',
  'display stand',
  'wall mount',
  'sticker',
  'replacement sticker',
  'instructions only',
  'box only',
]

const GRADERS = ['PSA', 'CGC', 'BGS', 'SGC', 'ACE', 'PCG']

const CATALOGUE_SELECT = [
  'item_id',
  'name',
  'subject',
  'category_id',
  'subcategory_id',
  'franchise_id',
  'brand_id',
  'collectible_set_id',
  'manufacturer_id',
  'publisher_id',
  'card_number',
  'lego_set_number',
  'minifig_code',
  'catalog_code',
  'upc',
  'release_year',
  'market_price',
  'retail_price',
  'image_path',
  'dynamic_fields',
  'attributes',
  'completion_eligible',
  'availability',
  'subset_id',
  'item_type_id',
  'description',
]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function publicImageUrl(path) {
  if (!path) return ''
  if (path.startsWith('http')) return path
  return supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path).data?.publicUrl || ''
}

function asMap(rows, idKey) {
  return Object.fromEntries((rows || []).map((row) => [row[idKey], row.name || row.subject_name || row.subject || '']))
}

async function count(table, build = (query) => query) {
  const base = supabase.from(table).select('*', { count: 'exact', head: true })
  const { count: total, error } = await build(base)
  if (error) throw error
  return total || 0
}

async function safeCount(table, build) {
  try {
    return await count(table, build)
  } catch (error) {
    console.warn(`[Admin Data] Count failed for ${table}:`, error)
    return 0
  }
}

export async function loadAdminOverview() {
  const [
    catalogueItems,
    missingImageDetails,
    missingImageItems,
    missingPricing,
    imageCandidates,
    imageJobErrors,
  ] = await Promise.all([
    safeCount('items'),
    safeCount('item_details', (query) => query.is('front_image_path', null)),
    safeCount('items', (query) => query.or('image_path.is.null,image_path.eq.')),
    safeCount('items', (query) => query.is('market_price', null)),
    safeCount('image_candidates', (query) => query.eq('status', 'pending')),
    safeCount('image_search_jobs', (query) => query.eq('status', 'error')),
  ])

  const missingImages = Math.max(missingImageDetails, missingImageItems)
  const pendingReviews = imageCandidates + imageJobErrors
  const recentCatalogue = await loadCatalogueItems({ limit: 6 })
  const recentImports = await loadExplorerRecords({ table: 'image_search_jobs', pageSize: 6 })

  return {
    metrics: {
      catalogueItems,
      pendingReviews,
      missingImages,
      missingPricing,
      duplicateCandidates: 0,
      failedImports: imageJobErrors,
    },
    recentCatalogue: recentCatalogue.rows,
    recentImports: recentImports.rows,
    reviewItems: [],
    scanBatches: [],
    systemIssues: imageJobErrors ? [`${imageJobErrors} image search job error${imageJobErrors === 1 ? '' : 's'}`] : [],
  }
}

// Filters shared by the catalogue list and "select all matching".
function applyCatalogueFilters(query, { search = '', categoryId = '', franchiseId = '', releaseYear = '', missingImages = false, missingPricing = false } = {}) {
  const term = String(search || '').trim()
  if (term) {
    const searchFilters = [
      orContains('name', term),
      orContains('subject', term),
      orEq('upc', term),
      orContains('catalog_code', term),
      orContains('card_number', term),
      orContains('lego_set_number', term),
      orContains('minifig_code', term),
    ]
    if (UUID_RE.test(term)) searchFilters.push(`item_id.eq.${term}`)
    query = query.or(searchFilters.join(','))
  }
  if (categoryId) query = query.eq('category_id', categoryId)
  if (franchiseId) query = query.eq('franchise_id', franchiseId)
  if (String(releaseYear || '').trim()) query = query.eq('release_year', Number(releaseYear))
  if (missingImages) query = query.or('image_path.is.null,image_path.eq.')
  if (missingPricing) query = query.is('market_price', null)
  return query
}

// Every item id matching the filters (for bulk actions), up to `max`.
export async function loadCatalogueItemIds(filters = {}, max = 5000) {
  const ids = []
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await applyCatalogueFilters(supabase.from('items').select('item_id'), filters)
      .order('item_id')
      .range(from, Math.min(from + 999, max - 1))
    if (error) throw error
    ids.push(...(data || []).map((row) => row.item_id))
    if (!data || data.length < 1000) break
  }
  return ids
}

export async function loadFranchiseOptions() {
  const { data, error } = await supabase.from('franchises').select('franchise_id, name').order('name')
  if (error) throw error
  const byName = new Map()
  ;(data || []).forEach((row) => {
    const name = String(row.name || '').trim()
    if (name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { id: row.franchise_id, name })
  })
  return [...byName.values()]
}

// Tables whose rows keep pointing at a catalogue item that is in use (store
// stock, sales, orders, in-store sales history, customer collections).
// Deleting such an item would unlink or block them, so bulk delete skips it.
const ITEM_IN_USE_TABLES = [
  ['store_inventory', 'store inventory'],
  ['store_transaction_items', 'sales'],
  ['store_order_items', 'pre-orders / layaways'],
  ['item_market_sales', 'in-store sales history'],
  ['owned_copies', 'customer collections'],
]

// Returns { deleted: [ids], skipped: [{ id, reason }], failed: [{ id, message }] }.
// Items in use are skipped; deletes run in batches, and a batch that fails is
// retried item by item so one bad row never blocks the rest.
// Local catalogue backup (desktop app only): every catalogue write is also
// recorded in the backup folder, including writes Supabase refused. Fire and
// forget: the backup never blocks or breaks the save.
export function backupCatalogueChange(change) {
  try { globalThis.window?.nordvikDesktop?.recordCatalogueChange?.(change)?.catch?.(() => {}) } catch {}
}

export async function deleteCatalogueItems(itemIds = [], onProgress = () => {}) {
  const ids = [...new Set(itemIds)].filter(Boolean)
  const inUse = new Map()
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const checks = await Promise.all(ITEM_IN_USE_TABLES.map(([table, label]) => (
      supabase.from(table).select('catalog_item_id').in('catalog_item_id', chunk).then(({ data, error }) => ({ label, rows: error ? [] : data || [] }))
    )))
    checks.forEach(({ label, rows }) => rows.forEach((row) => { if (!inUse.has(row.catalog_item_id)) inUse.set(row.catalog_item_id, label) }))
    onProgress({ phase: 'checking', done: Math.min(i + 200, ids.length), total: ids.length })
  }
  const skipped = [...inUse.entries()].map(([id, reason]) => ({ id, reason }))
  const toDelete = ids.filter((id) => !inUse.has(id))
  const deleted = []
  const failed = []
  for (let i = 0; i < toDelete.length; i += 50) {
    const chunk = toDelete.slice(i, i + 50)
    const { data, error } = await supabase.from('items').delete().in('item_id', chunk).select('item_id')
    if (!error) {
      const gone = new Set((data || []).map((row) => row.item_id))
      deleted.push(...gone)
      chunk.filter((id) => !gone.has(id)).forEach((id) => failed.push({ id, message: 'Not deleted (no permission or already removed).' }))
    } else {
      for (const id of chunk) {
        const single = await supabase.from('items').delete().eq('item_id', id).select('item_id')
        if (single.error) failed.push({ id, message: single.error.message })
        else if (single.data?.length) deleted.push(id)
        else failed.push({ id, message: 'Not deleted (no permission or already removed).' })
      }
    }
    onProgress({ phase: 'deleting', done: Math.min(i + 50, toDelete.length), total: toDelete.length })
  }
  if (deleted.length) backupCatalogueChange({ action: 'delete', itemIds: deleted })
  return { deleted, skipped, failed }
}

export async function loadCatalogueItems({ search = '', categoryId = '', franchiseId = '', releaseYear = '', missingImages = false, missingPricing = false, page = 1, limit = 25 } = {}) {
  const from = Math.max(0, (page - 1) * limit)
  const to = from + limit - 1
  let query = supabase
    .from('items')
    .select(CATALOGUE_SELECT.join(','), { count: 'exact' })
    .order('name', { ascending: true, nullsFirst: false })
    .range(from, to)

  query = applyCatalogueFilters(query, { search, categoryId, franchiseId, releaseYear, missingImages, missingPricing })

  const { data, error, count: total } = await query
  if (error) throw error

  const rows = data || []
  const lookupIds = {
    categories: [...new Set(rows.map((row) => row.category_id).filter(Boolean))],
    subcategories: [...new Set(rows.map((row) => row.subcategory_id).filter(Boolean))],
    franchises: [...new Set(rows.map((row) => row.franchise_id).filter(Boolean))],
    brands: [...new Set(rows.map((row) => row.brand_id).filter(Boolean))],
    sets: [...new Set(rows.map((row) => row.collectible_set_id).filter(Boolean))],
  }

  const [categories, subcategories, franchises, brands, sets, images] = await Promise.all([
    lookupIds.categories.length ? supabase.from('categories').select('category_id, name').in('category_id', lookupIds.categories) : Promise.resolve({ data: [] }),
    lookupIds.subcategories.length ? supabase.from('subcategories').select('subcategory_id, name').in('subcategory_id', lookupIds.subcategories) : Promise.resolve({ data: [] }),
    lookupIds.franchises.length ? supabase.from('franchises').select('franchise_id, name').in('franchise_id', lookupIds.franchises) : Promise.resolve({ data: [] }),
    lookupIds.brands.length ? supabase.from('brands').select('brand_id, name').in('brand_id', lookupIds.brands) : Promise.resolve({ data: [] }),
    lookupIds.sets.length ? supabase.from('collectible_sets').select('collectible_set_id, name').in('collectible_set_id', lookupIds.sets) : Promise.resolve({ data: [] }),
    rows.length ? supabase.from('item_images').select('item_id, image_path, position, is_primary').in('item_id', rows.map((row) => row.item_id)) : Promise.resolve({ data: [] }),
  ])

  const maps = {
    categories: asMap(categories.data, 'category_id'),
    subcategories: asMap(subcategories.data, 'subcategory_id'),
    franchises: asMap(franchises.data, 'franchise_id'),
    brands: asMap(brands.data, 'brand_id'),
    sets: asMap(sets.data, 'collectible_set_id'),
  }
  const imageRows = images.data || []
  const imagesByItem = imageRows.reduce((acc, image) => {
    const list = acc[image.item_id] || []
    list.push(image)
    acc[image.item_id] = list
    return acc
  }, {})

  return {
    rows: rows.map((row) => {
      const image = (imagesByItem[row.item_id] || []).sort((a, b) => {
        if (a.is_primary && !b.is_primary) return -1
        if (!a.is_primary && b.is_primary) return 1
        return Number(a.position || 0) - Number(b.position || 0)
      })[0]
      return {
        ...row,
        displayName: row.name || row.subject || row.catalog_code || row.item_id,
        categoryName: maps.categories[row.category_id] || '',
        subcategoryName: maps.subcategories[row.subcategory_id] || '',
        franchiseName: maps.franchises[row.franchise_id] || '',
        brandName: maps.brands[row.brand_id] || '',
        setName: maps.sets[row.collectible_set_id] || '',
        imageUrl: publicImageUrl(image?.image_path || row.image_path || ''),
        imageCount: (imagesByItem[row.item_id] || []).length,
        pricingStatus: row.market_price != null || row.retail_price != null ? 'Ready' : 'Missing',
        status: row.availability || (row.completion_eligible === false ? 'Hidden' : 'Published'),
      }
    }),
    total: total || rows.length,
  }
}

async function loadMarketBuckets(itemId, context = {}) {
  try {
    const { data, error } = await supabase.rpc('market_sales_bucket_summary', {
      p_item_id: itemId,
      p_currency: 'CAD',
    })
    if (error) throw error
    return data || []
  } catch (error) {
    console.warn('[Admin Market Data] Market bucket summary unavailable:', error)
    return []
  }
}

export async function loadMarketStatsForItem(itemId, bucket = {}, context = {}) {
  if (!itemId) return null
  try {
    const { data, error } = await supabase.rpc('get_market_sales_stats', {
      p_item_id: itemId,
      p_finish: bucket.finish || null,
      p_condition_code: bucket.conditionCode || bucket.condition_code || null,
      p_variant: bucket.variant || null,
      p_language: bucket.language || null,
      p_is_graded: !!bucket.isGraded || !!bucket.is_graded,
      p_grading_company: bucket.gradingCompany || bucket.grading_company || null,
      p_grade_numeric: bucket.gradeNumeric ?? bucket.grade ?? bucket.grade_numeric ?? null,
      p_grading_label: bucket.gradingLabel || bucket.grading_label || null,
      p_currency: bucket.currency || 'CAD',
    })
    if (error) throw error
    return Array.isArray(data) ? data[0] || null : data
  } catch (error) {
    console.warn('[Admin Market Data] Market stats unavailable:', error)
    return null
  }
}

export async function loadCatalogueItemRecord(itemId, context = {}) {
  const [{ data: raw, error }, details, images, market, conditionPrices, listings, marketSales, marketImports, marketBuckets] = await Promise.all([
    supabase.from('items').select(CATALOGUE_SELECT.join(',')).eq('item_id', itemId).maybeSingle(),
    supabase.from('item_details').select('*').eq('item_id', itemId).maybeSingle(),
    supabase.from('item_images').select('*').eq('item_id', itemId).order('position'),
    supabase.from('item_market_prices').select('*').eq('item_id', itemId).maybeSingle(),
    supabase.from('item_condition_prices').select('*').eq('catalog_item_id', itemId).order('price_date', { ascending: false }).limit(25),
    supabase.rpc('catalog_item_listings', { p_catalog_item_id: itemId }),
    safeRows('market_sales', '*', 'sold_at').then((result) => ({ ...result, data: result.rows.filter((row) => marketRowItemId(row) === itemId) })),
    safeRows('market_sales_imports', '*', 'started_at').then((result) => ({ ...result, data: result.rows.filter((row) => marketRowItemId(row) === itemId).slice(0, 20) })),
    loadMarketBuckets(itemId, context),
  ])

  if (error) throw error
  return {
    raw,
    details: details.data || null,
    images: images.data || [],
    market: market.data || null,
    conditionPrices: conditionPrices.data || [],
    listings: listings.data || [],
    marketSales: marketSales.data || [],
    marketImports: marketImports.data || [],
    marketBuckets: marketBuckets || [],
  }
}

export function generateMarketSearchQuery(item) {
  const dynamic = item?.dynamic_fields || {}
  const attributes = item?.attributes || {}
  const parts = [
    attributes.brand || dynamic.brand || item?.brandName,
    item?.name || item?.subject,
    item?.lego_set_number,
    item?.card_number,
    item?.catalog_code,
    dynamic.set_code || dynamic.set || attributes.set,
    dynamic.variant || attributes.variant,
    dynamic.finish || attributes.finish,
    dynamic.language || attributes.language,
  ]
  return [...new Set(parts.map((part) => String(part || '').trim()).filter(Boolean))].join(' ')
}

function detectGrading(title) {
  const text = String(title || '').toUpperCase()
  const grader = GRADERS.find((entry) => new RegExp(`\\b${entry}\\b`).test(text)) || null
  const gradeMatch = grader ? text.match(new RegExp(`\\b${grader}\\s*(10|9\\.5|9|8\\.5|8|7\\.5|7|6\\.5|6|5\\.5|5)\\b`)) : null
  return {
    itemState: grader ? 'GRADED' : 'RAW',
    grader,
    grade: gradeMatch ? Number(gradeMatch[1]) : null,
  }
}

function detectFinish(title, item) {
  const text = String(title || '').toLowerCase()
  if (/\b(non[-\s]?foil|regular)\b/.test(text)) return 'NON_FOIL'
  if (/\b(foil|holo|holofoil|reverse holo)\b/.test(text)) return 'FOIL'
  const metadataFinish = String(item?.dynamic_fields?.finish || item?.attributes?.finish || '').toLowerCase()
  if (metadataFinish.includes('foil') || metadataFinish.includes('holo')) return 'FOIL'
  return null
}

function detectCondition(title, rawCondition) {
  const text = `${title || ''} ${rawCondition || ''}`.toLowerCase()
  if (/\b(near mint|nm)\b/.test(text)) return 'Near Mint'
  if (/\b(light played|lightly played|lp)\b/.test(text)) return 'Lightly Played'
  if (/\b(moderately played|mp)\b/.test(text)) return 'Moderately Played'
  if (/\b(heavily played|hp)\b/.test(text)) return 'Heavily Played'
  if (/\b(damaged|poor)\b/.test(text)) return 'Damaged'
  if (/\b(missing parts|incomplete)\b/.test(text)) return 'Pre-Owned - Missing Parts'
  if (/\b(pre-owned|preowned|used|complete)\b/.test(text)) return 'Pre-Owned 100%'
  if (/\b(sealed|brand new|new)\b/.test(text)) return 'New/Sealed'
  return null
}

function conditionCode(condition) {
  const text = String(condition || '').trim().toLowerCase().replace(/\s+/g, ' ')
  const map = {
    mint: 'MT',
    'near mint': 'NM',
    'near mint or better': 'NM',
    'light played': 'LP',
    'lightly played': 'LP',
    'moderately played': 'MP',
    'heavily played': 'HP',
    damaged: 'DMG',
    sealed: 'SEALED',
    'new/sealed': 'SEALED',
    'new - sealed': 'SEALED',
    'used/complete': 'COMPLETE',
    'used complete': 'COMPLETE',
    'pre-owned 100%': 'COMPLETE',
    'pre owned 100%': 'COMPLETE',
    'pre-owned - missing parts': 'MISSING_PARTS',
    'pre owned missing parts': 'MISSING_PARTS',
  }
  return map[text] || String(condition || '').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 16) || null
}

function marketRowItemId(row) {
  return row?.item_id || row?.catalogue_item_id || row?.catalog_item_id || null
}

export function classifyMarketSaleCandidate(candidate, item) {
  const title = String(candidate.title || '')
  const lowerTitle = title.toLowerCase()
  const itemNumber = String(item?.card_number || item?.lego_set_number || item?.catalog_code || '').toLowerCase()
  const itemName = String(item?.name || item?.subject || '').toLowerCase()
  const categoryText = `${item?.categoryName || ''} ${item?.dynamic_fields?.category || ''}`.toLowerCase()
  const grading = detectGrading(title)
  const finish = detectFinish(title, item)
  const condition = detectCondition(title, candidate.rawCondition)
  const excludedPhrase = categoryText.includes('lego') ? LEGO_EXCLUDE_PHRASES.find((phrase) => lowerTitle.includes(phrase)) : ''
  const numberMatch = itemNumber && lowerTitle.includes(itemNumber)
  const nameMatch = itemName && itemName.split(/\s+/).filter((part) => part.length > 2).some((part) => lowerTitle.includes(part))
  const confidence = Math.min(98, (numberMatch ? 55 : 0) + (nameMatch ? 28 : 0) + (condition ? 5 : 0) + (finish ? 5 : 0) + (grading.grader ? 5 : 0))
  const needsFinishReview = /magic|pokemon|trading|card/.test(categoryText) && !finish
  const reviewStatus = excludedPhrase
    ? 'EXCLUDED'
    : confidence >= 80 && !needsFinishReview
      ? 'AUTO_APPROVED'
      : 'REVIEW'
  return {
    ...candidate,
    catalogueItemId: candidate.catalogueItemId || item?.item_id,
    itemState: candidate.itemState || grading.itemState,
    grader: candidate.grader || grading.grader,
    grade: candidate.grade ?? grading.grade,
    finish: candidate.finish || finish,
    normalisedCondition: candidate.normalisedCondition || condition,
    matchConfidence: candidate.matchConfidence ?? confidence,
    reviewStatus,
    exclusionReason: excludedPhrase ? `Excluded phrase: ${excludedPhrase}` : needsFinishReview ? 'Finish unclear' : candidate.exclusionReason || null,
  }
}

async function insertMarketImport(payload) {
  const { data, error } = await supabase
    .from('market_sales_imports')
    .insert(payload)
    .select('*')
    .maybeSingle()
  if (error) throw error
  return data
}

async function updateMarketImport(importId, patch) {
  if (!importId) return null
  const { data, error } = await supabase
    .from('market_sales_imports')
    .update({ ...patch, completed_at: patch.completed_at || new Date().toISOString() })
    .eq('id', importId)
    .select('*')
    .maybeSingle()
  if (error) throw error
  return data
}

export async function fetchMarketSales({ catalogueItemId, provider = 'ebay', since = null, queryOverride = '', context = {} }) {
  const itemRecord = await loadCatalogueItemRecord(catalogueItemId, context)
  const item = itemRecord.raw
  if (!item?.item_id) throw new Error('Catalogue item not found.')
  const searchQuery = queryOverride.trim() || generateMarketSearchQuery(item)
  const startedAt = new Date().toISOString()
  const importRow = await insertMarketImport({
    item_id: catalogueItemId,
    source: provider,
    search_query: searchQuery,
    status: 'running',
    results_found: 0,
    results_approved: 0,
    results_excluded: 0,
    results_review: 0,
    started_at: startedAt,
    created_by: (await supabase.auth.getUser()).data?.user?.id || null,
    raw_results: [],
    error_message: null,
  })

  if (provider !== 'ebay') {
    const message = `Provider ${provider} is not configured.`
    const failedImport = await updateMarketImport(importRow.id, {
      status: 'unavailable',
      error_message: message,
      raw_results: [],
    })
    return {
      import: failedImport || importRow,
      item: itemRecord,
      provider,
      query: searchQuery,
      candidates: [],
      status: 'unavailable',
      error: message,
      since,
    }
  }

  try {
    const desktop = window.nordvikDesktop
    if (!desktop?.searchEbayMarket) {
      throw new Error('eBay API search is only available in the installed CollectorsHub POS desktop app.')
    }

    const response = await desktop.searchEbayMarket({ query: searchQuery, limit: 25 })
    const candidates = (response.candidates || []).map((candidate) => classifyMarketSaleCandidate({
      ...candidate,
      catalogueItemId,
    }, item))
    const reviewCount = candidates.filter((candidate) => candidate.reviewStatus === 'REVIEW').length
    const excludedCount = candidates.filter((candidate) => candidate.reviewStatus === 'EXCLUDED').length
    const completeImport = await updateMarketImport(importRow.id, {
      status: response.mode === 'insights' ? 'completed' : 'review',
      results_found: candidates.length,
      results_excluded: excludedCount,
      results_review: reviewCount,
      raw_results: response.raw || response.candidates || [],
      error_message: response.mode === 'browse'
        ? 'Connected to eBay Browse API. Results are active listings, not confirmed sold history. Use Marketplace Insights mode only if eBay has approved the app for sold-history access.'
        : null,
    })

    return {
      import: completeImport || importRow,
      item: itemRecord,
      provider,
      query: searchQuery,
      candidates,
      status: response.mode === 'insights' ? 'completed' : 'review',
      error: response.mode === 'browse'
        ? 'eBay connection works. These are active listings, not sold-market sales, so review carefully before saving.'
        : '',
      mode: response.mode,
      marketplaceId: response.marketplaceId,
      since,
    }
  } catch (error) {
    const message = error.message || 'eBay market fetch failed.'
    const failedImport = await updateMarketImport(importRow.id, {
      status: 'error',
      error_message: message,
      raw_results: [],
    })
    return {
      import: failedImport || importRow,
      item: itemRecord,
      provider,
      query: searchQuery,
      candidates: [],
      status: 'error',
      error: message,
      since,
    }
  }
}

export async function loadMarketDataAdmin({ search = '', page = 1, limit = 25, context = {} } = {}) {
  const [catalogue, imports, sales] = await Promise.all([
    loadCatalogueItems({ search, page, limit }),
    safeRows('market_sales_imports', '*', 'started_at'),
    safeRows('market_sales', '*', 'sold_at'),
  ])
  return {
    catalogue,
    imports: imports.rows,
    sales: sales.rows,
    errors: [imports.error, sales.error].filter(Boolean),
  }
}

export async function loadMarketImport(importId) {
  const { data, error } = await supabase
    .from('market_sales_imports')
    .select('*')
    .eq('id', importId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Market import not found.')
  return data
}

function saleFingerprint(candidate) {
  return [
    candidate.catalogueItemId,
    candidate.source,
    candidate.dateOfSale || candidate.soldAt,
    candidate.price ?? candidate.soldPrice,
    candidate.title,
  ].map((part) => String(part || '').trim().toLowerCase()).join('|')
}

export async function approveMarketSales({ importId, candidates, context = {} }) {
  const selected = (candidates || []).filter((candidate) => candidate.include !== false && candidate.reviewStatus !== 'EXCLUDED')
  const userId = (await supabase.auth.getUser()).data?.user?.id || null
  const rows = selected.map((candidate) => ({
    item_id: candidate.catalogueItemId,
    import_id: importId || null,
    source: candidate.source || 'CSV',
    source_sale_id: candidate.sourceSaleId || saleFingerprint(candidate),
    sale_fingerprint: candidate.sourceSaleId ? null : saleFingerprint(candidate),
    title: candidate.title || null,
    source_url: candidate.sourceUrl || null,
    sold_price: Number(candidate.price ?? candidate.soldPrice ?? 0),
    shipping_price: candidate.shippingPrice == null ? null : Number(candidate.shippingPrice || 0),
    currency: candidate.currency || 'CAD',
    market_region: candidate.marketRegion || null,
    sold_at: candidate.dateOfSale || candidate.soldAt,
    finish: candidate.finish || null,
    condition_code: candidate.conditionCode || conditionCode(candidate.normalisedCondition || candidate.condition || ''),
    condition: candidate.normalisedCondition || candidate.condition || null,
    variant: candidate.variant || null,
    language: candidate.language || null,
    is_graded: candidate.itemState === 'GRADED' || !!candidate.grader,
    grading_company: candidate.grader || null,
    grade: candidate.grade ?? null,
    grade_numeric: candidate.grade ?? null,
    grade_display: candidate.grade ? String(candidate.grade) : null,
    grading_label: candidate.gradingLabel || null,
    quantity: Math.max(1, Number(candidate.quantity || 1)),
    is_excluded: candidate.reviewStatus === 'EXCLUDED',
    exclusion_reason: candidate.exclusionReason || null,
    match_status: candidate.reviewStatus === 'REVIEW' ? 'review_required' : 'confirmed',
    match_confidence: candidate.matchConfidence ?? null,
    approved_by: userId,
    approved_at: new Date().toISOString(),
    pricing_metadata: {
      sourceCondition: candidate.rawCondition || null,
      reviewStatus: candidate.reviewStatus || null,
    },
    raw_data: candidate.rawData || {},
  }))

  if (!rows.length) return { approved: 0 }

  const data = await saveMarketSaleRows(rows)
  await updateMarketImport(importId, {
    status: 'completed',
    results_approved: data?.length || rows.length,
    results_excluded: (candidates || []).filter((candidate) => candidate.reviewStatus === 'EXCLUDED').length,
    results_review: (candidates || []).filter((candidate) => candidate.reviewStatus === 'REVIEW').length,
  })
  return { approved: data?.length || rows.length }
}

async function saveMarketSaleRows(rows) {
  const saved = []
  for (const row of rows) {
    const { data: existing, error: selectError } = await supabase
      .from('market_sales')
      .select('sale_id')
      .eq('source', row.source)
      .eq('source_sale_id', row.source_sale_id)
      .maybeSingle()
    if (selectError) throw selectError

    if (existing?.sale_id) {
      const { data, error } = await writeMarketSaleRow('update', row, existing.sale_id)
      if (error) throw error
      saved.push(data || { sale_id: existing.sale_id })
    } else {
      const { data, error } = await writeMarketSaleRow('insert', row)
      if (error) throw error
      saved.push(data || { sale_id: row.source_sale_id })
    }
  }
  return saved
}

async function writeMarketSaleRow(mode, row, saleId = null) {
  const attempts = [
    row,
    toLegacyPriceMarketSaleRow(row),
    toLegacyDateMarketSaleRow(row),
    toLegacyDateMarketSaleRow(toLegacyPriceMarketSaleRow(row)),
    toCatalogueItemMarketSaleRow(row),
    toLegacyPriceMarketSaleRow(toCatalogueItemMarketSaleRow(row)),
    toLegacyDateMarketSaleRow(toCatalogueItemMarketSaleRow(row)),
    toLegacyDateMarketSaleRow(toLegacyPriceMarketSaleRow(toCatalogueItemMarketSaleRow(row))),
  ]

  let lastResponse = null
  const tried = new Set()
  for (const attempt of attempts) {
    const signature = JSON.stringify(Object.keys(attempt).sort())
    if (tried.has(signature)) continue
    tried.add(signature)

    const response = await persistMarketSaleRow(mode, attempt, saleId)
    if (!response.error) return response
    lastResponse = response
    if (!needsMarketSaleShapeRetry(response.error)) return response
  }
  return lastResponse
}

async function persistMarketSaleRow(mode, row, saleId = null) {
  if (mode === 'update') {
    return supabase
      .from('market_sales')
      .update(row)
      .eq('sale_id', saleId)
      .select('sale_id')
      .maybeSingle()
  }
  return supabase
    .from('market_sales')
    .insert(row)
    .select('sale_id')
    .maybeSingle()
}

function needsMarketSaleShapeRetry(error) {
  const text = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase()
  return text.includes('catalogue_item_id')
    || text.includes('catalog item id')
    || text.includes("'item_id' column")
    || text.includes('item_id column')
    || text.includes("column 'item_id'")
    || text.includes('null value in column "price"')
    || text.includes("null value in column 'price'")
    || text.includes('price" violates not-null')
    || text.includes('null value in column "date_of_sale"')
    || text.includes("null value in column 'date_of_sale'")
    || text.includes('date_of_sale" violates not-null')
}

function toCatalogueItemMarketSaleRow(row) {
  const next = { ...row, catalogue_item_id: row.catalogue_item_id || row.item_id || row.catalogItemId || row.catalogueItemId }
  delete next.item_id
  return next
}

function toLegacyPriceMarketSaleRow(row) {
  return {
    ...row,
    price: row.price ?? row.sold_price ?? 0,
  }
}

function toLegacyDateMarketSaleRow(row) {
  return {
    ...row,
    date_of_sale: row.date_of_sale || row.sold_at || row.dateOfSale || null,
  }
}

export async function updateCatalogueItemRecord(itemId, patch) {
  if (!itemId) throw new Error('Missing catalogue item ID.')
  const cleanPatch = { ...patch }
  delete cleanPatch.item_id

  const { data, error } = await supabase
    .from('items')
    .update(cleanPatch)
    .eq('item_id', itemId)
    .select(CATALOGUE_SELECT.join(','))
    .maybeSingle()

  if (error) {
    backupCatalogueChange({ action: 'update', ok: false, error: error.message, itemIds: [itemId], payload: cleanPatch })
    throw error
  }
  backupCatalogueChange({ action: 'update', itemIds: [itemId] })
  return data
}

export async function loadExplorerRecords({ table, search = '', page = 1, pageSize = 25 }) {
  const selected = ADMIN_EXPLORER_TABLES.find((entry) => entry.table === table) || ADMIN_EXPLORER_TABLES[0]
  const from = Math.max(0, (page - 1) * pageSize)
  const to = from + pageSize - 1
  let query = supabase.from(selected.table).select('*', { count: 'exact' }).range(from, to)

  if (selected.order) {
    query = query.order(selected.order, { ascending: false, nullsFirst: false })
  }

  const term = search.trim()
  if (term) {
    if (selected.table === 'items') {
      const filters = [orContains('name', term), orContains('subject', term)]
      if (UUID_RE.test(term)) filters.push(`item_id.eq.${term}`)
      query = query.or(filters.join(','))
    }
    if (selected.table === 'item_details') {
      const filters = [orContains('subject', term), orContains('description', term)]
      if (UUID_RE.test(term)) filters.push(`item_id.eq.${term}`)
      query = query.or(filters.join(','))
    }
    if (!['items', 'item_details'].includes(selected.table)) query = query.limit(pageSize)
  }

  const { data, error, count: total } = await query
  if (error) throw error
  return { rows: data || [], total: total || 0, table: selected.table, config: selected }
}

export async function loadAdminCategories() {
  const { data, error } = await supabase.from('categories').select('category_id, name').order('name')
  if (error) throw error
  return data || []
}

async function safeRows(table, select, order = 'name') {
  try {
    const { data, error } = await supabase.from(table).select(select).order(order)
    if (error) throw error
    return { rows: data || [], error: '' }
  } catch (error) {
    console.warn(`[Admin Data] Taxonomy load failed for ${table}:`, error)
    return { rows: [], error: error.message || `Could not load ${table}.` }
  }
}

export async function loadTaxonomyData() {
  const [
    categories,
    subcategories,
    franchises,
    brands,
    sets,
    subsets,
    manufacturers,
    publishers,
    platforms,
    sports,
    games,
    themes,
  ] = await Promise.all([
    safeRows('categories', 'category_id, name'),
    safeRows('subcategories', 'subcategory_id, category_id, name'),
    safeRows('franchises', 'franchise_id, name'),
    safeRows('brands', 'brand_id, name'),
    safeRows('collectible_sets', 'collectible_set_id, brand_id, franchise_id, name'),
    safeRows('subsets', 'subset_id, name'),
    safeRows('manufacturers', 'manufacturer_id, name'),
    safeRows('publishers', 'publisher_id, name'),
    safeRows('platforms', 'platform_id, name'),
    safeRows('sports', 'sport_id, name'),
    safeRows('games', 'game_id, name'),
    safeRows('themes', 'theme_id, name'),
  ])

  const categoryById = Object.fromEntries(categories.rows.map((row) => [row.category_id, row.name]))
  const brandById = Object.fromEntries(brands.rows.map((row) => [row.brand_id, row.name]))
  const franchiseById = Object.fromEntries(franchises.rows.map((row) => [row.franchise_id, row.name]))

  return {
    sections: [
      {
        key: 'categories',
        title: 'Categories',
        rows: categories.rows.map((row) => ({
          id: row.category_id,
          name: row.name,
          parent: 'Root',
          type: 'Category',
        })),
        error: categories.error,
      },
      {
        key: 'subcategories',
        title: 'Subcategories',
        rows: subcategories.rows.map((row) => ({
          id: row.subcategory_id,
          name: row.name,
          parent: categoryById[row.category_id] || row.category_id || '—',
          type: 'Subcategory',
        })),
        error: subcategories.error,
      },
      {
        key: 'franchises',
        title: 'Franchises',
        rows: franchises.rows.map((row) => ({
          id: row.franchise_id,
          name: row.name,
          parent: 'Catalogue',
          type: 'Franchise',
        })),
        error: franchises.error,
      },
      {
        key: 'sets',
        title: 'Sets / Collections',
        rows: sets.rows.map((row) => ({
          id: row.collectible_set_id,
          name: row.name,
          parent: brandById[row.brand_id] || franchiseById[row.franchise_id] || '—',
          type: 'Set',
        })),
        error: sets.error,
      },
      {
        key: 'brands',
        title: 'Brands',
        rows: brands.rows.map((row) => ({ id: row.brand_id, name: row.name, parent: 'Catalogue', type: 'Brand' })),
        error: brands.error,
      },
      {
        key: 'manufacturers',
        title: 'Manufacturers / Publishers',
        rows: [
          ...manufacturers.rows.map((row) => ({ id: row.manufacturer_id, name: row.name, parent: 'Manufacturer', type: 'Manufacturer' })),
          ...publishers.rows.map((row) => ({ id: row.publisher_id, name: row.name, parent: 'Publisher', type: 'Publisher' })),
        ],
        error: manufacturers.error || publishers.error,
      },
      {
        key: 'specialized',
        title: 'Platforms / Sports / Games / Themes',
        rows: [
          ...platforms.rows.map((row) => ({ id: row.platform_id, name: row.name, parent: 'Platform', type: 'Platform' })),
          ...sports.rows.map((row) => ({ id: row.sport_id, name: row.name, parent: 'Sport', type: 'Sport' })),
          ...games.rows.map((row) => ({ id: row.game_id, name: row.name, parent: 'Game', type: 'Game' })),
          ...themes.rows.map((row) => ({ id: row.theme_id, name: row.name, parent: 'Theme', type: 'Theme' })),
          ...subsets.rows.map((row) => ({ id: row.subset_id, name: row.name, parent: 'Subset', type: 'Subset' })),
        ],
        error: platforms.error || sports.error || games.error || themes.error || subsets.error,
      },
    ],
  }
}

export async function loadImagesMediaData() {
  const [itemsMissingImages, itemImages, imageCandidates, imageJobs] = await Promise.all([
    safeRows('items', 'item_id, name, subject, image_path, category_id', 'name'),
    safeRows('item_images', 'id, item_id, image_path, source_url, source_name, is_primary, is_verified, position, updated_at', 'updated_at'),
    safeRows('image_candidates', 'id, item_id, image_url, thumb_url, source_name, match_score, status, created_at', 'created_at'),
    safeRows('image_search_jobs', 'id, item_id, status, trigger, candidates_found, error_message, created_at', 'created_at'),
  ])

  return {
    sections: [
      {
        key: 'missing',
        title: 'Items Missing Images',
        rows: itemsMissingImages.rows
          .filter((row) => !row.image_path)
          .map((row) => ({ id: row.item_id, title: row.name || row.subject || row.item_id, detail: 'No primary image path', status: 'Missing' })),
        error: itemsMissingImages.error,
      },
      {
        key: 'approved',
        title: 'Approved Images',
        rows: itemImages.rows.map((row) => ({ id: row.id, title: row.image_path, detail: row.item_id, status: row.is_primary ? 'Primary' : row.is_verified ? 'Verified' : 'Attached' })),
        error: itemImages.error,
      },
      {
        key: 'candidates',
        title: 'Image Candidates',
        rows: imageCandidates.rows.map((row) => ({ id: row.id, title: row.image_url, detail: `${row.source_name || 'Source'} · score ${row.match_score ?? 0}`, status: row.status })),
        error: imageCandidates.error,
      },
      {
        key: 'jobs',
        title: 'Image Jobs',
        rows: imageJobs.rows.map((row) => ({ id: row.id, title: row.trigger || row.id, detail: row.error_message || `${row.candidates_found || 0} candidates`, status: row.status })),
        error: imageJobs.error,
      },
    ],
  }
}

export async function loadPricingData() {
  const [itemsMissingPricing, marketPrices, conditionPrices, marketSales] = await Promise.all([
    safeRows('items', 'item_id, name, subject, market_price, retail_price', 'name'),
    safeRows('item_market_prices', '*', 'updated_at'),
    safeRows('item_condition_prices', '*', 'price_date'),
    safeRows('market_sales', '*', 'sold_at'),
  ])

  return {
    sections: [
      {
        key: 'missing',
        title: 'Items Missing Pricing',
        rows: itemsMissingPricing.rows
          .filter((row) => row.market_price == null && row.retail_price == null)
          .map((row) => ({ id: row.item_id, title: row.name || row.subject || row.item_id, detail: 'No market or retail price', status: 'Missing' })),
        error: itemsMissingPricing.error,
      },
      {
        key: 'market',
        title: 'Market Prices',
        rows: marketPrices.rows.map((row) => ({ id: row.item_id, title: row.item_id, detail: `Updated ${row.updated_at || '—'}`, status: row.market_average ?? row.tcgplayer ?? row.cardmarket ?? row.cardkingdom ?? 'Cached' })),
        error: marketPrices.error,
      },
      {
        key: 'condition',
        title: 'Condition Prices',
        rows: conditionPrices.rows.map((row) => ({ id: row.id, title: row.catalog_item_id, detail: `${row.provider || 'provider'} · ${row.condition || 'condition'} · ${row.finish || 'default'}`, status: row.display_price ?? row.source_price ?? 'No price' })),
        error: conditionPrices.error,
      },
      {
        key: 'sales',
        title: 'Sales Records',
        rows: marketSales.rows.map((row) => ({ id: row.sale_id || row.item_id, title: row.item_id || row.sale_id, detail: `${row.source || 'sale'} · ${row.sold_at || row.created_at || '—'}`, status: row.sold_price ?? 'Recorded' })),
        error: marketSales.error,
      },
    ],
  }
}

export async function loadStoresOrganizationsData() {
  const [stores, locations, employees, organizations, orgStores] = await Promise.all([
    safeRows('store_settings', '*', 'created_at'),
    safeRows('store_locations', '*', 'created_at'),
    safeRows('store_employees', '*', 'created_at'),
    safeRows('organizations', '*', 'created_at'),
    safeRows('organization_stores', '*', 'created_at'),
  ])

  return {
    sections: [
      {
        key: 'stores',
        title: 'Stores',
        rows: stores.rows.map((row) => ({ id: row.store_id || row.store_owner_id, title: row.store_name || row.name || row.store_id || row.store_owner_id, detail: row.status || row.public_profile ? 'Public profile' : 'Store', status: row.created_at || '—' })),
        error: stores.error,
      },
      {
        key: 'locations',
        title: 'Locations',
        rows: locations.rows.map((row) => ({ id: row.id, title: row.location_name || row.name || row.id, detail: [row.city, row.province].filter(Boolean).join(', ') || row.store_id, status: row.status || 'Location' })),
        error: locations.error,
      },
      {
        key: 'employees',
        title: 'Employees / Memberships',
        rows: employees.rows.map((row) => ({ id: row.id || row.employee_id, title: row.username || row.email || row.id, detail: row.store_id || row.employee_user_id || '—', status: row.role || row.status || 'Employee' })),
        error: employees.error,
      },
      {
        key: 'organizations',
        title: 'Organisations',
        rows: organizations.rows.map((row) => ({ id: row.id || row.org_id, title: row.name || row.org_code || row.id, detail: row.org_code || row.slug || '—', status: row.status || 'Organisation' })),
        error: organizations.error,
      },
      {
        key: 'orgStores',
        title: 'Organisation Stores',
        rows: orgStores.rows.map((row) => ({ id: row.id || `${row.organization_id}-${row.store_id}`, title: row.store_id || row.id, detail: row.organization_id || row.org_id || '—', status: row.status || row.role || 'Linked' })),
        error: orgStores.error,
      },
    ],
  }
}

export async function loadUsersData() {
  const [profiles, storeEmployees, orgMembers] = await Promise.all([
    safeRows('profiles', 'id, email, username, display_name, subscription_tier, created_at, updated_at', 'created_at'),
    safeRows('store_employees', '*', 'created_at'),
    safeRows('organization_members', '*', 'created_at'),
  ])

  return {
    sections: [
      {
        key: 'profiles',
        title: 'Profiles',
        rows: profiles.rows.map((row) => ({ id: row.id, title: row.display_name || row.username || row.email || row.id, detail: row.email || row.username || '—', status: row.subscription_tier || 'collector' })),
        error: profiles.error,
      },
      {
        key: 'storeEmployees',
        title: 'Store Memberships',
        rows: storeEmployees.rows.map((row) => ({ id: row.id || row.employee_id, title: row.username || row.email || row.employee_user_id || row.id, detail: row.store_id || '—', status: row.role || row.status || 'Employee' })),
        error: storeEmployees.error,
      },
      {
        key: 'orgMembers',
        title: 'Organisation Memberships',
        rows: orgMembers.rows.map((row) => ({ id: row.id || `${row.organization_id}-${row.user_id}`, title: row.user_id || row.email || row.id, detail: row.organization_id || row.org_id || '—', status: row.role || row.status || 'Member' })),
        error: orgMembers.error,
      },
    ],
  }
}

export async function updateExplorerRecord({ table, record, patch }) {
  const selected = ADMIN_EXPLORER_TABLES.find((entry) => entry.table === table)
  if (!selected) throw new Error('Unknown explorer table.')
  if (!selected.editable) throw new Error(`${selected.label} is read-only.`)

  const pk = selected.pk
  const pkValue = record?.[pk]
  if (!pk || pkValue == null) throw new Error(`Cannot update ${selected.label}: missing ${pk}.`)

  const cleanPatch = { ...patch }
  delete cleanPatch[pk]

  const { data, error } = await supabase
    .from(selected.table)
    .update(cleanPatch)
    .eq(pk, pkValue)
    .select('*')
    .maybeSingle()
  if (selected.table === 'items' || selected.table === 'item_images') {
    const itemId = selected.table === 'items' ? pkValue : record?.item_id
    backupCatalogueChange(error
      ? { action: 'update', ok: false, error: error.message, itemIds: [itemId], payload: { table: selected.table, [pk]: pkValue, patch: cleanPatch } }
      : { action: selected.table === 'items' ? 'update' : 'photos', itemIds: [itemId] })
  }

  if (error) throw error
  return data
}

function normaliseText(value) {
  return String(value || '').trim().toLowerCase()
}

function sameText(a, b) {
  return normaliseText(a) === normaliseText(b)
}

function proposedScanFields(draft) {
  const meta = draft?.metadata || {}
  const cardName = meta.cardName || meta.name || meta.subject || ''
  const cardNumber = meta.cardNumber || meta.idNumber || ''
  const year = meta.year || meta.releaseYear || ''
  const brand = meta.brand || meta.manufacturerPublisher || meta.publisherManufacturer || meta.manufacturer || ''
  const productSet = meta.set || meta.productSet || meta.collection || meta.setName || ''
  return {
    name: cardName,
    subject: meta.characterSubject || meta.subject || meta.player || cardName,
    card_number: cardNumber,
    lego_set_number: meta.setNumber || '',
    catalog_code: meta.catalogueNumber || '',
    upc: meta.barcodes || meta.barcode || meta.upc || '',
    release_year: year ? Number(year) || year : '',
    manufacturer: brand,
    collectible_set: productSet,
    subcategory: meta.subcategory || '',
    franchise: meta.franchise || '',
    subfranchise: meta.subfranchise || '',
    property: meta.property || '',
    item_type: meta.itemType || '',
    collection: productSet,
    id_number: cardNumber,
    publisher_manufacturer: brand,
    description: meta.description || '',
    retail_price: meta.retailPrice || '',
    availability: meta.availability || '',
    barcodes: meta.barcodes || meta.barcode || '',
    includes: meta.includes || '',
    included_in: meta.includedIn || '',
    variant: meta.variant || '',
    language: meta.language || '',
    country: meta.country || '',
    notes: meta.notes || '',
    player: meta.player || '',
    subset_insert_set: meta.subsetInsertSet || '',
    sport: meta.sport || '',
    league: meta.league || '',
    team: meta.team || '',
    position: meta.position || '',
    rookie_card: meta.rookieCard || '',
    base_insert: meta.baseInsert || '',
    parallel: meta.parallel || '',
    parallel_colour: meta.parallelColour || '',
    variation: meta.variation || '',
    serial_numbered: meta.serialNumbered || '',
    serial_number: meta.serialNumber || '',
    print_run: meta.printRun || '',
    autograph: meta.autograph || '',
    autograph_type: meta.autographType || '',
    memorabilia_relic: meta.memorabiliaRelic || '',
    memorabilia_type: meta.memorabiliaType || '',
    memorabilia_source: meta.memorabiliaSource || '',
    patch_type: meta.patchType || '',
    rookie_patch_auto: meta.rookiePatchAuto || '',
    short_print: meta.shortPrint || '',
    super_short_print: meta.superShortPrint || '',
    case_hit: meta.caseHit || '',
    error_correction: meta.errorCorrection || '',
    multi_player_card: meta.multiPlayerCard || '',
    other_players: meta.otherPlayers || '',
    draft_team: meta.draftTeam || '',
    college_junior_team: meta.collegeJuniorTeam || '',
    grading_company: meta.gradingCompany || '',
    grade: meta.grade || '',
    subgrades: meta.subgrades || '',
    certification_number: meta.certificationNumber || '',
    raw_condition: meta.rawCondition || '',
    market_value: meta.marketValue || '',
    last_sale: meta.lastSale || '',
    price_updated: meta.priceUpdated || '',
    external_ids: meta.externalIds || '',
    series_block: meta.seriesBlock || '',
    franchise_game: meta.franchiseGame || '',
    release_date: meta.releaseDate || '',
    rarity: meta.rarity || '',
    variant_parallel: meta.variantParallel || '',
    finish: meta.finish || '',
    edition: meta.edition || '',
    card_type: meta.cardType || '',
    character_subject: meta.characterSubject || '',
    card_attributes: meta.cardAttributes || '',
    artist: meta.artist || '',
    promo: meta.promo || '',
    promo_number: meta.promoNumber || '',
    error_variation: meta.errorVariation || '',
    tcgplayer_id: meta.tcgplayerId || '',
    ebay_external_ids: meta.ebayExternalIds || '',
  }
}

function scoreScanCandidate(row, proposed) {
  let score = 0
  const reasons = []

  if (proposed.upc && sameText(row.upc, proposed.upc)) {
    score += 55
    reasons.push('Exact barcode/UPC match')
  }
  if (proposed.card_number && sameText(row.card_number, proposed.card_number)) {
    score += 18
    reasons.push('Card/item number match')
  }
  if (proposed.lego_set_number && sameText(row.lego_set_number, proposed.lego_set_number)) {
    score += 45
    reasons.push('Set number match')
  }
  if (proposed.catalog_code && sameText(row.catalog_code, proposed.catalog_code)) {
    score += 35
    reasons.push('Catalogue number match')
  }
  if (proposed.release_year && String(row.release_year || '') === String(proposed.release_year)) {
    score += 8
    reasons.push('Year match')
  }
  let titleMatch = false
  const itemName = normaliseText(row.name || row.subject)
  if (proposed.name && itemName) {
    const proposedName = normaliseText(proposed.name)
    if (itemName === proposedName) {
      score += 28
      titleMatch = true
      reasons.push('Exact title match')
    } else if (itemName.includes(proposedName) || proposedName.includes(itemName)) {
      score += 14
      titleMatch = true
      reasons.push('Similar title')
    }
  }
  // Name + number + year alone scored 54, just under the duplicate threshold;
  // set and brand separate the same card from a different product line.
  const itemSet = normaliseText(row.dynamic_fields?.set_name || row.dynamic_fields?.collection)
  const proposedSet = normaliseText(proposed.collectible_set)
  if (itemSet && proposedSet && (itemSet.includes(proposedSet) || proposedSet.includes(itemSet))) {
    score += 12
    reasons.push('Set match')
  }
  if (proposed.manufacturer && sameText(row.dynamic_fields?.manufacturer, proposed.manufacturer)) {
    score += 6
    reasons.push('Brand match')
  }

  const identifierMatch = reasons.some((reason) => ['Exact barcode/UPC match', 'Set number match', 'Catalogue number match'].includes(reason))
  const numberMatch = reasons.includes('Card/item number match')
  return {
    score: Math.min(100, score),
    reasons,
    // Strong enough that adding a new item is probably a duplicate.
    likelyDuplicate: identifierMatch || (titleMatch && numberMatch) || (titleMatch && score >= 50),
  }
}

// Below this a candidate is only listed as "similar", not reported as a match.
const MATCH_MIN_SCORE = 40

function compareScanFields(current, proposed) {
  const fieldMap = [
    ['name', current.name || current.subject, proposed.name],
    ['year', current.release_year, proposed.release_year],
    ['card_number', current.card_number || current.lego_set_number || current.minifig_code || current.catalog_code, proposed.card_number || proposed.lego_set_number || proposed.catalog_code],
    ['barcode', current.upc, proposed.upc],
    ['manufacturer', current.manufacturer_name || current.dynamic_fields?.manufacturer, proposed.manufacturer],
    ['set_or_series', current.collectible_set || current.dynamic_fields?.set_name, proposed.collectible_set],
    ['variant', current.dynamic_fields?.variant || current.dynamic_fields?.parallel, proposed.variant],
    ['language', current.dynamic_fields?.language, proposed.language],
    ['country', current.country || current.dynamic_fields?.country, proposed.country],
  ]

  return fieldMap
    .filter(([, , scannerValue]) => scannerValue !== '' && scannerValue != null)
    .map(([field, currentValue, scannerValue]) => ({
      field,
      currentValue: currentValue ?? '',
      proposedValue: scannerValue ?? '',
      differs: normaliseText(currentValue) !== normaliseText(scannerValue),
      confidence: ['barcode', 'card_number'].includes(field) ? 92 : 78,
      decision: 'pending',
      source: 'scanner metadata',
    }))
}

// Only items in the scan's category are candidates: a sports card never
// matches a trading card or a LEGO set. `categoryId: null` means the category
// could not be resolved, which returns nothing rather than every category.
async function searchCatalogueCandidates(proposed, { categoryId } = {}) {
  if (categoryId === null) return []
  const filters = []
  if (proposed.upc) filters.push(orEq('upc', proposed.upc))
  if (proposed.card_number) filters.push(orContains('card_number', proposed.card_number))
  if (proposed.lego_set_number) filters.push(orEq('lego_set_number', proposed.lego_set_number))
  if (proposed.catalog_code) filters.push(orContains('catalog_code', proposed.catalog_code))
  if (proposed.name) filters.push(orContains('name', proposed.name), orContains('subject', proposed.name))
  if (!filters.length) return []

  let query = supabase
    .from('items')
    .select(CATALOGUE_SELECT.join(','))
    .or(filters.join(','))
  if (categoryId) query = query.eq('category_id', categoryId)
  const { data, error } = await query.limit(25)
  if (error) throw error

  return (data || [])
    .map((row) => {
      const scored = scoreScanCandidate(row, proposed)
      return {
        item: { ...row, imageUrl: publicImageUrl(row.image_path) },
        score: scored.score,
        reasons: scored.reasons,
        likelyDuplicate: scored.likelyDuplicate,
        comparisons: compareScanFields(row, proposed),
      }
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
}

// Re-checks the live catalogue right before "Add to Catalogue". A draft's
// stored candidates are from when it was analysed, so they miss items added
// since, e.g. from another scan of the same card earlier in the queue.
export async function findDuplicateCatalogueItems(values = {}, { category } = {}) {
  const proposed = {
    name: String(values.name || '').trim(),
    card_number: String(values.card_number || '').trim(),
    upc: String(values.upc || '').trim(),
    lego_set_number: String(values.lego_set_number || '').trim(),
    catalog_code: String(values.catalog_code || '').trim(),
    release_year: String(values.release_year || '').trim(),
    collectible_set: String(values.set_name || '').trim(),
    manufacturer: String(values.manufacturer || '').trim(),
  }
  const candidates = await searchCatalogueCandidates(proposed, { categoryId: await categoryIdForName(category) })
  return candidates.filter((candidate) => candidate.likelyDuplicate)
}

// Live candidate search for the review screen's currently selected category.
export async function searchScanCandidates(draft, category) {
  return searchCatalogueCandidates(proposedScanFields(draft), { categoryId: await categoryIdForName(category) })
}

export async function identifyScannedDraft(draft) {
  const proposed = proposedScanFields(draft)

  const hasIdentity = Boolean(proposed.upc || proposed.card_number || proposed.lego_set_number || proposed.catalog_code || proposed.name)
  if (!hasIdentity && draft?.ocr?.rawText) {
    return {
      route: 'ocr_review_needed',
      status: 'OCR Review Needed',
      proposed,
      bestMatch: null,
      candidates: [],
      confidence: 0,
      analyzedAt: new Date().toISOString(),
      ocr: draft.ocr,
    }
  }

  const candidates = await searchCatalogueCandidates(proposed, { categoryId: await categoryIdForName(draft?.category) })
  const best = candidates[0]?.score >= MATCH_MIN_SCORE || candidates[0]?.likelyDuplicate ? candidates[0] : null
  const hasConflicts = !!best?.comparisons?.some((comparison) => comparison.differs)
  let route = 'new_item_proposal'
  let status = 'Proposed New Item'

  if (best?.score >= 95 && !hasConflicts) {
    route = 'existing_match'
    status = 'Matched'
  } else if (best?.score >= 80) {
    route = hasConflicts ? 'manual_review_existing_item' : 'existing_match'
    status = hasConflicts ? 'Manual Review - Existing Item' : 'Matched'
  } else if (best?.score >= 55 || best?.likelyDuplicate) {
    route = 'possible_duplicate'
    status = 'Manual Review - Possible Duplicate'
  }

  return {
    route,
    status,
    proposed,
    bestMatch: best,
    candidates,
    confidence: best?.score || 0,
    analyzedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Scan review field table. One definition per catalogue field drives reading
// an existing item, comparing it with the scan, and writing the approved
// values. `column` fields live on the items row; `path` fields live under
// items.dynamic_fields in the same shape scans have always been written in.

const TRADING_CARD_KEYS = [
  'series_block', 'franchise_game', 'release_date', 'rarity', 'variant_parallel', 'finish', 'language', 'edition',
  'card_type', 'character_subject', 'card_attributes', 'artist', 'serial_number', 'print_run', 'promo', 'promo_number',
  'autograph', 'memorabilia_relic', 'rookie_card', 'short_print', 'error_variation', 'grading_company', 'grade',
  'certification_number', 'raw_condition', 'market_value', 'last_sale', 'price_updated', 'tcgplayer_id', 'ebay_external_ids',
]

function fieldLabel(key) {
  const text = key.replaceAll('_', ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export const SCAN_REVIEW_GROUPS = [
  {
    id: 'core',
    label: 'Catalogue identity',
    fields: [
      { key: 'name', label: 'Name', column: 'name', required: true },
      { key: 'subject', label: 'Subject', column: 'subject' },
      { key: 'card_number', label: 'Card / item number', column: 'card_number' },
      { key: 'release_year', label: 'Year', column: 'release_year', type: 'number' },
      { key: 'manufacturer', label: 'Brand / manufacturer', path: ['manufacturer'] },
      { key: 'set_name', label: 'Set', path: ['set_name'], proposedKey: 'collectible_set' },
      { key: 'upc', label: 'Barcode / UPC', column: 'upc' },
      { key: 'catalog_code', label: 'Catalogue code', column: 'catalog_code' },
      { key: 'lego_set_number', label: 'LEGO set number', column: 'lego_set_number', categories: ['LEGO / Building Blocks'] },
      { key: 'variant', label: 'Variant', path: ['variant'] },
      { key: 'language', label: 'Language', path: ['language'] },
      { key: 'country', label: 'Country', path: ['country'] },
      { key: 'retail_price', label: 'Retail price', column: 'retail_price', type: 'number' },
      { key: 'availability', label: 'Availability', column: 'availability' },
      { key: 'description', label: 'Description', path: ['description'], multiline: true },
      { key: 'notes', label: 'Notes', path: ['notes'], multiline: true },
    ],
  },
  {
    id: 'trading',
    label: 'Trading card details',
    categories: ['Trading Cards'],
    fields: TRADING_CARD_KEYS.map((key) => ({ key: `trading_card.${key}`, label: fieldLabel(key), path: ['trading_card', key], proposedKey: key })),
  },
  {
    id: 'taxonomy',
    label: 'Taxonomy',
    fields: ['subcategory', 'franchise', 'subfranchise', 'property', 'item_type', 'collection', 'includes', 'included_in'].map((key) => ({
      key: ['collection', 'includes', 'included_in'].includes(key) ? key : `taxonomy.${key}`,
      label: fieldLabel(key),
      path: ['collection', 'includes', 'included_in'].includes(key) ? [key] : ['taxonomy', key],
      proposedKey: key,
    })),
  },
]

// Trading Cards (Pokémon, Magic: The Gathering, Yu-Gi-Oh!, One Piece...)
// follows the CollectorsHub Trading Cards spec: the cascade is brand ›
// franchise › era/storyline › release, and the card metadata uses the same
// dynamic_fields keys as the website's Trading Cards form (traits and
// abilities are lists).
const TRADING_CARD_METADATA = [
  ['evolves_from', 'Evolves From'],
  ['evolves_to', 'Evolves To'],
  ['attack', 'Attack'],
  ['health', 'Health'],
  ['damage', 'Damage'],
  ['shields', 'Shields'],
  ['type', 'Type'],
  ['traits', 'Traits', { list: true }],
  ['abilities', 'Abilities', { list: true }],
  ['weakness', 'Weakness'],
  ['resistance', 'Resistance'],
  ['artist', 'Artist'],
  ['language', 'Language'],
  ['legal', 'Legal'],
  ['cost', 'Cost'],
  ['finish', 'Finish'],
  ['unit_level', 'Unit Level'],
]

export const TRADING_DYNAMIC_KEYS = TRADING_CARD_METADATA.map(([key]) => key)

const TRADING_REVIEW_GROUPS = [
  {
    id: 'taxonomy',
    label: 'Cascading Taxonomy',
    fields: [
      { key: 'subcategory_id', label: 'Subcategory (brand)', column: 'subcategory_id', taxonomy: 'subcategory', required: true, scan: (meta) => meta.brand || meta.game },
      { key: 'franchise_id', label: 'Franchise', column: 'franchise_id', taxonomy: 'franchise', scan: (meta) => meta.franchise },
      { key: 'subset_id', label: 'Subfranchise (era / storyline)', column: 'subset_id', taxonomy: 'subset', scan: (meta) => meta.series || meta.era },
      { key: 'property_id', label: 'Property (release)', taxonomy: 'property', scan: (meta) => meta.set || meta.setName },
      { key: 'item_type_id', label: 'Item Type', column: 'item_type_id', taxonomy: 'item_type', scan: () => 'Card' },
    ],
  },
  {
    id: 'facets',
    label: 'Attached Facets',
    fields: [
      { key: 'collection', label: 'Collection', path: ['collection'], scan: (meta) => meta.collection },
      { key: 'subject', label: 'Subject (what it depicts)', column: 'subject', required: true, scan: (meta) => meta.cardName || meta.subject || meta.name },
      { key: 'card_number', label: 'ID Number', column: 'card_number', scan: (meta) => meta.cardNumber || meta.idNumber },
      { key: 'publisher_id', label: 'Publisher / Manufacturer', column: 'publisher_id', taxonomy: 'publisher', scan: (meta) => meta.publisher || meta.manufacturer },
    ],
  },
  {
    id: 'item',
    label: 'Item Metadata',
    fields: [
      { key: 'description', label: 'Description', column: 'description', multiline: true, scan: (meta) => meta.description },
      { key: 'retail_price', label: 'Retail Price', column: 'retail_price', type: 'number', scan: () => '' },
      { key: 'release_year', label: 'Release Year', column: 'release_year', type: 'number', scan: (meta) => meta.year || meta.releaseYear },
      { key: 'availability', label: 'Availability', column: 'availability', scan: () => '' },
      { key: 'upc', label: 'Barcodes', column: 'upc', scan: (meta) => meta.barcodes || meta.barcode },
      { key: 'includes', label: 'Includes', path: ['includes'], scan: () => '' },
      { key: 'included_in', label: 'Included In', path: ['included_in'], scan: () => '' },
      { key: 'source', label: 'Source (internal provenance)', path: ['source'], scan: () => '' },
    ],
  },
  {
    id: 'card',
    label: 'Card Metadata',
    fields: TRADING_CARD_METADATA.map(([key, label, extra = {}]) => ({
      key,
      label: extra.list ? `${label} (one per line)` : label,
      path: [key],
      ...(extra.list ? { list: true, multiline: true } : {}),
      scan: (meta) => meta[key],
    })),
  },
]

// Sports Cards follows the website's finalized Add Item spec exactly
// (Nordvik docs/add-item-form-spec.md, "Sports Cards — FINALIZED"): the same
// sections, fields, columns, link tables and dynamic_fields keys as the
// website's form, so scanned cards and website-created cards are identical.
export const SPORTS_CARD_TYPE_OPTIONS = ['Base', 'Insert', 'Autograph', 'Patch', 'Autograph Patch']
const YES_NO_OPTIONS = ['Yes', 'No']

function joinScanText(...parts) {
  return parts.map((part) => String(part || '').trim()).filter(Boolean).join(' ')
}

const SPORTS_REVIEW_GROUPS = [
  {
    id: 'taxonomy',
    label: 'Cascading Taxonomy',
    fields: [
      { key: 'subcategory_id', label: 'Subcategory (sport)', column: 'subcategory_id', taxonomy: 'subcategory', required: true, scan: (meta) => meta.sport },
      { key: 'franchise_id', label: 'Franchise (league)', column: 'franchise_id', taxonomy: 'franchise', scan: (meta) => meta.league },
      { key: 'subset_id', label: 'Subfranchise (product line)', column: 'subset_id', taxonomy: 'subset', scan: (meta) => meta.productSet },
      // Property is linked through item_properties, not an items column.
      { key: 'property_id', label: 'Property (release/set)', taxonomy: 'property', scan: (meta) => joinScanText(meta.year || meta.releaseYear, meta.brand, meta.productSet) },
      { key: 'item_type_id', label: 'Item Type', column: 'item_type_id', taxonomy: 'item_type', scan: () => 'Card' },
    ],
  },
  {
    id: 'facets',
    label: 'Attached Facets',
    fields: [
      { key: 'collection', label: 'Collection', path: ['collection'], scan: (meta) => meta.subsetInsertSet || meta.collection },
      { key: 'subject', label: 'Subject (player)', column: 'subject', required: true, personName: true, scan: (meta) => meta.player || meta.cardName || meta.subject || meta.name },
      { key: 'card_number', label: 'ID Number', column: 'card_number', scan: (meta) => meta.cardNumber || meta.idNumber },
      { key: 'publisher_id', label: 'Publisher / Manufacturer', column: 'publisher_id', taxonomy: 'publisher', scan: (meta) => meta.brand || meta.manufacturerPublisher },
    ],
  },
  {
    id: 'item',
    label: 'Item Metadata',
    fields: [
      { key: 'description', label: 'Description', column: 'description', multiline: true, scan: (meta) => meta.description },
      { key: 'release_year', label: 'Release Year', column: 'release_year', type: 'number', scan: (meta) => meta.year || meta.releaseYear },
      { key: 'upc', label: 'Barcodes', column: 'upc', scan: (meta) => meta.barcodes || meta.barcode },
      { key: 'source', label: 'Source (internal provenance)', path: ['source'], scan: () => '' },
    ],
  },
  {
    id: 'card',
    label: 'Card Metadata',
    fields: [
      { key: 'card_type', label: 'Card Type', path: ['card_type'], options: SPORTS_CARD_TYPE_OPTIONS, scan: (meta) => meta.baseInsert },
      { key: 'team', label: 'Team', path: ['team'], scan: (meta) => meta.team },
      { key: 'rookie', label: 'Rookie', path: ['rookie'], options: YES_NO_OPTIONS, scan: (meta) => meta.rookieCard },
      { key: 'parallel', label: 'Parallel', path: ['parallel'], scan: (meta) => joinScanText(meta.parallelColour, meta.parallel) },
      { key: 'variation', label: 'Variation', path: ['variation'], scan: (meta) => meta.variation },
      { key: 'serial_numbering', label: 'Serial Numbering', path: ['serial_numbering'], scan: (meta) => meta.serialNumber },
      { key: 'autograph', label: 'Autograph', path: ['autograph'], options: YES_NO_OPTIONS, scan: (meta) => meta.autograph },
      { key: 'autograph_type', label: 'Autograph Type', path: ['autograph_type'], scan: (meta) => meta.autographType },
      { key: 'relic', label: 'Memorabilia / Relic', path: ['relic'], options: YES_NO_OPTIONS, scan: (meta) => meta.memorabiliaRelic },
      // dynamic_fields.finish is already read by the completion views.
      { key: 'finish', label: 'Finish', path: ['finish'], scan: (meta) => meta.finish },
    ],
  },
]

// Review field key -> local AI recognition result key.
export const AI_FIELD_FOR_REVIEW_KEY = {
  // Trading Cards card metadata ('type' is the game classification, kept
  // apart from the sports card_type).
  evolves_from: 'evolves_from',
  evolves_to: 'evolves_to',
  attack: 'attack',
  health: 'health',
  damage: 'damage',
  shields: 'shields',
  type: 'tcg_type',
  traits: 'traits',
  abilities: 'abilities',
  weakness: 'weakness',
  resistance: 'resistance',
  artist: 'artist',
  language: 'language',
  legal: 'legal',
  cost: 'cost',
  unit_level: 'unit_level',
  subcategory_id: 'subcategory',
  franchise_id: 'franchise',
  subset_id: 'subfranchise',
  property_id: 'property',
  item_type_id: 'item_type',
  collection: 'collection',
  subject: 'subject',
  name: 'subject',
  card_number: 'id_number',
  publisher_id: 'publisher_manufacturer',
  manufacturer: 'publisher_manufacturer',
  description: 'description',
  release_year: 'release_year',
  upc: 'barcodes',
  card_type: 'card_type',
  team: 'team',
  rookie: 'rookie',
  parallel: 'parallel',
  variation: 'variation',
  serial_numbering: 'serial_numbering',
  autograph: 'autograph',
  autograph_type: 'autograph_type',
  relic: 'memorabilia_relic',
  finish: 'finish',
}

// A card from the release's base set: not an insert/autograph/relic card and
// not in a named collection.
export function isBaseSetCard(card = {}) {
  return !/insert|autograph|patch|relic/i.test(String(card.card_type || ''))
}

// "Base" and an empty collection are the same thing (older catalogue items
// were saved with it blank).
function collectionKey(value) {
  const text = matchText(value)
  return text === 'base' ? '' : text
}

export function recognitionResult(draft) {
  return draft?.recognition?.status === 'done' ? draft.recognition.result || null : null
}

function aiValueText(value) {
  if (value == null) return ''
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean).join('\n')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value).trim()
}

export function isSpecCategory(category) {
  return category === 'Sports Cards' || category === 'Trading Cards'
}

export function scanReviewGroups(category) {
  if (category === 'Sports Cards') return SPORTS_REVIEW_GROUPS
  if (category === 'Trading Cards') return TRADING_REVIEW_GROUPS
  return SCAN_REVIEW_GROUPS
    .filter((group) => !group.categories || group.categories.includes(category))
    .map((group) => ({ ...group, fields: group.fields.filter((field) => !field.categories || field.categories.includes(category)) }))
}

function readPath(object, path) {
  return path.reduce((current, key) => (current && typeof current === 'object' ? current[key] : undefined), object)
}

function reviewText(value) {
  if (value == null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value).trim()
}

export function catalogueFieldValue(item, field) {
  if (!item) return ''
  // Property is a link-table value, loaded onto the item as _property_id.
  if (field.taxonomy === 'property') return reviewText(item._property_id)
  if (field.column) return reviewText(item[field.column])
  const leaf = field.path[field.path.length - 1]
  const value = readPath(item.dynamic_fields, field.path) ?? item.dynamic_fields?.[leaf] ?? item.attributes?.[leaf]
  if (field.list) return (Array.isArray(value) ? value : value ? [value] : []).map((entry) => String(entry).trim()).filter(Boolean).join('\n')
  return reviewText(value)
}

// OCR returns names in capitals ("MICAH PARSONS"); store them as "Micah Parsons".
const PERSON_NAME_FIELDS = new Set(['name', 'subject'])

function titleCaseIfShouting(value) {
  if (!/[A-Z]{2}/.test(value) || value !== value.toUpperCase()) return value
  // '/' separates players on multi-player cards ('JORDAN TRAVIS/MALACHI CORLEY').
  return value.toLowerCase().replace(/(^|[\s'./-])([a-z])/g, (match, separator, letter) => separator + letter.toUpperCase())
}

// For taxonomy fields this is the scanned text (e.g. "NFL"); the review screen
// resolves it to a taxonomy row.
export function scannedFieldValue(draft, field) {
  let value
  const ai = recognitionResult(draft)
  if (ai && field.key === 'source') {
    // Provenance is set by the app, never by the model.
    value = 'AI Card Scan'
  } else if (ai && AI_FIELD_FOR_REVIEW_KEY[field.key]) {
    // The AI reading replaces OCR and the intake form's defaults entirely: a
    // null means "not determinable", not "fall back to a guess".
    value = aiValueText(ai[AI_FIELD_FOR_REVIEW_KEY[field.key]])
    // Base-set cards have no named collection; the catalogue calls it "Base".
    if (field.key === 'collection' && !value && isBaseSetCard(ai) && !/trading/i.test(String(ai.category || draft?.category || ''))) value = 'Base'
  } else if (field.scan) {
    value = reviewText(field.scan(draft?.metadata || {}))
  } else {
    const proposed = proposedScanFields(draft)
    const key = field.proposedKey || field.key
    value = key === 'upc' ? reviewText(proposed.upc || proposed.barcodes) : reviewText(proposed[key])
  }
  if (field.key === 'team') return cleanTeamName(value)
  return field.personName || PERSON_NAME_FIELDS.has(field.key) ? titleCaseIfShouting(value) : value
}

// Team names as printed on cards: drop trademark symbols and fix capitals
// ("vancouver CANUCKS®" -> "Vancouver Canucks").
export function cleanTeamName(value) {
  // Trademark symbols (registered, trade mark, copyright).
  const plain = String(value || '').replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim()
  if (!plain) return plain
  const messy = /^[a-z]/.test(plain) || /\b[A-Z]{4,}\b/.test(plain)
  return messy ? plain.toLowerCase().replace(/(^|[\s.-])([a-z])/g, (match, separator, letter) => separator + letter.toUpperCase()) : plain
}

function reviewColumnValue(field, value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  if (field.type === 'number') return Number(text.replace(/[^0-9.-]/g, '')) || null
  return text
}

function writeDynamicFields(baseDynamicFields, groups, values, { dropEmpty = false } = {}) {
  const dynamicFields = JSON.parse(JSON.stringify(baseDynamicFields || {}))
  groups.flatMap((group) => group.fields).filter((field) => field.path).forEach((field) => {
    let target = dynamicFields
    field.path.slice(0, -1).forEach((key) => {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {}
      target = target[key]
    })
    const leaf = field.path[field.path.length - 1]
    const value = String(values[field.key] ?? '').trim()
    // The website's form stores only filled dynamic fields.
    if (dropEmpty && !value) delete target[leaf]
    else if (field.list) target[leaf] = value.split('\n').map((entry) => entry.trim()).filter(Boolean)
    else target[leaf] = value
  })
  return dynamicFields
}

// Scan Intake category labels that differ from the catalogue's category names.
const CATALOGUE_CATEGORY_NAMES = {
  'LEGO / Building Blocks': 'Building Blocks',
  Coins: 'Currency, Medals, & Stamps',
}
const categoryIdCache = new Map()

export function catalogueCategoryName(categoryLabel) {
  return CATALOGUE_CATEGORY_NAMES[categoryLabel] || categoryLabel || ''
}

export async function categoryIdForName(categoryName) {
  if (!categoryName) return null
  const name = CATALOGUE_CATEGORY_NAMES[categoryName] || categoryName
  if (categoryIdCache.has(name)) return categoryIdCache.get(name)
  const exact = await supabase.from('categories').select('category_id').ilike('name', name).limit(1).maybeSingle()
  let categoryId = exact.data?.category_id || null
  if (!categoryId) {
    const { data } = await supabase.from('categories').select('category_id').ilike('name', `%${name}%`).limit(1).maybeSingle()
    categoryId = data?.category_id || null
  }
  if (categoryId) categoryIdCache.set(name, categoryId)
  return categoryId
}

// Admin scans REPLACE an item's catalogue photos: front at position 0 (what
// the website shows via item_details.front_image_path) and back at position 1,
// stored like the website's Add Item form (item-images/items/<id>/<ts>_<pos>.<ext>).
// Uploads happen first, so a failed upload leaves the current photos intact.
// Old files stay in storage; only the item_images rows and items.image_path
// are switched to the scans. Returns warning strings (empty on success).
async function attachItemImages(itemId, images = []) {
  if (!images.length) return []
  const uploaded = []
  for (const image of images) {
    const path = `items/${itemId}/${Date.now()}_${image.position}.${image.ext || 'jpg'}`
    const { error: uploadError } = await supabase.storage.from(IMAGE_BUCKET).upload(path, image.blob, { contentType: image.blob.type || 'image/jpeg' })
    if (uploadError) return [`Image upload failed: ${uploadError.message}. The existing catalogue photos were kept.`]
    uploaded.push({ item_id: itemId, image_path: path, position: image.position })
  }
  const { error: deleteError } = await supabase.from('item_images').delete().eq('item_id', itemId)
  if (deleteError) return [`Image upload failed: could not replace the existing photos (${deleteError.message}). The existing catalogue photos were kept.`]
  const { error: rowError } = await supabase.from('item_images').insert(uploaded)
  if (rowError) return [`Image record save failed: ${rowError.message}`]
  const front = uploaded.find((row) => row.position === 0) || uploaded[0]
  const { error: itemError } = await supabase.from('items').update({ image_path: front.image_path }).eq('item_id', itemId)
  backupCatalogueChange({ action: 'photos', itemIds: [itemId] })
  return itemError ? [`Front image link not updated: ${itemError.message}`] : []
}

// Swaps an item's front (position 0) and back (position 1) photos, e.g. when
// a scan was saved the wrong way round. The website shows position 0 as the
// front, and items.image_path follows it.
export async function swapItemFrontBack(itemId) {
  const { data: rows, error } = await supabase.from('item_images').select('item_image_id, image_path, position').eq('item_id', itemId).in('position', [0, 1])
  if (error) throw error
  const front = (rows || []).find((row) => row.position === 0)
  const back = (rows || []).find((row) => row.position === 1)
  if (!front || !back) throw new Error('This item needs both a front and a back photo to swap them.')
  // Via a temporary position, in case (item_id, position) must stay unique.
  const steps = [[front.item_image_id, { position: 99 }], [back.item_image_id, { position: 0, is_primary: true }], [front.item_image_id, { position: 1, is_primary: false }]]
  for (const [id, patch] of steps) {
    const { error: stepError } = await supabase.from('item_images').update(patch).eq('item_image_id', id)
    if (stepError) throw stepError
  }
  const { error: itemError } = await supabase.from('items').update({ image_path: back.image_path }).eq('item_id', itemId)
  if (itemError) throw itemError
  backupCatalogueChange({ action: 'photos', itemIds: [itemId] })
}

// Number of catalogue images an item already has (item_images rows).
export async function countItemImages(itemId) {
  if (!itemId) return 0
  const { count, error } = await supabase.from('item_images').select('item_id', { count: 'exact', head: true }).eq('item_id', itemId)
  if (error) throw error
  return count || 0
}

// Replaces an existing catalogue item's photos with the scans.
// Returns { attached, warnings }.
export async function attachScanImagesToItem(itemId, images = []) {
  const warnings = await attachItemImages(itemId, images)
  return { attached: warnings.some((warning) => warning.startsWith('Image upload failed')) ? 0 : images.length, warnings }
}

function itemNameFromValues(category, values) {
  return String((isSpecCategory(category) ? values.subject : values.name) || '').trim()
}

export async function createCatalogueItemFromReview({ category, values, confidence = null, images = [] }) {
  const groups = scanReviewGroups(category)
  const name = itemNameFromValues(category, values)
  const trading = category === 'Trading Cards'
  if (!name) throw new Error(isSpecCategory(category) ? `A Subject (${trading ? 'what the card depicts' : 'player'}) is required before adding the card to the catalogue.` : 'A name is required before adding the item to the catalogue.')
  if (isSpecCategory(category) && !values.subcategory_id) throw new Error(`Select a Subcategory (${trading ? 'brand' : 'sport'}) before adding the card to the catalogue.`)

  const payload = { category_id: await categoryIdForName(category) }
  groups.flatMap((group) => group.fields).filter((field) => field.column).forEach((field) => {
    payload[field.column] = reviewColumnValue(field, values[field.key])
  })
  if (isSpecCategory(category)) {
    // Matches the website's Add Item insert: the display name is the Subject.
    payload.name = name
    payload.completion_eligible = true
  }
  payload.dynamic_fields = writeDynamicFields({
    scanner_source: 'CollectorsHub Desktop scanner',
    scanner_confidence: confidence,
  }, groups, values, { dropEmpty: isSpecCategory(category) })

  const { data, error } = await supabase.from('items').insert(payload).select(CATALOGUE_SELECT.join(',')).single()
  if (error) {
    // Kept in the local backup so the card isn't lost.
    backupCatalogueChange({ action: 'create', ok: false, error: error.message, payload: { category, ...payload, property_id: values.property_id || null } })
    throw error
  }

  const warnings = []
  if (values.property_id) {
    const { error: propertyError } = await supabase.from('item_properties').insert({ item_id: data.item_id, property_id: values.property_id })
    if (propertyError) warnings.push(`Property link failed: ${propertyError.message}`)
  }
  warnings.push(...await attachItemImages(data.item_id, images))
  backupCatalogueChange({ action: 'create', itemIds: [data.item_id] })
  return { ...data, warnings }
}

// Writes only the fields whose final value differs from the catalogue item, and
// keeps any dynamic_fields keys the review table does not know about.
export async function updateCatalogueItemFromReview({ item, category, values, images = [] }) {
  const groups = scanReviewGroups(category)
  const fields = groups.flatMap((group) => group.fields)
  const changed = fields.filter((field) => String(values[field.key] ?? '').trim() !== catalogueFieldValue(item, field))
  const warnings = []
  let updated = item

  if (changed.length) {
    const patch = {}
    changed.filter((field) => field.column).forEach((field) => {
      patch[field.column] = reviewColumnValue(field, values[field.key])
    })
    if (isSpecCategory(category) && changed.some((field) => field.key === 'subject')) patch.name = itemNameFromValues(category, values)
    if (changed.some((field) => field.path)) {
      patch.dynamic_fields = writeDynamicFields(item.dynamic_fields, groups, values, { dropEmpty: isSpecCategory(category) })
    }
    if (Object.keys(patch).length) updated = await updateCatalogueItemRecord(item.item_id, patch)

    if (changed.some((field) => field.taxonomy === 'property')) {
      const { error: deleteError } = await supabase.from('item_properties').delete().eq('item_id', item.item_id)
      if (deleteError) warnings.push(`Property link update failed: ${deleteError.message}`)
      else if (values.property_id) {
        const { error: insertError } = await supabase.from('item_properties').insert({ item_id: item.item_id, property_id: values.property_id })
        if (insertError) warnings.push(`Property link update failed: ${insertError.message}`)
      }
    }
  }

  warnings.push(...await attachItemImages(item.item_id, images))
  return { item: updated, changed: changed.map((field) => field.key), warnings }
}

// ---------------------------------------------------------------------------
// Cascading taxonomy for the Sports Cards review, loaded exactly as the
// website's Add Item form loads it:
//   Subcategory  <- subcategories.category_id
//   Franchise    <- franchise_subcategory links (+ franchises already used by
//                   items in the subcategory)
//   Subfranchise <- subsets.franchise_id
//   Property     <- properties.franchise_id (+ subset_id when one is chosen)
//   Item Type    <- item_types.subcategory_id
//   Publisher    <- publishers (unscoped)

function optionRows(data, idKey) {
  return (data || []).map((row) => ({ id: row[idKey], name: String(row.name || '').trim() })).filter((row) => row.id && row.name)
}

async function franchiseOptions(subcategoryId) {
  const [links, used] = await Promise.all([
    supabase.from('franchise_subcategory').select('franchise_id').eq('subcategory_id', subcategoryId),
    supabase.from('items').select('franchise_id').eq('subcategory_id', subcategoryId).not('franchise_id', 'is', null).limit(1000),
  ])
  const ids = [...new Set([...(links.data || []), ...(used.data || [])].map((row) => row.franchise_id).filter(Boolean))]
  if (!ids.length) return []
  const { data } = await supabase.from('franchises').select('franchise_id, name').in('franchise_id', ids).order('name')
  // Duplicate franchise names exist; keep one row per name.
  const byName = new Map()
  optionRows(data, 'franchise_id').forEach((row) => {
    if (!byName.has(row.name.toLowerCase())) byName.set(row.name.toLowerCase(), row)
  })
  return [...byName.values()]
}

// ---------------------------------------------------------------------------
// Catalogue item editor: every items column, as a dropdown of existing
// records (cascading like the website form) or a typed input.
export const CATALOGUE_EDIT_GROUPS = [
  {
    id: 'classification',
    label: 'Classification',
    fields: [
      { key: 'category_id', label: 'Category', taxonomy: 'category' },
      { key: 'subcategory_id', label: 'Subcategory', taxonomy: 'subcategory' },
      { key: 'franchise_id', label: 'Franchise', taxonomy: 'franchise' },
      { key: 'subset_id', label: 'Subfranchise', taxonomy: 'subset' },
      // Linked through item_properties, not an items column.
      { key: 'property_id', label: 'Property', taxonomy: 'property', link: true },
      { key: 'item_type_id', label: 'Item Type', taxonomy: 'item_type' },
      { key: 'publisher_id', label: 'Publisher', taxonomy: 'publisher' },
      { key: 'manufacturer_id', label: 'Manufacturer', taxonomy: 'manufacturer' },
      { key: 'brand_id', label: 'Brand', taxonomy: 'brand' },
      { key: 'collectible_set_id', label: 'Collectible Set', taxonomy: 'collectible_set' },
    ],
  },
  {
    id: 'item',
    label: 'Item Details',
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'subject', label: 'Subject' },
      { key: 'card_number', label: 'Card / ID Number' },
      { key: 'release_year', label: 'Release Year', type: 'number' },
      { key: 'upc', label: 'Barcodes (UPC/EAN)' },
      { key: 'catalog_code', label: 'Catalogue Code' },
      { key: 'lego_set_number', label: 'LEGO Set Number' },
      { key: 'minifig_code', label: 'Minifig Code' },
      { key: 'retail_price', label: 'Retail Price', type: 'number' },
      { key: 'market_price', label: 'Market Price', type: 'number' },
      { key: 'availability', label: 'Availability' },
      { key: 'completion_eligible', label: 'Completion Eligible', type: 'boolean' },
      { key: 'description', label: 'Description', multiline: true },
    ],
  },
]

// Levels cleared when a parent changes (their option lists depend on it).
export const CATALOGUE_EDIT_CHILDREN = {
  category_id: ['subcategory_id', 'franchise_id', 'subset_id', 'property_id', 'item_type_id', 'collectible_set_id'],
  subcategory_id: ['franchise_id', 'subset_id', 'property_id', 'item_type_id', 'collectible_set_id'],
  franchise_id: ['subset_id', 'property_id', 'collectible_set_id'],
  subset_id: ['property_id'],
}

// Every dropdown's options for the current parent selection, loaded the way
// the website's Add Item form loads them.
export async function loadCatalogueTaxonomyOptions({ categoryId = '', subcategoryId = '', franchiseId = '', subsetId = '' } = {}) {
  const list = (table, idKey, apply = (query) => query) => apply(supabase.from(table).select(`${idKey}, name`)).order('name').then(({ data }) => optionRows(data, idKey))
  const [category, scoped, manufacturer, brand, collectibleSet] = await Promise.all([
    list('categories', 'category_id'),
    loadTaxonomyLevels({ categoryId, subcategoryId, franchiseId, subsetId }),
    list('manufacturers', 'manufacturer_id'),
    list('brands', 'brand_id'),
    franchiseId ? list('collectible_sets', 'collectible_set_id', (query) => query.eq('franchise_id', franchiseId)) : [],
  ])
  return { category, ...scoped, manufacturer, brand, collectible_set: collectibleSet }
}

// Names for an item's current ids, so a value outside the currently loaded
// options (e.g. legacy data) still shows its name instead of a blank.
export async function loadCatalogueValueNames(values = {}) {
  const lookups = [
    ['category', 'categories', 'category_id'],
    ['subcategory', 'subcategories', 'subcategory_id'],
    ['franchise', 'franchises', 'franchise_id'],
    ['subset', 'subsets', 'subset_id'],
    ['property', 'properties', 'property_id'],
    ['item_type', 'item_types', 'item_type_id'],
    ['publisher', 'publishers', 'publisher_id'],
    ['manufacturer', 'manufacturers', 'manufacturer_id'],
    ['brand', 'brands', 'brand_id'],
    ['collectible_set', 'collectible_sets', 'collectible_set_id'],
  ].filter(([, , idKey]) => values[idKey])
  const results = await Promise.all(lookups.map(([level, table, idKey]) => (
    supabase.from(table).select(`${idKey}, name`).eq(idKey, values[idKey]).maybeSingle().then(({ data }) => [`${level}:${values[idKey]}`, data?.name || ''])
  )))
  return Object.fromEntries(results)
}

function editValueText(field, value) {
  if (value == null) return ''
  if (field.type === 'boolean') return value === true || value === 'true' ? 'true' : value === false || value === 'false' ? 'false' : ''
  return String(value)
}

// Starting values for the editor from a loaded catalogue item.
export function catalogueEditValues(item = {}, propertyId = '') {
  const values = {}
  CATALOGUE_EDIT_GROUPS.flatMap((group) => group.fields).forEach((field) => {
    values[field.key] = field.link ? (propertyId || '') : editValueText(field, item[field.key])
  })
  return values
}

function editColumnValue(field, text) {
  const value = String(text ?? '').trim()
  if (!value) return field.type === 'boolean' ? null : null
  if (field.type === 'number') {
    const number = Number(value.replace(/[^0-9.-]/g, ''))
    return Number.isFinite(number) ? number : null
  }
  if (field.type === 'boolean') return value === 'true'
  return value
}

// JSON with object keys sorted, so key order never counts as a change.
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

// Saves only what changed: items columns, the whole dynamic_fields object
// when any of it changed, and the item_properties link for Property.
export async function saveCatalogueItemEdits({ item, propertyId = '', values, dynamicFields }) {
  const fields = CATALOGUE_EDIT_GROUPS.flatMap((group) => group.fields)
  const original = catalogueEditValues(item, propertyId)
  const patch = {}
  const changed = []
  fields.filter((field) => !field.link).forEach((field) => {
    if (String(values[field.key] ?? '').trim() === String(original[field.key] ?? '').trim()) return
    patch[field.key] = editColumnValue(field, values[field.key])
    changed.push(field.key)
  })
  if (dynamicFields && stableJson(dynamicFields) !== stableJson(item.dynamic_fields || {})) {
    patch.dynamic_fields = dynamicFields
    changed.push('dynamic_fields')
  }
  const warnings = []
  let updated = item
  if (Object.keys(patch).length) updated = await updateCatalogueItemRecord(item.item_id, patch)
  if ((values.property_id || '') !== (propertyId || '')) {
    changed.push('property_id')
    const { error: deleteError } = await supabase.from('item_properties').delete().eq('item_id', item.item_id)
    if (deleteError) warnings.push(`Property was not changed: ${deleteError.message}`)
    else if (values.property_id) {
      const { error: insertError } = await supabase.from('item_properties').insert({ item_id: item.item_id, property_id: values.property_id })
      if (insertError) warnings.push(`Property was not changed: ${insertError.message}`)
    }
  }
  return { item: updated, changed, warnings }
}

export async function loadSportsTaxonomyOptions({ category = 'Sports Cards', subcategoryId = '', franchiseId = '', subsetId = '' } = {}) {
  return loadTaxonomyLevels({ categoryId: await categoryIdForName(category), subcategoryId, franchiseId, subsetId })
}

// Subcategory -> Franchise -> Subfranchise -> Property, Item Type and
// Publisher, each scoped by the level above (shared by scan review and the
// catalogue editor).
async function loadTaxonomyLevels({ categoryId = '', subcategoryId = '', franchiseId = '', subsetId = '' } = {}) {
  const propertyQuery = () => {
    let query = supabase.from('properties').select('property_id, name').eq('franchise_id', franchiseId).order('name')
    // A chosen subfranchise narrows the list, but properties not tied to any
    // subfranchise stay available (many releases have none set), otherwise
    // they could never be picked once a subfranchise is chosen.
    if (subsetId) query = query.or(`subset_id.eq.${subsetId},subset_id.is.null`)
    return query.then(({ data }) => optionRows(data, 'property_id'))
  }
  const [subcategory, franchise, subset, property, itemType, publisher] = await Promise.all([
    categoryId ? supabase.from('subcategories').select('subcategory_id, name').eq('category_id', categoryId).order('name').then(({ data }) => optionRows(data, 'subcategory_id')) : [],
    subcategoryId ? franchiseOptions(subcategoryId) : [],
    franchiseId ? supabase.from('subsets').select('subset_id, name').eq('franchise_id', franchiseId).order('name').then(({ data }) => optionRows(data, 'subset_id')) : [],
    franchiseId ? propertyQuery() : [],
    subcategoryId ? supabase.from('item_types').select('item_type_id, name').eq('subcategory_id', subcategoryId).order('name').then(({ data }) => optionRows(data, 'item_type_id')) : [],
    supabase.from('publishers').select('publisher_id, name').order('name').then(({ data }) => optionRows(data, 'publisher_id')),
  ])
  return { subcategory, franchise, subset, property, item_type: itemType, publisher }
}

// Names for a catalogue item's current taxonomy ids (which may sit outside the
// options currently loaded for the review's selected parents).
export async function loadTaxonomyNames(item) {
  if (!item) return {}
  const lookups = [
    ['subcategory', 'subcategories', 'subcategory_id', item.subcategory_id],
    ['franchise', 'franchises', 'franchise_id', item.franchise_id],
    ['subset', 'subsets', 'subset_id', item.subset_id],
    ['property', 'properties', 'property_id', item._property_id],
    ['item_type', 'item_types', 'item_type_id', item.item_type_id],
    ['publisher', 'publishers', 'publisher_id', item.publisher_id],
  ].filter(([, , , id]) => id)
  const results = await Promise.all(lookups.map(([level, table, idKey, id]) => (
    supabase.from(table).select(`${idKey}, name`).eq(idKey, id).maybeSingle().then(({ data }) => [level, data?.name || ''])
  )))
  return Object.fromEntries(results)
}

export async function loadItemPropertyId(itemId) {
  if (!itemId) return ''
  const { data } = await supabase.from('item_properties').select('property_id').eq('item_id', itemId).limit(1).maybeSingle()
  return data?.property_id || ''
}

// Inline "+ New" for a taxonomy level, mirroring the website's inline create
// (and reusing an existing row with the same name where the website does).
export async function createTaxonomyOption(level, name, { category = 'Sports Cards', subcategoryId = '', franchiseId = '', subsetId = '' } = {}) {
  const clean = String(name || '').trim()
  if (!clean) throw new Error('Enter a name first.')
  if (level === 'subcategory') {
    const categoryId = await categoryIdForName(category)
    if (!categoryId) throw new Error(`Category "${category}" was not found.`)
    const { data, error } = await supabase.from('subcategories').insert({ name: clean, category_id: categoryId }).select('subcategory_id, name').single()
    if (error) throw error
    return { id: data.subcategory_id, name: data.name }
  }
  if (level === 'franchise') {
    if (!subcategoryId) throw new Error('Select a Subcategory first.')
    const { data: existing } = await supabase.from('franchises').select('franchise_id, name').ilike('name', clean).limit(1).maybeSingle()
    let row = existing
    if (!row) {
      const { data, error } = await supabase.from('franchises').insert({ name: clean }).select('franchise_id, name').single()
      if (error) throw error
      row = data
    }
    await supabase.from('franchise_subcategory').upsert({ franchise_id: row.franchise_id, subcategory_id: subcategoryId }, { onConflict: 'franchise_id,subcategory_id', ignoreDuplicates: true })
    return { id: row.franchise_id, name: row.name }
  }
  if (level === 'subset') {
    if (!franchiseId) throw new Error('Select a Franchise first.')
    const { data, error } = await supabase.from('subsets').insert({ name: clean, franchise_id: franchiseId }).select('subset_id, name').single()
    if (error) throw error
    return { id: data.subset_id, name: data.name }
  }
  if (level === 'property') {
    if (!franchiseId) throw new Error('Select a Franchise first.')
    const { data, error } = await supabase.from('properties').insert({ name: clean, franchise_id: franchiseId, subset_id: subsetId || null }).select('property_id, name').single()
    if (error) throw error
    return { id: data.property_id, name: data.name }
  }
  if (level === 'item_type') {
    if (!subcategoryId) throw new Error('Select a Subcategory first.')
    const { data, error } = await supabase.from('item_types').insert({ name: clean, subcategory_id: subcategoryId }).select('item_type_id, name').single()
    if (error) throw error
    return { id: data.item_type_id, name: data.name }
  }
  if (level === 'publisher') {
    const { data: existing } = await supabase.from('publishers').select('publisher_id, name').ilike('name', clean).limit(1).maybeSingle()
    if (existing) return { id: existing.publisher_id, name: existing.name }
    const { data, error } = await supabase.from('publishers').insert({ name: clean }).select('publisher_id, name').single()
    if (error) throw error
    return { id: data.publisher_id, name: data.name }
  }
  throw new Error(`Unknown taxonomy level: ${level}`)
}

function scanTokens(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
}

// Picks the taxonomy option that best matches scanned text, e.g. "Contenders
// Football" -> "Panini Contenders Football". Returns '' when nothing is close.
export function matchTaxonomyOption(options = [], text = '') {
  const wanted = scanTokens(text)
  if (!wanted.length) return ''
  let best = null
  options.forEach((option) => {
    const tokens = scanTokens(option.name)
    if (!tokens.length) return
    const shared = wanted.filter((token) => tokens.includes(token)).length
    if (!shared) return
    const exact = tokens.join(' ') === wanted.join(' ')
    // Share of the option's words found in the scan, and of the scan's in the option.
    const score = (exact ? 10 : 0) + shared / tokens.length + shared / wanted.length
    if (!best || score > best.score) best = { id: option.id, score, covers: shared / tokens.length }
  })
  // Most of the option's own words must be in the scan, so that "Football" alone
  // never picks "Panini Contenders Football"...
  if (best && best.covers >= 0.6) return best.id
  // ...unless exactly one option contains every scanned word ("Football" ->
  // "American Football" when no other sport mentions football).
  const containing = options.filter((option) => {
    const tokens = scanTokens(option.name)
    return wanted.every((token) => tokens.includes(token))
  })
  return containing.length === 1 ? containing[0].id : ''
}

// ---------------------------------------------------------------------------
// Local AI recognition: taxonomy resolver + catalogue matcher.
//
// The model's strings are never written to the taxonomy. They are resolved to
// existing rows (exact names preferred, "Football" -> "American Football" via
// matchTaxonomyOption); anything unresolved is left for the reviewer, who can
// pick an existing row or explicitly create one.

function reverseCategoryLabel(catalogueName) {
  const entry = Object.entries(CATALOGUE_CATEGORY_NAMES).find(([, name]) => name.toLowerCase() === String(catalogueName || '').toLowerCase())
  return entry ? entry[0] : catalogueName
}

export async function resolveRecognizedTaxonomy(result = {}, fallbackCategory = '') {
  const { data: categoryRows } = await supabase.from('categories').select('category_id, name').order('name')
  const categories = optionRows(categoryRows, 'category_id')
  // The category the card was scanned under wins: the AI sometimes calls a
  // trading card a sports card (and then searches the wrong category).
  const categoryOptionId = (fallbackCategory ? matchTaxonomyOption(categories, catalogueCategoryName(fallbackCategory)) : '')
    || matchTaxonomyOption(categories, result.category || '')
  const categoryRow = categories.find((row) => row.id === categoryOptionId)
  const category = categoryRow ? reverseCategoryLabel(categoryRow.name) : fallbackCategory
  const resolution = {
    category,
    categoryId: categoryRow?.id || null,
    ids: {},
    names: {},
    unresolved: {},
  }
  if (!isSpecCategory(category)) return resolution

  const pick = (level, options, text, { allowSingle = true } = {}) => {
    const id = matchTaxonomyOption(options, text || '') || (!text && allowSingle && options.length === 1 ? options[0].id : '')
    if (id) {
      resolution.ids[`${level}_id`] = id
      resolution.names[level] = options.find((option) => option.id === id)?.name || ''
    } else if (text) {
      resolution.unresolved[level] = text
    }
    return id
  }

  const top = await loadSportsTaxonomyOptions({ category })
  const subcategoryId = pick('subcategory', top.subcategory, result.subcategory)
  pick('publisher', top.publisher, result.publisher_manufacturer, { allowSingle: false })
  if (!subcategoryId) return resolution

  const bySport = await loadSportsTaxonomyOptions({ category, subcategoryId })
  const franchiseId = pick('franchise', bySport.franchise, result.franchise)
  pick('item_type', bySport.item_type, result.item_type)
  if (!franchiseId) return resolution

  const byLeague = await loadSportsTaxonomyOptions({ category, subcategoryId, franchiseId })
  const subsetId = pick('subset', byLeague.subset, result.subfranchise)
  const properties = subsetId
    ? (await loadSportsTaxonomyOptions({ category, subcategoryId, franchiseId, subsetId })).property
    : byLeague.property
  pick('property', properties, result.property, { allowSingle: Boolean(subsetId) })
  return resolution
}

function matchText(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function splitPlayers(value) {
  return String(value || '').split('/').map((part) => part.trim()).filter(Boolean)
}

function playerSetKey(value) {
  return splitPlayers(value).map(matchText).sort().join('|')
}

// Spaces in card numbers are ignored ("EC - 20" is "EC-20").
function cardNumberText(value) {
  return matchText(value).replace(/^(no\.?|#)\s*/, '').replace(/\s+/g, '')
}

// The digits of a card number, for numbers printed with a set prefix,
// leading zeros or a set size ("os050", "D25", "02/60" -> "50", "25", "2").
function cardNumberCore(value) {
  const match = cardNumberText(value).split('/')[0].match(/(\d+)\D*$/)
  return match ? String(Number(match[1])) : ''
}

// A name's words without punctuation or quotes ("Orbital-Mine", '"Clankers!"').
function looseNameWords(value) {
  return matchText(value).split(/[^a-z0-9]+/).filter(Boolean)
}

// Rarity words the AI sometimes reads into Parallel on trading cards; a
// rarity is not a parallel printing.
const RARITY_WORDS = /^(common|uncommon|rare|super rare|ultra rare|secret rare|mythic|mythic rare|holo rare|rare holo|very rare)$/

function yesNo(value) {
  if (value === true || /^(yes|true)$/i.test(String(value ?? ''))) return 'yes'
  if (value === false || /^(no|false)$/i.test(String(value ?? ''))) return 'no'
  return ''
}

function serialDenominator(value) {
  const match = String(value ?? '').match(/\/\s*(\d+)/)
  return match ? match[1] : ''
}

// Print finish in the catalogue's terms. Trading card games list foil and
// non-foil printings as separate items (Magic data says Foil / Nonfoil; the AI
// may say Holo / None).
function finishKey(value) {
  const text = matchText(value)
  if (!text) return ''
  if (/reverse/.test(text)) return 'reverse'
  if (/^(none|nonfoil|non-foil|non foil|normal|regular|standard|matte)$/.test(text)) return 'nonfoil'
  if (/foil|holo|etched|refractor|shiny/.test(text)) return 'foil'
  return text
}

// Set names compared loosely (punctuation, case and maker names aside).
function looseSetName(value) {
  return matchText(value).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((word) => word && !['the', 'panini', 'topps', 'set'].includes(word)).join(' ')
}

// The parallel as read (a rarity read as a parallel on a trading card is none).
function cardParallelText(card) {
  return card._trading && RARITY_WORDS.test(matchText(card.parallel)) ? '' : matchText(card.parallel)
}

// Two variant names for the same thing, wording aside ("Cracked Ice" and
// "Cracked Ice Ticket"; "Gold" and "Game Ticket Gold" are not enough alone).
function sameVariantName(a, b) {
  const wordsA = looseNameWords(a)
  const wordsB = looseNameWords(b)
  if (!wordsA.length || !wordsB.length) return false
  const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA]
  if (shorter.join(' ') === longer.join(' ')) return true
  // The longer name is the shorter plus a generic word ("Cracked Ice" +
  // "Ticket"); "Gold" and "Gold Vinyl" stay different parallels.
  return longer.length === shorter.length + 1 && ['ticket', 'parallel', 'version', 'variant'].includes(longer[longer.length - 1])
    && shorter.every((word, index) => longer[index] === word)
}

// Refinement fields that separate variants of the same player/number/release.
// Each returns 'match', 'mismatch' or 'unknown'.
const REFINE_FIELDS = [
  {
    key: 'finish',
    weight: 8,
    // Trading cards only (foil and non-foil are different catalogue items);
    // unknown when either side doesn't say.
    compare: (card, item) => {
      if (!card._trading) return 'unknown'
      const cardFinish = finishKey(card.finish)
      const itemFinish = finishKey(item.dynamic_fields?.finish)
      if (!cardFinish || !itemFinish) return 'unknown'
      return cardFinish === itemFinish ? 'match' : 'mismatch'
    },
  },
  // The catalogue often keeps parallels in Collection ("Cracked Ice Ticket"),
  // while the AI reads them as a parallel ("Cracked Ice"): a parallel that
  // names the item's collection counts for both.
  {
    key: 'collection',
    weight: 10,
    compare: (card, item) => {
      const itemCollection = collectionKey(item.dynamic_fields?.collection)
      if (collectionKey(card.collection) === itemCollection) return 'match'
      return itemCollection && !item.dynamic_fields?.parallel && sameVariantName(cardParallelText(card), itemCollection) ? 'match' : 'mismatch'
    },
  },
  // No parallel read from the card means a base card: it matches items with no parallel.
  {
    key: 'parallel',
    weight: 10,
    compare: (card, item) => {
      const cardParallel = cardParallelText(card)
      const itemParallel = matchText(item.dynamic_fields?.parallel)
      if (cardParallel === itemParallel) return 'match'
      return !itemParallel && sameVariantName(cardParallel, collectionKey(item.dynamic_fields?.collection)) ? 'match' : 'mismatch'
    },
  },
  { key: 'variation', weight: 4, compare: (card, item) => matchText(card.variation) === matchText(item.dynamic_fields?.variation) ? 'match' : 'mismatch' },
  {
    key: 'serial_numbering',
    weight: 4,
    compare: (card, item) => {
      const cardDen = serialDenominator(card.serial_numbering)
      const itemDen = serialDenominator(item.dynamic_fields?.serial_numbering)
      if (!cardDen && !itemDen) return 'match'
      return cardDen === itemDen ? 'match' : 'mismatch'
    },
  },
  {
    key: 'autograph',
    weight: 4,
    compare: (card, item) => {
      const cardValue = yesNo(card.autograph)
      const itemValue = yesNo(item.dynamic_fields?.autograph)
      if (!cardValue || !itemValue) return cardValue === 'yes' || itemValue === 'yes' ? 'mismatch' : 'unknown'
      return cardValue === itemValue ? 'match' : 'mismatch'
    },
  },
  {
    key: 'memorabilia_relic',
    weight: 4,
    compare: (card, item) => {
      const cardValue = yesNo(card.memorabilia_relic)
      const itemValue = yesNo(item.dynamic_fields?.relic)
      if (!cardValue || !itemValue) return cardValue === 'yes' || itemValue === 'yes' ? 'mismatch' : 'unknown'
      return cardValue === itemValue ? 'match' : 'mismatch'
    },
  },
]

// Matches a recognised card against catalogue records. CollectorsHub decides
// the match from database fields; the model's own confidence is never used.
//   card: { subject, id_number, release_year, collection, parallel, variation,
//           serial_numbering, autograph, memorabilia_relic, uncertain_fields }
//   ids:  resolved taxonomy ids { subset_id, property_id, ... }
// Returns { status: 'exact' | 'likely' | 'multiple' | 'none', best, candidates }.
export async function matchRecognizedCard({ categoryId, ids = {}, card: readCard = {} }) {
  const trading = /trading/i.test(String(readCard.category || ''))
  // Trading cards print their place in the set as "33/120"; the AI often
  // files that under serial numbering, but it is the card number.
  // A number with nothing before the slash ("/120") is no number.
  const cardIn = /^\s*\//.test(String(readCard.id_number || '')) ? { ...readCard, id_number: null } : readCard
  const setPosition = trading && !cardIn.id_number && String(cardIn.serial_numbering || '').match(/^\s*#?\s*([a-z]*\d+)\s*\/\s*\d+\s*$/i)
  const card = setPosition ? { ...cardIn, id_number: setPosition[1], serial_numbering: null } : cardIn
  const subject = String(card.subject || '').trim()
  const number = cardNumberText(card.id_number)
  if (!categoryId || (!subject && !number)) return { status: 'none', best: null, candidates: [] }

  const numberCore = cardNumberCore(card.id_number)
  // Search for each player on multi-player cards ('A/B'), in any order.
  const players = splitPlayers(subject)
  // Trading card names with punctuation are searched word by word, so
  // "Orbital-Mine" finds "Orbital Mine" and quotes don't matter.
  const wordSearch = (column, player) => `${column}.ilike.${orValue(`%${looseNameWords(player).map((word) => word.replace(/[\\%_]/g, '\\$&')).join('%')}%`)}`
  const byWords = trading && players.some((player) => /[^a-z0-9 ]/i.test(player) && looseNameWords(player).length)
  const runQuery = (words) => {
    let query = supabase.from('items').select(CATALOGUE_SELECT.join(',')).eq('category_id', categoryId)
    if (players.length) query = query.or(players.flatMap((player) => [words ? wordSearch('name', player) : orContains('name', player), words ? wordSearch('subject', player) : orContains('subject', player)]).join(','))
    // Trading card numbers are often printed differently from the catalogue's
    // ("os050" for 50), so with a name to search by they are compared below.
    // The stored number may have spaces ("EC - 20") or not ("EC-20").
    if (number && !(trading && players.length)) query = query.in('card_number', [...new Set([number, `#${number}`, number.toUpperCase(), number.toUpperCase().replace(/-/g, ' - '), String(card.id_number || '').trim(), numberCore].filter(Boolean))])
    return query.limit(300)
  }
  let { data, error } = await runQuery(byWords)
  // A word-by-word search can be slow on very short words; fall back to the
  // plain search.
  if (error && byWords) ({ data, error } = await runQuery(false))
  if (error) throw error
  const rows = data || []

  const propertyByItem = new Map()
  const subsetNames = new Map()
  const franchiseNames = new Map()
  if (rows.length) {
    const subsetIds = [...new Set(rows.map((row) => row.subset_id).filter(Boolean))]
    const franchiseIds = trading ? [...new Set(rows.map((row) => row.franchise_id).filter(Boolean))] : []
    const [{ data: links }, { data: subsets }, { data: franchises }] = await Promise.all([
      supabase.from('item_properties').select('item_id, property_id').in('item_id', rows.map((row) => row.item_id)),
      subsetIds.length ? supabase.from('subsets').select('subset_id, name').in('subset_id', subsetIds) : Promise.resolve({ data: [] }),
      franchiseIds.length ? supabase.from('franchises').select('franchise_id, name').in('franchise_id', franchiseIds) : Promise.resolve({ data: [] }),
    ])
    ;(links || []).forEach((link) => { if (!propertyByItem.has(link.item_id)) propertyByItem.set(link.item_id, link.property_id) })
    ;(subsets || []).forEach((subset) => subsetNames.set(subset.subset_id, subset.name))
    ;(franchises || []).forEach((franchise) => franchiseNames.set(franchise.franchise_id, franchise.name))
  }
  // The set as the AI read it (trading card games keep the set on the
  // subfranchise, e.g. each Magic or Yu-Gi-Oh! set is one).
  const setTexts = [card.property, card.subfranchise].map(looseSetName).filter(Boolean)
  const cardForRefine = { ...card, _trading: trading }

  const uncertain = new Set((card.uncertain_fields || []).map((field) => String(field).toLowerCase()))
  const candidates = rows.map((row) => {
    const item = { ...row, imageUrl: publicImageUrl(row.image_path), _property_id: propertyByItem.get(row.item_id) || '' }
    const reasons = []
    const differences = []
    // Score = share of comparable evidence that agrees, so a card matching on
    // collection AND parallel outranks one matching on collection alone.
    let score = 0
    // A trading card with no number read is judged on name and set alone.
    let possible = trading && !number ? 30 : 55

    // Same set of players, in any order; a card that only shares one player
    // of a dual card (or a solo card of one of them) is a different card.
    const wanted = playerSetKey(subject)
    const looseWanted = trading ? looseNameWords(subject).join('') : ''
    const subjectMatch = Boolean(wanted) && (playerSetKey(item.subject) === wanted || playerSetKey(item.name) === wanted
      || (Boolean(looseWanted) && (looseNameWords(item.name).join('') === looseWanted || looseNameWords(item.subject).join('') === looseWanted)))
    if (subjectMatch) { score += 30; reasons.push('Same player/subject') }
    const numberMatch = Boolean(number) && (cardNumberText(item.card_number) === number
      || (trading && Boolean(numberCore) && cardNumberCore(item.card_number) === numberCore))
    if (numberMatch) { score += 25; reasons.push('Same card number') }

    // Release: the resolved Property is strongest, then the Subfranchise, then
    // the set name as read, then the year. Each is used only when the
    // catalogue item has it (trading cards have no Property links, and keep
    // the set on the Subfranchise).
    let releaseMatch = true
    // A Property, or a trading-card set, is one specific release; a sports
    // Subfranchise is a product line spanning years, so the year still counts.
    let specificRelease = false
    const itemSetName = looseSetName(subsetNames.get(item.subset_id))
    if (ids.property_id && item._property_id) {
      possible += 20
      specificRelease = true
      releaseMatch = item._property_id === ids.property_id
      if (releaseMatch) { score += 20; reasons.push('Same release/set') } else differences.push('release/set')
    } else if (ids.subset_id && item.subset_id && (!trading || ids.subset_id === item.subset_id || !setTexts.length)) {
      possible += 15
      specificRelease = trading
      releaseMatch = item.subset_id === ids.subset_id
      if (releaseMatch) { score += 15; reasons.push(trading ? 'Same set' : 'Same product line') } else differences.push(trading ? 'set' : 'product line')
    } else if (setTexts.length && itemSetName) {
      const sameSet = setTexts.some((text) => text === itemSetName || text.includes(itemSetName) || itemSetName.includes(text))
      // The AI often reads the game's name ("PocketModel TCG") where the set
      // goes; that says nothing about which of the game's sets it is.
      const gameName = looseSetName(franchiseNames.get(item.franchise_id))
      const onlyGameName = trading && !sameSet && Boolean(gameName) && setTexts.every((text) => gameName.includes(text) || text.includes(gameName))
      if (!onlyGameName) {
        possible += 15
        specificRelease = trading
        releaseMatch = sameSet
        if (releaseMatch) { score += 15; reasons.push('Same set') } else differences.push('set')
      }
    }
    if (card.release_year) {
      possible += 5
      const sameYear = String(item.release_year || '') === String(card.release_year)
      // A confirmed specific release outranks the year (copyright years can
      // differ from the catalogue's release year); otherwise it must agree.
      if (sameYear) { score += 5; reasons.push('Same year') } else if (!(specificRelease && releaseMatch)) { releaseMatch = false; differences.push('year') }
    }

    // Trading cards often show no number (or the AI can't read it): the name
    // and set/year decide, and several same-named cards go to the picker.
    const identity = subjectMatch && releaseMatch && (numberMatch || (trading && !number))
    let refineAllMatch = true
    REFINE_FIELDS.forEach((field) => {
      const outcome = field.compare(cardForRefine, item)
      if (outcome !== 'unknown') possible += field.weight
      if (outcome === 'match') { score += field.weight; if (['collection', 'parallel'].includes(field.key)) reasons.push(`Same ${field.key}`) }
      if (outcome === 'mismatch') { refineAllMatch = false; differences.push(field.key.replace('_', ' ')) }
      if (uncertain.has(field.key)) refineAllMatch = false
    })

    return {
      item,
      score: Math.round((100 * score) / possible),
      reasons,
      differences,
      identity,
      exact: identity && refineAllMatch,
      likelyDuplicate: identity && refineAllMatch,
      // Same name and set/year but another number (trading card numbers are
      // often misread, or listed differently by the checklist source).
      nameAndRelease: trading && subjectMatch && releaseMatch,
    }
  })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)

  const exact = candidates.filter((candidate) => candidate.exact)
  if (exact.length === 1) return { status: 'exact', best: exact[0], candidates }
  if (exact.length > 1) return { status: 'multiple', best: null, candidates }
  const identities = candidates.filter((candidate) => candidate.identity)
  if (!identities.length) {
    // A trading card that agrees on everything but the number needs a person
    // to pick, never a new catalogue item.
    const sameName = candidates.filter((candidate) => candidate.nameAndRelease)
    if (sameName.length === 1) return { status: 'likely', best: sameName[0], candidates }
    if (sameName.length > 1) return { status: 'multiple', best: null, candidates }
    return { status: 'none', best: null, candidates }
  }
  if (identities.length === 1 || identities[0].score > identities[1].score) return { status: 'likely', best: identities[0], candidates }
  return { status: 'multiple', best: null, candidates }
}

const MATCH_STATUS_ROUTE = {
  exact: ['existing_match', 'Exact catalogue match'],
  likely: ['manual_review_existing_item', 'Likely catalogue match'],
  multiple: ['possible_duplicate', 'Several possible matches'],
  none: ['new_item_proposal', 'No catalogue match'],
}

// Full pipeline for one recognised card: taxonomy resolver -> catalogue matcher.
// The result is stored on the draft as scanAnalysis (same shape the review
// screen already uses) plus the resolved taxonomy.
// Identity of one catalogue card, for spotting copies of the same card among
// scans: player(s), number, year, set, and everything that makes a different
// catalogue item (parallel, serial run, autograph, relic). Resolved taxonomy
// ids are used when available because the AI's set wording can vary between
// scans of the same card. Empty when there isn't enough to be sure.
export function recognizedCardKey(card = {}, ids = {}) {
  const players = playerSetKey(card.subject || (Array.isArray(card.subjects) ? card.subjects.join(' / ') : ''))
  const number = cardNumberText(card.id_number)
  const year = String(card.release_year ?? '').trim()
  if (!players || !number || !year) return ''
  const parallel = matchText(card.parallel).replace(/^(base|none|n\/a)$/, '')
  return [
    players,
    number,
    year,
    ids.subset_id || matchText(card.subfranchise),
    ids.property_id || matchText(card.property),
    parallel,
    matchText(card.variation).replace(/^(base|none|n\/a)$/, ''),
    serialDenominator(card.serial_numbering) || '',
    yesNo(card.autograph),
    yesNo(card.memorabilia_relic ?? card.relic),
  ].join('|')
}

export async function analyseRecognizedCard(result, fallbackCategory) {
  const taxonomy = await resolveRecognizedTaxonomy(result, fallbackCategory)
  const match = await matchRecognizedCard({ categoryId: taxonomy.categoryId, ids: taxonomy.ids, card: { ...result, category: taxonomy.category || result.category } })
  const [route, status] = MATCH_STATUS_ROUTE[match.status]
  return {
    taxonomy,
    scanAnalysis: {
      source: 'local-ai',
      route,
      status,
      matchStatus: match.status,
      bestMatch: match.best,
      candidates: match.candidates.slice(0, 15),
      confidence: match.best?.score || 0,
      analyzedAt: new Date().toISOString(),
    },
  }
}

// Duplicate check for the Sports Cards review form, using the same matcher:
// only an item with the same identity AND the same collection/parallel/etc.
// counts, so adding a new parallel of an existing card is not blocked.
export async function findSpecDuplicates({ category, values = {} }) {
  const categoryId = await categoryIdForName(category)
  const match = await matchRecognizedCard({
    categoryId,
    ids: { property_id: values.property_id || '', subset_id: values.subset_id || '' },
    card: {
      category,
      finish: values.finish,
      subject: values.subject,
      id_number: values.card_number,
      release_year: values.release_year,
      collection: values.collection,
      parallel: values.parallel,
      variation: values.variation,
      serial_numbering: values.serial_numbering,
      autograph: values.autograph,
      memorabilia_relic: values.relic,
    },
  })
  return match.candidates.filter((candidate) => candidate.exact)
}

// ---------------------------------------------------------------------------
// Set checklists: placeholder catalogue items for every card in a set, so a
// set shows complete (and collectors can track it) before every card has been
// scanned. A scan that matches a placeholder fills it in on approval.

export const CHECKLIST_PLACEHOLDER_KEY = 'checklist_placeholder'

export function isChecklistPlaceholder(item) {
  return Boolean(item?.dynamic_fields?.[CHECKLIST_PLACEHOLDER_KEY])
}

// One card per line, in the shapes checklists usually come in:
//   1 Josh Allen - Buffalo Bills        #1 Josh Allen, Bills
//   1. Josh Allen | Buffalo Bills RC    BLLR-EN033 Sadion, the Timelord
//   1<TAB>Josh Allen<TAB>Buffalo Bills  (pasted from a spreadsheet)
//   64<TAB>Aaron Jones [Cracked Ice Ticket] /25
//   Aaron Jones [Cracked Ice Ticket] #64 /25   (copied from a price guide)
// RC / Rookie marks a rookie card; SP / SSP a short print. Text in
// [brackets] is the card's variant: its collection (where the catalogue keeps
// parallels; or its parallel when brackets is 'parallel'). A trailing /25 is its print run (serial
// numbering). A spreadsheet's last column is the collection (number, name,
// team, collection; trading cards: number, name, collection). A number may
// repeat for each parallel or collection. Lines that aren't cards (prices,
// "+ Collection", "+ Wishlist") are ignored.
// teams: whether lines carry a team after the name (sports cards). Trading
// card names often contain commas ("Sadion, the Timelord"), so for them the
// rest of the line is the name.

// One card of a set: its number within its collection ("Base" and blank are
// the same) and parallel, plus the name for checklists that repeat a number.
export function checklistRowKey({ number, collection = '', parallel = '', name = '' }) {
  return [cardNumberText(number), collectionKey(collection), matchText(parallel), matchText(name)].join('|')
}

// The same card in the catalogue (number, collection and parallel; names on
// scanned items may be written differently from the checklist's).
export function checklistItemKey({ number, collection = '', parallel = '' }) {
  return [cardNumberText(number), collectionKey(collection), matchText(parallel)].join('|')
}

const CHECKLIST_NOISE = /^(\*\s*)?(\+\s*(collection|wishlist)\b|(un)?graded\b|price\b|\$)/i
const CHECKLIST_LEADING_NUMBER = /^#?\s*([A-Za-z]{0,6}-?[A-Za-z]{0,4}\d+[A-Za-z0-9-]*)[.):]?\s+(.+)$/

export function parseChecklist(text, { teams = true, brackets = 'collection' } = {}) {
  const rows = []
  const seen = new Set()
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.replace(/ /g, ' ').trim()
    if (!line || CHECKLIST_NOISE.test(line)) continue
    // A link copied from a web page: [text](address) -> text.
    line = line.replace(/^\[(.+)\]\((?:https?:)?[^)]*\)/, '$1').trim()
    let variant = ''
    line = line.replace(/\s*\[([^\]]+)\]/, (all, value) => { variant = value.trim(); return '' })
    let serial = ''
    line = line.replace(/\s+\/\s*(\d+)\s*$/, (all, run) => { serial = `/${run}`; return '' }).trim()
    // "Aaron Jones #64" (price guides list the number after the name).
    if (!line.includes('\t') && !CHECKLIST_LEADING_NUMBER.test(line)) {
      const trailing = line.match(/^(.*\S)\s+#\s*([A-Za-z0-9-]+)$/)
      if (trailing) line = `${trailing[2]} ${trailing[1]}`
    }
    let collection = ''
    let parts
    if (line.includes('\t')) {
      parts = line.split('\t').map((part) => part.trim()).filter(Boolean)
      const collectionColumn = teams ? 3 : 2
      if (parts[collectionColumn]) collection = parts[collectionColumn]
      parts = parts.slice(0, collectionColumn)
    } else {
      const match = line.match(CHECKLIST_LEADING_NUMBER)
      if (!match) { rows.push({ raw: rawLine.trim(), error: 'No card number' }); continue }
      parts = teams
        ? [match[1], ...match[2].split(/\s+[-–—|]\s+|\s*,\s+(?=[^,]+$)/).map((part) => part.trim()).filter(Boolean)]
        : [match[1], match[2].trim()]
    }
    let parallel = ''
    if (variant) {
      if (brackets === 'collection' && !collection) collection = variant
      else parallel = variant
    }
    let [number, name = '', team = ''] = parts
    number = String(number || '').replace(/^#/, '').trim()
    const flags = { rookie: false, shortPrint: false }
    const stripFlags = (value) => String(value || '').replace(/\s+\b(RC|Rookie|SSP|SP)\b\.?$/i, (all, flag) => {
      if (/^(rc|rookie)$/i.test(flag)) flags.rookie = true
      else flags.shortPrint = true
      return ''
    }).trim()
    // Wiki lists often quote card names ("Laser Beak").
    const unquote = (value) => String(value || '').replace(/^["“”'‘’]+|["“”'‘’]+$/g, '').trim()
    name = unquote(stripFlags(stripFlags(name)))
    team = unquote(stripFlags(stripFlags(team)))
    if (!number || !name) { rows.push({ raw: rawLine.trim(), error: 'Needs a card number and a name' }); continue }
    const key = checklistRowKey({ number, collection, parallel, name })
    if (seen.has(key)) { rows.push({ raw: rawLine.trim(), error: `Card ${number} is listed twice` }); continue }
    seen.add(key)
    rows.push({ raw: rawLine.trim(), number, name, team, collection, parallel, serial, rookie: flags.rookie, shortPrint: flags.shortPrint })
  }
  return rows
}

// The cards already in the catalogue for a set: by Property when one is
// chosen, otherwise by Subfranchise (+ year for sports product lines).
export async function loadSetItems({ categoryId, subcategoryId = '', franchiseId = '', subsetId = '', propertyId = '', releaseYear = '' }) {
  if (!categoryId) return []
  const rows = []
  for (let from = 0; ; from += 1000) {
    let query = supabase.from('items')
      .select(propertyId ? 'item_id, name, subject, card_number, release_year, image_path, dynamic_fields, item_properties!inner(property_id)' : 'item_id, name, subject, card_number, release_year, image_path, dynamic_fields')
      .eq('category_id', categoryId)
    if (subcategoryId) query = query.eq('subcategory_id', subcategoryId)
    if (franchiseId) query = query.eq('franchise_id', franchiseId)
    if (subsetId) query = query.eq('subset_id', subsetId)
    if (propertyId) query = query.eq('item_properties.property_id', propertyId)
    else if (releaseYear) query = query.eq('release_year', Number(releaseYear))
    const { data, error } = await query.order('item_id').range(from, from + 999)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return rows
}

// Creates a placeholder item for each checklist row that the set doesn't have
// yet. Returns { created: [ids], skipped: number }.
export async function createChecklistPlaceholders({ category, ids, releaseYear = '', rows = [], existing = [] }) {
  const categoryId = await categoryIdForName(category)
  if (!categoryId || !ids?.subcategory_id) throw new Error('Choose the set (at least the category and subcategory) first.')
  // Already in the catalogue: same number in the same collection.
  const have = new Set(existing.map((item) => checklistItemKey({ number: item.card_number, collection: item.dynamic_fields?.collection, parallel: item.dynamic_fields?.parallel })))
  const todo = rows.filter((row) => !row.error && !have.has(checklistItemKey(row)))
  const created = []
  for (let index = 0; index < todo.length; index += 100) {
    const payload = todo.slice(index, index + 100).map((row) => {
      const dynamic = { [CHECKLIST_PLACEHOLDER_KEY]: true, source: 'Set checklist' }
      if (row.team) dynamic.team = row.team
      // A card with no collection named is the base card.
      dynamic.collection = row.collection || 'Base'
      if (row.parallel) dynamic.parallel = row.parallel
      if (row.serial) dynamic.serial_numbering = row.serial
      if (row.rookie) dynamic.rookie = 'Yes'
      if (row.shortPrint) dynamic.variation = 'Short Print'
      return {
        category_id: categoryId,
        subcategory_id: ids.subcategory_id || null,
        franchise_id: ids.franchise_id || null,
        subset_id: ids.subset_id || null,
        item_type_id: ids.item_type_id || null,
        publisher_id: ids.publisher_id || null,
        name: row.name,
        subject: row.name,
        card_number: row.number,
        release_year: releaseYear ? Number(releaseYear) : null,
        completion_eligible: true,
        dynamic_fields: dynamic,
      }
    })
    const { data, error } = await supabase.from('items').insert(payload).select('item_id')
    if (error) {
      backupCatalogueChange({ action: 'create', ok: false, error: error.message, payload: { checklist: payload } })
      throw error
    }
    const newIds = (data || []).map((row) => row.item_id)
    created.push(...newIds)
    if (ids.property_id && newIds.length) {
      const { error: linkError } = await supabase.from('item_properties').insert(newIds.map((itemId) => ({ item_id: itemId, property_id: ids.property_id })))
      if (linkError) throw new Error(`Placeholders created, but linking them to the set failed: ${linkError.message}`)
    }
    backupCatalogueChange({ action: 'create', itemIds: newIds })
  }
  return { created, skipped: rows.length - todo.length }
}

// A scan approved against a placeholder: fill the placeholder's empty fields
// from the reviewed values (never overwriting what the checklist set) and
// mark it scanned.
export async function fillChecklistPlaceholder({ item, category, values }) {
  if (!isChecklistPlaceholder(item)) return null
  const groups = scanReviewGroups(category)
  const patch = {}
  groups.flatMap((group) => group.fields).forEach((field) => {
    if (!field.column || field.taxonomy) return
    if (String(item[field.column] ?? '').trim()) return
    const value = reviewColumnValue(field, values[field.key])
    if (value != null && value !== '') patch[field.column] = value
  })
  const filled = writeDynamicFields({}, groups, values, { dropEmpty: true })
  const dynamic = { ...(item.dynamic_fields || {}) }
  Object.entries(filled).forEach(([key, value]) => {
    if (dynamic[key] == null || dynamic[key] === '') dynamic[key] = value
  })
  delete dynamic[CHECKLIST_PLACEHOLDER_KEY]
  // Scanned in: the record is now CollectorsHub's own, not the checklist's.
  dynamic.source = 'CollectorsHub'
  dynamic.scanner_source = 'CollectorsHub Desktop scanner'
  patch.dynamic_fields = dynamic
  return updateCatalogueItemRecord(item.item_id, patch)
}
