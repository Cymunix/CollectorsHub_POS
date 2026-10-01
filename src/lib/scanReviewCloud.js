import { supabase } from './supabaseClient'

// Cloud review queue (see supabase/scan_review_queue.sql). The scanning PC
// uploads each analysed card so its review can be done from any machine
// signed in as a platform admin. Local drafts stay the working copy on each
// machine; this module only moves them to and from Supabase.

const TABLE = 'scan_review_drafts'
const BUCKET = 'scan-review'
const SIGNED_URL_SECONDS = 6 * 60 * 60
const IMAGE_SIDES = ['frontImage', 'backImage']
// Image fields that only make sense on the machine that has the files.
const LOCAL_IMAGE_FIELDS = ['path', 'url', 'rawPath', 'rawUrl', 'displayPath', 'displayUrl', 'urlExpires', 'cloudSource']

// null = not checked yet, true/false once known.
let available = null

// Whether the queue table exists and this sign-in may use it.
export async function cloudReviewAvailable({ refresh = false } = {}) {
  if (available !== null && !refresh) return available
  const { error } = await supabase.from(TABLE).select('id', { head: true, count: 'exact' }).limit(1)
  available = !error
  return available
}

// What the cloud row stores for an image: where it is in the bucket plus the
// scan facts the review screen shows, never local file paths.
function cloudImage(image) {
  if (!image) return null
  const result = { ...image }
  LOCAL_IMAGE_FIELDS.forEach((field) => delete result[field])
  return result
}

function cloudPayload(draft) {
  const data = { ...draft }
  delete data.cloud
  IMAGE_SIDES.forEach((side) => { data[side] = cloudImage(draft[side]) })
  return data
}

// Uploads any side whose local file has not been uploaded yet (or changed,
// e.g. rotated) and returns the draft's images with their cloudPath set.
async function uploadImages(draft, readImage) {
  const images = {}
  for (const side of IMAGE_SIDES) {
    const image = draft[side]
    if (!image) { images[side] = null; continue }
    if (image.path && image.cloudSource !== image.path) {
      const file = await readImage(image)
      const cloudPath = `${draft.id}/${side === 'frontImage' ? 'front' : 'back'}-${Date.now()}.${file.ext || 'jpg'}`
      const { error } = await supabase.storage.from(BUCKET).upload(cloudPath, new Blob([file.data], { type: file.mime || 'image/jpeg' }), { contentType: file.mime || 'image/jpeg', upsert: true })
      if (error) throw error
      images[side] = { ...image, cloudPath, cloudSource: image.path }
    } else {
      images[side] = image
    }
  }
  return images
}

// Saves one draft to the cloud. Uses the row version so an older copy can't
// overwrite a newer change made on another machine: on a conflict the caller
// takes the cloud copy instead. Returns { version, updatedAt, images } or
// { conflict: true }.
export async function pushReviewDraft(draft, { readImage }) {
  const images = await uploadImages(draft, readImage)
  const merged = { ...draft, ...images }
  const row = {
    status: merged.status || '',
    data: cloudPayload(merged),
    front_image_path: images.frontImage?.cloudPath || null,
    back_image_path: images.backImage?.cloudPath || null,
  }
  const version = draft.cloud?.version
  if (version) {
    const { data, error } = await supabase.from(TABLE).update({ ...row, version: version + 1 }).eq('id', draft.id).eq('version', version).select('version, updated_at')
    if (error) throw error
    if (!data?.length) return { conflict: true, images }
    return { version: data[0].version, updatedAt: data[0].updated_at, images }
  }
  const { data, error } = await supabase.from(TABLE).insert({ id: draft.id, ...row, version: 1 }).select('version, updated_at')
  if (error) {
    if (error.code === '23505') return { conflict: true, images }
    throw error
  }
  return { version: data[0].version, updatedAt: data[0].updated_at, images }
}

