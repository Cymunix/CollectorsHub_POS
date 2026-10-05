import { supabase } from './supabaseClient'

const ITEM_IMAGES_BUCKET = 'item-images'
const STORE_INVENTORY_IMAGES_BUCKET = 'store-inventory-images'

function publicUrl(bucket, path) {
  if (!path) return ''
  return path.startsWith('http') ? path : (supabase.storage.from(bucket).getPublicUrl(path).data?.publicUrl || '')
}

function uniq(values) {
  return [...new Set((values || []).filter(Boolean))]
}

async function resolvePrimaryLocation(storeId, preferredLocationId) {
  if (preferredLocationId) return preferredLocationId
  if (!storeId) return null

  const { data, error } = await supabase
    .from('store_locations')
    .select('id')
    .eq('store_id', storeId)
    .eq('status', 'active')
    .order('created_at')
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data?.id || null
}

async function resolveContext(session) {
  if (session?.storeId) {
    return {
      storeId: session.storeId,
      locationId: await resolvePrimaryLocation(session.storeId, session.locationId),
    }
  }

  if (session?.type === 'organization' && session.orgId) {
    const { data, error } = await supabase.rpc('organization_stores', { p_org_id: session.orgId })
    if (error) throw error
    const store = (data || []).find((row) => row.status === 'active') || (data || [])[0]
    return {
      storeId: store?.store_id || null,
      locationId: await resolvePrimaryLocation(store?.store_id || null, null),
    }
  }

  return { storeId: null, locationId: null }
}

async function loadCategoryMap(categoryIds) {
  const ids = uniq(categoryIds)
  if (!ids.length) return {}

  const { data, error } = await supabase.from('categories').select('category_id, name').in('category_id', ids)
  if (error) throw error
  return Object.fromEntries((data || []).map((row) => [row.category_id, row.name]))
}

// Runs a query per batch of ids (one request listing thousands of ids is too
// long for the server) and joins the rows.
async function inBatches(ids, query, size = 100) {
  const rows = []
  for (let index = 0; index < ids.length; index += size) {
    const { data, error } = await query(ids.slice(index, index + size))
    if (error) throw error
    rows.push(...(data || []))
  }
  return { data: rows, error: null }
}

async function loadCatalogueMeta(catalogItemIds) {
  const ids = uniq(catalogItemIds)
  if (!ids.length) return {}

  const { data, error } = await inBatches(ids, (batch) => supabase
    .from('items')
    .select('item_id, name, card_number, lego_set_number, minifig_code, category_id, market_price, retail_price, image_path, dynamic_fields')
    .in('item_id', batch))

  if (error) throw error

  const categoryMap = await loadCategoryMap((data || []).map((row) => row.category_id))
  return Object.fromEntries((data || []).map((row) => [
    row.item_id,
    {
      catalogItemId: row.item_id,
      catalogName: row.name || '',
      name: row.name || '',
      number: row.card_number || row.lego_set_number || row.minifig_code || '',
      category: categoryMap[row.category_id] || '',
      marketPrice: row.market_price,
      retailPrice: row.retail_price,
      imagePath: row.image_path || '',
      finish: row.dynamic_fields?.finish || row.dynamic_fields?.foil || '',
    },
  ]))
}

async function loadImageMaps(inventoryIds, catalogItemIds) {
  const inventoryImageMap = {}
  const catalogImageMap = {}

  if (inventoryIds.length) {
    const { data, error } = await inBatches(inventoryIds, (batch) => supabase
      .from('store_inventory_images')
      .select('inventory_id, storage_path, position')
      .in('inventory_id', batch)
      .order('position'))

    if (error) throw error

    for (const row of data || []) {
      if (row.inventory_id && row.storage_path && !(row.inventory_id in inventoryImageMap)) {
        inventoryImageMap[row.inventory_id] = publicUrl(STORE_INVENTORY_IMAGES_BUCKET, row.storage_path)
      }
    }
  }

  if (catalogItemIds.length) {
    const { data, error } = await inBatches(catalogItemIds, (batch) => supabase
      .from('item_images')
      .select('item_id, image_path, position')
      .in('item_id', batch)
      .order('position'))

    if (error) throw error

    for (const row of data || []) {
      if (row.item_id && row.image_path && !(row.item_id in catalogImageMap)) {
        catalogImageMap[row.item_id] = publicUrl(ITEM_IMAGES_BUCKET, row.image_path)
      }
    }
  }

  return { inventoryImageMap, catalogImageMap }
}

