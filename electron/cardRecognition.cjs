// Local AI card recognition. Runs in the Electron main process so the renderer
// never talks to Ollama or touches scan files directly.
//
// CardRecognitionProvider contract (any future provider implements the same):
//   id, label
//   getStatus()                                  -> { state, model, message }
//       state: 'ready' | 'unavailable' | 'model-missing' | 'error'
//   installModel(onProgress, signal)             -> resolves when installed
//   recognizeCard({ frontPath, backPath }, signal) -> { result, model, durationMs }
// Errors are CardRecognitionError with a stable `code` the UI can act on.

const { nativeImage } = require('electron')
const { readFile } = require('node:fs/promises')
const { rotateNativeImage } = require('./imageRotate.cjs')

const OLLAMA_URL = 'http://127.0.0.1:11434'
const QWEN_MODEL = 'qwen3-vl:8b-instruct'
// Long edge sent to the model: enough to read card numbers, copyright lines
// and serial stamps without sending the full 600 DPI scan. Measured on
// FastFoto scans: 1600 gives the same results as 2000 about 30% faster
// (~7 s vs ~10 s per card); 1280 started misreading card numbers.
const AI_IMAGE_LONG_EDGE = 1600
// The front/back check only needs to see the layout.
const SIDE_CHECK_EDGE = 640
const UPRIGHT_CHECK_EDGE = 512
const STATUS_TIMEOUT_MS = 4000
const RECOGNITION_TIMEOUT_MS = 5 * 60 * 1000

class CardRecognitionError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.code = code
    this.cause = cause
  }
}

// Structured output the model must return (Ollama `format` JSON Schema).
const nullable = (type) => ({ type: [type, 'null'] })
const CARD_SCHEMA = {
  type: 'object',
  properties: {
    category: nullable('string'),
    subcategory: nullable('string'),
    franchise: nullable('string'),
    subfranchise: nullable('string'),
    property: nullable('string'),
    item_type: nullable('string'),
    collection: nullable('string'),
    subject: nullable('string'),
    subjects: { type: 'array', items: { type: 'string' } },
    id_number: nullable('string'),
    publisher_manufacturer: nullable('string'),
    description: nullable('string'),
    release_year: nullable('integer'),
    barcodes: nullable('string'),
    card_type: nullable('string'),
    team: nullable('string'),
    rookie: nullable('boolean'),
    parallel: nullable('string'),
    variation: nullable('string'),
    serial_numbering: nullable('string'),
    autograph: nullable('boolean'),
    autograph_type: nullable('string'),
    memorabilia_relic: nullable('boolean'),
    finish: nullable('string'),
    uncertain_fields: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'category', 'subcategory', 'franchise', 'subfranchise', 'property', 'item_type',
    'collection', 'subject', 'subjects', 'id_number', 'publisher_manufacturer', 'description',
    'release_year', 'barcodes', 'card_type', 'team', 'rookie', 'parallel', 'variation',
    'serial_numbering', 'autograph', 'autograph_type', 'memorabilia_relic', 'finish',
    'uncertain_fields',
  ],
  additionalProperties: false,
}