// Rows changed since a timestamp (ISO), oldest first.
export async function pullReviewDrafts(since = '') {
  const rows = []
  for (let from = 0; ; from += 500) {
    let query = supabase.from(TABLE).select('id, status, data, front_image_path, back_image_path, version, updated_at').order('updated_at').range(from, from + 499)
    if (since) query = query.gt('updated_at', since)
    const { data, error } = await query
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < 500) break
  }
  return rows
}

// Every draft id in the cloud (to notice drafts deleted on another machine).
export async function cloudReviewDraftIds() {
  const ids = new Set()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(TABLE).select('id').order('id').range(from, from + 999)
    if (error) throw error
    ;(data || []).forEach((row) => ids.add(row.id))
    if (!data || data.length < 1000) break
  }
  return ids
}

// A reviewed card's uploaded scans are no longer needed (its photos are in
// the catalogue by then), so the bucket only holds cards awaiting review.
export async function removeCloudImages(draft) {
  const paths = IMAGE_SIDES.map((side) => draft[side]?.cloudPath).filter(Boolean)
  if (!paths.length) return
  const { error } = await supabase.storage.from(BUCKET).remove(paths)
  if (error) throw error
}

export async function deleteCloudReviewDraft(draft) {
  const paths = IMAGE_SIDES.map((side) => draft[side]?.cloudPath).filter(Boolean)
  const { error } = await supabase.from(TABLE).delete().eq('id', draft.id)
  if (error) throw error
  if (paths.length) await supabase.storage.from(BUCKET).remove(paths).catch(() => {})
}

// Merges a cloud row into the local copy of the draft (or builds it). The
// cloud wins for everything except images that this machine has locally:
// those keep their local file (matched by cloudPath, so a front/back swap made
// elsewhere is followed).
export function mergeCloudRow(local, row) {
  const remote = row.data || {}
  const localImages = IMAGE_SIDES.map((side) => local?.[side]).filter(Boolean)
  const merged = { ...remote, id: row.id }
  for (const side of IMAGE_SIDES) {
    const cloudPath = side === 'frontImage' ? row.front_image_path : row.back_image_path
    if (!cloudPath) { merged[side] = remote[side] ? { ...remote[side] } : null; continue }
    const mine = localImages.find((image) => image.cloudPath === cloudPath)
    merged[side] = mine ? { ...mine } : { ...(remote[side] || {}), cloudPath, remote: true }
  }
  merged.cloud = { version: row.version, updatedAt: row.updated_at }
  return merged
}

// Fills in viewable (signed) URLs for images that only exist in the cloud.
export async function signRemoteImages(drafts) {
  const soon = Date.now() + 30 * 60 * 1000
  const wanted = []
  for (const draft of drafts) {
    for (const side of IMAGE_SIDES) {
      const image = draft[side]
      if (image?.cloudPath && !image.path && !(image.url && image.urlExpires > soon)) wanted.push(image.cloudPath)
    }
  }
  if (!wanted.length) return drafts
  const urls = new Map()
  for (let index = 0; index < wanted.length; index += 200) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(wanted.slice(index, index + 200), SIGNED_URL_SECONDS)
    if (error) throw error
    ;(data || []).forEach((entry) => { if (entry.signedUrl) urls.set(entry.path, entry.signedUrl) })
  }
  const expires = Date.now() + SIGNED_URL_SECONDS * 1000
  return drafts.map((draft) => {
    let changed = false
    const next = { ...draft }
    for (const side of IMAGE_SIDES) {
      const image = draft[side]
      if (image?.cloudPath && !image.path && urls.has(image.cloudPath)) {
        next[side] = { ...image, url: urls.get(image.cloudPath), urlExpires: expires }
        changed = true
      }
    }
    return changed ? next : draft
  })
}

// The image as a Blob from the cloud (approving on a machine without the
// original scan files).
export async function downloadCloudImage(image) {
  const { data, error } = await supabase.storage.from(BUCKET).download(image.cloudPath)
  if (error) throw error
  const ext = (image.cloudPath.split('.').pop() || 'jpg').toLowerCase()
  return { blob: data, ext }
}
