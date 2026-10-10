import { supabase } from '../lib/supabaseClient'

// NORDVIK Identity client for NORDVIK apps (the v1 API in
// supabase/functions/nordvik-identity). Apps only see verification status and
// session progress; ID images and photos go straight to NORDVIK Identity's
// private storage through short-lived upload authorisations and are never
// written to local files. Nothing here can mark anyone verified.

export const IDENTITY_FUNCTION = 'bright-action' // the nordvik-identity Edge Function, deployed as bright-action
export const NOTICE_VERSION = 'nordvik-identity-consent-2026-10-v3' // must match the API

export const DOCUMENT_TYPES = [
  { id: 'drivers_licence', label: "Driver's Licence", hasBack: true },
  { id: 'passport', label: 'Passport', hasBack: false },
  { id: 'provincial_id', label: 'Provincial/State Photo ID', hasBack: true },
]
export const documentLabel = (id) => DOCUMENT_TYPES.find((type) => type.id === id)?.label || 'ID'

export const IDENTITY_STATUS = {
  unverified: { label: 'Identity Unverified', tone: 'amber' },
  pending: { label: 'Verification pending', tone: 'amber' },
  processing: { label: 'Verification processing', tone: 'amber' },
  manual_review: { label: 'Waiting for review', tone: 'amber' },
  verified: { label: 'Identity Verified', tone: 'green' },
  demo_verified: { label: 'Demo Verified', tone: 'demo' }, // development/testing only, never a real identity check
  failed: { label: 'Verification failed', tone: 'red' },
  expired: { label: 'Verification expired', tone: 'amber' },
  revoked: { label: 'Verification revoked', tone: 'red' },
}
export const DISCREPANCY_TEXT = {
  name_differs_from_account: "The name on the ID differs from the customer's account",
  date_of_birth_in_future: 'The date of birth is in the future',
  under_18: 'The customer is under 18',
}

export class IdentityUnavailableError extends Error {}

async function call(path, { method = 'POST', body } = {}) {
  let response
  try {
    response = await supabase.functions.invoke(`${IDENTITY_FUNCTION}/v1/identity/${path}`, { method, body })
  } catch (error) {
    throw new IdentityUnavailableError("NORDVIK Identity isn't reachable. Check the connection, or the nordvik-identity Edge Function isn't deployed yet.")
  }
  const { data, error } = response
  if (error || data?.error) {
    let message = data?.error || error?.message || 'NORDVIK Identity had a problem.'
    let status = error?.context?.status
    try { const details = await error?.context?.json?.(); if (details?.error) message = details.error } catch {}
    if (status === 404 && /requested function was not found/i.test(message)) throw new IdentityUnavailableError("NORDVIK Identity isn't deployed yet (the nordvik-identity Edge Function).")
    if (/failed to send a request/i.test(message)) throw new IdentityUnavailableError("NORDVIK Identity isn't reachable. Check the connection, or the nordvik-identity Edge Function isn't deployed yet.")
    const failure = new Error(message)
    failure.status = status
    throw failure
  }
  return data
}

// ── Sessions ────────────────────────────────────────────────────────────────
export const startVerification = (storeId, accountId) => call('verifications', { body: { storeId, accountId } })
export const readSession = (sessionId) => call(`verifications/${sessionId}`, { method: 'GET' })
export const cancelSession = (sessionId, reason = '') => call(`verifications/${sessionId}/cancel`, { body: { reason } })
// consentType: identity_check | biometric | portrait_display; status: given | declined.
// The customer types their own name to agree (consent_method pos_customer_signature).
export const recordConsent = (sessionId, consentType, status, signedName = '') =>
  call(`verifications/${sessionId}/consent`, { body: { consentType, status, signedName, noticeVersion: NOTICE_VERSION } })
export const recordDocument = (sessionId, documentType, details) => call(`verifications/${sessionId}/document`, { body: { documentType, details } })
export const requestMobileCapture = (sessionId) => call(`verifications/${sessionId}/mobile-capture`)
export const submitVerification = (sessionId) => call(`verifications/${sessionId}/submit`)

