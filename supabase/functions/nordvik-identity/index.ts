// nordvik-identity: the NORDVIK Identity API (v1), shared by NORDVIK apps.
// Data model and rules: supabase/nordvik_identity.sql.
//
// POS / staff (Authorization: the employee's Supabase session):
//   POST /v1/identity/verifications                         start a session { storeId, accountId }
//   GET  /v1/identity/verifications/{id}                    session status
//   POST /v1/identity/verifications/{id}/consent            customer consent typed at the POS
//   POST /v1/identity/verifications/{id}/document           ID type + details read from the ID
//   POST /v1/identity/verifications/{id}/documents          upload authorisation for an ID image { kind }
//   POST /v1/identity/verifications/{id}/photo              upload authorisation for the live photo (store webcam)
//   POST /v1/identity/verifications/{id}/uploaded           confirm an upload { kind, sha256 }
//   POST /v1/identity/verifications/{id}/mobile-capture     single-use QR link for the customer's phone
//   POST /v1/identity/verifications/{id}/submit             send the evidence for a decision
//   POST /v1/identity/verifications/{id}/cancel
//   GET  /v1/identity/profiles/{accountId}/verification-status?storeId=
//   GET  /v1/identity/profiles/{accountId}/portrait?storeId=
// Customer phone (X-Identity-Token: the QR token; nothing else is accessible):
//   GET  /v1/identity/mobile/session
//   POST /v1/identity/mobile/consent
//   POST /v1/identity/mobile/photo
//   POST /v1/identity/mobile/complete
// Reviewers (signed in and listed in identity_reviewers):
//   GET  /v1/identity/reviews
//   GET  /v1/identity/reviews/{id}/evidence
//   POST /v1/identity/reviews/{id}/decision                 { decision: verified | failed, note }
//   POST /v1/identity/profiles/{accountId}/revoke           { reason }
// Maintenance (Authorization: the service role key):
//   POST /v1/identity/maintenance/purge
//
// Verification providers sit behind the PROVIDERS interface below. None is
// connected, so submissions go to authorised manual review: nothing here
// ever returns a fabricated "verified".
//
// Secrets: MOBILE_VERIFY_URL (the hosted phone page, https), optional
// IDENTITY_PROVIDER. SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
// are provided by Supabase.

import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2'

const NOTICE_VERSION = 'nordvik-identity-consent-2026-10-v3'
const SESSION_MINUTES = 30
const MOBILE_LINK_MINUTES = 10
const MAX_SESSIONS_PER_USER_PER_10_MIN = 12
const MAX_TOKEN_FAILURES = 8
const BUCKET = 'identity-evidence'
const DOCUMENT_TYPES = ['drivers_licence', 'passport', 'provincial_id']
const EVIDENCE_KINDS = ['document_front', 'document_back', 'live_photo']

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-identity-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }
const fail = (status: number, message: string): never => { throw new HttpError(status, message) }

// ── Verification providers (replaceable) ─────────────────────────────────────
// A provider implements document validation, face comparison + liveness and
// portrait generation. Thresholds come from the provider's own evaluated
// configuration (false accept / false reject testing), never from here.
interface ProviderResult {
  documentCheck: 'passed' | 'failed' | 'inconclusive'
  faceMatch: 'passed' | 'failed' | 'inconclusive' | 'not_checked'
  liveness: 'passed' | 'failed' | 'inconclusive' | 'not_checked'
  reference: string
  failureReason?: string
}
interface VerificationProvider {
  name: string
  verify(input: { documentType: string, images: Record<string, Uint8Array>, details: Record<string, unknown> }): Promise<ProviderResult>
  portrait?(livePhoto: Uint8Array): Promise<Uint8Array | null> // 512x512, white background, no retouching
}
// Approved, implemented providers. Empty until one is evaluated and connected.
const PROVIDERS: Record<string, VerificationProvider> = {}
const provider = (): VerificationProvider | null => PROVIDERS[Deno.env.get('IDENTITY_PROVIDER') || ''] || null

