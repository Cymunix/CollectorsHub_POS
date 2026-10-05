import { supabase } from './supabaseClient'

// Store favourites (supabase/store_favorites.sql): catalogue cards a store
// always wants in stock. They stay on the Inventory screen at 0, and the POS
// alerts when one is low (at or below its low-stock level) or out.

// Returns { [catalogItemId]: { threshold } } for the store.
export async function loadStoreFavorites(storeId) {
  if (!storeId) return {}
  const { data, error } = await supabase
    .from('store_favorite_items')
    .select('catalog_item_id, low_stock_threshold')
    .eq('store_id', storeId)
  if (error) throw error
  return Object.fromEntries((data || []).map((row) => [row.catalog_item_id, { threshold: Number(row.low_stock_threshold ?? 1) }]))
}

export async function setStoreFavorite(storeId, catalogItemId, favorite) {
  if (!storeId || !catalogItemId) throw new Error('Only catalogue items can be favourited.')
  if (favorite) {
    const { error } = await supabase
      .from('store_favorite_items')
      .upsert({ store_id: storeId, catalog_item_id: catalogItemId }, { onConflict: 'store_id,catalog_item_id', ignoreDuplicates: true })
    if (error) throw error
  } else {
    const { error } = await supabase.from('store_favorite_items').delete().eq('store_id', storeId).eq('catalog_item_id', catalogItemId)
    if (error) throw error
  }
}

export async function setFavoriteThreshold(storeId, catalogItemId, threshold) {
  const value = Math.max(0, parseInt(threshold, 10) || 0)
  const { error } = await supabase
    .from('store_favorite_items')
    .update({ low_stock_threshold: value, updated_at: new Date().toISOString() })
    .eq('store_id', storeId)
    .eq('catalog_item_id', catalogItemId)
  if (error) throw error
  return value
}

// Favourites that need attention: [{ catalogItemId, name, available, threshold, level: 'out' | 'low' }].
export function favoriteStockAlerts(favorites = {}, inventory = [], stockOf = () => 0) {
  const byCard = new Map()
  for (const item of inventory || []) {
    const id = item.catalogItemId || item.catalogueItemId || ''
    if (!id || !favorites[id]) continue
    const entry = byCard.get(id) || { name: item.name || item.title || 'Item', available: 0 }
    entry.available += Math.max(0, Number(stockOf(item)) || 0)
    byCard.set(id, entry)
  }
  return Object.entries(favorites).map(([catalogItemId, { threshold }]) => {
    const entry = byCard.get(catalogItemId) || { name: '', available: 0 }
    const level = entry.available <= 0 ? 'out' : entry.available <= threshold ? 'low' : ''
    return { catalogItemId, name: entry.name, available: entry.available, threshold, level }
  }).filter((alert) => alert.level)
}
