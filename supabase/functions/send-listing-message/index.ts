// send-listing-message: emails a collector a store's message about an item they've listed for
// sale (supabase/listing_messages.sql). The email shows the message and links to the
// conversation on the website (#/messages/<conversation id>), where the collector replies.
//
// The POS calls this right after store_listing_send_message. Only staff (or the owner) of the
// store can trigger it (identity_staff_check, run as the caller), and each message is emailed
// once. The collector's email address never leaves this function. Collectors who turned email
// notifications off aren't emailed; they still see the message on the website.
//
// Secrets: the same SMTP_USER / SMTP_PASS / SMTP_FROM as send-receipt.
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import nodemailer from 'npm:nodemailer@6.9.14'
import { createClient } from 'npm:@supabase/supabase-js@2'

// The website routes with the hash: #/messages/<conversation id> (pages/MessagesPage.jsx).
const MESSAGES_URL = 'https://collectorshub.ca/#/messages'

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
const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })

function messageHtml({ name, storeName, senderName, itemTitle, askingPrice, body, link }: { name: string, storeName: string, senderName: string, itemTitle: string, askingPrice: string, body: string, link: string }) {
  const paragraphs = escapeHtml(body).split(/\n{2,}/).map((part) => `<p style="font-size:14px;margin:0 0 10px;white-space:pre-wrap">${part}</p>`).join('')
  return `<!doctype html><html><body style="margin:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#17253d">
  <div style="max-width:520px;margin:0 auto;padding:24px">
    <div style="background:#fff;border:1px solid #dce5ef;border-radius:10px;padding:22px">
      <h2 style="margin:0 0 4px">${escapeHtml(storeName)} sent you a message</h2>
      <div style="color:#667;font-size:13px">About your listing: ${escapeHtml(itemTitle)}${askingPrice ? ` · asking ${escapeHtml(askingPrice)}` : ''}</div>
      <hr style="border:0;border-top:1px solid #eee;margin:16px 0">
      <p style="font-size:14px;margin:0 0 10px">Hi ${escapeHtml(name)},</p>
      <div style="background:#f6f8fb;border-left:3px solid #d6a632;border-radius:6px;padding:12px 14px;margin:0 0 14px">
        ${paragraphs}
        <div style="color:#667;font-size:12px">${senderName ? `${escapeHtml(senderName)}, ` : ''}${escapeHtml(storeName)}</div>
      </div>
      <p style="margin:0 0 16px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#d6a632;color:#17253d;font-weight:700;text-decoration:none;padding:10px 18px;border-radius:8px">Reply on CollectorsHub</a></p>
      <p style="color:#889;font-size:12px;margin:0">Replying to this email won't reach the store; use the button to reply on your CollectorsHub account. The store doesn't see your email address. You can stop messages from this store on the conversation page, or turn off email notifications in your CollectorsHub settings.</p>
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
  let body: { messageId?: string }
  try { body = await request.json() } catch { return reply(400, { error: 'Invalid request.' }) }
  const messageId = String(body.messageId || '').trim()
  if (!messageId) return reply(400, { error: 'No message.' })

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const { data: message } = await admin.from('listing_messages')
    .select('id, conversation_id, sender, sender_name, body, emailed_at')
    .eq('id', messageId).maybeSingle()
  if (!message || message.sender !== 'store') return reply(404, { error: 'Message not found.' })
  if (message.emailed_at) return reply(200, { ok: true, sent: false, reason: 'already emailed' })
  const { data: conversation } = await admin.from('listing_conversations')
    .select('id, store_id, collector_id, item_title, asking_price, collector_blocked_at')
    .eq('id', message.conversation_id).maybeSingle()
  if (!conversation) return reply(404, { error: 'Message not found.' })

  // Staff of this store only (checked as the caller).
  const caller = createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } })
  const { data: check } = await caller.rpc('identity_staff_check', { p_store_id: conversation.store_id })
  const allowed = Array.isArray(check) ? check[0]?.allowed : check?.allowed
  if (!allowed) return reply(403, { error: 'Only staff of this store can send its messages.' })
  if (conversation.collector_blocked_at) return reply(200, { ok: true, sent: false, reason: 'blocked' })

  const [{ data: store }, { data: profile }, { data: userData }] = await Promise.all([
    admin.from('stores').select('store_name').eq('id', conversation.store_id).maybeSingle(),
    admin.from('profiles').select('username, display_name, notifications_email').eq('id', conversation.collector_id).maybeSingle(),
    admin.auth.admin.getUserById(conversation.collector_id),
  ])
  if (profile?.notifications_email === false) {
    await admin.from('listing_messages').update({ email_error: 'email notifications off' }).eq('id', messageId)
    return reply(200, { ok: true, sent: false, reason: 'email notifications off' })
  }
  const email = String(userData?.user?.email || '').trim()
  if (!email) {
    await admin.from('listing_messages').update({ email_error: 'no email address' }).eq('id', messageId)
    return reply(200, { ok: true, sent: false, reason: 'no email address' })
  }

  const storeName = plain(store?.store_name || 'A CollectorsHub store')
  const itemTitle = plain(conversation.item_title || 'your item', 120)
  const askingPrice = conversation.asking_price != null ? money.format(Number(conversation.asking_price)) : ''
  try {
    const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: smtpUser, pass: smtpPass } })
    await transport.sendMail({
      from: `"${storeName} via CollectorsHub" <${Deno.env.get('SMTP_FROM') || smtpUser}>`,
      to: email,
      subject: `${storeName} messaged you about ${itemTitle}`,
      html: messageHtml({
        name: plain(profile?.display_name || profile?.username || 'there'),
        storeName,
        senderName: plain(message.sender_name || '', 60),
        itemTitle,
        askingPrice,
        body: String(message.body || ''),
        link: `${MESSAGES_URL}/${encodeURIComponent(conversation.id)}`,
      }),
    })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    await admin.from('listing_messages').update({ email_error: text.slice(0, 300) }).eq('id', messageId)
    return reply(502, { error: `The email couldn't be sent: ${text}` })
  }
  await admin.from('listing_messages').update({ emailed_at: new Date().toISOString(), email_error: null }).eq('id', messageId)
  return reply(200, { ok: true, sent: true })
})
