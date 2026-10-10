// send-schedule: after a manager publishes a week in the Schedule Builder,
// emails each scheduled employee their own shifts for that week, at the
// contact email in their MyHR personal information.
//
// First publish of a week: everyone on it gets an email. Re-publish: only
// people whose shifts changed (added, moved, retimed or removed).
//
// The caller must be a manager of the store: the published week is read with
// the caller's own sign-in (myhr_schedule_week refuses anyone else), so the
// emails always match what staff see in My Schedule. The email is built here
// from that data (all text escaped), never from caller-supplied HTML.
//
// Secrets: the same SMTP_USER / SMTP_PASS / SMTP_FROM as send-receipt.
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import nodemailer from 'npm:nodemailer@6.9.14'
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const TIME_ZONE = 'America/Halifax' // the schedule's weeks are Halifax weeks (myhr_publish_schedule)

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const validEmail = (value: unknown) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(value || '').trim())
const plain = (value: unknown, max = 80) => String(value ?? '').replace(/[\r\n"<>]/g, '').slice(0, max)

type Shift = { id?: string, employee_id?: string | null, starts_at: string, ends_at: string, role?: string | null, break_minutes?: number | null, note?: string | null, changed?: boolean }

const dayText = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TIME_ZONE, weekday: 'long', month: 'long', day: 'numeric' })
const timeText = (iso: string) => new Date(iso).toLocaleTimeString('en-CA', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' })
const hours = (shift: Shift) => Math.max(0, (new Date(shift.ends_at).getTime() - new Date(shift.starts_at).getTime()) / 3600000 - Number(shift.break_minutes || 0) / 60)
const round = (value: number) => Math.round(value * 100) / 100
const sameShift = (a: Shift, b: Shift) => String(a.id) === String(b.id) && String(a.employee_id) === String(b.employee_id)
  && new Date(a.starts_at).getTime() === new Date(b.starts_at).getTime() && new Date(a.ends_at).getTime() === new Date(b.ends_at).getTime()
  && String(a.role || '') === String(b.role || '') && Number(a.break_minutes || 0) === Number(b.break_minutes || 0)

function scheduleHtml({ storeName, firstName, weekLabel, mine, removed, update }: { storeName: string, firstName: string, weekLabel: string, mine: Shift[], removed: Shift[], update: boolean }) {
  const row = (shift: Shift, mark = '') => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee">${escapeHtml(dayText(shift.starts_at))}${mark}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;white-space:nowrap">${escapeHtml(timeText(shift.starts_at))} – ${escapeHtml(timeText(shift.ends_at))}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;color:#556">${escapeHtml(shift.role || '')}${Number(shift.break_minutes) ? ` · ${escapeHtml(shift.break_minutes)} min break` : ''}${shift.note ? `<br><small>${escapeHtml(shift.note)}</small>` : ''}</td>
    </tr>`
  const total = round(mine.reduce((sum, shift) => sum + hours(shift), 0))
  const rows = mine.map((shift) => row(shift, update && shift.changed ? ' <strong style="color:#a66a00">(updated)</strong>' : '')).join('')
  const removedRows = removed.map((shift) => row(shift, ' <strong style="color:#b42318">(removed)</strong>')).join('')
  return `<!doctype html><html><body style="margin:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#17253d">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#fff;border:1px solid #dce5ef;border-radius:10px;padding:22px">
      <h2 style="margin:0 0 4px">${escapeHtml(storeName)}</h2>
      <div style="color:#667;font-size:13px">${update ? 'Updated schedule' : 'Your schedule'} · week of ${escapeHtml(weekLabel)}</div>
      <hr style="border:0;border-top:1px solid #eee;margin:16px 0">
      <p style="margin:0 0 12px;font-size:14px">Hi ${escapeHtml(firstName)},${update ? ' your schedule for this week has changed.' : ' here is your schedule for this week.'}</p>
      ${mine.length
        ? `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>
           <p style="margin:12px 0 0;font-size:14px"><strong>${escapeHtml(mine.length)} shift${mine.length === 1 ? '' : 's'} · ${escapeHtml(total)} hours</strong> (after breaks)</p>`
        : '<p style="margin:0;font-size:14px"><strong>You have no shifts this week.</strong></p>'}
      ${removedRows ? `<p style="margin:16px 0 6px;font-size:14px">No longer scheduled:</p><table style="width:100%;border-collapse:collapse;font-size:14px;color:#667">${removedRows}</table>` : ''}
      <p style="margin:18px 0 0;color:#889;font-size:12px">You can also see your schedule in the CollectorsHub POS under MyHR → My Schedule. Powered by CollectorsHub.</p>
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

  const authorization = request.headers.get('Authorization') || ''
  if (!/^Bearer\s+\S+/i.test(authorization)) return reply(401, { error: 'Sign in to send schedules.' })

  let body: { storeId?: string, weekStart?: string, previousShifts?: Shift[] }
  try { body = await request.json() } catch { return reply(400, { error: 'Invalid request.' }) }
  const storeId = String(body.storeId || '').trim()
  const weekStart = String(body.weekStart || '').trim()
  if (!storeId || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return reply(400, { error: 'Missing store or week.' })

  // The published week, read as the caller: only managers of the store get it.
  const asCaller = createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } })
  const { data: weekRows, error: weekError } = await asCaller.rpc('myhr_schedule_week', { p_store_id: storeId, p_week_start: weekStart })
  if (weekError) return reply(403, { error: weekError.message || 'Only managers can send the schedule.' })
  const week = Array.isArray(weekRows) ? weekRows[0] : weekRows
  if (!week?.published_at) return reply(400, { error: 'This week has not been published yet.' })
  const shifts: Shift[] = (Array.isArray(week.shifts) ? week.shifts : []).filter((shift: Shift) => shift?.employee_id)
  const update = Number(week.version) > 1
  const previous: Shift[] = (Array.isArray(body.previousShifts) ? body.previousShifts : []).slice(0, 2000)
    .filter((shift) => shift?.employee_id && shift.starts_at && shift.ends_at)

  // Who to email: first publish, everyone on it. Re-publish, anyone with a
  // changed shift or a shift that was taken away.
  const removedFor = (employeeId: string) => previous.filter((old) => String(old.employee_id) === employeeId && !shifts.some((shift) => sameShift(shift, old)) && !shifts.some((shift) => String(shift.id) === String(old.id) && String(shift.employee_id) === employeeId))
  const ids = new Set<string>(shifts.map((shift) => String(shift.employee_id)))
  if (update) previous.forEach((shift) => ids.add(String(shift.employee_id)))
  const recipients = [...ids].filter((id) => !update
    || shifts.some((shift) => String(shift.employee_id) === id && shift.changed)
    || removedFor(id).length > 0)
  if (!recipients.length) return reply(200, { ok: true, sent: [], skipped: [], failed: [] })

  // Names and contact emails, only for this store's employees.
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const [{ data: store }, { data: people }, { data: details }] = await Promise.all([
    admin.from('stores').select('store_name').eq('id', storeId).maybeSingle(),
    admin.from('store_employees').select('id, first_name, last_name, username, store_id').in('id', recipients),
    admin.from('store_employee_details').select('employee_id, contact_email').in('employee_id', recipients),
  ])
  const storeName = plain((store as { store_name?: string } | null)?.store_name || 'CollectorsHub store')
  const weekLabel = new Date(`${weekStart}T12:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })
  const emailOf = new Map((details || []).map((row: { employee_id: string, contact_email: string | null }) => [String(row.employee_id), String(row.contact_email || '').trim()]))
  const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: smtpUser, pass: smtpPass } })

  const sent: string[] = []
  const skipped: string[] = []
  const failed: string[] = []
  for (const person of (people || []) as { id: string, first_name?: string, last_name?: string, username?: string, store_id?: string | null }[]) {
    if (person.store_id && person.store_id !== storeId) continue
    const name = plain([person.first_name, person.last_name].filter(Boolean).join(' ') || person.username || 'Employee')
    const to = emailOf.get(String(person.id)) || ''
    if (!validEmail(to)) { skipped.push(name); continue }
    const mine = shifts.filter((shift) => String(shift.employee_id) === String(person.id))
    try {
      await transport.sendMail({
        from: `"${storeName} via CollectorsHub" <${Deno.env.get('SMTP_FROM') || smtpUser}>`,
        to,
        subject: `${update ? 'Updated schedule' : 'Your schedule'}: week of ${weekLabel} (${storeName})`,
        html: scheduleHtml({ storeName, firstName: plain(person.first_name || name, 40), weekLabel, mine, removed: update ? removedFor(String(person.id)) : [], update }),
      })
      sent.push(name)
    } catch {
      failed.push(name)
    }
  }
  return reply(200, { ok: true, sent, skipped, failed })
})
