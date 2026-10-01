// Local catalogue backup (a second copy of the Supabase catalogue on a local
// drive). Two parts:
//  - recordChange: every catalogue write the desktop app makes is appended to
//    a journal with the saved row (or, when Supabase refused it, the attempted
//    data and the error), and the item's own photos are downloaded.
//  - verify: the whole catalogue is compared with the backup: new/changed
//    items are pulled in, items the backup has but Supabase no longer has are
//    set aside and reported, failed writes are reported, and own-storage
//    photos are completed. The snapshot is then refreshed.
// Reads use the public (anon) REST API; nothing here writes to Supabase.

const { createHash } = require('node:crypto')
const { createReadStream, createWriteStream, existsSync } = require('node:fs')
const { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } = require('node:fs/promises')
const path = require('node:path')
const readline = require('node:readline')

const PAGE = 1000
const PHOTO_BUCKET = 'item-images'
const TAXONOMY_TABLES = ['categories', 'subcategories', 'franchises', 'subsets', 'properties', 'item_types', 'publishers']

function rowHash(row) {
  return createHash('sha1').update(JSON.stringify(row)).digest('hex')
}

function monthStamp(date = new Date()) {
  return date.toISOString().slice(0, 7)
}

class CatalogueBackup {
  constructor({ log = async () => {} } = {}) {
    this.log = log
    this.config = null // { dir, supabaseUrl, anonKey }
    this.verifying = null
  }

  configure(config) {
    this.config = config && config.dir && config.supabaseUrl && config.anonKey ? config : null
  }

  get ready() {
    return Boolean(this.config)
  }

  dir(...parts) {
    return path.join(this.config.dir, ...parts)
  }

  async get(query, attempt = 1) {
    const { supabaseUrl, anonKey } = this.config
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/${query}`, { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } })
      const body = await response.json()
      if (!Array.isArray(body)) throw new Error(JSON.stringify(body).slice(0, 200))
      return body
    } catch (error) {
      if (attempt >= 5) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000))
      return this.get(query, attempt + 1)
    }
  }

  async * pages(table, key, select = '*') {
    let last = null
    for (;;) {
      const filter = last === null ? '' : `&${key}=gt.${encodeURIComponent(last)}`
      const rows = await this.get(`${table}?select=${select}&order=${key}.asc&limit=${PAGE}${filter}`)
      if (!rows.length) return
      yield rows
      last = rows[rows.length - 1][key]
      if (rows.length < PAGE) return
    }
  }

  async allRows(table) {
    const rows = []
    for (let from = 0; ; from += PAGE) {
      const page = await this.get(`${table}?select=*&offset=${from}&limit=${PAGE}`)
      rows.push(...page)
      if (page.length < PAGE) return rows
    }
  }

  // Photos stored in our own Supabase bucket (the rest are links to public
  // card databases and are kept as links).
  ownPhotoPath(imagePath) {
    const text = String(imagePath || '')
    if (!text) return ''
    if (!/^https?:\/\//i.test(text)) return text.replace(/^\/+/, '')
    const marker = `/storage/v1/object/public/${PHOTO_BUCKET}/`
    const index = text.indexOf(marker)
    return index >= 0 && text.startsWith(this.config.supabaseUrl) ? decodeURIComponent(text.slice(index + marker.length)) : ''
  }

  async backupPhoto(imagePath) {
    const own = this.ownPhotoPath(imagePath)
    if (!own) return 'external'
    const target = this.dir('photos', ...own.split('/'))
    if (existsSync(target)) return 'present'
    const url = `${this.config.supabaseUrl}/storage/v1/object/public/${PHOTO_BUCKET}/${own.split('/').map(encodeURIComponent).join('/')}`
    const response = await fetch(url)
    if (!response.ok) return 'missing-upstream'
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, Buffer.from(await response.arrayBuffer()))
    return 'downloaded'
  }

  async journal(entry) {
    await mkdir(this.dir('journal'), { recursive: true })
    await appendFile(this.dir('journal', `${monthStamp()}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8')
  }