// ── Helpers ─────────────────────────────────────────────────────────────────
const url = Deno.env.get('SUPABASE_URL') || ''
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const normalName = (value: unknown) => String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim()
const isoDate = (value: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : ''

async function audit(profileId: string | null, sessionId: string | null, actorId: string | null, actorType: string, action: string, meta: Record<string, unknown> = {}) {
  await admin.rpc('identity_audit', { p_profile: profileId, p_session: sessionId, p_actor: actorId, p_actor_type: actorType, p_action: action, p_meta: meta })
}

// Simple per-instance rate limit for unauthenticated (phone) requests.
const hits = new Map<string, { count: number, reset: number }>()
function rateLimit(key: string, limit = 60, windowMs = 60_000) {
  const now = Date.now()
  const entry = hits.get(key)
  if (!entry || entry.reset < now) { hits.set(key, { count: 1, reset: now + windowMs }); return }
  entry.count += 1
  if (entry.count > limit) fail(429, 'Too many requests. Wait a minute and try again.')
}

type Staff = { userId: string, employeeId: string | null, client: SupabaseClient }
async function signedInUser(request: Request) {
  const authorization = request.headers.get('Authorization') || ''
  const token = authorization.replace(/^Bearer\s+/i, '')
  if (!token || token === anonKey) fail(401, 'Sign in to use NORDVIK Identity.')
  const { data } = await admin.auth.getUser(token)
  if (!data?.user) fail(401, 'Your session has expired. Sign in again.')
  const client = createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } })
  return { user: data.user!, client }
}
async function staffFor(request: Request, storeId: string): Promise<Staff> {
  const { user, client } = await signedInUser(request)
  if (!storeId) fail(400, 'No store.')
  const { data, error } = await client.rpc('identity_staff_check', { p_store_id: storeId })
  const row = Array.isArray(data) ? data[0] : data
  if (error || !row?.allowed) fail(403, 'Only staff of this store can do that.')
  return { userId: user.id, employeeId: row.employee_id || null, client }
}
async function isTestStore(storeId: string) {
  const { data } = await admin.from('stores').select('is_test_store').eq('id', storeId).maybeSingle()
  return data?.is_test_store === true
}
async function isReviewer(userId: string) {
  const { data } = await admin.from('identity_reviewers').select('user_id').eq('user_id', userId).maybeSingle()
  return Boolean(data)
}

async function loadSession(id: string) {
  const { data } = await admin.from('identity_verification_sessions').select('*').eq('id', id).maybeSingle()
  if (!data) fail(404, 'Verification session not found.')
  return data as Record<string, any>
}
async function staffSession(request: Request, id: string) {
  const session = await loadSession(id)
  const staff = await staffFor(request, session.store_id)
  return { session, staff }
}
function assertOpen(session: Record<string, any>) {
  if (!['pending', 'awaiting_capture'].includes(session.status)) fail(409, `This verification is ${String(session.status).replace('_', ' ')}.`)
  if (new Date(session.expires_at) < new Date()) fail(410, 'This verification session has expired. Start a new one.')
}
async function consents(sessionId: string) {
  const { data } = await admin.from('identity_consent_records').select('consent_type, consent_status, consent_method, consent_timestamp').eq('session_id', sessionId).order('consent_timestamp')
  const latest: Record<string, any> = {}
  for (const row of data || []) latest[row.consent_type] = row
  return latest
}
async function evidence(sessionId: string) {
  const { data } = await admin.from('identity_evidence').select('kind, uploaded_at, deleted_at').eq('session_id', sessionId)
  return Object.fromEntries((data || []).filter((row) => row.uploaded_at && !row.deleted_at).map((row) => [row.kind, true]))
}

async function sessionView(session: Record<string, any>) {
  const [{ data: profile }, given, uploaded, { data: links }] = await Promise.all([
    admin.from('identity_profiles').select('*').eq('id', session.identity_profile_id).maybeSingle(),
    consents(session.id),
    evidence(session.id),
    admin.from('identity_mobile_links').select('expires_at, opened_at, completed_at, revoked_at').eq('session_id', session.id).order('created_at', { ascending: false }).limit(1),
  ])
  const link = links?.[0]
  return {
    id: session.id,
    status: new Date(session.expires_at) < new Date() && ['pending', 'awaiting_capture'].includes(session.status) ? 'expired' : session.status,
    documentType: session.document_type,
    captureMethod: session.capture_method,
    biometricConsent: session.biometric_consent,
    consents: Object.fromEntries(Object.entries(given).map(([type, row]) => [type, row.consent_status])),
    discrepancies: session.discrepancies || [],
    evidence: uploaded,
    expiresAt: session.expires_at,
    mobile: link ? { expiresAt: link.expires_at, opened: Boolean(link.opened_at), completed: Boolean(link.completed_at), revoked: Boolean(link.revoked_at) } : null,
    profileStatus: profile ? await effectiveStatus(profile) : 'unverified',
    automatedAvailable: Boolean(provider()),
  }
}
async function effectiveStatus(profile: Record<string, any>) {
  if (profile.revoked_at) return 'revoked'
  if (profile.verification_status === 'verified' && profile.verification_expires_at && new Date(profile.verification_expires_at) < new Date()) return 'expired'
  return profile.verification_status
}

