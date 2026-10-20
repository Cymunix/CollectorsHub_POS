import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'

// Which catalogue items members want (supabase/wishlist_open_profiles.sql): only members
// whose wishlist this store can see count. Resolves to { [catalogItemId]: { members, names } }.
// Before the SQL is installed (or on any error) it resolves to {} so buying is never blocked.
export async function loadWishlistDemand(storeId, catalogItemIds = []) {
  const ids = [...new Set(catalogItemIds.filter(Boolean))]
  if (!storeId || !ids.length) return {}
  const { data, error } = await supabase.rpc('store_wishlist_demand', { p_store_id: storeId, p_catalog_item_ids: ids })
  if (error) return {}
  return Object.fromEntries((data || []).map((row) => [row.catalog_item_id, { members: Number(row.members) || 0, names: row.names || [] }]))
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

// "Wanted by 3 users"
export function wantedLabel(entry) {
  if (!entry?.members) return ''
  return `Wanted by ${entry.members} user${entry.members === 1 ? '' : 's'}`
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
