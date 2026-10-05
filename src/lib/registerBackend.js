import { supabase } from './supabaseClient'

const CATALOGUE_IMAGE_BUCKET = 'item-images'

function publicCatalogueImage(path) {
  if (!path) return ''
  if (String(path).startsWith('http')) return path
  return supabase.storage.from(CATALOGUE_IMAGE_BUCKET).getPublicUrl(path).data?.publicUrl || ''
}

function catalogueSearchValue(value) {
  return String(value ?? '').trim()
}

/**
 * Buy / Trade-In searches the catalogue, just like the web Store POS. A buy
 * candidate does not need an existing store_inventory row because the item is
 * being offered by the customer for the first time.
 */
const DESKTOP_CATALOGUE_SELECT = 'item_id, name, subject, description, card_number, lego_set_number, minifig_code, bricklink_id, catalog_code, upc, external_ids, release_year, category_id, market_price, retail_price, image_path, dynamic_fields'

// One catalogue item as a register candidate, looked up by its id (the AI
// match already knows it; a text search for it was slow).
export async function loadDesktopCatalogueItem(itemId) {
  if (!itemId) return null
  let { data, error } = await supabase.from('items').select(DESKTOP_CATALOGUE_SELECT).eq('item_id', itemId).maybeSingle()
  // Older databases may lack an optional identifier column: retry with the basics.
  if (error) ({ data, error } = await supabase.from('items').select('item_id, name, subject, description, card_number, release_year, category_id, market_price, retail_price, image_path, dynamic_fields').eq('item_id', itemId).maybeSingle())
  if (error) throw error
  return data ? (await buildDesktopCatalogueCandidates([data]))[0] || null : null
}