async function uploadAuthorisation(session: Record<string, any>, kind: string) {
  const path = `sessions/${session.id}/${kind}-${crypto.randomUUID()}.jpg`
  const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path)
  if (error || !data) fail(500, `Upload could not be authorised: ${error?.message || 'unknown error'}`)
  // Replace any earlier capture of the same kind (retakes).
  const { data: previous } = await admin.from('identity_evidence').select('storage_path').eq('session_id', session.id).eq('kind', kind).maybeSingle()
  if (previous?.storage_path) await admin.storage.from(BUCKET).remove([previous.storage_path])
  await admin.from('identity_evidence').upsert({ session_id: session.id, kind, storage_path: path, uploaded_at: null, sha256: null, deleted_at: null }, { onConflict: 'session_id,kind' })
  return { path, token: data.token, signedUrl: data.signedUrl, bucket: BUCKET, maxBytes: 8 * 1024 * 1024, contentType: 'image/jpeg' }
}
async function confirmUpload(session: Record<string, any>, kind: string, sha256: string) {
  const { data: row } = await admin.from('identity_evidence').select('storage_path').eq('session_id', session.id).eq('kind', kind).maybeSingle()
  if (!row) fail(400, 'Nothing was authorised for that upload.')
  const folder = row!.storage_path.split('/').slice(0, -1).join('/')
  const name = row!.storage_path.split('/').pop()
  const { data: files } = await admin.storage.from(BUCKET).list(folder, { search: name })
  const file = files?.find((entry) => entry.name === name)
  if (!file) fail(400, 'The image did not arrive. Try again.')
  if (Number(file!.metadata?.size || 0) > 8 * 1024 * 1024) { await admin.storage.from(BUCKET).remove([row!.storage_path]); fail(413, 'The image is too large.') }
  await admin.from('identity_evidence').update({ uploaded_at: new Date().toISOString(), sha256: /^[a-f0-9]{64}$/.test(sha256) ? sha256 : null }).eq('session_id', session.id).eq('kind', kind)
}

// ── Mobile token ────────────────────────────────────────────────────────────
async function mobileLink(request: Request) {
  const token = request.headers.get('x-identity-token') || ''
  rateLimit(`ip:${request.headers.get('x-forwarded-for') || 'unknown'}`, 40)
  if (token.length < 30) fail(401, 'This verification link is not valid.')
  const { data: link } = await admin.from('identity_mobile_links').select('*').eq('token_hash', await sha256Hex(token)).maybeSingle()
  if (!link) fail(401, 'This verification link is not valid.')
  if (link!.revoked_at) fail(410, 'This verification link was cancelled. Ask the store for a new code.')
  if (link!.completed_at) fail(410, 'This verification link has already been used.')
  if (new Date(link!.expires_at) < new Date()) fail(410, 'This verification link has expired. Ask the store for a new code.')
  if (link!.failed_attempts >= MAX_TOKEN_FAILURES) fail(429, 'Too many attempts. Ask the store for a new code.')
  const session = await loadSession(link!.session_id)
  if (!['pending', 'awaiting_capture'].includes(session.status) || new Date(session.expires_at) < new Date()) fail(410, 'This verification is no longer open.')
  return { link: link!, session }
}

