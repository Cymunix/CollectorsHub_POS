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
    season: nullable('string'),
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
    // Trading card games (Pokémon, Magic, Yu-Gi-Oh!...): null for sports cards.
    evolves_from: nullable('string'),
    evolves_to: nullable('string'),
    attack: nullable('string'),
    health: nullable('string'),
    damage: nullable('string'),
    shields: nullable('string'),
    tcg_type: nullable('string'),
    traits: { type: 'array', items: { type: 'string' } },
    abilities: { type: 'array', items: { type: 'string' } },
    weakness: nullable('string'),
    resistance: nullable('string'),
    artist: nullable('string'),
    language: nullable('string'),
    legal: nullable('string'),
    cost: nullable('string'),
    unit_level: nullable('string'),
    uncertain_fields: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'category', 'subcategory', 'franchise', 'subfranchise', 'property', 'item_type',
    'collection', 'subject', 'subjects', 'id_number', 'publisher_manufacturer', 'description',
    'release_year', 'season', 'barcodes', 'card_type', 'team', 'rookie', 'parallel', 'variation',
    'serial_numbering', 'autograph', 'autograph_type', 'memorabilia_relic', 'finish',
    'evolves_from', 'evolves_to', 'attack', 'health', 'damage', 'shields', 'tcg_type', 'traits',
    'abilities', 'weakness', 'resistance', 'artist', 'language', 'legal', 'cost', 'unit_level',
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
This is the specific set, WITHOUT the year or season (that goes in SEASON), such as: Panini Contenders Football,
SP Authentic Hockey.

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
The release/set year. For a season that spans two years (2013-14), the first year (2013).

SEASON
Sports cards: the season as printed or as the set names it: "2013-14" for hockey and basketball seasons that span
two years, "2024" for football and baseball. Trading card games: null.

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

TRADING CARD GAMES
Cards from a trading card GAME (Pokémon, Magic: The Gathering, Yu-Gi-Oh!, One Piece, Disney Lorcana,
Star Wars and similar) are NOT sports cards. For them the fields above mean:
- category: Trading Cards
- subcategory: the brand / game, e.g. Pokémon, Magic: The Gathering, Yu-Gi-Oh!, One Piece.
- franchise: the product family within the brand. For Pokémon cards from the main expansion sets use: Core Sets.
  Return null if unsure.
- subfranchise: the era, generation or storyline, e.g. Scarlet & Violet, Sword & Shield, Illustration Contest.
- property: the specific release / set, e.g. Stellar Crown, Surging Sparks.
- item_type: Card.
- collection: only a named collector line printed on the card; otherwise null (never "Base").
- subject / subjects: what the card depicts (the card name, e.g. Feraligatr). One entry.
- id_number: the card's own collector number as printed, without the set size (213/191 -> 213). A number printed
  as 33/120 is the collector number 33, never serial numbering.
- publisher_manufacturer: e.g. The Pokémon Company, Wizards of the Coast, Konami, Bandai.
- release_year: the year printed on the card (copyright line) for that release.
- description: ONLY the flavour text: the small italic Pokédex entry or flavour line (on Magic, the italic flavour
  text under the rules). Never put abilities, attacks, rules or effect text here. null if the card has none.
- finish: print treatment. Pokémon: Holo, Reverse Holo, or None. Magic and Yu-Gi-Oh!: Foil or Nonfoil.
- team, rookie, parallel, variation, serial_numbering, autograph, autograph_type, memorabilia_relic, card_type:
  null / false (sports-card fields).