  // Write-through for one desktop catalogue write. Never throws: a backup
  // problem must not break the save itself.
  async recordChange({ action, itemIds = [], ok = true, error = '', payload = null } = {}) {
    if (!this.ready) return { ok: false, reason: 'not-configured' }
    try {
      const ids = [...new Set(itemIds.filter(Boolean))]
      if (!ok || action === 'delete' || !ids.length) {
        await this.journal({ action, ok, error, itemIds: ids, payload })
        return { ok: true }
      }
      const rows = []
      const images = []
      for (let index = 0; index < ids.length; index += 100) {
        const chunk = ids.slice(index, index + 100).join(',')
        rows.push(...await this.get(`items?select=*&item_id=in.(${chunk})`))
        images.push(...await this.get(`item_images?select=*&item_id=in.(${chunk})`))
      }
      for (const row of rows) {
        await this.journal({ action, ok: true, itemId: row.item_id, row, images: images.filter((image) => image.item_id === row.item_id) })
      }
      const missing = ids.filter((id) => !rows.some((row) => row.item_id === id))
      if (missing.length) await this.journal({ action, ok: false, error: 'Saved, but the item could not be read back from Supabase.', itemIds: missing, payload })
      for (const image of images) await this.backupPhoto(image.image_path).catch(() => null)
      return { ok: true }
    } catch (backupError) {
      await this.log({ event: 'catalogue-backup-error', action, message: backupError.message })
      return { ok: false, reason: backupError.message }
    }
  }

  async lastVerify() {
    try { return JSON.parse(await readFile(this.dir('last-verify.json'), 'utf8')) } catch { return null }
  }

  // The backup's view of the catalogue: snapshot plus journal entries since.
  // Only a fingerprint per item is held in memory (the catalogue is large);
  // full rows are re-read later for the few items that need them.
  async backupState(since) {
    const state = new Map()
    if (existsSync(this.dir('items.jsonl'))) {
      const lines = readline.createInterface({ input: createReadStream(this.dir('items.jsonl'), 'utf8'), crlfDelay: Infinity })
      for await (const line of lines) {
        if (!line.trim()) continue
        const row = JSON.parse(line)
        state.set(row.item_id, { hash: rowHash(row) })
      }
    }
    const failed = []
    const deleted = new Set()
    let files = []
    try { files = (await readdir(this.dir('journal'))).filter((name) => name.endsWith('.jsonl')).sort() } catch {}
    for (const name of files) {
      const lines = readline.createInterface({ input: createReadStream(this.dir('journal', name), 'utf8'), crlfDelay: Infinity })
      for await (const line of lines) {
        if (!line.trim()) continue
        const entry = JSON.parse(line)
        if (since && entry.at <= since) continue
        if (!entry.ok) failed.push(entry)
        else if (entry.action === 'delete') entry.itemIds.forEach((id) => { deleted.add(id); state.delete(id) })
        // Journal rows are few, so they are kept whole.
        else if (entry.row) state.set(entry.row.item_id, { hash: rowHash(entry.row), row: entry.row })
      }
    }
    return { state, failed, deleted }
  }