// ── Routes ──────────────────────────────────────────────────────────────────
async function route(request: Request) {
  const path = new URL(request.url).pathname
  const at = path.indexOf('/v1/identity')
  if (at < 0) fail(404, 'Not found.')
  const parts = path.slice(at + '/v1/identity'.length).split('/').filter(Boolean)
  const method = request.method
  const body = method === 'POST' ? await request.json().catch(() => ({})) : {}
  const query = new URL(request.url).searchParams

  // Start a verification.
  if (method === 'POST' && parts.length === 1 && parts[0] === 'verifications') {
    const storeId = String(body.storeId || '')
    const accountId = String(body.accountId || '')
    const staff = await staffFor(request, storeId)
    if (!accountId) fail(400, 'No customer account.')
    const { count } = await admin.from('identity_verification_sessions').select('id', { count: 'exact', head: true })
      .eq('initiated_by_user', staff.userId).gte('created_at', new Date(Date.now() - 10 * 60_000).toISOString())
    if ((count || 0) >= MAX_SESSIONS_PER_USER_PER_10_MIN) fail(429, 'Too many verifications started. Wait a few minutes.')
    // The customer must be this store's customer (links them if needed, as the POS does).
    const { error: linkError } = await staff.client.rpc('ensure_store_customer_for_profile', { p_store_id: storeId, p_profile_id: accountId })
    if (linkError) fail(400, linkError.message)
    const { data: account } = await admin.from('profiles').select('id, full_name, display_name').eq('id', accountId).maybeSingle()
    if (!account) fail(404, 'CollectorsHub account not found.')
    let { data: profile } = await admin.from('identity_profiles').select('*').eq('account_id', accountId).maybeSingle()
    if (!profile) {
      const created = await admin.from('identity_profiles').insert({ account_id: accountId, legal_name: account!.full_name || null }).select('*').single()
      profile = created.data
    }
    // A demo verification doesn't count outside test stores, so a real one can be started there.
    if (await effectiveStatus(profile!) === 'verified' && !(profile!.is_demo && !(await isTestStore(storeId)))) fail(409, profile!.is_demo ? 'This customer is Demo Verified at test stores.' : 'This customer is already verified.')
    // One open session per person: earlier ones are cancelled (prevents substitution between parallel sessions).
    const { data: open } = await admin.from('identity_verification_sessions').select('id').eq('identity_profile_id', profile!.id).in('status', ['pending', 'awaiting_capture'])
    for (const old of open || []) {
      await admin.from('identity_verification_sessions').update({ status: 'cancelled', completed_at: new Date().toISOString() }).eq('id', old.id)
      await admin.from('identity_mobile_links').update({ revoked_at: new Date().toISOString() }).eq('session_id', old.id).is('revoked_at', null)
      await audit(profile!.id, old.id, staff.userId, 'employee', 'session_replaced')
    }
    const { data: session, error } = await admin.from('identity_verification_sessions').insert({
      identity_profile_id: profile!.id, store_id: storeId, initiated_by_employee_id: staff.employeeId, initiated_by_user: staff.userId,
      expires_at: new Date(Date.now() + SESSION_MINUTES * 60_000).toISOString(),
    }).select('*').single()
    if (error) fail(500, error.message)
    await audit(profile!.id, session!.id, staff.userId, 'employee', 'session_started', { store_id: storeId })
    return reply(201, { ...(await sessionView(session!)), noticeVersion: NOTICE_VERSION })
  }

  // Session routes.
  if (parts[0] === 'verifications' && parts[1]) {
    const { session, staff } = await staffSession(request, parts[1])
    const action = parts[2] || ''
    if (method === 'GET' && !action) return reply(200, await sessionView(session))

    if (method === 'POST' && action === 'cancel') {
      if (['pending', 'awaiting_capture', 'processing'].includes(session.status)) {
        await admin.from('identity_verification_sessions').update({ status: 'cancelled', completed_at: new Date().toISOString() }).eq('id', session.id)
        await admin.from('identity_mobile_links').update({ revoked_at: new Date().toISOString() }).eq('session_id', session.id).is('revoked_at', null)
        await audit(session.identity_profile_id, session.id, staff.userId, 'employee', 'session_cancelled', { reason: body.reason || null })
      }
      return reply(200, await sessionView(await loadSession(session.id)))
    }

    assertOpen(session)

    if (method === 'POST' && action === 'consent') {
      const type = String(body.consentType || '')
      const status = String(body.status || '')
      const signedName = String(body.signedName || '').trim()
      if (!['identity_check', 'biometric', 'portrait_display'].includes(type) || !['given', 'declined'].includes(status)) fail(400, 'Unknown consent.')
      if (status === 'given' && signedName.length < 2) fail(400, 'The customer must type their name to agree.')
      if (body.noticeVersion !== NOTICE_VERSION) fail(409, 'The privacy notice has changed. Reload and show the customer the current notice.')
      await admin.from('identity_consent_records').insert({
        identity_profile_id: session.identity_profile_id, session_id: session.id, notice_version: NOTICE_VERSION,
        consent_type: type, consent_status: status, consent_method: 'pos_customer_signature', signed_name: signedName || null,
      })
      if (type === 'biometric') await admin.from('identity_verification_sessions').update({ biometric_consent: status === 'given', capture_method: status === 'given' ? session.capture_method : 'none' }).eq('id', session.id)
      // Agreeing to photo verification covers stores where they sell seeing the identity photo (notice v3).
      if (type === 'biometric') await admin.from('identity_profiles').update({ portrait_display_consent: status === 'given', updated_at: new Date().toISOString() }).eq('id', session.identity_profile_id)
      await audit(session.identity_profile_id, session.id, staff.userId, 'employee', `consent_${type}_${status}`, { method: 'pos_customer_signature', notice: NOTICE_VERSION })
      return reply(200, await sessionView(await loadSession(session.id)))
    }

    const given = await consents(session.id)
    if (given.identity_check?.consent_status !== 'given') fail(403, 'The customer has not agreed to the identity check yet.')

    if (method === 'POST' && action === 'document') {
      const documentType = String(body.documentType || '')
      if (!DOCUMENT_TYPES.includes(documentType)) fail(400, 'Choose a type of ID.')
      const details = {
        full_name: String(body.details?.full_name || '').trim().replace(/\s+/g, ' '),
        date_of_birth: isoDate(body.details?.date_of_birth),
        expiry_date: isoDate(body.details?.expiry_date),
        jurisdiction: String(body.details?.jurisdiction || '').trim().slice(0, 80),
        source: ['manual_entry', 'barcode', 'mrz', 'provider'].includes(body.details?.source) ? body.details.source : 'manual_entry',
      }
      if (details.full_name.length < 2 || !details.date_of_birth || !details.expiry_date || !details.jurisdiction) fail(400, 'Enter the full name, date of birth, expiry date and issuer from the ID.')
      const { data: profile } = await admin.from('identity_profiles').select('legal_name').eq('id', session.identity_profile_id).single()
      const discrepancies: string[] = []
      if (profile?.legal_name && normalName(profile.legal_name) !== normalName(details.full_name)) discrepancies.push('name_differs_from_account')
      const today = new Date().toISOString().slice(0, 10)
      const born = new Date(`${details.date_of_birth}T00:00:00Z`)
      const age = (Date.now() - born.getTime()) / (365.2425 * 86_400_000)
      if (details.date_of_birth > today) discrepancies.push('date_of_birth_in_future')
      else if (age < 18) discrepancies.push('under_18')
      await admin.from('identity_verification_sessions').update({ document_type: documentType, document_details: details, discrepancies, status: 'awaiting_capture' }).eq('id', session.id)
      await audit(session.identity_profile_id, session.id, staff.userId, 'employee', 'document_details_recorded', { document_type: documentType, source: details.source, discrepancies })
      if (details.expiry_date < today) {
        await admin.from('identity_verification_attempts').insert({ session_id: session.id, document_type: documentType, document_check_status: 'failed', failure_reason_code: 'document_expired' })
        await admin.rpc('identity_decide', { p_session_id: session.id, p_status: 'failed', p_method: 'document_check', p_actor: staff.userId, p_actor_type: 'employee', p_note: 'The ID has expired.' })
      }
      return reply(200, await sessionView(await loadSession(session.id)))
    }

    if (method === 'POST' && action === 'documents') {
      const kind = String(body.kind || '')
      if (!['document_front', 'document_back'].includes(kind)) fail(400, 'Unknown ID side.')
      const upload = await uploadAuthorisation(session, kind)
      await audit(session.identity_profile_id, session.id, staff.userId, 'employee', 'upload_authorised', { kind })
      return reply(200, upload)
    }

    if (method === 'POST' && action === 'photo') {
      if (session.biometric_consent !== true) fail(403, 'The customer has not agreed to a live photo.')
      await admin.from('identity_verification_sessions').update({ capture_method: 'webcam' }).eq('id', session.id)
      const upload = await uploadAuthorisation(session, 'live_photo')
      await audit(session.identity_profile_id, session.id, staff.userId, 'employee', 'upload_authorised', { kind: 'live_photo', method: 'webcam' })
      return reply(200, upload)
    }

    if (method === 'POST' && action === 'uploaded') {
      const kind = String(body.kind || '')
      if (!EVIDENCE_KINDS.includes(kind)) fail(400, 'Unknown upload.')
      await confirmUpload(session, kind, String(body.sha256 || ''))
      await audit(session.identity_profile_id, session.id, staff.userId, 'employee', 'evidence_uploaded', { kind })
      return reply(200, await sessionView(await loadSession(session.id)))
    }

    if (method === 'POST' && action === 'mobile-capture') {
      const base = Deno.env.get('MOBILE_VERIFY_URL') || ''
      if (!/^https:\/\//.test(base)) fail(503, "Phone capture isn't set up yet (the hosted verification page, MOBILE_VERIFY_URL).")
      const token = randomToken()
      const expiresAt = new Date(Math.min(Date.now() + MOBILE_LINK_MINUTES * 60_000, new Date(session.expires_at).getTime())).toISOString()
      await admin.from('identity_mobile_links').update({ revoked_at: new Date().toISOString() }).eq('session_id', session.id).is('revoked_at', null).is('completed_at', null)
      await admin.from('identity_mobile_links').insert({ session_id: session.id, token_hash: await sha256Hex(token), expires_at: expiresAt })
      await admin.from('identity_verification_sessions').update({ capture_method: 'mobile' }).eq('id', session.id)
      await audit(session.identity_profile_id, session.id, staff.userId, 'employee', 'mobile_link_created', { expires_at: expiresAt })
      // The token is in the fragment, so it's never sent to the page's web server or logged by it.
      return reply(200, { url: `${base}#t=${token}`, expiresAt })
    }

    if (method === 'POST' && action === 'submit') {
      const uploaded = await evidence(session.id)
      if (!session.document_details) fail(400, 'Record the ID details first.')
      if (session.biometric_consent === true && !uploaded.live_photo) fail(400, 'Capture the customer photo first.')
      const p = provider()
      await admin.from('identity_verification_sessions').update({ status: 'processing' }).eq('id', session.id)
      await audit(session.identity_profile_id, session.id, staff.userId, 'employee', 'submitted', { evidence: Object.keys(uploaded), provider: p?.name || null })
      if (!p || session.biometric_consent !== true) {
        // No approved provider (or the customer chose the non-biometric
        // alternative): an authorised reviewer decides from the evidence.
        await admin.from('identity_verification_attempts').insert({
          session_id: session.id, document_type: session.document_type, document_check_status: 'manual',
          face_match_status: session.biometric_consent === true ? 'not_checked' : 'not_applicable', liveness_status: 'not_checked',
          review_status: 'pending', verification_provider: null,
        })
        await admin.rpc('identity_decide', { p_session_id: session.id, p_status: 'manual_review', p_method: 'manual_review', p_actor: null, p_actor_type: 'service', p_note: p ? 'Non-biometric alternative chosen' : 'No verification provider connected' })
        return reply(200, { ...(await sessionView(await loadSession(session.id))), message: 'Sent to an authorised NORDVIK Identity reviewer.' })
      }
      // Automated path (only when a provider is connected).
      const images: Record<string, Uint8Array> = {}
      const { data: rows } = await admin.from('identity_evidence').select('kind, storage_path').eq('session_id', session.id).not('uploaded_at', 'is', null).is('deleted_at', null)
      for (const row of rows || []) {
        const { data: blob } = await admin.storage.from(BUCKET).download(row.storage_path)
        if (blob) images[row.kind] = new Uint8Array(await blob.arrayBuffer())
      }
      const result = await p.verify({ documentType: session.document_type, images, details: session.document_details })
      await admin.from('identity_verification_attempts').insert({
        session_id: session.id, document_type: session.document_type, document_check_status: result.documentCheck, face_match_status: result.faceMatch,
        liveness_status: result.liveness, review_status: 'none', verification_provider: p.name, provider_reference: result.reference, failure_reason_code: result.failureReason || null,
      })
      const passed = result.documentCheck === 'passed' && result.faceMatch === 'passed' && result.liveness === 'passed' && !(session.discrepancies || []).length
      const definiteFail = result.documentCheck === 'failed'
      const decision = passed ? 'verified' : definiteFail ? 'failed' : 'manual_review' // inconclusive -> people decide
      await admin.rpc('identity_decide', { p_session_id: session.id, p_status: decision, p_method: 'automated', p_actor: null, p_actor_type: 'service', p_note: result.failureReason || null })
      if (decision === 'verified' && p.portrait && images.live_photo) await makePortrait(session.identity_profile_id, images.live_photo, p)
      return reply(200, await sessionView(await loadSession(session.id)))
    }
    fail(404, 'Not found.')
  }

  // Status and portrait for a connected store.
  if (parts[0] === 'profiles' && parts[1] && method === 'GET') {
    const accountId = parts[1]
    const storeId = query.get('storeId') || ''
    await staffFor(request, storeId)
    const { data: visible } = await admin.rpc('identity_store_can_see', { p_store_id: storeId, p_account_id: accountId })
    if (!visible) fail(403, 'This customer is not linked to your store.')
    const { data: profile } = await admin.from('identity_profiles').select('*').eq('account_id', accountId).maybeSingle()
    // Demo verification (development/testing): only test stores see it.
    const testStore = await isTestStore(storeId)
    const demoHidden = Boolean(profile?.is_demo) && !testStore
    if (parts[2] === 'verification-status') {
      if (!profile || demoHidden) return reply(200, { status: 'unverified', buybackAllowed: false, demo: false })
      const status = await effectiveStatus(profile)
      const { data: open } = await admin.from('identity_verification_sessions').select('id, status').eq('identity_profile_id', profile.id)
        .in('status', ['pending', 'awaiting_capture', 'processing', 'manual_review']).order('created_at', { ascending: false }).limit(1)
      return reply(200, {
        status,
        demo: Boolean(profile.is_demo), // "Demo Verified": test stores only, never a real identity check
        buybackAllowed: status === 'verified',
        verifiedAt: profile.verified_at,
        expiresAt: profile.verification_expires_at,
        reverificationRequired: status === 'expired' || status === 'revoked',
        method: profile.verified_method,
        openSession: open?.[0] ? { id: open[0].id, status: open[0].status } : null,
        portraitAvailable: profile.portrait_status === 'ready' && profile.portrait_display_consent,
        portraitProcessed: profile.portrait_source === 'provider_processed' || profile.portrait_source === 'demo_sample',
        // Verified identity details for identifying the customer at the till (verified customers only).
        legalName: status === 'verified' ? profile.legal_name : null,
        dateOfBirth: status === 'verified' ? profile.verified_date_of_birth : null,
      })
    }
    if (parts[2] === 'portrait') {
      if (!profile || demoHidden || profile.portrait_status !== 'ready' || !profile.portrait_display_consent || !profile.portrait_path) fail(404, 'No authorised portrait.')
      if (await effectiveStatus(profile) !== 'verified') fail(404, 'No authorised portrait.')
      // The identity photo: never the CollectorsHub profile picture, never a raw ID
      // scan. Every view is logged with the store, employee and purpose.
      const purpose = ['checkout_identification', 'buyback_identification'].includes(query.get('purpose') || '') ? query.get('purpose') : ''
      if (!purpose) fail(400, 'Say why the identity photo is needed.')
      const staff = await staffFor(request, storeId)
      const { data } = await admin.storage.from(BUCKET).createSignedUrl(profile.portrait_path, 60)
      await audit(profile.id, null, staff.userId, 'employee', 'identity_photo_viewed', { store_id: storeId, employee_id: staff.employeeId, purpose })
      if (!data?.signedUrl) fail(404, 'The identity photo is missing from storage.')
      return reply(200, { url: data?.signedUrl, expiresInSeconds: 60, processed: profile.portrait_source === 'provider_processed' || profile.portrait_source === 'demo_sample', demo: Boolean(profile.is_demo) })
    }
  }

  // Customer phone.
  if (parts[0] === 'mobile') {
    const { link, session } = await mobileLink(request)
    const action = parts[1] || ''
    if (method === 'GET' && action === 'session') {
      if (!link.opened_at) {
        await admin.from('identity_mobile_links').update({ opened_at: new Date().toISOString() }).eq('id', link.id)
        await audit(session.identity_profile_id, session.id, null, 'customer_phone', 'mobile_link_opened')
      }
      const { data: store } = await admin.from('stores').select('store_name').eq('id', session.store_id).maybeSingle()
      const given = await consents(session.id)
      return reply(200, { storeName: store?.store_name || 'A CollectorsHub store', noticeVersion: NOTICE_VERSION, expiresAt: link.expires_at, phoneConsent: given.biometric?.consent_method === 'customer_phone' ? given.biometric.consent_status : null })
    }
    if (method === 'POST' && action === 'consent') {
      const status = String(body.status || '')
      const signedName = String(body.signedName || '').trim()
      if (!['given', 'declined'].includes(status)) fail(400, 'Unknown consent.')
      if (status === 'given' && signedName.length < 2) fail(400, 'Type your name to agree.')
      if (body.noticeVersion !== NOTICE_VERSION) fail(409, 'The privacy notice has changed. Reload the page.')
      await admin.from('identity_consent_records').insert({ identity_profile_id: session.identity_profile_id, session_id: session.id, notice_version: NOTICE_VERSION, consent_type: 'biometric', consent_status: status, consent_method: 'customer_phone', signed_name: signedName || null })
      // Photo verification consent covers stores where they sell seeing the identity photo (notice v3).
      await admin.from('identity_profiles').update({ portrait_display_consent: status === 'given' }).eq('id', session.identity_profile_id)
      await admin.from('identity_verification_sessions').update({ biometric_consent: status === 'given' }).eq('id', session.id)
      await audit(session.identity_profile_id, session.id, null, 'customer_phone', `consent_biometric_${status}`, { notice: NOTICE_VERSION })
      return reply(200, { ok: true })
    }
    const given = await consents(session.id)
    if (given.biometric?.consent_status !== 'given') fail(403, 'Agree to the photo first.')
    if (method === 'POST' && action === 'photo') return reply(200, await uploadAuthorisation(session, 'live_photo'))
    if (method === 'POST' && action === 'complete') {
      try { await confirmUpload(session, 'live_photo', String(body.sha256 || '')) } catch (error) {
        await admin.from('identity_mobile_links').update({ failed_attempts: link.failed_attempts + 1 }).eq('id', link.id)
        throw error
      }
      await admin.from('identity_mobile_links').update({ completed_at: new Date().toISOString() }).eq('id', link.id) // single use
      await audit(session.identity_profile_id, session.id, null, 'customer_phone', 'live_photo_submitted')
      return reply(200, { ok: true })
    }
    fail(404, 'Not found.')
  }

  // Reviewers.
  if (parts[0] === 'reviews' || (parts[0] === 'profiles' && parts[2] === 'revoke')) {
    const { user } = await signedInUser(request)
    if (!(await isReviewer(user.id))) fail(403, 'Only NORDVIK Identity reviewers can do that.')
    if (parts[0] === 'profiles') {
      if (!String(body.reason || '').trim()) fail(400, 'A reason is required to revoke.')
      const { data: revoking } = await admin.from('identity_profiles').select('portrait_path').eq('account_id', parts[1]).maybeSingle()
      if (revoking?.portrait_path) await admin.storage.from(BUCKET).remove([revoking.portrait_path]) // the identity photo goes with the verification
      await admin.rpc('identity_revoke', { p_account_id: parts[1], p_reason: String(body.reason || ''), p_actor: user.id })
      return reply(200, { ok: true })
    }
    if (method === 'GET' && parts.length === 1) {
      const { data } = await admin.from('identity_verification_sessions')
        .select('id, document_type, document_details, discrepancies, biometric_consent, capture_method, created_at, initiated_by_user, store_id, identity_profile_id, identity_profiles(account_id, legal_name, profiles(username))')
        .eq('status', 'manual_review').order('created_at')
      const storeIds = [...new Set((data || []).map((row: any) => row.store_id).filter(Boolean))]
      const { data: stores } = storeIds.length ? await admin.from('stores').select('id, store_name').in('id', storeIds) : { data: [] }
      return reply(200, (data || []).map((row: any) => ({
        id: row.id, documentType: row.document_type, details: row.document_details, discrepancies: row.discrepancies, biometricConsent: row.biometric_consent,
        captureMethod: row.capture_method, createdAt: row.created_at, startedByMe: row.initiated_by_user === user.id,
        storeName: (stores || []).find((store: any) => store.id === row.store_id)?.store_name || '',
        accountName: row.identity_profiles?.legal_name || '', username: row.identity_profiles?.profiles?.username || '',
      })))
    }
    const session = await loadSession(parts[1])
    if (method === 'GET' && parts[2] === 'evidence') {
      const { data: rows } = await admin.from('identity_evidence').select('kind, storage_path').eq('session_id', session.id).not('uploaded_at', 'is', null).is('deleted_at', null)
      const urls: Record<string, string> = {}
      for (const row of rows || []) {
        const { data } = await admin.storage.from(BUCKET).createSignedUrl(row.storage_path, 120)
        if (data?.signedUrl) urls[row.kind] = data.signedUrl
      }
      await audit(session.identity_profile_id, session.id, user.id, 'reviewer', 'evidence_viewed', { kinds: Object.keys(urls) })
      return reply(200, { urls, expiresInSeconds: 120 })
    }
    if (method === 'POST' && parts[2] === 'decision') {
      if (session.status !== 'manual_review') fail(409, 'This review is no longer open.')
      if (session.initiated_by_user === user.id) fail(403, "You can't decide a verification you started.")
      const decision = String(body.decision || '')
      if (!['verified', 'failed'].includes(decision)) fail(400, 'Decide verified or failed.')
      if (decision === 'failed' && !String(body.note || '').trim()) fail(400, 'Give a reason when failing a verification.')
      await admin.from('identity_verification_attempts').update({ review_status: decision === 'verified' ? 'approved' : 'rejected' }).eq('session_id', session.id).eq('review_status', 'pending')
      const status = (await admin.rpc('identity_decide', { p_session_id: session.id, p_status: decision, p_method: 'manual_review', p_actor: user.id, p_actor_type: 'reviewer', p_note: body.note || null })).data
      if (status === 'verified') await interimPortrait(session)
      return reply(200, { status })
    }
    fail(404, 'Not found.')
  }

  // Maintenance: delete evidence that's no longer needed.
  if (parts[0] === 'maintenance' && parts[1] === 'purge' && method === 'POST') {
    if ((request.headers.get('Authorization') || '') !== `Bearer ${serviceKey}`) fail(403, 'Service only.')
    const { data: due } = await admin.rpc('identity_evidence_due_for_deletion')
    const paths = (due || []).map((row: any) => row.storage_path)
    if (paths.length) await admin.storage.from(BUCKET).remove(paths)
    for (const row of due || []) await admin.from('identity_evidence').update({ deleted_at: new Date().toISOString() }).eq('id', row.id)
    const { data: purged } = await admin.rpc('identity_purge_details')
    if (paths.length) await audit(null, null, null, 'system', 'evidence_deleted', { files: paths.length })
    return reply(200, { evidenceDeleted: paths.length, detailsPurged: purged || 0 })
  }

  fail(404, 'Not found.')
}

// After a manual approval with no provider to remove the background: keep the
// customer's unedited live photo as their identity photo (an authorised
// fallback, marked unprocessed so it's regenerated once a provider exists).
// It's a copy, so it survives the evidence purge; it's deleted on revocation.
async function interimPortrait(session: Record<string, any>) {
  try {
    const { data: profile } = await admin.from('identity_profiles').select('id, portrait_status, portrait_display_consent').eq('id', session.identity_profile_id).single()
    if (!profile?.portrait_display_consent || profile.portrait_status === 'ready') return
    const { data: row } = await admin.from('identity_evidence').select('storage_path').eq('session_id', session.id).eq('kind', 'live_photo').not('uploaded_at', 'is', null).is('deleted_at', null).maybeSingle()
    if (!row) return
    const path = `portraits/${profile.id}.jpg`
    await admin.storage.from(BUCKET).remove([path])
    const { error } = await admin.storage.from(BUCKET).copy(row.storage_path, path)
    if (error) throw error
    await admin.from('identity_profiles').update({ portrait_path: path, portrait_status: 'ready', portrait_source: 'live_photo_unprocessed', updated_at: new Date().toISOString() }).eq('id', profile.id)
  } catch (error) {
    await admin.from('identity_profiles').update({ portrait_status: 'failed' }).eq('id', session.identity_profile_id)
    console.error('[nordvik-identity] interim portrait', error)
  }
}

async function makePortrait(profileId: string, livePhoto: Uint8Array, p: VerificationProvider) {
  // A separate display asset from the original photo; failure never affects the verification.
  try {
    await admin.from('identity_profiles').update({ portrait_status: 'pending' }).eq('id', profileId)
    const portrait = await p.portrait!(livePhoto)
    if (!portrait) throw new Error('no portrait')
    const path = `portraits/${profileId}.png`
    await admin.storage.from(BUCKET).upload(path, portrait, { contentType: 'image/png', upsert: true })
    await admin.from('identity_profiles').update({ portrait_path: path, portrait_status: 'ready', portrait_source: 'provider_processed' }).eq('id', profileId)
  } catch {
    await admin.from('identity_profiles').update({ portrait_status: 'failed' }).eq('id', profileId)
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    return await route(request)
  } catch (error) {
    if (error instanceof HttpError) return reply(error.status, { error: error.message })
    console.error('[nordvik-identity]', error)
    return reply(500, { error: 'NORDVIK Identity had a problem. Try again.' })
  }
})
