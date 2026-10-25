import { supabase } from './supabaseClient'
import { DEFAULT_BUY_PERCENT, buyPercentFor, legoGroupFromCondition, pricingGroupFor, simpleBaseline, toCents, isLegoCategoryName } from './marketMath'

// Market Intelligence data (supabase/market_intelligence.sql): completed-sale
// history from the central market_sales table, a LEGO set's minifigures, the
// store's own activity and buying policy, and saving purchase inspections.
// Active listings come separately from the eBay Browse API (asking prices,
// never used in any calculation). Results are cached for a few minutes so
// moving between items doesn't repeat requests.

const CACHE_MS = 5 * 60 * 1000
const cache = new Map()
async function cached(key, load) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
  const value = await load()
  cache.set(key, { at: Date.now(), value })
  return value
}
export function clearMarketCache() { cache.clear() }

async function rpc(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    if (/could not find the function/i.test(error.message || '')) throw new Error('Market Intelligence is not installed in Supabase yet. Run supabase/market_intelligence.sql.')
    throw new Error(error.message)
  }
  return data
}

export const loadMarketHistory = (itemId, currency = 'CAD') => cached(`history:${itemId}:${currency}`, () => rpc('market_intelligence', { p_item_id: itemId, p_currency: currency }))
export const loadSetContents = (itemId, currency = 'CAD') => cached(`set:${itemId}:${currency}`, () => rpc('market_set_contents', { p_set_item_id: itemId, p_currency: currency }))
export const loadStoreActivity = (storeId, itemId) => cached(`store:${storeId}:${itemId}`, () => rpc('market_store_activity', { p_store_id: storeId, p_item_id: itemId }))

export async function loadPurchasePolicy(storeId) {
  if (!storeId) return null
  const { data, error } = await supabase.from('store_purchase_policies').select('*').eq('store_id', storeId).maybeSingle()
  if (error) return null // not installed yet: the default percentage applies
  return data
}
export const savePurchasePolicy = (storeId, policy) => rpc('market_save_purchase_policy', { p_store_id: storeId, p_policy: policy })

// Active listings (asking prices) for an item, when an eBay connection in
// Browse mode is set up on this register. Never mixed with completed sales.
export async function loadActiveListings(query) {
  const api = typeof window !== 'undefined' ? window.nordvikDesktop : null
  if (!api?.searchEbayMarket || !String(query || '').trim()) return { available: false, reason: 'No eBay connection on this register.' }
  return cached(`listings:${query}`, async () => {
    try {
      const result = await api.searchEbayMarket({ query, limit: 25 })
      if (result?.mode !== 'browse') return { available: false, reason: 'The eBay connection is not in listing (Browse) mode.' }
      const listings = (result.candidates || []).filter((row) => Number(row.price) > 0)
      return { available: true, listings, marketplace: result.marketplaceId, fetchedAt: new Date().toISOString() }
    } catch (error) {
      return { available: false, reason: error.message || 'eBay listings could not be loaded.' }
    }
  })
}

// The group a Register line is priced in, and the matching history group.
export function lineGroup(line) {
  return pricingGroupFor({ category: line?.category, condition: line?.condition, graded: line?.graded, gradingCompany: line?.gradingCompany, grade: line?.grade })
}
export function historyGroup(history, key) {
  return (history?.groups || []).find((group) => group.key === key) || null
}

// The signed-in store's buying policy, set by the Register when it loads, so
// every suggested offer (Register lines, buy scans) uses the same percentage.
let activePolicy = null
export function setActivePurchasePolicy(policy) { activePolicy = policy || null }

// The suggested Store Offer for a line from its market value and the store's
// buying percentage (75% when the store hasn't set one). Cents-safe.
export function suggestedOffer(marketValue, line = {}, policy = activePolicy) {
  const legoGroup = isLegoCategoryName(line.category) ? legoGroupFromCondition(line.condition) : null
  const { percent } = buyPercentFor(policy, { category: line.category, legoGroup })
  const cents = simpleBaseline({ referenceCents: toCents(marketValue), buyPercent: percent ?? DEFAULT_BUY_PERCENT })
  return cents == null ? 0 : cents / 100
}

// Saves the inspections for a completed buy (one per researched trade line,
// matched to its new stock record by SKU). Failures never undo the sale.
export async function savePurchaseInspections(transactionId, inspections) {
  if (!transactionId || !inspections?.length) return 0
  return rpc('market_save_inspections', { p_transaction_id: transactionId, p_inspections: inspections })
}

export async function loadInspectionsForInventory(inventoryId) {
  if (!inventoryId) return []
  const { data, error } = await supabase.from('purchase_inspections').select('*').eq('inventory_id', inventoryId).order('created_at', { ascending: false })
  if (error) return []
  return data || []
}

// The public listing description on a stock record (shown on the website and
// used for online listings). Store members can read and change their own.
export async function loadListingNotes(inventoryId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(inventoryId || ''))) return ''
  const { data, error } = await supabase.from('store_inventory').select('listing_notes').eq('id', inventoryId).maybeSingle()
  if (error) return ''
  return data?.listing_notes || ''
}
export async function saveListingNotes(inventoryId, text) {
  const { error } = await supabase.from('store_inventory').update({ listing_notes: String(text || '').trim().slice(0, 2000) || null }).eq('id', inventoryId)
  if (error) throw new Error(error.message)
}

export function publicImageUrl(path) {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path
  return supabase.storage.from('item-images').getPublicUrl(path).data?.publicUrl || ''
}