Card metadata for trading card games (null when the card doesn't show it):
- evolves_from: the previous form, e.g. "Evolves from Croconaw" -> Croconaw.
- evolves_to: the next form, only if printed.
- attack: an offensive stat printed as a number (e.g. Yu-Gi-Oh! ATK, One Piece power). Not attack names.
- health: hit points / life, e.g. HP 180 -> 180.
- damage: a printed damage value or modifier, only if the game has a single one.
- shields: a defensive resource / protection value, only if printed.
- tcg_type: the card's primary game classification: the Pokémon type (e.g. Water); the Magic colour(s) written
  out (e.g. Green, or "Red, Blue" for more than one, Colorless for none); the Yu-Gi-Oh! card type (e.g. Effect Monster).
- traits: one entry each.
  Pokémon: each box labelled "Ability" (red banner), written as "Name: effect",
  e.g. "Deep Submergence: Once during your turn, ...". An Ability has no energy cost and no damage.
  Magic: the subtypes after the dash in the type line, one each ("Creature — Vampire Rogue" -> Vampire, Rogue;
  "Land — Forest Island" -> Forest, Island). Other games: what the card is associated with (tags, archetypes).
- abilities: one entry each.
  Pokémon: each ATTACK (move), written as "Name (Cost) Damage: effect", where Cost is the energy symbols to its
  left in order and Damage is the number to its right exactly as printed; leave out parts the attack doesn't have,
  e.g. "Hydro Pump (Water Water Colorless) 160+: This attack does 20 more damage for each Water Energy..."
  or "Bite (Colorless) 30". Anything with an energy cost or damage is an attack and goes HERE, never in traits.
  Magic: each rules-text paragraph exactly as printed, one entry each (keywords such as Lifelink or Flying are
  their own entry), with symbols written in braces: {T} for tap, {W} {U} {B} {R} {G} for coloured mana, {C} colourless,
  numbers as {2}, and {X}. E.g. "{2}{B}: This creature gains lifelink until end of turn." or "{T}: Add {G}."
  Yu-Gi-Oh!: the card's effect text.
- On Pokémon cards, leave damage null (each attack carries its own damage).
- weakness: e.g. Lightning / Electric. resistance: likewise.
- artist: the illustrator credited on the card (e.g. "Illus. Acorviart" -> Acorviart).
- language: the printing language, e.g. English, Japanese.
- legal: tournament legality only if printed (e.g. a regulation mark); otherwise null.
- cost: the play / resource cost to use the card, if the game has one.
  Magic: the mana cost in the top corner written out - each colour with its count first, then the generic number
  as "Any Colour", then X: {2}{G} -> "1 Green, 2 Any Colour"; {U}{R} -> "1 Blue, 1 Red";
  {1}{B}{B} -> "2 Black, 1 Any Colour"; {X}{G} -> "1 Green, 1 {X}". Lands have no cost: null.
  Pokémon: null (attack costs go with each attack).
- unit_level: a printed level / rank (e.g. Yu-Gi-Oh! level), if any.
For sports cards all of these card-metadata fields are null and traits/abilities are empty lists.

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
  // (A sports-card convention; trading card games leave it empty.)
  const tradingCardGame = /trading/i.test(String(result.category || ''))
  if (!tradingCardGame && !result.collection && !/insert|autograph|patch|relic/i.test(String(result.card_type || ''))) result.collection = 'Base'
  // Sports sets are named without their season: a season left in the set name
  // ("2013-14 SP Authentic Hockey") moves to season. Trading card games have none.
  if (tradingCardGame) {
    result.season = null
  } else {
    const seasonInSet = String(result.property || '').match(/^((?:19|20)\d{2}(?:-\d{2,4})?)\s+(.+)$/)
    if (seasonInSet) {
      if (!result.season) result.season = seasonInSet[1]
      result.property = seasonInSet[2].trim()
    }
  }
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
  async backSideIndex({ firstPath, secondPath, trading = false }, signal) {
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
          // Trading card games print the card number, rules and copyright on the
          // front; the back is the same design on every card of the game.
          content: trading
            ? 'Image 1 and image 2 are the two sides of one trading card game card (e.g. Pokémon, Magic: The Gathering, Yu-Gi-Oh!). The FRONT shows the card name, artwork, rules or attack text, card number and copyright. The BACK is the same design on every card of the game: the game logo or a pattern, with no card name or rules text. Which image is the BACK? Answer 1 or 2.'
            : 'Image 1 and image 2 are the two sides of one trading card. The FRONT shows the main player photo or artwork. The BACK shows the biography paragraph, statistics table, card number and copyright lines. Which image is the BACK? Answer 1 or 2.',
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

  async recognizeCard({ frontPath, backPath, category = '' }, signal) {
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
            // The category the card was scanned under (the person scanning knows it).
            content: 'These two images are ONE card. Image 1 is the FRONT of the card. Image 2 is the BACK of the same card. Identify the card.'
              + (/trading/i.test(category) ? ' It is a trading card GAME card (category: Trading Cards), not a sports card: follow the TRADING CARD GAMES rules.'
                : /sports/i.test(category) ? ' It is a sports card (category: Sports Cards).' : ''),
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

// ---------------------------------------------------------------------------
// Quick identify (stores): only what finds the card in the catalogue (name,
// number, set, year, parallel), not the full description, stats and game
// text that creating a catalogue item needs. Much less to write, so faster.

const IDENTIFY_FIELDS = [
  'category', 'subcategory', 'franchise', 'subfranchise', 'property', 'collection', 'subject', 'subjects',
  'id_number', 'release_year', 'season', 'team', 'parallel', 'variation', 'serial_numbering', 'autograph',
  'memorabilia_relic', 'finish', 'uncertain_fields',
]
// Store intake also gets a suggested condition (the store's card scale) and
// the observations behind it, shown to staff as the reason.
const CARD_CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged']
const IDENTIFY_SCHEMA = {
  type: 'object',
  properties: {
    ...Object.fromEntries(IDENTIFY_FIELDS.map((key) => [key, CARD_SCHEMA.properties[key]])),
    suggested_condition: { type: ['string', 'null'], enum: [...CARD_CONDITIONS, null] },
    condition_notes: { type: 'array', items: { type: 'string' } },
  },
  required: [...IDENTIFY_FIELDS, 'suggested_condition', 'condition_notes'],
  additionalProperties: false,
}
// Smaller images than a full reading (fewer image tokens), still enough for
// card numbers and copyright lines.
const IDENTIFY_IMAGE_EDGE = 1280

const IDENTIFY_PROMPT = `You are identifying ONE collectable card so a store can find it in its catalogue.
Read only what identifies the card. Use only what is printed on the card; never guess. Use null when a field is not visible.

- category: Sports Cards or Trading Cards.
- subcategory: the sport (e.g. Football, Hockey, Baseball) or, for trading card games, the game (e.g. Pokémon, Magic: The Gathering, Star Wars).
- franchise: the league (e.g. NFL, NHL) or the trading card game's product family. null if unsure.
- subfranchise: the product line (e.g. Panini Contenders, Upper Deck) or the trading card game's era / set series.
- property: the specific set without its year, e.g. "Panini Contenders Football", or a game's expansion name.
- collection: a named insert or parallel line printed on the card (e.g. Rookie Ticket, Cracked Ice Ticket); null for a base card.
- subject: the player(s) or the card's name. Several players: join them with "/". subjects: each one.
- id_number: the card's own number as printed, without the set size: "64" for #64, "33" for 33/120, "EC-20" for EC-20.
- release_year: the set's year (copyright line or set name); for a two-year season, the first year.
- season: sports cards only: "2013-14" for hockey/basketball seasons, "2024" for football/baseball.
- team: the team on a sports card.
- parallel, variation: only if clearly printed or obvious (e.g. a foil colour named on the card).
- serial_numbering: hand/stamped numbering such as 14/99 (NOT the card number of a trading card game).
- autograph, memorabilia_relic: true only if the physical card has one.
- finish: trading card games only: Foil / Nonfoil (Magic, Yu-Gi-Oh!) or Holo / Reverse Holo / None (Pokémon).
- uncertain_fields: the fields you could not read clearly.
- suggested_condition: the card's physical condition from what you can see on BOTH sides:
  Near Mint: sharp corners, clean edges, no creases, at most a tiny flaw.
  Lightly Played: slight corner rounding or edge whitening, small scuffs.
  Moderately Played: clear corner/edge wear, scuffing or a minor crease.
  Heavily Played: heavy wear, creases or bends.
  Damaged: tears, water damage, writing, large creases or missing pieces.
  When unsure between two, choose the better one. null only if the card can't be seen.
- condition_notes: 1 to 4 short observations behind that condition, naming where (e.g. "top-left corner slightly
  rounded", "white wear along the back edges", "no creases or scratches visible"). Mention clearly off-centre
  printing if you see it.`

OllamaCardRecognitionProvider.prototype.identifyCard = async function identifyCard({ frontPath, backPath, category = '' }, signal) {
  if (!frontPath) throw new CardRecognitionError('IMAGE_MISSING', 'The front scan is missing.')
  const images = await Promise.all([prepareAiImage(frontPath, 'front', IDENTIFY_IMAGE_EDGE), ...(backPath ? [prepareAiImage(backPath, 'back', IDENTIFY_IMAGE_EDGE)] : [])])
  const started = Date.now()
  const response = await ollamaFetch('/api/chat', {
    method: 'POST',
    timeoutMs: RECOGNITION_TIMEOUT_MS,
    signal,
    body: {
      model: this.model,
      stream: false,
      format: IDENTIFY_SCHEMA,
      keep_alive: '10m',
      // Same context size as a full reading: a different one makes Ollama
      // reload the model, which would stall a scan queue running alongside.
      options: { num_ctx: 16384, temperature: 0 },
      messages: [
        { role: 'system', content: IDENTIFY_PROMPT },
        {
          role: 'user',
          content: (images.length === 2 ? 'Image 1 is the FRONT of the card, image 2 the BACK. Identify the card.' : 'This is the FRONT of the card. Identify the card.')
            + (/trading/i.test(category) ? ' It is a trading card GAME card (category: Trading Cards), not a sports card.'
              : /sports/i.test(category) ? ' It is a sports card (category: Sports Cards).' : ''),
          images,
        },
      ],
    },
  })
  if (!response.ok) throw classifyOllamaError(response.status, await response.text().catch(() => ''))
  const data = await response.json().catch(() => null)
  let parsed
  try {
    parsed = JSON.parse(data?.message?.content)
  } catch (error) {
    throw new CardRecognitionError('INVALID_JSON', 'The local AI returned an unreadable result. Retry the card.', error)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CardRecognitionError('INVALID_JSON', 'The local AI returned an unexpected result. Retry the card.')
  }
  const result = normaliseResult(parsed)
  result.suggested_condition = CARD_CONDITIONS.includes(parsed.suggested_condition) ? parsed.suggested_condition : null
  result.condition_notes = Array.isArray(parsed.condition_notes) ? parsed.condition_notes.map((note) => String(note).trim()).filter(Boolean).slice(0, 4) : []
  return { result, model: this.model, durationMs: Date.now() - started, mode: 'identify' }
}

module.exports = { OllamaCardRecognitionProvider, CardRecognitionError, QWEN_MODEL, normaliseResult }