const SYSTEM_PROMPT = `You are identifying ONE collectable trading card for the CollectorsHub catalogue.

The supplied images are the FRONT and BACK of the SAME card.

Extract factual catalogue information only.
Do not describe the photographs unless needed to identify the card.
Do not invent information.
If a field cannot be determined reliably, return null.
Use uncertain_fields for fields where there is meaningful uncertainty (list the field names).
Follow CollectorsHub taxonomy semantics exactly.

CATEGORY
For sports trading cards use: Sports Cards

SUBCATEGORY
This is the sport. Use specific names such as: American Football, Baseball, Basketball, Hockey, Soccer, Wrestling.
Do not return 'Football' for American football.

FRANCHISE
This is the league or major organisation, such as: NFL, NBA, MLB, NHL, CFL, NCAA.

SUBFRANCHISE
This is the product line, such as: Panini Contenders, Panini Prizm, Panini Select, Upper Deck Series 1.

PROPERTY
This is the specific release/set, such as: 2024 Panini Contenders Football.

ITEM TYPE
The kind of item. For any trading or sports card this is: Card.
It is NOT the card type (Base/Insert) and NOT the collection.

COLLECTION
This is a collection/subset within the release, such as: Season Ticket, Rookie Ticket, Winning Ticket.
Collection is NOT the card parallel.

SUBJECT / SUBJECTS
subjects: EVERY player/person featured on the card, as a list. Dual, triple and quad cards
(two or more players pictured or named, e.g. rookie combos, "Dual" inserts) have several; list each
one separately, in the order printed (left to right, then top to bottom). Read the names from both sides.
A single-player card has exactly one entry. Do not include coaches or people only mentioned in the bio text.
subject: the first player in subjects.

ID NUMBER
Card number printed on the card.

PUBLISHER/MANUFACTURER
Examples: Panini, Topps, Upper Deck.

DESCRIPTION
Extract the descriptive text found on the BACK of the card.
Do not generate a new biography.
Preserve the meaning of the printed card-back text.

RELEASE YEAR
The release/set year.

BARCODES
Only a UPC/EAN barcode number printed under a barcode (8 to 14 digits). Most single cards have none: return null.
Never put the card number here.

CARD TYPE
Only return a type if it is clearly supported by the card. One of: Base, Insert, Autograph, Patch, Autograph Patch.

TEAM
Team represented by the card.

ROOKIE
true only when the card is genuinely a rookie card or clearly contains recognised rookie identification
(an RC logo, a "Rookie" designation printed as part of the card design, or a rookie subset name such as Rookie Ticket).
The word "rookie" in the biography text or stats does NOT make it a rookie card; return false unless the card design itself marks it.

PARALLEL
Parallel only. Examples: Gold, Silver, Cracked Ice, Blue, Red.
Do not put names such as Season Ticket into Parallel.

VARIATION
Recognised photo/design/image variation where applicable.

SERIAL NUMBERING
Return visible numbering such as: 14/99, /99, 1/1.

AUTOGRAPH
Whether the physical card contains an autograph.

AUTOGRAPH TYPE
If identifiable: Sticker, On-card.

MEMORABILIA / RELIC
Whether the physical card contains memorabilia/material/relic.

FINISH
Only identify the finish when reasonably clear. Examples: Foil, Holofoil, Refractor-style, Matte.

Do not guess at foil/parallel/variation based solely on general colours.

Return only data matching the provided JSON schema.`