export async function searchDesktopTradeCatalogue(query) {
  const term = catalogueSearchValue(query)
  if (term.length < 2) return []

  const catalogueSelect = DESKTOP_CATALOGUE_SELECT
  const results = []
  const seen = new Set()
  const addRows = (rows) => {
    for (const row of rows || []) {
      if (!row?.item_id || seen.has(row.item_id)) continue
      seen.add(row.item_id)
      results.push(row)
    }
  }

  const textQueries = [
    supabase.from('items').select(catalogueSelect).ilike('name', `%${term}%`).limit(15),
    supabase.from('items').select(catalogueSelect).ilike('subject', `%${term}%`).limit(15),
    supabase.from('items').select(catalogueSelect).ilike('description', `%${term}%`).limit(15),
    supabase.from('items').select(catalogueSelect).ilike('card_number', `%${term}%`).limit(15),
    supabase.from('items').select(catalogueSelect).ilike('lego_set_number', `%${term}%`).limit(15),
    supabase.from('items').select(catalogueSelect).ilike('minifig_code', `%${term}%`).limit(15),
    supabase.from('items').select(catalogueSelect).ilike('bricklink_id', `%${term}%`).limit(15),
    supabase.from('items').select(catalogueSelect).ilike('catalog_code', `%${term}%`).limit(15),
    supabase.from('items').select(catalogueSelect).ilike('upc', `%${term}%`).limit(15),
  ]
  // Several words, e.g. "jalen hurts 64": the name words in order, and any
  // word with a digit as the card number.
  const words = term.split(/\s+/).map((word) => word.replace(/^#/, '')).filter(Boolean)
  const numberWords = words.filter((word) => /\d/.test(word))
  const nameWords = words.filter((word) => !/\d/.test(word)).map((word) => word.replace(/[^\p{L}\p{N}'-]/gu, '')).filter((word) => word.length >= 2)
  if (words.length > 1 && nameWords.length) {
    const namePattern = `%${nameWords.join('%')}%`
    if (numberWords.length) {
      const numbers = [...new Set(numberWords.flatMap((word) => [word, word.toUpperCase(), word.replace(/^0+(?=\d)/, '')]))]
      textQueries.push(supabase.from('items').select(catalogueSelect).ilike('name', namePattern).in('card_number', numbers).limit(15))
      textQueries.push(supabase.from('items').select(catalogueSelect).ilike('subject', namePattern).in('card_number', numbers).limit(15))
    } else {
      textQueries.push(supabase.from('items').select(catalogueSelect).ilike('name', namePattern).limit(15))
    }
  }
  const responses = await Promise.all(textQueries)
  // Keep a supported name search useful even if an older database instance is
  // missing one of the optional identifier columns.
  const successfulResponses = responses.filter((response) => !response.error)
  if (!successfulResponses.length) throw responses[0]?.error || new Error('Catalogue search failed.')
  successfulResponses.forEach((response) => addRows(response.data))

  if (results.length < 15) {
    const { data: subjects, error: subjectError } = await supabase
      .from('subjects')
      .select('subject_id')
      .ilike('subject_name', `%${term}%`)
      .limit(15)
    if (subjectError) console.warn('[Desktop Register] Catalogue subject search unavailable:', subjectError)

    const subjectIds = (subjects || []).map((row) => row.subject_id).filter(Boolean)
    if (subjectIds.length) {
      const { data, error } = await supabase
        .from('items')
        .select(catalogueSelect)
        .in('subject_id', subjectIds)
        .limit(15)
      if (error) console.warn('[Desktop Register] Catalogue subject item search unavailable:', error)
      else addRows(data)
    }
  }

  return buildDesktopCatalogueCandidates(results.slice(0, 15))
}

// Catalogue rows -> register candidates (category, photo, market value from
// approved sales by condition).
async function buildDesktopCatalogueCandidates(rows) {
  if (!rows.length) return []

  const categoryIds = [...new Set(rows.map((row) => row.category_id).filter(Boolean))]
  const itemIds = rows.map((row) => row.item_id).filter(Boolean)
  const [{ data: categories, error: categoryError }, { data: images, error: imageError }, aggregateMarketStats, marketSales] = await Promise.all([
    categoryIds.length
      ? supabase.from('categories').select('category_id, name').in('category_id', categoryIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from('item_images').select('item_id, image_path, position').in('item_id', itemIds).order('position'),
    loadRegisterMarketStatsForItems(itemIds),
    loadMarketSalesForItems(itemIds),
  ])
  if (categoryError) console.warn('[Desktop Register] Catalogue category lookup failed:', categoryError)
  if (imageError) console.warn('[Desktop Register] Catalogue image lookup failed:', imageError)

  const categoryMap = Object.fromEntries((categories || []).map((row) => [row.category_id, row.name]))
  const imageMap = {}
  for (const row of images || []) {
    if (row.item_id && row.image_path && !imageMap[row.item_id]) imageMap[row.item_id] = publicCatalogueImage(row.image_path)
  }

  return rows.map((row) => {
    const fallbackValue = Number(row.market_price ?? row.retail_price ?? 0)
    const marketStats = aggregateMarketStats[row.item_id] || buildConditionMarketStats(marketSales[row.item_id] || [])
    const defaultCondition = preferredConditionForCategory(categoryMap[row.category_id] || '')
    const defaultConditionStats = marketValueForCondition(marketStats, defaultCondition)
    const marketValue = defaultConditionStats?.average30Day ?? defaultConditionStats?.average ?? fallbackValue
    return {
      id: `catalog_${row.item_id}`,
      catalogItemId: row.item_id,
      catalogueItemId: row.item_id,
      sku: row.card_number || row.lego_set_number || row.minifig_code || row.bricklink_id || row.catalog_code || row.upc || '',
      number: row.card_number || row.lego_set_number || row.minifig_code || row.catalog_code || row.upc || '',
      name: row.name || row.subject || row.description || 'Catalogue item',
      title: row.name || row.subject || row.description || 'Catalogue item',
      category: categoryMap[row.category_id] || '',
      marketValue,
      price: marketValue,
      marketStats,
      conditionMarketValues: marketStats.byCondition,
      marketValueSource: defaultConditionStats
        ? defaultConditionStats.recentCount
          ? `${defaultConditionStats.recentCount} approved sale${defaultConditionStats.recentCount === 1 ? '' : 's'} 30-day avg (${defaultCondition})`
          : `${defaultConditionStats.count} approved sale${defaultConditionStats.count === 1 ? '' : 's'} all-time avg (${defaultCondition})`
        : fallbackValue ? 'Catalogue pricing' : 'Unavailable',
      salesUsed: defaultConditionStats?.recentCount || defaultConditionStats?.count || 0,
      average30Day: marketStats.average30Day || 0,
      image: imageMap[row.item_id] || publicCatalogueImage(row.image_path),
      imageUrl: imageMap[row.item_id] || publicCatalogueImage(row.image_path),
      releaseYear: row.release_year || '',
      dynamicFields: row.dynamic_fields || {},
      isCatalogueCandidate: true,
    }
  })
}

async function loadRegisterMarketStatsForItems(itemIds) {
  const ids = [...new Set((itemIds || []).filter(Boolean))]
  if (!ids.length) return {}

  const { data, error } = await supabase.rpc('register_market_condition_averages', {
    p_item_ids: ids,
    p_currency: 'CAD',
  })
  if (error) {
    console.warn('[Desktop Register] Register market aggregate unavailable:', error)
    return {}
  }

  const grouped = {}
  for (const row of data || []) {
    const itemId = row.item_id
    if (!itemId) continue
    const condition = normalizeMarketCondition(row.condition || row.condition_code || 'Unknown')
    if (!grouped[itemId]) grouped[itemId] = { byCondition: {}, salesCount: 0, average30Day: 0 }
    const stat = {
      condition,
      count: Number(row.sales_count || 0),
      recentCount: Number(row.count_30d || 0),
      average: row.average_price == null ? null : Number(row.average_price),
      average30Day: row.avg_30d == null ? null : Number(row.avg_30d),
      low: row.lowest_price == null ? null : Number(row.lowest_price),
      high: row.highest_price == null ? null : Number(row.highest_price),
    }
    grouped[itemId].byCondition[condition] = stat
    grouped[itemId].salesCount += stat.count
  }

  for (const stats of Object.values(grouped)) {
    const recentStats = Object.values(stats.byCondition).filter((stat) => stat.average30Day != null && stat.recentCount)
    const recentCount = recentStats.reduce((sum, stat) => sum + stat.recentCount, 0)
    stats.average30Day = recentCount
      ? roundMoney(recentStats.reduce((sum, stat) => sum + (stat.average30Day * stat.recentCount), 0) / recentCount)
      : 0
  }
  return grouped
}

async function loadMarketSalesForItems(itemIds) {
  const ids = [...new Set((itemIds || []).filter(Boolean))]
  if (!ids.length) return {}

  const select = 'sale_id,item_id,catalogue_item_id,sold_price,price,currency,sold_at,date_of_sale,condition,condition_code,is_excluded,match_status'
  const [byItemId, byCatalogueItemId] = await Promise.all([
    supabase.from('market_sales').select(select).in('item_id', ids),
    supabase.from('market_sales').select(select).in('catalogue_item_id', ids),
  ])

  for (const response of [byItemId, byCatalogueItemId]) {
    if (response.error) console.warn('[Desktop Register] Market sales lookup failed:', response.error)
  }

  const grouped = {}
  const seen = new Set()
  for (const row of [...(byItemId.data || []), ...(byCatalogueItemId.data || [])]) {
    if (row.is_excluded || row.match_status === 'excluded') continue
    const key = row.sale_id || `${row.item_id || row.catalogue_item_id}-${row.sold_at || row.date_of_sale}-${row.sold_price || row.price}`
    if (seen.has(key)) continue
    seen.add(key)
    const itemId = row.catalogue_item_id || row.item_id
    if (!itemId) continue
    if (!grouped[itemId]) grouped[itemId] = []
    grouped[itemId].push(row)
  }
  return grouped
}

function buildConditionMarketStats(rows = []) {
  const byCondition = {}
  const datedPrices = []
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)
  for (const row of rows) {
    const price = Number(row.sold_price ?? row.price)
    if (!Number.isFinite(price)) continue
    const condition = normalizeMarketCondition(row.condition || row.condition_code || 'Unknown')
    if (!byCondition[condition]) {
      byCondition[condition] = {
        condition,
        prices: [],
        recentPrices: [],
        count: 0,
        recentCount: 0,
        average: 0,
        average30Day: null,
        low: 0,
        high: 0,
      }
    }
    byCondition[condition].prices.push(price)
    const soldAt = new Date(row.sold_at || row.date_of_sale || 0)
    if (!Number.isNaN(soldAt.getTime())) {
      datedPrices.push({ price, soldAt })
      if (soldAt >= cutoff) byCondition[condition].recentPrices.push(price)
    }
  }

  for (const stat of Object.values(byCondition)) {
    stat.count = stat.prices.length
    stat.recentCount = stat.recentPrices.length
    stat.average = roundMoney(stat.prices.reduce((sum, value) => sum + value, 0) / stat.count)
    stat.average30Day = stat.recentPrices.length
      ? roundMoney(stat.recentPrices.reduce((sum, value) => sum + value, 0) / stat.recentPrices.length)
      : null
    stat.low = roundMoney(Math.min(...stat.prices))
    stat.high = roundMoney(Math.max(...stat.prices))
    delete stat.prices
    delete stat.recentPrices
  }

  const recent = datedPrices.filter((row) => row.soldAt >= cutoff).map((row) => row.price)

  return {
    byCondition,
    salesCount: rows.length,
    average30Day: recent.length ? roundMoney(recent.reduce((sum, value) => sum + value, 0) / recent.length) : 0,
  }
}

function normalizeMarketCondition(condition) {
  const text = String(condition || '').trim()
  const key = text.toLowerCase().replace(/[\s_-]+/g, ' ')
  const compact = key.replace(/[^a-z0-9]/g, '')
  const map = {
    sealed: 'New/Sealed',
    newsealed: 'New/Sealed',
    new: 'New/Sealed',
    complete: 'Pre-Owned 100%',
    preowned100: 'Pre-Owned 100%',
    preownedcomplete: 'Pre-Owned 100%',
    missingparts: 'Pre-Owned - Missing Parts',
    preownedmissingparts: 'Pre-Owned - Missing Parts',
    dmg: 'Damaged',
    damaged: 'Damaged',
    nm: 'Near Mint',
    nearmint: 'Near Mint',
    lp: 'Lightly Played',
    lightlyplayed: 'Lightly Played',
    mp: 'Moderately Played',
    moderatelyplayed: 'Moderately Played',
    hp: 'Heavily Played',
    heavilyplayed: 'Heavily Played',
  }
  return map[compact] || text || 'Unknown'
}

function preferredConditionForCategory(category) {
  const text = String(category || '').toLowerCase()
  if (text.includes('lego') || text.includes('building')) return 'New/Sealed'
  return 'Near Mint'
}

function marketValueForCondition(marketStats, condition) {
  const normalized = normalizeMarketCondition(condition)
  return marketStats?.byCondition?.[normalized] || null
}

export async function loadRegisterLocation(locationId) {
  if (!locationId) return null
  const { data, error } = await supabase
    .from('store_locations')
    .select('id, location_name, street_address, city, province, postal_code, phone_number, tax_rate_1, tax_label_1, tax_rate_2, tax_label_2')
    .eq('id', locationId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

export async function loadReceiptBranding(session, location = null) {
  const fallback = {
    storeName: session?.storeName || 'Store',
    logoUrl: '',
    address: [location?.street_address, location?.city, location?.province, location?.postal_code].filter(Boolean).join(', '),
    phone: location?.phone_number || '',
    email: '',
    locationName: location?.location_name || 'Primary Location',
    returnPolicy: '',
  }
  if (!session?.storeId) return fallback

  try {
    const { data, error } = await supabase.rpc('public_store_profile', { p_store_id: session.storeId })
    if (error) throw error
    const profile = Array.isArray(data) ? data[0] : data
    const activeLocation = (profile?.locations || []).find((entry) => entry.location_id === session.locationId) || profile?.locations?.[0] || {}
    return {
      ...fallback,
      storeName: profile?.store_name || fallback.storeName,
      logoUrl: profile?.logo_url || '',
      address: [activeLocation.street_address, activeLocation.city, activeLocation.province, activeLocation.postal_code].filter(Boolean).join(', ') || fallback.address,
      phone: profile?.phone || activeLocation.phone || fallback.phone,
      email: profile?.email || '',
      locationName: activeLocation.name || fallback.locationName,
      returnPolicy: profile?.return_policy || '',
    }
  } catch (error) {
    console.warn('[Desktop Receipt] Store branding lookup failed:', error)
    return fallback
  }
}

export function calcLocationTax(location, taxableAmount) {
  const base = Math.max(0, Number(taxableAmount) || 0)
  const rate1 = Number(location?.tax_rate_1 || 0)
  const rate2 = Number(location?.tax_rate_2 || 0)
  return {
    rate: rate1 + rate2,
    total: +((base * rate1) + (base * rate2)).toFixed(2),
    lines: [
      rate1 ? { label: location?.tax_label_1 || 'Tax 1', rate: rate1, amount: +(base * rate1).toFixed(2) } : null,
      rate2 ? { label: location?.tax_label_2 || 'Tax 2', rate: rate2, amount: +(base * rate2).toFixed(2) } : null,
    ].filter(Boolean),
  }
}

export async function ensureStoreCustomer(session, customer) {
  if (!customer || customer.guest || customer.kind === 'guest') return null
  if (customer.id && !String(customer.id).startsWith('local_')) return customer.id

  if (customer.collectorshub_user_id || customer.profileId) {
    const { data, error } = await supabase.rpc('ensure_store_customer_for_profile', {
      p_store_id: session.storeId,
      p_profile_id: customer.collectorshub_user_id || customer.profileId,
    })
    if (error) throw error
    const row = Array.isArray(data) ? data[0] : data
    return row?.customer_id || row?.id || null
  }

  const { data, error } = await supabase
    .from('store_customers')
    .insert({
      store_id: session.storeId,
      display_name: customer.name || customer.username || 'Walk-in',
      email: customer.email || null,
      phone: customer.phone || null,
      membership_code: customer.username || customer.membership_code || null,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

function uuidOrNull(value) {
  const text = String(value || '').trim()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text) ? text : null
}

function saleLine(line) {
  const quantity = Number(line.quantity || 1)
  const unitPrice = Number(line.unitPrice || line.price || 0)
  const discount = Number(line.discountTotal ?? (line.discount || 0))
  return {
    inventory_id: line.inventoryId || line.id || null,
    catalog_item_id: line.catalogItemId || null,
    direction: 'out',
    name_snapshot: line.name || line.title || line.sku || 'Inventory Item',
    sku_snapshot: line.sku || null,
    condition: line.rawCondition || line.condition || null,
    grade: line.grade || null,
    unit_price: roundMoney(unitPrice),
    quantity,
    discount_total: roundMoney(discount),
    line_total: roundMoney(unitPrice * quantity - discount),
    fulfilment_type: 'purchase_now',
  }
}

// A new stock record's SKU: the card number (or name) plus a short unique
// suffix. SKUs are unique per store, and the card number alone repeats for
// every copy (and across different cards).
function uniqueTradeSku(line) {
  const base = String(line.sku || line.number || line.name || 'ITEM').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12) || 'ITEM'
  return `${base}-${Date.now().toString(36).toUpperCase().slice(-4)}${Math.random().toString(36).toUpperCase().slice(2, 5)}`
}

function tradeLine(line, payoutMethod) {
  const quantity = Number(line.quantity || 1)
  const offer = Number(line.storeOffer || line.unitPrice || 0)
  const market = Number(line.marketValue || line.sellPrice || offer || 0)
  return {
    // A searched store item (a specific stock record) gets its quantity
    // increased. Anything else becomes its own new stock record, so each copy
    // bought keeps its own cost, condition and price.
    inventory_id: uuidOrNull(line.inventoryId),
    catalog_item_id: uuidOrNull(line.catalogItemId),
    direction: 'in',
    name_snapshot: line.name || line.title || 'Trade-in Item',
    sku_snapshot: uuidOrNull(line.inventoryId) ? line.sku || null : uniqueTradeSku(line),
    condition: line.condition || null,
    grade: line.grade || null,
    unit_price: roundMoney(offer),
    quantity,
    discount_total: 0,
    line_total: roundMoney(offer * quantity),
    buy_price: roundMoney(offer),
    sell_price: roundMoney(market),
    is_used: true,
    payout: payoutMethod || 'cash',
  }
}

export async function completeDesktopCheckout(session, draft) {
  if (!session?.storeId || !session?.locationId) {
    throw new Error('No active Supabase store/location is connected for this Register.')
  }

  const customerId = await ensureStoreCustomer(session, draft.customer)
  const saleItems = (draft.items || []).filter((line) => line.direction !== 'incoming').map(saleLine)
  const tradeDraftItems = (draft.items || []).filter((line) => line.direction === 'incoming')
  const tradeItems = tradeDraftItems.map((line) => tradeLine(line, draft.payout?.method))
  const payments = (draft.payments || [])
    .filter((payment) => Math.abs(Number(payment.amount || 0)) > 0)
    .map((payment) => ({
      method: payment.method || 'cash',
      amount: roundMoney(payment.amount),
      reference: payment.reference || payment.status || null,
    }))

  const checkout = {
    purchase_items: saleItems,
    trade_items: tradeItems,
    payments,
    seller: draft.seller || null,
    totals: {
      subtotal_today: roundMoney(draft.subtotal),
      discount_today: roundMoney(draft.discounts),
      tax_today: roundMoney(draft.tax),
      trade_credit_total: draft.payout?.method === 'store_credit' ? roundMoney(draft.payout.amount) : 0,
      store_credit_total: roundMoney(draft.storeCreditApplied),
      total_today: roundMoney(draft.total),
      balance_today: roundMoney(draft.balance || 0),
    },
    notes: draft.notes || null,
    layaway: null,
    preorder: null,
  }

  const { data, error } = await supabase.rpc('complete_store_checkout', {
    p_location_id: session.locationId,
    p_customer_id: customerId,
    p_checkout: checkout,
  })
  if (error) throw error
  return data
}

export async function openRegisterShift(session, { openingCash = 0, registerName = 'REG-01' } = {}) {
  if (!session?.storeId || !session?.locationId) throw new Error('No active Supabase store/location is connected.')
  const { data, error } = await supabase.rpc('open_store_shift', {
    p_store_id: session.storeId,
    p_location_id: session.locationId,
    p_opening_cash: Number(openingCash) || 0,
    p_register_name: registerName,
  })
  if (error) throw error
  return data
}

export async function closeRegisterShift(shiftId, { countedCash = 0, notes = '' } = {}) {
  if (!shiftId) throw new Error('No open register shift is attached to this till.')
  const { data, error } = await supabase.rpc('close_store_shift', {
    p_shift_id: shiftId,
    p_counted_cash: Number(countedCash) || 0,
    p_notes: notes || null,
    p_counted_tenders: {},
    p_tender_slips: {},
    p_closeout_attestation: {},
  })
  if (error) throw error
  return data
}

export async function loadActiveStorePromotions(storeId) {
  if (!storeId) return []
  const { data, error } = await supabase.rpc('list_store_promotions', {
    p_store_id: storeId,
    p_status: 'active',
  })
  if (error) throw error
  return data || []
}

export async function verifyRegisterManagerApproval({ storeCode, username, pin }) {
  const { data, error } = await supabase.rpc('verify_store_employee_pin', {
    p_store_code: String(storeCode || '').trim(),
    p_username: String(username || '').trim(),
    p_pin: String(pin || '').trim(),
  })
  if (error) return { ok: false, error: error.message }
  const row = Array.isArray(data) ? data[0] : data
  const role = String(row?.role || '').toLowerCase()
  if (!row?.employee_id) return { ok: false, error: 'Invalid manager username or PIN.' }
  if (!['supervisor', 'manager', 'owner'].includes(role)) {
    return { ok: false, error: 'This employee is not authorised to approve discounts.' }
  }
  return { ok: true, approver: { employeeId: row.employee_id, role, username: username.trim() } }
}

export async function completeDesktopRefund(session, { originalTransactionId, refundMethod, refundAmount, reason }) {
  if (!session?.locationId) throw new Error('No live store location connected.')
  const { data, error } = await supabase.rpc('complete_store_return', {
    p_original_transaction_id: originalTransactionId,
    p_location_id: session.locationId,
    p_items: [],
    p_refund_method: refundMethod || 'cash',
    p_refund_amount: Number(refundAmount) || 0,
    p_reason: reason || null,
  })
  if (error) throw new Error(error.message)
  return data
}