async function logEmptyDiagnostics(storeId, locationId) {
  const [{ count: quantityCount, error: quantityError }, { count: inventoryCount, error: inventoryError }] = await Promise.all([
    supabase
      .from('store_inventory_quantities')
      .select('inventory_id', { count: 'exact', head: true })
      .eq('store_id', storeId),
    supabase
      .from('store_inventory')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', storeId)
      .eq('status', 'active'),
  ])

  console.info('[Desktop Sync] Empty inventory diagnostics', {
    storeId,
    locationId,
    storeQuantityRows: quantityCount ?? 0,
    activeInventoryRows: inventoryCount ?? 0,
    quantityError: quantityError?.message || null,
    inventoryError: inventoryError?.message || null,
  })
}

export async function syncInventoryFromSupabase(session) {
  const startedAt = new Date().toISOString()
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError) throw userError

  const userId = userData?.user?.id || null
  const { storeId, locationId } = await resolveContext(session)

  console.info('[Desktop Sync] Authenticated User:', userId)
  console.info('[Desktop Sync] Store:', storeId)
  console.info('[Desktop Sync] Location:', locationId)

  if (!storeId || !locationId) {
    throw new Error('No active store/location could be resolved for this desktop session.')
  }

  // Every stock record at this location, including ones at 0 (favourites stay
  // listed and the Sold out filter needs them; the register only sells what's
  // available). Paged past Supabase's 1,000-row limit.
  const quantityRows = []
  for (let from = 0; ; from += 1000) {
    const { data, error: quantityError } = await supabase
      .from('store_inventory_quantities')
      .select('inventory_id, store_id, location_id, quantity, quantity_reserved, updated_at')
      .eq('store_id', storeId)
      .eq('location_id', locationId)
      .gte('quantity', 0)
      .order('updated_at', { ascending: false })
      .range(from, from + 999)
    if (quantityError) {
      console.error('[Desktop Sync] RLS/query error:', quantityError)
      throw quantityError
    }
    quantityRows.push(...(data || []))
    if (!data || data.length < 1000) break
  }

  const quantityList = quantityRows
  const inventoryIds = quantityList.map((row) => row.inventory_id)
  console.info('[Desktop Sync] Quantity rows returned:', quantityList.length)

  if (!inventoryIds.length) {
    console.info('[Desktop Sync] Inventory returned: 0 records')
    await logEmptyDiagnostics(storeId, locationId)
    return {
      inventory: [],
      context: { userId, storeId, locationId },
      status: { startedAt, completedAt: new Date().toISOString(), returned: 0, written: 0 },
    }
  }

  // In batches: one request listing thousands of ids is too long for the server.
  const inventoryRows = []
  for (let index = 0; index < inventoryIds.length; index += 200) {
    const { data, error: inventoryError } = await supabase
      .from('store_inventory')
      .select('id, store_id, catalog_item_id, sku, barcode, condition, grade, grading_company, buy_price, sell_price, in_store_price, name_snapshot, status, is_trade_in, listed_for_sale')
      .eq('store_id', storeId)
      .eq('status', 'active')
      .in('id', inventoryIds.slice(index, index + 200))
    if (inventoryError) {
      console.error('[Desktop Sync] RLS/query error:', inventoryError)
      throw inventoryError
    }
    inventoryRows.push(...(data || []))
  }

  const quantityMap = Object.fromEntries(quantityList.map((row) => [row.inventory_id, row]))
  const activeInventory = inventoryRows || []
  const catalogIds = activeInventory.map((row) => row.catalog_item_id)
  const [catalogMeta, imageMaps] = await Promise.all([
    loadCatalogueMeta(catalogIds),
    loadImageMaps(inventoryIds, uniq(catalogIds)),
  ])

  const inventory = activeInventory.map((row) => {
    const quantity = quantityMap[row.id] || {}
    const meta = catalogMeta[row.catalog_item_id] || {}
    const onHand = Number(quantity.quantity) || 0
    const reserved = Number(quantity.quantity_reserved) || 0
    const available = Math.max(0, onHand - reserved)
    const onlinePrice = row.sell_price != null ? Number(row.sell_price) : null
    const inStorePrice = row.in_store_price != null ? Number(row.in_store_price) : null
    const price = inStorePrice ?? onlinePrice ?? 0
    const fallbackCatalogImage = meta.imagePath ? publicUrl(ITEM_IMAGES_BUCKET, meta.imagePath) : ''
    const image = imageMaps.inventoryImageMap[row.id] || imageMaps.catalogImageMap[row.catalog_item_id] || fallbackCatalogImage

    return {
      id: row.id,
      inventoryId: row.id,
      catalogItemId: row.catalog_item_id,
      storeId: row.store_id,
      locationId: quantity.location_id || locationId,
      sku: row.sku || '',
      barcode: row.barcode || '',
      name: row.name_snapshot || meta.name || row.sku || 'Inventory Item',
      title: row.name_snapshot || meta.name || row.sku || 'Inventory Item',
      // A store's own item (a drink, a snack…) has no catalogue card.
      category: meta.category || (row.catalog_item_id ? '' : 'Store item'),
      number: meta.number || '',
      condition: row.grade || row.condition || '',
      rawCondition: row.condition || '',
      grade: row.grade || '',
      gradingCompany: row.grading_company || '',
      quantity: available,
      onHand,
      reserved,
      available,
      price,
      inStorePrice,
      onlinePrice,
      cost: row.buy_price != null ? Number(row.buy_price) : null,
      buyPrice: row.buy_price != null ? Number(row.buy_price) : null,
      image,
      imageUrl: image,
      status: row.status,
      listedForSale: !!row.listed_for_sale,
      isTradeIn: !!row.is_trade_in,
      availability: available > 0 ? 'available' : 'out_of_stock',
      unit_price: price,
      syncedAt: new Date().toISOString(),
    }
  })

  console.info(`[Desktop Sync] Inventory returned: ${inventory.length} records`)
  console.info(`[Desktop Sync] Local cache written: ${inventory.length} records`)
  console.info('[Desktop Sync] Complete')

  if (inventory.length === 0) await logEmptyDiagnostics(storeId, locationId)

  return {
    inventory,
    context: { userId, storeId, locationId },
    status: {
      startedAt,
      completedAt: new Date().toISOString(),
      returned: inventory.length,
      written: inventory.length,
      failedRecords: [],
    },
  }
}

export async function syncCustomersFromSupabase(session) {
  const { storeId } = await resolveContext(session)
  if (!storeId) return []

  const { data, error } = await supabase
    .from('store_customers')
    .select('id, display_name, phone, email, membership_code, collectorshub_user_id, notes, updated_at, created_at')
    .eq('store_id', storeId)
    .order('updated_at', { ascending: false })
    .limit(250)

  if (error) {
    console.error('[Desktop Sync] Customer query error:', error)
    throw error
  }

  return (data || []).map((row) => ({
    id: row.id,
    name: row.display_name || row.membership_code || row.email || 'Customer',
    username: row.membership_code || '',
    email: row.email || '',
    phone: row.phone || '',
    notes: row.notes || '',
    collectorshub_user_id: row.collectorshub_user_id || null,
    profileId: row.collectorshub_user_id || null,
    storeCredit: 0,
    updatedAt: row.updated_at || row.created_at || null,
  }))
}
