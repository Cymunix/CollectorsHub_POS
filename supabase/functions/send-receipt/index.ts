// send-receipt: emails a register receipt through the CollectorsHub Google
// Workspace account (the same mailbox Supabase Auth sends from).
//
// Only staff (or the owner) of the receipt's store may send, so the function
// can't be used to send mail from the CollectorsHub domain by anyone else.
// The email is built here from the receipt's fields (all text escaped), never
// from caller-supplied HTML.
//
// Secrets (Supabase dashboard -> Edge Functions -> Secrets):
//   SMTP_USER  the Google Workspace address, e.g. receipts@collectorshub.ca
//   SMTP_PASS  a Google app password for that account
//   SMTP_FROM  optional: the From address (defaults to SMTP_USER)
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
//
// Google is reached on port 465 (SSL): Supabase Edge Functions block outbound
// ports 25 and 587.

import nodemailer from 'npm:nodemailer@6.9.14'
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const money = (value: unknown) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(Number(value) || 0)
const validEmail = (value: unknown) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(value || '').trim())

type Item = { name?: string, sku?: string, quantity?: number, total?: number, direction?: string, condition?: string }
type Receipt = {
  number?: string, type?: string, createdAt?: string, items?: Item[], subtotal?: number, tax?: number, taxLabel?: string, total?: number,
  discounts?: number, payments?: { method?: string, amount?: number }[], payout?: { amount?: number, method?: string } | null,
  employeeName?: string, registerName?: string,
  receiptBranding?: { storeName?: string, locationName?: string, address?: string, phone?: string, email?: string },
}

function receiptHtml(r: Receipt) {
  const b = r.receiptBranding || {}
  const rows = (r.items || []).slice(0, 500).map((item) => `
    <tr>
      <td style="padding:6px 0;border-bottom:1px solid #eee">${escapeHtml(item.quantity || 1)} × ${escapeHtml(item.name || item.sku || 'Item')}${item.direction === 'incoming' ? ' <span style="color:#8a6a17">(trade-in)</span>' : ''}${item.condition ? `<br><small style="color:#667">${escapeHtml(item.condition)}</small>` : ''}</td>
      <td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${money(item.total)}</td>
    </tr>`).join('')
  const line = (label: string, value: unknown, strong = false) => `<tr><td style="padding:3px 0;${strong ? 'font-weight:700;font-size:16px' : 'color:#444'}">${escapeHtml(label)}</td><td style="padding:3px 0;text-align:right;${strong ? 'font-weight:700;font-size:16px' : ''}">${money(value)}</td></tr>`
  const payments = (r.payments || []).map((p) => `<div style="color:#444">${escapeHtml(String(p.method || 'payment').replace('_', ' '))}: ${money(p.amount)}</div>`).join('')
  const title = r.type === 'buy' ? 'Trade receipt' : r.type === 'refund' ? 'Refund receipt' : 'Receipt'
  return `<!doctype html><html><body style="margin:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#17253d">
  <div style="max-width:520px;margin:0 auto;padding:24px">
    <div style="background:#fff;border:1px solid #dce5ef;border-radius:10px;padding:22px">
      <h2 style="margin:0 0 4px">${escapeHtml(b.storeName || 'CollectorsHub store')}</h2>
      <div style="color:#667;font-size:13px">${[b.locationName, b.address, b.phone].filter(Boolean).map(escapeHtml).join(' · ')}</div>
      <hr style="border:0;border-top:1px solid #eee;margin:16px 0">
      <div style="font-size:14px"><strong>${title}</strong> · ${escapeHtml(r.number || '')}<br>
        <span style="color:#667">${escapeHtml(new Date(r.createdAt || Date.now()).toLocaleString('en-CA', { timeZone: 'America/Halifax' }))}${r.employeeName ? ` · ${escapeHtml(r.employeeName)}` : ''}</span></div>
      <table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:14px">${rows}</table>
      <table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:14px">
        ${line('Subtotal', r.subtotal)}${Number(r.discounts) ? line('Discounts', -Number(r.discounts)) : ''}${line(r.taxLabel || 'Tax', r.tax)}${line(r.payout?.amount ? 'Paid to you' : 'Total', r.payout?.amount || r.total, true)}
      </table>
      ${payments ? `<div style="margin-top:10px;font-size:13px">${payments}</div>` : ''}
      <p style="margin:18px 0 0;color:#889;font-size:12px">Thank you for shopping with ${escapeHtml(b.storeName || 'us')}. Powered by CollectorsHub.</p>
    </div>
  </div></body></html>`
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (request.method !== 'POST') return reply(405, { error: 'Use POST.' })

  const url = Deno.env.get('SUPABASE_URL') || ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const smtpUser = Deno.env.get('SMTP_USER') || ''
  const smtpPass = Deno.env.get('SMTP_PASS') || ''
  if (!smtpUser || !smtpPass) return reply(500, { error: 'Receipt email is not set up yet (SMTP_USER / SMTP_PASS secrets).' })

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  const { data: userData } = await admin.auth.getUser(token)
  const user = userData?.user
  if (!user) return reply(401, { error: 'Sign in to send receipts.' })

  let body: { to?: string, storeId?: string, receipt?: Receipt }
  try { body = await request.json() } catch { return reply(400, { error: 'Invalid request.' }) }
  const to = String(body.to || '').trim()
  const storeId = String(body.storeId || '').trim()
  const receipt = body.receipt || {}
  if (!validEmail(to)) return reply(400, { error: 'Enter a valid email address.' })
  if (!storeId) return reply(400, { error: 'No store on this receipt.' })

  // Staff of this store (any id column linking the employee to the login), or its owner.
  const [{ data: store }, { data: staff }] = await Promise.all([
    admin.from('stores').select('owner_user_id').eq('id', storeId).maybeSingle(),
    admin.from('store_employees').select('*').eq('store_id', storeId),
  ])
  // Linked by the login's id, or by its email (staff sign in with an internal
  // account email that the employee row records).
  const email = String(user.email || '').toLowerCase()
  // store_employees links a login by employee_user_id / auth_user_id, or by
  // internal_email (the account staff sign in with).
  const linked = (row: Record<string, unknown>) => ['employee_user_id', 'auth_user_id'].some((key) => row?.[key] && row[key] === user.id)
    || (Boolean(email) && ['internal_email', 'email'].some((key) => String(row?.[key] || '').toLowerCase() === email))
  const active = (row: Record<string, unknown>) => !['inactive', 'disabled', 'suspended', 'terminated', 'removed', 'deleted', 'archived'].includes(String(row?.status || '').toLowerCase())
  const allowed = store?.owner_user_id === user.id
    || (staff || []).some((row: Record<string, unknown>) => row?.store_owner_id === user.id || (linked(row) && active(row)))
  if (!allowed) return reply(403, { error: 'Only staff of this store can email its receipts.' })

  const branding = receipt.receiptBranding || {}
  const storeName = String(branding.storeName || 'CollectorsHub store').replace(/[\r\n"<>]/g, '').slice(0, 80)
  const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: smtpUser, pass: smtpPass } })
  try {
    await transport.sendMail({
      from: `"${storeName} via CollectorsHub" <${Deno.env.get('SMTP_FROM') || smtpUser}>`,
      to,
      replyTo: validEmail(branding.email) ? String(branding.email) : undefined,
      subject: `${storeName} receipt ${String(receipt.number || '').replace(/[\r\n]/g, '').slice(0, 40)}`.trim(),
      html: receiptHtml(receipt),
    })
  } catch (error) {
    return reply(502, { error: `The email could not be sent: ${(error as Error).message}` })
  }
  return reply(200, { ok: true })
})