// Uploads an image (a data URL held in memory) as evidence: kind is
// document_front, document_back or live_photo.
export async function uploadEvidence(sessionId, kind, dataUrl) {
  const blob = await (await fetch(dataUrl)).blob()
  if (blob.size > 8 * 1024 * 1024) throw new Error('The image is too large. Retake it.')
  const jpeg = blob.type === 'image/jpeg' ? blob : await toJpeg(dataUrl)
  const upload = await call(`verifications/${sessionId}/${kind === 'live_photo' ? 'photo' : 'documents'}`, { body: { kind } })
  const { error } = await supabase.storage.from(upload.bucket).uploadToSignedUrl(upload.path, upload.token, jpeg, { contentType: 'image/jpeg', upsert: false })
  if (error) throw new Error(`The image could not be uploaded: ${error.message}`)
  const digest = await crypto.subtle.digest('SHA-256', await jpeg.arrayBuffer())
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return call(`verifications/${sessionId}/uploaded`, { body: { kind, sha256 } })
}
async function toJpeg(dataUrl) {
  const image = new Image()
  await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = dataUrl })
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  canvas.getContext('2d').drawImage(image, 0, 0)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
}

// ── Status (any connected store where the person is a customer) ─────────────
export async function getVerificationStatus(storeId, accountId) {
  const data = await call(`profiles/${accountId}/verification-status?storeId=${encodeURIComponent(storeId)}`, { method: 'GET' })
  return {
    status: data?.status || 'unverified',
    demo: data?.demo === true,
    buybackAllowed: data?.buybackAllowed === true,
    verifiedAt: data?.verifiedAt || null,
    expiresAt: data?.expiresAt || null,
    reverificationRequired: Boolean(data?.reverificationRequired),
    method: data?.method || null,
    openSession: data?.openSession || null,
    portraitAvailable: Boolean(data?.portraitAvailable),
    portraitProcessed: Boolean(data?.portraitProcessed),
    legalName: data?.legalName || '',
    dateOfBirth: data?.dateOfBirth || '',
  }
}
// The NORDVIK Identity photo (never the CollectorsHub profile picture). purpose:
// checkout_identification or buyback_identification; every view is logged.
// Fetched without caching and returned as an in-memory object URL: revoke it
// (URL.revokeObjectURL) when the customer is deselected.
export async function loadIdentityPhoto(storeId, accountId, purpose = 'checkout_identification') {
  const data = await call(`profiles/${accountId}/portrait?storeId=${encodeURIComponent(storeId)}&purpose=${encodeURIComponent(purpose)}`, { method: 'GET' })
  if (!data?.url) throw new Error('No identity photo.')
  const response = await fetch(data.url, { cache: 'no-store', referrerPolicy: 'no-referrer' })
  if (!response.ok) throw new Error('The identity photo could not be loaded.')
  return { url: URL.createObjectURL(await response.blob()), processed: data.processed === true }
}

// ── Reviewers ───────────────────────────────────────────────────────────────
export const listReviews = () => call('reviews', { method: 'GET' })
export const reviewEvidence = (sessionId) => call(`reviews/${sessionId}/evidence`, { method: 'GET' })
export const decideReview = (sessionId, decision, note = '') => call(`reviews/${sessionId}/decision`, { body: { decision, note } })
export const revokeVerification = (accountId, reason) => call(`profiles/${accountId}/revoke`, { body: { reason } })

// ── Capture quality (guidance only; NORDVIK Identity decides) ───────────────
export function imageQuality(source) {
  const width = 160
  const height = Math.max(1, Math.round(width * (source.videoHeight || source.height) / (source.videoWidth || source.width)))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(source, 0, 0, width, height)
  const { data } = context.getImageData(0, 0, width, height)
  const gray = new Float32Array(width * height)
  let total = 0
  for (let index = 0; index < gray.length; index += 1) {
    gray[index] = 0.299 * data[index * 4] + 0.587 * data[index * 4 + 1] + 0.114 * data[index * 4 + 2]
    total += gray[index]
  }
  let sum = 0
  let sumSquares = 0
  let count = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x
      const value = 4 * gray[index] - gray[index - 1] - gray[index + 1] - gray[index - width] - gray[index + width]
      sum += value
      sumSquares += value * value
      count += 1
    }
  }
  return { brightness: total / gray.length, sharpness: sumSquares / count - (sum / count) ** 2 }
}
export async function countFaces(source) {
  if (!('FaceDetector' in window)) return null // not available here: NORDVIK Identity checks faces
  try { return (await new window.FaceDetector({ fastMode: true, maxDetectedFaces: 3 }).detect(source)).length } catch { return null }
}
export function qualityProblem({ brightness, sharpness }, faces, { face = false } = {}) {
  if (brightness < 60) return 'Too dark. Add light and try again.'
  if (brightness > 225) return 'Too bright or glare. Reduce the light and try again.'
  if (sharpness < 40) return 'Blurry. Hold still and try again.'
  if (face && faces === 0) return 'No face found. Centre the face in the guide.'
  if (face && faces > 1) return 'More than one face. Only the customer should be in the photo.'
  return ''
}
