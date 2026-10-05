import { supabase } from './supabaseClient'

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
