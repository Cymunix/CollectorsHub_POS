import { supabase } from './supabaseClient'

// Collector scanning (supabase/collection_scanning.sql): Express Scan and
// Collection Drop-Off jobs. Scans are saved as draft entries on a job and only
// reach the collector's collection at Finalise Import. Never touches store stock.

// Where collectors approve requests (signed in to their own account).
export const COLLECTOR_APPROVAL_URL = 'https://collectorshub.ca/collection-scanning'
export const approvalLink = (authorisationId) => `${COLLECTOR_APPROVAL_URL}?request=${encodeURIComponent(authorisationId)}`

export const JOB_STATUS = {
  pending_authorisation: 'Pending Authorisation',
  awaiting_intake: 'Awaiting Intake',
  received: 'Received',
  scanning: 'Scanning',
  paused: 'Paused',
  needs_review: 'Needs Review',
  ready_to_finalise: 'Ready to Finalise',
  importing: 'Importing',
  ready_for_collection: 'Ready for Collection',
  completed: 'Completed',
  cancelled: 'Cancelled',
}
export const CUSTODY_STATUS = { not_received: 'Not received', in_store: 'In store', partially_returned: 'Partly returned', returned: 'Returned', not_applicable: '—' }

async function call(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    if (/could not find the function|does not exist/i.test(error.message || '')) throw new Error('Collector scanning is not installed in Supabase yet (run supabase/collection_scanning.sql).')
    throw error
  }
  return data
}

export const createJob = (storeId, locationId, collectorUserId, kind, details = {}) => call('cs_create_job', { p_store_id: storeId, p_location_id: locationId || null, p_collector_user_id: collectorUserId, p_kind: kind, p_details: details })
export const requestAuthorisation = (jobId) => call('cs_request_authorisation', { p_job_id: jobId })
export const listJobs = (storeId, { kind = 'dropoff', filter = 'active', search = '' } = {}) => call('cs_jobs', { p_store_id: storeId, p_kind: kind, p_filter: filter, p_search: search })
export const loadJob = (jobId) => call('cs_job', { p_job_id: jobId })
export const loadJobItems = (jobId, { status = null, containerId = null, limit = 200, offset = 0 } = {}) => call('cs_job_items', { p_job_id: jobId, p_status: status, p_container_id: containerId, p_limit: limit, p_offset: offset })
export const addContainer = (jobId, { kind = 'box', description = '', conditionNotes = '', estimatedItems = null } = {}) => call('cs_add_container', { p_job_id: jobId, p_kind: kind, p_description: description, p_condition_notes: conditionNotes, p_estimated_items: estimatedItems })
export const recordReceipt = (jobId, acknowledgedBy) => call('cs_record_receipt', { p_job_id: jobId, p_acknowledged_by: acknowledgedBy })
export const updateItem = (itemId, patch) => call('cs_update_item', { p_item_id: itemId, p_patch: patch })
export const setJobStatus = (jobId, status) => call('cs_set_status', { p_job_id: jobId, p_status: status })
export const finaliseImport = (jobId, idempotencyKey, excludeUnresolved = false) => call('cs_finalise_import', { p_job_id: jobId, p_idempotency_key: idempotencyKey, p_exclude_unresolved: excludeUnresolved })
export const recordReturn = (jobId, containerIds, recipientName, discrepancies = '') => call('cs_record_return', { p_job_id: jobId, p_container_ids: containerIds, p_recipient_name: recipientName, p_discrepancies: discrepancies })
export const cancelJob = (jobId, reason) => call('cs_cancel_job', { p_job_id: jobId, p_reason: reason })

// A scanned card (from the shared scanner screen) saved as a draft entry.
// The card's own id is the idempotency key, so a retry never adds it twice.
export const saveScannedCard = (jobId, containerId, card) => call('cs_save_item', {
  p_job_id: jobId,
  p_container_id: containerId || null,
  p_client_key: card.id,
  p_catalog_item_id: card.item?.item_id || null,
  p_name: card.item?.name || card.result?.subject || 'Unidentified card',
  p_category: card.category || null,
  p_condition: card.condition || null,
  p_quantity: Number(card.quantity) || 1,
  p_identification: { subject: card.result?.subject || null, number: card.result?.id_number || null, year: card.result?.release_year || null, candidates: (card.candidates || []).slice(0, 3).map((candidate) => ({ item_id: candidate.item?.item_id, score: candidate.score })) },
  p_image_ref: card.frontImage?.path || card.frontImage?.url || null,
})

// Before Add to Collection / Finalise Import: what will be imported, what still
// needs review, intentional duplicates, and whether the authorisation is valid.
export const importPreview = (jobId) => call('cs_import_preview', { p_job_id: jobId })

// Optional drop-off photos (private, store staff only). Images are data URLs held in memory.
export const INTAKE_PHOTO_BUCKET = 'collection-intake-photos'
export async function uploadIntakePhotos(storeId, jobId, dataUrls = []) {
  const paths = []
  for (const dataUrl of dataUrls) {
    const blob = await (await fetch(dataUrl)).blob()
    const path = `${storeId}/${jobId}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`
    const { error } = await supabase.storage.from(INTAKE_PHOTO_BUCKET).upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false })
    if (error) throw new Error(`A photo could not be uploaded: ${error.message}`)
    paths.push(path)
  }
  if (paths.length) await call('cs_add_photos', { p_job_id: jobId, p_paths: paths })
  return paths
}
export async function intakePhotoUrls(paths = []) {
  if (!paths.length) return []
  const { data, error } = await supabase.storage.from(INTAKE_PHOTO_BUCKET).createSignedUrls(paths, 300)
  if (error) return []
  return (data || []).map((row) => row.signedUrl).filter(Boolean)
}

// A membership QR from a USB scanner types into the search box: accept a plain
// username / membership ID, or a profile link containing one.
export function memberQueryFrom(input) {
  const text = String(input || '').trim()
  if (!/^https?:\/\//i.test(text)) return text.replace(/^@/, '')
  try {
    const url = new URL(text)
    const param = url.searchParams.get('member') || url.searchParams.get('username') || url.searchParams.get('u')
    if (param) return param.replace(/^@/, '')
    const last = url.pathname.split('/').filter(Boolean).pop() || ''
    return decodeURIComponent(last).replace(/^@/, '')
  } catch {
    return text
  }
}
