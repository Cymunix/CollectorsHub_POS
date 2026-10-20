import { supabase } from './supabaseClient'

// Collector Listings (supabase/collector_listings.sql): copies collectors have listed for sale
// on the website, with the wishlist demand this store can see for each item.

const publicUrl = (bucket, path) => {
  if (!path) return ''
  if (/^https?:/i.test(String(path))) return path
  return supabase.storage.from(bucket).getPublicUrl(path).data?.publicUrl || ''
}

// filter: 'wanted' (only items members are looking for) or 'all'.
export async function loadCollectorListings(storeId, { filter = 'wanted', search = '', limit = 100, offset = 0 } = {}) {
  const { data, error } = await supabase.rpc('store_collector_listings', { p_store_id: storeId, p_filter: filter, p_search: search, p_limit: limit, p_offset: offset })
  if (error) {
    if (/could not find the function|does not exist/i.test(error.message || '')) throw new Error('Collector Listings is not installed in Supabase yet (run supabase/collector_listings.sql).')
    throw error
  }
  return {
    totalListed: Number(data?.total_listed) || 0,
    rows: (data?.rows || []).map((row) => ({
      ...row,
      itemImageUrl: publicUrl('item-images', row.image_path),
      frontImageUrl: publicUrl('collection-copy-images', row.front_image_url),
      backImageUrl: publicUrl('collection-copy-images', row.back_image_url),
    })),
  }
}
