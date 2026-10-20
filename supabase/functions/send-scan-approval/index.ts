// send-scan-approval: the Scan Centre's approval request. Emails the collector a link to approve
// (or decline) the store scanning their cards into their collection. They approve on their own
// signed-in CollectorsHub account, the same page the old QR code opened.
//
// Only staff of the job's store can send it: the job is loaded with the caller's own sign-in
// through cs_job, which refuses anyone else. The collector's email is looked up here and never
// returned in full (the store only sees it masked, e.g. j***@gmail.com).
//
// Secrets: the same SMTP_USER / SMTP_PASS / SMTP_FROM as send-receipt.
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import nodemailer from 'npm:nodemailer@6.9.14'
import { createClient } from 'npm:@supabase/supabase-js@2'

// The website routes with the hash: #/collection-scanning/<request id> (pages/CollectionScanningPage.jsx).
const APPROVAL_URL = 'https://collectorshub.ca/#/collection-scanning'

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

// j***@gmail.com
function maskEmail(email: string) {
  const [local, domain] = email.split('@')
  if (!domain) return '***'
  return `${local.slice(0, 1)}***@${domain}`
}

function approvalHtml({ storeName, location, name, express, link }: { storeName: string, location: string, name: string, express: boolean, link: string }) {
  const what = express ? 'the cards you brought in today' : 'the cards you dropped off'
  const lasts = express ? 'It lasts 60 minutes.' : "It lasts 30 days for this drop-off only, and you can extend or revoke it at any time. You don't need to be there while it's scanned."
  return `<!doctype html><html><body style="margin:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#17253d">
  <div style="max-width:520px;margin:0 auto;padding:24px">
    <div style="background:#fff;border:1px solid #dce5ef;border-radius:10px;padding:22px">
      <h2 style="margin:0 0 4px">Approve collection scanning</h2>
      <div style="color:#667;font-size:13px">${escapeHtml(storeName)}${location ? ` · ${escapeHtml(location)}` : ''}</div>
      <hr style="border:0;border-top:1px solid #eee;margin:16px 0">
      <p style="font-size:14px;margin:0 0 10px">Hi ${escapeHtml(name)},</p>
      <p style="font-size:14px;margin:0 0 10px">${escapeHtml(storeName)} is asking to scan ${what} and add them to your CollectorsHub collection.</p>
      <ul style="font-size:14px;margin:0 0 14px;padding-left:20px;line-height:1.5">
        <li>The store can scan and identify these cards and add them to your collection.</li>
        <li>It can't change or remove anything already in your collection.</li>
        <li>${lasts}</li>
      </ul>
      <p style="margin:0 0 16px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#d6a632;color:#17253d;font-weight:700;text-decoration:none;padding:10px 18px;border-radius:8px">Review the request</a></p>
      <p style="color:#889;font-size:12px;margin:0">You'll sign in to your own CollectorsHub account to approve or decline. If you didn't ask ${escapeHtml(storeName)} to scan your cards, decline the request or ignore this email.</p>
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
  if (!/^Bearer\s+\S+/i.test(authHeader)) return reply(401, { error: 'Sign in to send approval requests.' })

  let body: { jobId?: string }
  try { body = await request.json() } catch { return reply(400, { error: 'Invalid request.' }) }
  const jobId = String(body.jobId || '').trim()
  if (!jobId) return reply(400, { error: 'No scanning job.' })

  // The job as the caller sees it: cs_job refuses anyone who isn't staff of its store.
  const caller = createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } })
  const { data: job, error: jobError } = await caller.rpc('cs_job', { p_job_id: jobId })
  if (jobError || !job) return reply(403, { error: jobError?.message || 'Only staff of this store can send approval requests.' })

  const authorisation = job.authorisation
  if (!authorisation?.id) return reply(409, { error: 'Request authorisation first.' })
  if (authorisation.status !== 'pending') return reply(409, { error: authorisation.status === 'approved' ? 'The collector has already approved.' : 'This request is no longer pending. Request authorisation again.' })

  const collectorId = job.collector?.id
  if (!collectorId) return reply(404, { error: 'The collector for this job was not found.' })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const { data: userData } = await admin.auth.admin.getUserById(collectorId)
  let email = String(userData?.user?.email || '').trim()
  if (!email) {
    const { data: profile } = await admin.from('profiles').select('email').eq('id', collectorId).maybeSingle()
    email = String(profile?.email || '').trim()
  }
  if (!email) return reply(404, { error: "This collector's account has no email address." })

  const storeName = plain(job.store?.name || 'A CollectorsHub store')
  const link = `${APPROVAL_URL}/${encodeURIComponent(authorisation.id)}`
  try {
    const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: smtpUser, pass: smtpPass } })
    await transport.sendMail({
      from: `"CollectorsHub" <${Deno.env.get('SMTP_FROM') || smtpUser}>`,
      to: email,
      subject: `${storeName} is asking to scan cards into your collection`,
      html: approvalHtml({
        storeName,
        location: plain(job.location?.name || ''),
        name: plain(job.collector?.name || job.collector?.username || 'there'),
        express: job.job?.kind === 'express',
        link,
      }),
    })
  } catch (error) {
    return reply(502, { error: `The approval email could not be sent: ${error instanceof Error ? error.message : String(error)}` })
  }

  return reply(200, { ok: true, sentTo: maskEmail(email) })
})
