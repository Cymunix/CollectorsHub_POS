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

export async function loadCatalogueItems({ search = '', categoryId = '', missingImages = false, missingPricing = false, page = 1, limit = 25 } = {}) {
  const from = Math.max(0, (page - 1) * limit)
  const to = from + limit - 1
  let query = supabase
    .from('items')
    .select(CATALOGUE_SELECT.join(','), { count: 'exact' })
    .order('name', { ascending: true, nullsFirst: false })
    .range(from, to)

  const term = search.trim()
  if (term) {
    const searchFilters = [
      `name.ilike.%${term}%`,
      `subject.ilike.%${term}%`,
      `upc.eq.${term}`,
      `catalog_code.ilike.%${term}%`,
      `card_number.ilike.%${term}%`,
      `lego_set_number.ilike.%${term}%`,
      `minifig_code.ilike.%${term}%`,
    ]
    if (UUID_RE.test(term)) searchFilters.push(`item_id.eq.${term}`)
    query = query.or(searchFilters.join(','))
  }

  if (categoryId) query = query.eq('category_id', categoryId)
  if (missingImages) query = query.or('image_path.is.null,image_path.eq.')
  if (missingPricing) query = query.is('market_price', null)

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
    status: 'unavailable',
    results_found: 0,
    results_approved: 0,
    results_excluded: 0,
    results_review: 0,
    started_at: startedAt,
    created_by: (await supabase.auth.getUser()).data?.user?.id || null,
    raw_results: [],
    error_message: provider === 'ebay'
      ? 'Sold-market history unavailable with current eBay API permissions. Configure an official sold/completed-sales provider endpoint before fetching live results.'
      : `Provider ${provider} is not configured.`,
  })

  return {
    import: importRow,
    item: itemRecord,
    provider,
    query: searchQuery,
    candidates: [],
    status: 'unavailable',
    error: importRow.error_message,
    since,
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

  if (error) throw error
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
      const filters = [`name.ilike.%${term}%`, `subject.ilike.%${term}%`]
      if (UUID_RE.test(term)) filters.push(`item_id.eq.${term}`)
      query = query.or(filters.join(','))
    }
    if (selected.table === 'item_details') {
      const filters = [`subject.ilike.%${term}%`, `description.ilike.%${term}%`]
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
  if (proposed.name) {
    const itemName = normaliseText(row.name || row.subject)
    const proposedName = normaliseText(proposed.name)
    if (itemName === proposedName) {
      score += 28
      reasons.push('Exact title match')
    } else if (itemName.includes(proposedName) || proposedName.includes(itemName)) {
      score += 14
      reasons.push('Similar title')
    }
  }

  return { score: Math.min(100, score), reasons }
}

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

