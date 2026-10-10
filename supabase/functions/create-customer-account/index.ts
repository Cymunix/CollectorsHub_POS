// create-customer-account: the register's "Create Customer" button. Creates a
// CollectorsHub (NORDVIK) account for a customer at the counter, links it to
// the store as a customer, and emails the customer a link to set their own
// password (staff never see or choose it).
//
// The account is a normal CollectorsHub account: the new-user trigger makes
// its profile with the chosen username (profiles.username: 3-20 letters,
// numbers or underscores, unique, can't be changed), the same as signing up
// on the website.
//
// Only staff (or the owner) of the store may create customers.
//
// Secrets: the same SMTP_USER / SMTP_PASS / SMTP_FROM as send-receipt.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

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
const validEmail = (value: unknown) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(value || '').trim())
const plain = (value: unknown, max = 80) => String(value ?? '').replace(/[\r\n"<>]/g, '').trim().slice(0, max)
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/

function welcomeHtml({ storeName, name, username, link }: { storeName: string, name: string, username: string, link: string }) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#17253d">
  <div style="max-width:520px;margin:0 auto;padding:24px">
    <div style="background:#fff;border:1px solid #dce5ef;border-radius:10px;padding:22px">
      <h2 style="margin:0 0 4px">Welcome to CollectorsHub</h2>
      <div style="color:#667;font-size:13px">Your account was created at ${escapeHtml(storeName)}</div>
      <hr style="border:0;border-top:1px solid #eee;margin:16px 0">
      <p style="font-size:14px;margin:0 0 10px">Hi ${escapeHtml(name)},</p>
      <p style="font-size:14px;margin:0 0 10px">Your CollectorsHub username is <strong>@${escapeHtml(username)}</strong>. Give it at the counter to collect purchase XP, use store credit and keep your collection up to date.</p>
      <p style="font-size:14px;margin:0 0 16px">Set your password to sign in on the website and app:</p>
      <p style="margin:0 0 16px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#d6a632;color:#17253d;font-weight:700;text-decoration:none;padding:10px 18px;border-radius:8px">Set my password</a></p>
      <p style="color:#889;font-size:12px;margin:0">If you didn't ask ${escapeHtml(storeName)} to create an account, you can ignore this email.</p>
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
  if (!smtpUser || !smtpPass) return reply(500, { error: 'Email is not set up yet (SMTP_USER / SMTP_PASS secrets).' })

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  const { data: userData } = await admin.auth.getUser(token)
  const user = userData?.user
  if (!user) return reply(401, { error: 'Sign in to create customers.' })

  let body: { storeId?: string, name?: string, username?: string, email?: string, phone?: string }
  try { body = await request.json() } catch { return reply(400, { error: 'Invalid request.' }) }
  const storeId = String(body.storeId || '').trim()
  const name = plain(body.name, 80)
  const username = String(body.username || '').trim()
  const email = String(body.email || '').trim().toLowerCase()
  const phone = plain(body.phone, 30)
  if (!storeId) return reply(400, { error: 'No store.' })
  if (name.length < 2) return reply(400, { error: "Enter the customer's full name." })
  if (!USERNAME_RE.test(username)) return reply(400, { error: 'Usernames are 3–20 letters, numbers or underscores.' })
  if (!validEmail(email)) return reply(400, { error: 'Enter a valid email address.' })

  // Staff of this store (same check as send-receipt), or its owner.
  const [{ data: store }, { data: staff }] = await Promise.all([
    admin.from('stores').select('owner_user_id, store_name').eq('id', storeId).maybeSingle(),
    admin.from('store_employees').select('*').eq('store_id', storeId),
  ])
  const callerEmail = String(user.email || '').toLowerCase()
  const linked = (row: Record<string, unknown>) => ['employee_user_id', 'auth_user_id'].some((key) => row?.[key] && row[key] === user.id)
    || (Boolean(callerEmail) && ['internal_email', 'email'].some((key) => String(row?.[key] || '').toLowerCase() === callerEmail))
  const active = (row: Record<string, unknown>) => !['inactive', 'disabled', 'suspended', 'terminated', 'removed', 'deleted', 'archived'].includes(String(row?.status || '').toLowerCase())
  const allowed = store?.owner_user_id === user.id
    || (staff || []).some((row: Record<string, unknown>) => row?.store_owner_id === user.id || (linked(row) && active(row)))
  if (!allowed) return reply(403, { error: 'Only staff of this store can create customers.' })

  // Clear answers before creating anything.
  const [{ data: takenName }, { data: takenEmail }] = await Promise.all([
    admin.from('profiles').select('id').ilike('username', username.replace(/_/g, '\\_')).maybeSingle(),
    admin.from('profiles').select('id, username').ilike('email', email.replace(/[%_]/g, (c) => `\\${c}`)).maybeSingle(),
  ])
  if (takenEmail) return reply(409, { error: `That email already has a CollectorsHub account${takenEmail.username ? ` (@${takenEmail.username})` : ''}. Search for it instead.` })
  if (takenName) return reply(409, { error: `The username @${username} is taken. Try another.` })

  // Create the account (no password; email confirmed, since staff entered it
  // with the customer), then a password-reset link: the website's existing
  // "set your password" screen opens from it (PASSWORD_RECOVERY).
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: name, username },
  })
  if (createError || !created?.user) {
    const message = createError?.message || 'The account could not be created.'
    if (/already|registered|exists/i.test(message)) return reply(409, { error: 'That email already has a CollectorsHub account. Search for it instead.' })
    if (/username|duplicate|unique|database error/i.test(message)) return reply(409, { error: `The username @${username} is taken. Try another.` })
    return reply(500, { error: message })
  }
  const profileId = created.user.id
  const { data: link } = await admin.auth.admin.generateLink({ type: 'recovery', email })

  // Full name on the profile (supabase/customer_full_name.sql adds the column;
  // skipped if not run yet). The account starts unverified: only NORDVIK
  // Identity can verify it (supabase/nordvik_identity.sql).
  await admin.from('profiles').update({ full_name: name }).eq('id', profileId)

  // The store's customer record, linked to the new account.
  const { data: customer, error: customerError } = await admin.from('store_customers')
    .insert({ store_id: storeId, display_name: name, email, phone: phone || null, membership_code: username, collectorshub_user_id: profileId })
    .select('id')
    .single()
  if (customerError) return reply(500, { error: `The account was created, but linking it to the store failed: ${customerError.message}` })

  // Welcome email with the set-password link.
  const storeName = plain(store?.store_name || 'a CollectorsHub store')
  let emailed = Boolean(link?.properties?.action_link)
  if (emailed) try {
    const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: smtpUser, pass: smtpPass } })
    await transport.sendMail({
      from: `"CollectorsHub" <${Deno.env.get('SMTP_FROM') || smtpUser}>`,
      to: email,
      subject: `Welcome to CollectorsHub, ${name}`,
      html: welcomeHtml({ storeName, name, username, link: link?.properties?.action_link || '' }),
    })
  } catch {
    emailed = false
  }

  return reply(200, {
    ok: true,
    emailed,
    customer: { id: customer.id, profileId, collectorshub_user_id: profileId, name, username, email, phone, storeCredit: 0, kind: 'profile', fullName: name, identityStatus: 'unverified' },
  })
})