async function ollamaFetch(pathname, { method = 'GET', body, timeoutMs, signal } = {}) {
  const controller = new AbortController()
  const timer = timeoutMs ? setTimeout(() => controller.abort(new Error('timeout')), timeoutMs) : null
  const onAbort = () => controller.abort(signal.reason || new Error('cancelled'))
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    return await fetch(`${OLLAMA_URL}${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
  } catch (error) {
    if (signal?.aborted) throw new CardRecognitionError('CANCELLED', 'Analysis was cancelled.', error)
    if (controller.signal.aborted) throw new CardRecognitionError('TIMEOUT', 'Local AI took too long to respond.', error)
    throw new CardRecognitionError('OLLAMA_UNAVAILABLE', 'CollectorsHub could not connect to the local AI (Ollama).', error)
  } finally {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

function classifyOllamaError(status, text) {
  const message = String(text || '')
  if (status === 404 || /model .*not found|pull the model/i.test(message)) {
    return new CardRecognitionError('MODEL_MISSING', 'The local AI model is not installed.')
  }
  if (/out of memory|cuda|cudaMalloc|insufficient memory|requires more system memory/i.test(message)) {
    return new CardRecognitionError('OUT_OF_MEMORY', 'The computer ran out of graphics memory while analysing this card. Close other programs and retry.')
  }
  if (/context|num_ctx|too long|exceeds/i.test(message)) {
    return new CardRecognitionError('CONTEXT_TOO_LARGE', 'The card images were too large for the local AI. Retry the card.')
  }
  return new CardRecognitionError('AI_ERROR', `Local AI error: ${message || `HTTP ${status}`}`)
}

// Resizes a scan in memory to AI_IMAGE_LONG_EDGE and re-encodes it as JPEG.
// The original high-resolution file is never modified; nothing is written to
// disk, so there is no temporary file to clean up.
async function prepareAiImage(filePath, side, longEdge = AI_IMAGE_LONG_EDGE) {
  let bytes
  try {
    bytes = await readFile(filePath)
  } catch (error) {
    throw new CardRecognitionError('IMAGE_MISSING', `The ${side} scan image could not be found.`, error)
  }
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) {
    // Formats nativeImage cannot decode (e.g. TIFF): send as-is only if small.
    if (bytes.length > 12 * 1024 * 1024) throw new CardRecognitionError('IMAGE_UNSUPPORTED', `The ${side} image format is not supported for AI analysis.`)
    return bytes.toString('base64')
  }
  const { width, height } = image.getSize()
  const scale = Math.min(1, longEdge / Math.max(width, height))
  const resized = scale < 1
    ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' })
    : image
  return resized.toJPEG(92).toString('base64')
}

function normaliseResult(raw) {
  const result = {}
  Object.entries(CARD_SCHEMA.properties).forEach(([key, spec]) => {
    const value = raw?.[key]
    if (spec.type === 'array') {
      result[key] = Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : []
      return
    }
    const types = spec.type
    if (value == null || value === '') result[key] = null
    else if (types.includes('boolean')) result[key] = typeof value === 'boolean' ? value : /^(true|yes)$/i.test(String(value)) ? true : /^(false|no)$/i.test(String(value)) ? false : null
    else if (types.includes('integer')) result[key] = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : null
    else result[key] = String(value).trim() || null
  })
  // Base-set cards have no named collection; the catalogue calls it "Base".
  if (!result.collection && !/insert|autograph|patch|relic/i.test(String(result.card_type || ''))) result.collection = 'Base'
  // App-side guard: a barcode is 8-14 digits; anything else (e.g. "No. 42") is dropped.
  const barcodeDigits = String(result.barcodes || '').replace(/[\s-]/g, '')
  result.barcodes = /^\d{8,14}$/.test(barcodeDigits) ? barcodeDigits : null
  // The 8B model tends to infer "rookie" from biography text ("a rookie who
  // made four starts...") even on later-year cards, so a positive rookie
  // reading is always flagged for the reviewer to confirm.
  if (result.rookie === true && !result.uncertain_fields.includes('rookie')) result.uncertain_fields.push('rookie')
  // Multi-player cards: the catalogue stores every player in one subject,
  // joined with '/' (e.g. 'Jordan Travis/Malachi Corley').
  const players = []
  for (const name of [...(result.subjects || []), result.subject]) {
    for (const part of String(name || '').split('/')) {
      const clean = part.trim()
      if (clean && !players.some((existing) => existing.toLowerCase() === clean.toLowerCase())) players.push(clean)
    }
  }
  result.subjects = players
  result.subject = players.length ? players.join('/') : null
  return result
}

class OllamaCardRecognitionProvider {
  constructor({ model = QWEN_MODEL } = {}) {
    this.id = 'ollama'
    this.model = model
    this.label = 'Qwen3-VL 8B'
  }

  async getStatus() {
    let response
    try {
      response = await ollamaFetch('/api/tags', { timeoutMs: STATUS_TIMEOUT_MS })
    } catch (error) {
      return { state: 'unavailable', model: this.model, label: this.label, message: 'CollectorsHub could not connect to Ollama.' }
    }
    if (!response.ok) return { state: 'error', model: this.model, label: this.label, message: `Ollama responded with HTTP ${response.status}.` }
    const data = await response.json().catch(() => ({}))
    const installed = (data.models || []).some((entry) => entry.name === this.model || entry.model === this.model)
    return installed
      ? { state: 'ready', model: this.model, label: this.label, message: 'Ready' }
      : { state: 'model-missing', model: this.model, label: this.label, message: 'Local AI model required' }
  }

  // Streams Ollama's pull progress (NDJSON) as { status, completed, total, percent }.
  async installModel(onProgress, signal) {
    const response = await ollamaFetch('/api/pull', { method: 'POST', body: { model: this.model, stream: true }, signal })
    if (!response.ok || !response.body) throw classifyOllamaError(response.status, await response.text().catch(() => ''))
    const layers = new Map()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let succeeded = false
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines) {
          if (!line.trim()) continue
          let event
          try { event = JSON.parse(line) } catch { continue }
          if (event.error) throw new CardRecognitionError('MODEL_DOWNLOAD_FAILED', `Model download failed: ${event.error}`)
          if (event.digest && event.total) layers.set(event.digest, { total: event.total, completed: event.completed || 0 })
          const total = [...layers.values()].reduce((sum, layer) => sum + layer.total, 0)
          const completed = [...layers.values()].reduce((sum, layer) => sum + layer.completed, 0)
          if (event.status === 'success') succeeded = true
          onProgress?.({ status: event.status || '', completed, total, percent: total ? Math.min(100, Math.round((completed / total) * 100)) : null })
        }
      }
    } catch (error) {
      if (signal?.aborted) throw new CardRecognitionError('CANCELLED', 'Model download was cancelled.', error)
      if (error instanceof CardRecognitionError) throw error
      throw new CardRecognitionError('MODEL_DOWNLOAD_FAILED', 'The model download was interrupted. Check the internet connection and retry.', error)
    }
    if (!succeeded) throw new CardRecognitionError('MODEL_DOWNLOAD_FAILED', 'The model download did not finish. Retry to resume it.')
  }

  // Loads the model into memory ahead of a batch (a cold start adds ~20 s to
  // the first card). Best effort: failures surface on the real request.
  async warmUp() {
    try {
      await ollamaFetch('/api/generate', { method: 'POST', timeoutMs: RECOGNITION_TIMEOUT_MS, body: { model: this.model, keep_alive: '10m' } })
    } catch {}
  }

  // Which of two images is the card's back (1 or 2). A focused question on
  // small images: asked inside the full identification the model nearly
  // always kept the given order, but on its own it was right 20/20 (~2 s).
  async backSideIndex({ firstPath, secondPath }, signal) {
    const [first, second] = await Promise.all([prepareAiImage(firstPath, 'first', SIDE_CHECK_EDGE), prepareAiImage(secondPath, 'second', SIDE_CHECK_EDGE)])
    const response = await ollamaFetch('/api/chat', {
      method: 'POST',
      timeoutMs: RECOGNITION_TIMEOUT_MS,
      signal,
      body: {
        model: this.model,
        stream: false,
        keep_alive: '10m',
        options: { num_ctx: 4096, temperature: 0 },
        format: { type: 'object', properties: { back_image: { type: 'integer', enum: [1, 2] } }, required: ['back_image'] },
        messages: [{
          role: 'user',
          content: 'Image 1 and image 2 are the two sides of one trading card. The FRONT shows the main player photo or artwork. The BACK shows the biography paragraph, statistics table, card number and copyright lines. Which image is the BACK? Answer 1 or 2.',
          images: [first, second],
        }],
      },
    })
    if (!response.ok) throw classifyOllamaError(response.status, await response.text().catch(() => ''))
    const data = await response.json().catch(() => null)
    try {
      const answer = JSON.parse(data?.message?.content).back_image
      return answer === 1 || answer === 2 ? answer : null
    } catch {
      return null
    }
  }

  // Clockwise turn (0/90/180/270) that puts a card side the right way up.
  // The model picks the upright one of the four rotations, with a question
  // per side: fronts by the people in the photo (54/54 in testing, where the
  // text check failed on sideways printed names), backs by the text only,
  // because back photos are often printed sideways (18/18; the photo-based
  // question got 2/5 on backs). ~3 s each.
  async uprightTurn(filePath, signal, side = 'front') {
    const image = nativeImage.createFromPath(filePath)
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    const scale = Math.min(1, UPRIGHT_CHECK_EDGE / Math.max(width, height))
    const small = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' })
    const turns = [0, 90, 180, 270]
    const response = await ollamaFetch('/api/chat', {
      method: 'POST',
      timeoutMs: RECOGNITION_TIMEOUT_MS,
      signal,
      body: {
        model: this.model,
        stream: false,
        keep_alive: '10m',
        options: { num_ctx: 8192, temperature: 0 },
        format: { type: 'object', properties: { upright_image: { type: 'integer', enum: [1, 2, 3, 4] } }, required: ['upright_image'] },
        messages: [{
          role: 'user',
          content: side === 'back'
            ? 'These 4 images are the same trading card BACK, each turned a different way. Which ONE is the right way up? Judge ONLY by the printed text: the name heading, the biography paragraph and the statistics table must read normally, left to right in horizontal lines, not sideways and not upside down. Ignore any photos (photos on card backs are often printed sideways). Answer 1, 2, 3 or 4.'
            : 'These 4 images are the same trading card side, each turned a different way. Which ONE is the right way up, as the card is meant to be viewed: people standing upright with heads at the top, and the main printed text (player name, headings) reading left to right? Answer 1, 2, 3 or 4.',
          images: turns.map((turn) => rotateNativeImage(small, turn).toJPEG(85).toString('base64')),
        }],
      },
    })
    if (!response.ok) throw classifyOllamaError(response.status, await response.text().catch(() => ''))
    const data = await response.json().catch(() => null)
    try {
      const pick = JSON.parse(data?.message?.content).upright_image
      return turns[pick - 1] ?? null
    } catch {
      return null
    }
  }

  async recognizeCard({ frontPath, backPath }, signal) {
    if (!frontPath || !backPath) {
      throw new CardRecognitionError('IMAGE_MISSING', !frontPath ? 'The front scan is missing.' : 'The back scan is missing.')
    }
    const [front, back] = await Promise.all([prepareAiImage(frontPath, 'front'), prepareAiImage(backPath, 'back')])
    const started = Date.now()
    const response = await ollamaFetch('/api/chat', {
      method: 'POST',
      timeoutMs: RECOGNITION_TIMEOUT_MS,
      signal,
      body: {
        model: this.model,
        stream: false,
        format: CARD_SCHEMA,
        keep_alive: '10m',
        options: { num_ctx: 16384, temperature: 0 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: 'These two images are ONE card. Image 1 is the FRONT of the card. Image 2 is the BACK of the same card. Identify the card.',
            images: [front, back],
          },
        ],
      },
    })
    if (!response.ok) throw classifyOllamaError(response.status, await response.text().catch(() => ''))
    const data = await response.json().catch(() => null)
    const content = data?.message?.content
    let parsed
    try {
      parsed = JSON.parse(content)
    } catch (error) {
      throw new CardRecognitionError('INVALID_JSON', 'The local AI returned an unreadable result. Retry the card.', error)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CardRecognitionError('INVALID_JSON', 'The local AI returned an unexpected result. Retry the card.')
    }
    return { result: normaliseResult(parsed), model: this.model, durationMs: Date.now() - started }
  }
}

module.exports = { OllamaCardRecognitionProvider, CardRecognitionError, QWEN_MODEL, normaliseResult }