export async function identifyScannedDraft(draft) {
  const proposed = proposedScanFields(draft)
  const filters = []
  if (proposed.upc) filters.push(`upc.eq.${proposed.upc}`)
  if (proposed.card_number) filters.push(`card_number.ilike.%${proposed.card_number}%`)
  if (proposed.lego_set_number) filters.push(`lego_set_number.eq.${proposed.lego_set_number}`)
  if (proposed.catalog_code) filters.push(`catalog_code.ilike.%${proposed.catalog_code}%`)
  if (proposed.name) filters.push(`name.ilike.%${proposed.name}%`, `subject.ilike.%${proposed.name}%`)

  let query = supabase
    .from('items')
    .select(CATALOGUE_SELECT.join(','))
    .limit(25)

  if (filters.length) {
    query = query.or(filters.join(','))
  } else {
    query = query.order('name', { ascending: true, nullsFirst: false }).limit(0)
  }

  const { data, error } = await query
  if (error) throw error

  const candidates = (data || [])
    .map((row) => {
      const scored = scoreScanCandidate(row, proposed)
      return {
        item: row,
        score: scored.score,
        reasons: scored.reasons,
        comparisons: compareScanFields(row, proposed),
      }
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)

  const best = candidates[0] || null
  const hasConflicts = !!best?.comparisons?.some((comparison) => comparison.differs)
  let route = 'new_item_proposal'
  let status = 'Proposed New Item'

  if (best?.score >= 95 && !hasConflicts) {
    route = 'existing_match'
    status = 'Matched'
  } else if (best?.score >= 80) {
    route = hasConflicts ? 'manual_review_existing_item' : 'existing_match'
    status = hasConflicts ? 'Manual Review - Existing Item' : 'Matched'
  } else if (best?.score >= 55) {
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

export async function createCatalogueItemFromScan(draft) {
  const proposed = draft.scanAnalysis?.proposed || proposedScanFields(draft)
  if (!proposed.name) throw new Error('A name is required before creating a catalogue item.')

  const categoryName = draft.category || ''
  const { data: category } = categoryName
    ? await supabase.from('categories').select('category_id').ilike('name', `%${categoryName}%`).limit(1).maybeSingle()
    : { data: null }

  const payload = {
    name: proposed.name,
    subject: proposed.subject || proposed.name,
    category_id: category?.category_id || null,
    card_number: proposed.card_number || proposed.id_number || null,
    lego_set_number: proposed.lego_set_number || null,
    catalog_code: proposed.catalog_code || null,
    upc: proposed.upc || proposed.barcodes || null,
    release_year: Number(proposed.release_year) || null,
    retail_price: Number(proposed.retail_price) || null,
    availability: proposed.availability || null,
    dynamic_fields: {
      scanner_source: 'CollectorsHub Desktop scanner',
      scanner_confidence: draft.scanAnalysis?.confidence || null,
      manufacturer: proposed.manufacturer || '',
      set_name: proposed.collectible_set || '',
      taxonomy: {
        subcategory: proposed.subcategory || '',
        franchise: proposed.franchise || '',
        subfranchise: proposed.subfranchise || '',
        property: proposed.property || '',
        item_type: proposed.item_type || '',
      },
      collection: proposed.collection || '',
      sports_card: {
        player: proposed.player || '',
        subset_insert_set: proposed.subset_insert_set || '',
        sport: proposed.sport || '',
        league: proposed.league || '',
        team: proposed.team || '',
        position: proposed.position || '',
        rookie_card: proposed.rookie_card || '',
        base_insert: proposed.base_insert || '',
        parallel: proposed.parallel || '',
        parallel_colour: proposed.parallel_colour || '',
        variation: proposed.variation || '',
        serial_numbered: proposed.serial_numbered || '',
        serial_number: proposed.serial_number || '',
        print_run: proposed.print_run || '',
        autograph: proposed.autograph || '',
        autograph_type: proposed.autograph_type || '',
        memorabilia_relic: proposed.memorabilia_relic || '',
        memorabilia_type: proposed.memorabilia_type || '',
        memorabilia_source: proposed.memorabilia_source || '',
        patch_type: proposed.patch_type || '',
        rookie_patch_auto: proposed.rookie_patch_auto || '',
        short_print: proposed.short_print || '',
        super_short_print: proposed.super_short_print || '',
        case_hit: proposed.case_hit || '',
        error_correction: proposed.error_correction || '',
        multi_player_card: proposed.multi_player_card || '',
        other_players: proposed.other_players || '',
        draft_team: proposed.draft_team || '',
        college_junior_team: proposed.college_junior_team || '',
        grading_company: proposed.grading_company || '',
        grade: proposed.grade || '',
        subgrades: proposed.subgrades || '',
        certification_number: proposed.certification_number || '',
        raw_condition: proposed.raw_condition || '',
        market_value: proposed.market_value || '',
        last_sale: proposed.last_sale || '',
        price_updated: proposed.price_updated || '',
        external_ids: proposed.external_ids || '',
      },
      trading_card: {
        series_block: proposed.series_block || '',
        franchise_game: proposed.franchise_game || '',
        release_date: proposed.release_date || '',
        rarity: proposed.rarity || '',
        variant_parallel: proposed.variant_parallel || '',
        finish: proposed.finish || '',
        language: proposed.language || '',
        edition: proposed.edition || '',
        card_type: proposed.card_type || '',
        character_subject: proposed.character_subject || '',
        card_attributes: proposed.card_attributes || '',
        artist: proposed.artist || '',
        serial_number: proposed.serial_number || '',
        print_run: proposed.print_run || '',
        promo: proposed.promo || '',
        promo_number: proposed.promo_number || '',
        autograph: proposed.autograph || '',
        memorabilia_relic: proposed.memorabilia_relic || '',
        rookie_card: proposed.rookie_card || '',
        short_print: proposed.short_print || '',
        error_variation: proposed.error_variation || '',
        grading_company: proposed.grading_company || '',
        grade: proposed.grade || '',
        certification_number: proposed.certification_number || '',
        raw_condition: proposed.raw_condition || '',
        market_value: proposed.market_value || '',
        last_sale: proposed.last_sale || '',
        price_updated: proposed.price_updated || '',
        tcgplayer_id: proposed.tcgplayer_id || '',
        ebay_external_ids: proposed.ebay_external_ids || '',
      },
      description: proposed.description || '',
      includes: proposed.includes || '',
      included_in: proposed.included_in || '',
      variant: proposed.variant || '',
      language: proposed.language || '',
      country: proposed.country || '',
      notes: proposed.notes || '',
    },
  }

  const { data, error } = await supabase.from('items').insert(payload).select(CATALOGUE_SELECT.join(',')).single()
  if (error) throw error
  return data
}
