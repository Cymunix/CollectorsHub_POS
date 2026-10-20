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

// ── Messages to sellers (supabase/listing_messages.sql) ──
// The store messages the collector who listed an item; the collector is emailed and replies on
// the website. Replies show here and as a badge on the Collector Listings nav button.

const notInstalled = (error) => /could not find the function|does not exist/i.test(error?.message || '')
const MESSAGES_MISSING = 'Messaging sellers is not installed in Supabase yet (run supabase/listing_messages.sql).'

export async function loadListingConversations(storeId) {
  const { data, error } = await supabase.rpc('store_listing_conversations', { p_store_id: storeId })
  if (error) throw notInstalled(error) ? new Error(MESSAGES_MISSING) : error
  return (data || []).map((row) => ({
    ...row,
    itemImageUrl: publicUrl('item-images', row.image_path),
    frontImageUrl: publicUrl('collection-copy-images', row.front_image_url),
  }))
}

// By conversation id, or by the listed copy (null when the store hasn't messaged about it yet).
export async function loadListingConversation(storeId, { conversationId = null, copyId = null } = {}) {
  const { data, error } = await supabase.rpc('store_listing_conversation', { p_store_id: storeId, p_conversation_id: conversationId, p_copy_id: copyId })
  if (error) throw notInstalled(error) ? new Error(MESSAGES_MISSING) : error
  return data || null
}

export async function loadListingUnreadCount(storeId) {
  const { data, error } = await supabase.rpc('store_listing_unread_count', { p_store_id: storeId })
  if (error) return 0
  return Number(data) || 0
}

// Saves the message, then emails it to the collector (supabase/functions/send-listing-message).
// Resolves to { conversationId, emailed, emailError }: a failed email never loses the message.
export async function sendListingMessage(storeId, { copyId = null, conversationId = null, body, senderName = '' }) {
  const { data, error } = await supabase.rpc('store_listing_send_message', { p_store_id: storeId, p_copy_id: copyId, p_conversation_id: conversationId, p_body: body, p_sender_name: senderName })
  if (error) throw notInstalled(error) ? new Error(MESSAGES_MISSING) : error
  const result = { conversationId: data?.conversation_id, emailed: false, emailError: '' }
  try {
    const { data: sent, error: sendError } = await supabase.functions.invoke('send-listing-message', { body: { messageId: data?.message_id } })
    if (sendError || sent?.error) result.emailError = sent?.error || "The email couldn't be sent (is the send-listing-message Edge Function deployed?)."
    else result.emailed = Boolean(sent?.sent)
  } catch {
    result.emailError = "The email couldn't be sent: the internet connection dropped."
  }
  return result
}
