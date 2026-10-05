import { supabase } from './supabaseClient'
import { resolvePrimaryLocation } from './sync'

// Store scan intake: scanned cards that matched a catalogue item are added to
// the signed-in store's stock exactly the way the website adds stock - a
// store_inventory row, then a "receive" movement for the quantity at the
// store's location (apply_inventory_movement keeps the stock history). Each
// batch is its own record (own cost, condition and price); the Inventory
// screen groups copies of a card. Never creates catalogue items.

export const CARD_CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged']

function money(value) {
  if (value === '' || value == null) return null
  const number = Number(String(value).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null
}

function makeSku(name) {
  const base = String(name || 'CARD').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10) || 'CARD'
  return `${base}-${Date.now().toString(36).toUpperCase().slice(-5)}${Math.floor(Math.random() * 90 + 10)}`
}

// Returns { inventoryId, created }.
export async function addScannedCardToStock({ session, item, condition = 'Near Mint', quantity = 1, sellPrice = '', buyPrice = '' }) {
  if (!session?.storeId) throw new Error('No store is signed in.')
  if (!session?.locationId) throw new Error('This store has no location to receive stock into.')
  if (!item?.item_id) throw new Error('Pick the catalogue item for this card first.')
  const count = Math.max(1, parseInt(quantity, 10) || 1)
  const sell = money(sellPrice)
  const buy = money(buyPrice)

  // Each scanned batch of a card becomes its own stock record (its own cost,
  // condition and price), never merged into an existing one.
  const { data, error } = await supabase.from('store_inventory').insert({
    store_id: session.storeId,
    catalog_item_id: item.item_id,
    sku: makeSku(item.card_number || item.name || item.subject),
    condition,
    cost_basis: buy,
    buy_price: buy,
    sell_price: sell,
    in_store_price: sell,
    name_snapshot: String(item.name || item.subject || 'Card').trim(),
    status: 'active',
    is_used: false,
    is_trade_in: false,
  }).select('id').single()
  if (error) throw error
  const inventoryId = data.id


  const { error: moveError } = await supabase.rpc('apply_inventory_movement', {
    p_inventory_id: inventoryId,
    p_location_id: session.locationId,
    p_quantity_change: count,
    p_movement_type: 'receive',
    p_reason: 'scan intake',
  })
  if (moveError) throw moveError
  return { inventoryId, created: true }
}

// A store's own item that isn't a catalogue card (a Coke, a snack, sleeves…):
// a stock record with no catalogue link, its barcode (so it scans at the
// register) and prices, then a "receive" movement for the starting quantity.
// Returns the new stock record's id.
export async function createStoreItem({ session, name, sku = '', barcode = '', cost = '', price = '', quantity = 0, condition = 'New' }) {
  if (!session?.storeId) throw new Error('No store is signed in.')
  if (!session?.locationId) throw new Error('This store has no location to receive stock into.')
  const cleanName = String(name || '').trim()
  if (!cleanName) throw new Error('Give the item a name.')
  const cleanBarcode = String(barcode || '').trim()
  const buy = money(cost)
  const sell = money(price)
  const { data, error } = await supabase.from('store_inventory').insert({
    store_id: session.storeId,
    catalog_item_id: null,
    // SKUs are unique per store: the typed SKU, else the barcode, else one made from the name.
    sku: String(sku || '').trim() || cleanBarcode || makeSku(cleanName),
    barcode: cleanBarcode || null,
    condition: condition || 'New',
    cost_basis: buy,
    buy_price: buy,
    sell_price: sell,
    in_store_price: sell,
    name_snapshot: cleanName,
    status: 'active',
    is_used: false,
    is_trade_in: false,
  }).select('id').single()
  if (error) {
    if (/duplicate|unique/i.test(error.message || '')) throw new Error('That SKU or barcode is already used by another item in this store.')
    throw error
  }
  const count = Math.max(0, parseInt(quantity, 10) || 0)
  if (count > 0) {
    const { error: moveError } = await supabase.rpc('apply_inventory_movement', {
      p_inventory_id: data.id,
      p_location_id: session.locationId,
      p_quantity_change: count,
      p_movement_type: 'receive',
      p_reason: 'new store item',
    })
    if (moveError) throw moveError
  }
  return data.id
}

// Saves an Inventory edit to the store's stock record in Supabase (so it
// survives the next sync): name, SKU, barcode, condition, cost and prices,
// and a stock adjustment (a movement, so it's in the stock history).
export async function saveStoreItemChanges({ session, item, patch }) {
  const id = String(item?.inventoryId || item?.id || '')
  if (!session?.storeId || !/^[0-9a-f-]{36}$/i.test(id)) return false
  const update = {}
  if ('name' in patch) update.name_snapshot = String(patch.name || '').trim() || null
  if ('sku' in patch) update.sku = String(patch.sku || '').trim() || null
  if ('barcode' in patch) update.barcode = String(patch.barcode || '').trim() || null
  if ('condition' in patch) update.condition = String(patch.condition || '').trim() || null
  if ('cost' in patch) { update.buy_price = money(patch.cost); update.cost_basis = money(patch.cost) }
  if ('inStorePrice' in patch) update.in_store_price = money(patch.inStorePrice)
  if ('onlinePrice' in patch) update.sell_price = money(patch.onlinePrice)
  if ('listedForSale' in patch) update.listed_for_sale = Boolean(patch.listedForSale)
  if (Object.keys(update).length) {
    const { error } = await supabase.from('store_inventory').update(update).eq('id', id).eq('store_id', session.storeId)
    if (error) throw error
  }
  // A stock change: the +/- amount (stockDelta), or a new on-hand count. The
  // movement goes to the location the stock is held at, and the count it
  // returns (the real one in Supabase) is passed back for the screen.
  const result = { saved: true, onHand: null }
  if ('stockDelta' in patch || 'onHand' in patch) {
    const delta = 'stockDelta' in patch
      ? Math.round(Number(patch.stockDelta) || 0)
      : Math.round(Number(patch.onHand) - Number(item.onHand ?? item.quantity ?? 0))
    if (delta) {
      const locationId = item.locationId || await resolvePrimaryLocation(session.storeId, session.locationId)
      if (!locationId) throw new Error('This store has no location to hold stock.')
      const { data, error } = await supabase.rpc('apply_inventory_movement', {
        p_inventory_id: id,
        p_location_id: locationId,
        p_quantity_change: delta,
        p_movement_type: 'adjustment',
        p_reason: 'inventory screen adjustment',
      })
      if (error) throw error
      if (data != null && Number.isFinite(Number(data))) result.onHand = Number(data)
    }
  }
  return result
}
