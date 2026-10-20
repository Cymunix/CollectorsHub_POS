// send-wishlist-alerts: emails members that a store they've shopped at now has items from
// their wishlist in stock. The emails are queued by the database when stock becomes available
// (supabase/wishlist_stock_emails.sql); the POS calls this after a buy or a stock scan and it
// sends that store's queue, one email per member listing their items.
//
// Only staff (or the owner) of the store can trigger it (identity_staff_check, run as the
// caller). Members' email addresses never leave this function.
//
// Secrets: the same SMTP_USER / SMTP_PASS / SMTP_FROM as send-receipt.
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import nodemailer from 'npm:nodemailer@6.9.14'
import { createClient } from 'npm:@supabase/supabase-js@2'

const SITE = 'https://collectorshub.ca'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const plain = (value: unknown, max = 80) => String(value ?? '').replace(/[\r\n"<>]/g, '').trim().slice(0, max)

type Item = { item_id: string, name: string | null, card_number: string | null, release_year: number | null }
type Row = { id: string, user_id: string, location_id: string | null, catalog_item_id: string }

function itemTitle(item: Item) {
  return [item.name || 'Catalogue item', item.card_number ? `#${item.card_number}` : '', item.release_year ? `(${item.release_year})` : ''].filter(Boolean).join(' ')
}

function alertHtml({ name, storeName, where, storeId, items }: { name: string, storeName: string, where: string, storeId: string, items: Item[] }) {
  const list = items.map((item) => `<li style="margin:0 0 6px"><a href="${SITE}/#/item/${encodeURIComponent(item.item_id)}" style="color:#17253d;font-weight:700">${escapeHtml(itemTitle(item))}</a></li>`).join('')
  return `<!doctype html><html><body style="margin:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#17253d">
  <div style="max-width:520px;margin:0 auto;padding:24px">
    <div style="background:#fff;border:1px solid #dce5ef;border-radius:10px;padding:22px">
      <h2 style="margin:0 0 4px">${items.length === 1 ? 'An item on your wishlist is in stock' : 'Items on your wishlist are in stock'}</h2>
      <div style="color:#667;font-size:13px">${escapeHtml(storeName)}${where ? ` · ${escapeHtml(where)}` : ''}</div>
      <hr style="border:0;border-top:1px solid #eee;margin:16px 0">
      <p style="font-size:14px;margin:0 0 10px">Hi ${escapeHtml(name)},</p>
      <p style="font-size:14px;margin:0 0 10px">${escapeHtml(storeName)} just got ${items.length === 1 ? 'this item' : 'these items'} from your wishlist in stock:</p>
      <ul style="font-size:14px;margin:0 0 16px;padding-left:20px">${list}</ul>
      <p style="margin:0 0 16px"><a href="${SITE}/#/store/${encodeURIComponent(storeId)}" style="display:inline-block;background:#d6a632;color:#17253d;font-weight:700;text-decoration:none;padding:10px 18px;border-radius:8px">View the store</a></p>
      <p style="color:#889;font-size:12px;margin:0">Stock can sell quickly. You're getting this because you've shopped at ${escapeHtml(storeName)} and have wishlist alerts on. Turn off wishlist alerts or email notifications in your CollectorsHub settings to stop these emails.</p>
    </div>
  </div></body></html>`
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (request.method !== 'POST') return reply(405, { error: 'Use POST.' })

  const url = Deno.env.get('SUPABASE_URL') || ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const smtpUser = Deno.env.get('SMTP_USER') || ''
  const smtpPass = Deno.env.get('SMTP_PASS') || ''
  if (!smtpUser || !smtpPass) return reply(500, { error: 'Email is not set up yet (SMTP_USER / SMTP_PASS secrets).' })

  const authHeader = request.headers.get('Authorization') || ''
  if (!/^Bearer\s+\S+/i.test(authHeader)) return reply(401, { error: 'Sign in first.' })
  let body: { storeId?: string }
  try { body = await request.json() } catch { return reply(400, { error: 'Invalid request.' }) }
  const storeId = String(body.storeId || '').trim()
  if (!storeId) return reply(400, { error: 'No store.' })

  // Staff of this store only (checked as the caller).
  const caller = createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } })
  const { data: check } = await caller.rpc('identity_staff_check', { p_store_id: storeId })
  const allowed = Array.isArray(check) ? check[0]?.allowed : check?.allowed
  if (!allowed) return reply(403, { error: 'Only staff of this store can send wishlist alerts.' })

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const { data: queue, error: queueError } = await admin.from('wishlist_stock_email_queue')
    .select('id, user_id, location_id, catalog_item_id')
    .eq('store_id', storeId).is('sent_at', null).is('error', null)
    .order('created_at').limit(200)
  if (queueError) return reply(500, { error: queueError.message })
  const rows = (queue || []) as Row[]
  if (!rows.length) return reply(200, { ok: true, sent: 0, members: 0 })

  const itemIds = [...new Set(rows.map((row) => row.catalog_item_id))]
  const locationIds = [...new Set(rows.map((row) => row.location_id).filter(Boolean))] as string[]
  const userIds = [...new Set(rows.map((row) => row.user_id))]
  const [{ data: store }, { data: items }, { data: locations }, { data: profiles }] = await Promise.all([
    admin.from('stores').select('store_name').eq('id', storeId).maybeSingle(),
    admin.from('items').select('item_id, name, card_number, release_year').in('item_id', itemIds),
    locationIds.length ? admin.from('store_locations').select('id, location_name, city, province').in('id', locationIds) : Promise.resolve({ data: [] }),
    admin.from('profiles').select('id, username, display_name').in('id', userIds),
  ])
  const itemById = new Map((items || []).map((item: Item) => [item.item_id, item]))
  const locationById = new Map((locations || []).map((l: Record<string, string>) => [l.id, l]))
  const profileById = new Map((profiles || []).map((p: Record<string, string>) => [p.id, p]))
  const storeName = plain(store?.store_name || 'A CollectorsHub store')

  const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: smtpUser, pass: smtpPass } })
  let sent = 0
  let members = 0
  const failed: string[] = []
  for (const userId of userIds) {
    const mine = rows.filter((row) => row.user_id === userId)
    const ids = mine.map((row) => row.id)
    const list = [...new Set(mine.map((row) => row.catalog_item_id))].map((id) => itemById.get(id)).filter(Boolean) as Item[]
    const { data: userData } = await admin.auth.admin.getUserById(userId)
    const email = String(userData?.user?.email || '').trim()
    if (!email || !list.length) {
      await admin.from('wishlist_stock_email_queue').update({ error: !email ? 'no email address' : 'item not found' }).in('id', ids)
      continue
    }
    const location = mine[0].location_id ? locationById.get(mine[0].location_id) : null
    const where = location ? [location.location_name, location.city, location.province].filter(Boolean).join(', ') : ''
    const profile = profileById.get(userId)
    try {
      await transport.sendMail({
        from: `"${storeName} via CollectorsHub" <${Deno.env.get('SMTP_FROM') || smtpUser}>`,
        to: email,
        subject: list.length === 1 ? `${itemTitle(list[0])} is in stock at ${storeName}` : `${list.length} items on your wishlist are in stock at ${storeName}`,
        html: alertHtml({ name: plain(profile?.display_name || profile?.username || 'there'), storeName, where: plain(where, 120), storeId, items: list }),
      })
      await admin.from('wishlist_stock_email_queue').update({ sent_at: new Date().toISOString() }).in('id', ids)
      sent += list.length
      members += 1
    } catch (error) {
      failed.push(error instanceof Error ? error.message : String(error))
      // Left unsent (no error mark) so the next call retries it.
    }
  }

  return reply(200, { ok: true, sent, members, failed: failed.length, error: failed[0] || undefined })
})
