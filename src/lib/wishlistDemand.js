import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'

// Which catalogue items members want (supabase/wishlist_open_profiles.sql): only members
// whose wishlist this store can see count. Resolves to { [catalogItemId]: { members, priced, averagePrice } }.
// Before the SQL is installed (or on any error) it resolves to {} so buying is never blocked.
export async function loadWishlistDemand(storeId, catalogItemIds = []) {
  const ids = [...new Set(catalogItemIds.filter(Boolean))]
  if (!storeId || !ids.length) return {}
  const { data, error } = await supabase.rpc('store_wishlist_demand', { p_store_id: storeId, p_catalog_item_ids: ids })
  if (error) return {}
  return Object.fromEntries((data || []).map((row) => [row.catalog_item_id, { members: Number(row.members) || 0, priced: Number(row.priced) || 0, averagePrice: row.average_price == null ? null : Number(row.average_price) }]))
}

// The demand for a changing list of items, refreshed when the list changes.
export function useWishlistDemand(storeId, catalogItemIds = []) {
  const key = [...new Set(catalogItemIds.filter(Boolean))].sort().join(',')
  const [demand, setDemand] = useState({})
  useEffect(() => {
    let cancelled = false
    if (!storeId || !key) { setDemand({}); return undefined }
    loadWishlistDemand(storeId, key.split(',')).then((next) => { if (!cancelled) setDemand(next) })
    return () => { cancelled = true }
  }, [storeId, key])
  return demand
}

const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })

// "Wanted by 3 users · avg $12.50" (the average of the prices members set; left off when none did)
export function wantedLabel(entry) {
  if (!entry?.members) return ''
  const users = `Wanted by ${entry.members} user${entry.members === 1 ? '' : 's'}`
  return entry.priced && entry.averagePrice != null ? `${users} · avg ${money.format(entry.averagePrice)}` : users
}

// Hover text: how many of them set a price.
export function wantedTitle(entry) {
  if (!entry?.members) return ''
  if (!entry.priced) return "On members' wishlists. None has set a price they'd pay yet."
  return `Average of the prices ${entry.priced} of ${entry.members} member${entry.members === 1 ? '' : 's'} said they'd pay.`
}

// After stock comes in (a buy at the register, a stock scan): email members whose wishlist
// items just became available (supabase/functions/send-wishlist-alerts; the queue is filled by
// supabase/wishlist_stock_emails.sql). Fire and forget: it never blocks or fails the buy.
export function sendWishlistAlerts(storeId) {
  if (!storeId) return
  try {
    supabase.functions.invoke('send-wishlist-alerts', { body: { storeId } })
      .then(({ data, error }) => { if (error || data?.error) console.warn('Wishlist alert emails:', data?.error || error?.message || error) })
      .catch(() => {})
  } catch {}
}