  // Full rows for the given ids, from the snapshot (journal rows are already whole).
  async snapshotRows(ids) {
    const wanted = new Set(ids)
    const rows = new Map()
    if (!wanted.size || !existsSync(this.dir('items.jsonl'))) return rows
    const lines = readline.createInterface({ input: createReadStream(this.dir('items.jsonl'), 'utf8'), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      const row = JSON.parse(line)
      if (wanted.has(row.item_id)) rows.set(row.item_id, row)
    }
    return rows
  }

  // Full comparison with Supabase; refreshes the snapshot. onProgress({stage, done, total}).
  async verify({ onProgress = () => {} } = {}) {
    if (!this.ready) throw new Error('Choose a catalogue backup folder first.')
    if (this.verifying) return this.verifying
    this.verifying = (async () => {
      const started = new Date()
      await mkdir(this.dir(), { recursive: true })
      const previous = await this.lastVerify()
      onProgress({ stage: 'Reading the backup' })
      const { state, failed, deleted } = await this.backupState(previous?.finishedAt || '')
      const hadSnapshot = state.size > 0

      onProgress({ stage: 'Comparing items with Supabase', done: 0 })
      const next = createWriteStream(this.dir('items.next.jsonl'), 'utf8')
      let total = 0
      let added = 0
      let changed = 0
      const addedSamples = []
      const changedSamples = []
      for await (const rows of this.pages('items', 'item_id')) {
        for (const row of rows) {
          const known = state.get(row.item_id)
          if (!known) { added += 1; if (addedSamples.length < 50) addedSamples.push({ item_id: row.item_id, name: row.name || row.subject }) }
          else if (known.hash !== rowHash(row)) { changed += 1; if (changedSamples.length < 50) changedSamples.push({ item_id: row.item_id, name: row.name || row.subject }) }
          state.delete(row.item_id)
          if (!next.write(JSON.stringify(row) + '\n')) await new Promise((resolve) => next.once('drain', resolve))
        }
        total += rows.length
        onProgress({ stage: 'Comparing items with Supabase', done: total })
      }
      await new Promise((resolve) => next.end(resolve))

      // In the backup but no longer in Supabase (and not deleted from this app).
      const missingIds = [...state.keys()].filter((id) => !deleted.has(id))
      const fromSnapshot = await this.snapshotRows(missingIds.filter((id) => !state.get(id).row))
      const missing = missingIds.map((id) => ({ row: state.get(id).row || fromSnapshot.get(id) || { item_id: id } }))
      if (missing.length) {
        await appendFile(this.dir('missing-from-supabase.jsonl'), missing.map((entry) => JSON.stringify({ seenMissingAt: started.toISOString(), row: entry.row })).join('\n') + '\n', 'utf8')
      }

      onProgress({ stage: 'Backing up photo records' })
      const images = createWriteStream(this.dir('item_images.next.jsonl'), 'utf8')
      const photoStats = { own: 0, downloaded: 0, present: 0, missingUpstream: [] }
      const ownPhotos = []
      for await (const rows of this.pages('item_images', 'item_image_id')) {
        for (const row of rows) {
          if (!images.write(JSON.stringify(row) + '\n')) await new Promise((resolve) => images.once('drain', resolve))
          if (this.ownPhotoPath(row.image_path)) ownPhotos.push(row)
        }
      }
      await new Promise((resolve) => images.end(resolve))
      for (const [index, row] of ownPhotos.entries()) {
        photoStats.own += 1
        const result = await this.backupPhoto(row.image_path).catch(() => 'error')
        if (result === 'downloaded') photoStats.downloaded += 1
        else if (result === 'present') photoStats.present += 1
        else if (photoStats.missingUpstream.length < 100) photoStats.missingUpstream.push({ item_id: row.item_id, image_path: row.image_path, result })
        if (index % 25 === 0) onProgress({ stage: 'Backing up photos', done: index + 1, total: ownPhotos.length })
      }

      onProgress({ stage: 'Backing up taxonomy' })
      await mkdir(this.dir('taxonomy'), { recursive: true })
      for (const table of TAXONOMY_TABLES) await writeFile(this.dir('taxonomy', `${table}.json`), JSON.stringify(await this.allRows(table), null, 2))
      const properties = await this.allRows('item_properties')
      await writeFile(this.dir('item_properties.jsonl'), properties.map((row) => JSON.stringify(row)).join('\n') + '\n')

      // Swap in the refreshed snapshot (keeping the previous one).
      if (existsSync(this.dir('items.jsonl'))) await rename(this.dir('items.jsonl'), this.dir('items.previous.jsonl')).catch(async () => { await rm(this.dir('items.previous.jsonl'), { force: true }); await rename(this.dir('items.jsonl'), this.dir('items.previous.jsonl')) })
      await rename(this.dir('items.next.jsonl'), this.dir('items.jsonl'))
      await rm(this.dir('item_images.jsonl'), { force: true })
      await rename(this.dir('item_images.next.jsonl'), this.dir('item_images.jsonl'))

      const report = {
        startedAt: started.toISOString(),
        finishedAt: new Date().toISOString(),
        supabaseItems: total,
        firstSnapshot: !hadSnapshot,
        newInSupabase: hadSnapshot ? added : 0,
        changedInSupabase: changed,
        missingFromSupabase: missing.length,
        missingSamples: missing.slice(0, 50).map((entry) => ({ item_id: entry.row.item_id, name: entry.row.name || entry.row.subject })),
        failedWrites: failed.length,
        failedSamples: failed.slice(0, 50).map((entry) => ({ at: entry.at, action: entry.action, error: entry.error, itemIds: entry.itemIds || [entry.itemId] })),
        photos: { own: photoStats.own, downloaded: photoStats.downloaded, alreadyBackedUp: photoStats.present, notFoundInSupabase: photoStats.missingUpstream.length, notFoundSamples: photoStats.missingUpstream },
        newSamples: hadSnapshot ? addedSamples : [],
        changedSamples,
      }
      await mkdir(this.dir('verify-reports'), { recursive: true })
      await writeFile(this.dir('verify-reports', `${report.finishedAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2))
      await writeFile(this.dir('last-verify.json'), JSON.stringify(report, null, 2))
      await this.log({ event: 'catalogue-backup-verified', ...report, missingSamples: undefined, failedSamples: undefined, newSamples: undefined, changedSamples: undefined })
      return report
    })()
    try {
      return await this.verifying
    } finally {
      this.verifying = null
    }
  }
}

module.exports = { CatalogueBackup }
