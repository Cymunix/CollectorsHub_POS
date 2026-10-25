// Confidence for an AI-analysed scan, from checks the app can make itself
// (the model gives no reliable probability of its own): the fields the AI
// highlighted as uncertain, whether the card number and player name appear in
// the text read off the card, whether other scans of the same card agree, and
// how much the scan needed fixing. Plus what approving would do (readiness).

const HIGH = 85
const MEDIUM = 65

const ESSENTIAL = [['subject', 'player'], ['id_number', 'card number'], ['release_year', 'year']]
const FIELD_LABELS = {
  subject: 'player', subjects: 'player', id_number: 'card number', release_year: 'year', team: 'team', card_type: 'card type',
  collection: 'collection', parallel: 'parallel', variation: 'variation', serial_numbering: 'serial number', autograph: 'autograph',
  autograph_type: 'autograph type', memorabilia_relic: 'relic', finish: 'finish', rookie: 'rookie', property: 'set', subfranchise: 'product line',
}

function text(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

// Spaces in card numbers are ignored ("EC - 20" is "EC-20").
function cardNumber(value) {
  return text(value).replace(/^(no\.?|#)\s*/, '').replace(/\s+/g, '')
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The card's identity without set wording, for comparing copies.
export function looseCardKey(result = {}) {
  const players = String(result.subject || '').split('/').map(text).filter(Boolean).sort().join('|')
  return [players, cardNumber(result.id_number), String(result.release_year ?? '')].join('#')
}

// The matched item already has a photo that doesn't look like this scan (the photo
// check in review): linking would replace its photos, so it waits for a person.
function differentPhoto(draft, itemId) {
  const check = draft?.catalogueCheck
  return Boolean(itemId && check?.itemId === itemId && check.similar === false && !check.error)
}

// A scan matched within the set chosen at Scan Intake ("Photograph a set"): judged on
// how its number was found and cross-checked, rather than on the AI reading alone.
function targetSetConfidence(draft) {
  const analysis = draft.scanAnalysis
  const check = analysis.setCheck || {}
  let score = 100
  const reasons = []
  const add = (delta, reason, good = false) => { score += delta; reasons.push({ text: reason, good, delta }) }
  if (analysis.matchStatus === 'none') {
    add(-100, check.readNumber ? `#${check.readNumber} isn't in the chosen set` : 'No card number read, and none found on the card')
  } else {
    if (check.numberFrom === 'ai') add(0, `#${check.number} is in the chosen set`, true)
    else if (check.numberFrom === 'ocr') add(-5, `#${check.number} read from the card text (the AI missed it)`)
    else if (check.numberFrom === 'sequence') add(-15, `#${check.number} assumed from the stack order`)
    if (check.ocr === 'confirmed') add(0, 'Card number printed on the card agrees', true)
    else if (check.ocr === 'seen') add(-3, 'Card number found in the card text')
    else if (check.ocr === 'missing') add(-15, 'Card number not found in the card text')
    if (check.nameAgrees === true) add(0, 'Name agrees with the set item', true)
    else if (check.nameAgrees === false) add(-20, 'Name read differs from the set item')
    if (check.sequence === 'in-order') add(0, 'Next card in the stack', true)
    else if (check.sequence === 'repeat') add(0, 'Another copy of the previous card', true)
    else if (check.sequence === 'out-of-order') add(-15, `Out of order (expected #${check.expectedNumber})`)
    if (analysis.matchStatus === 'multiple') add(-30, `${check.printings} printings share #${check.number}: pick one`)
    else if (check.variantBy === 'photo') add(-5, 'Printing chosen by its photo')
    if (differentPhoto(draft, analysis.bestMatch?.item?.item_id)) add(-40, 'The item already has a different photo')
  }
  score = Math.max(0, Math.min(100, Math.round(score)))
  const tier = score >= HIGH ? 'high' : score >= MEDIUM ? 'medium' : 'low'
  return { score, tier, reasons, readiness: analysis.matchStatus === 'exact' ? 'link' : 'check' }
}

export function scanConfidence(draft, { copies = [], exactMatch = null } = {}) {
  const result = draft?.recognition?.result
  if (!result) return null
  if (draft.scanAnalysis?.source === 'target-set' && !exactMatch) return targetSetConfidence(draft)
  let score = 100
  const reasons = []
  const add = (delta, reason, good = false) => { score += delta; reasons.push({ text: reason, good, delta }) }

  // 1. The essentials must be there.
  for (const [key, label] of ESSENTIAL) {
    if (!text(result[key])) add(-35, `No ${label} read`)
  }

  // The release year should match the set the AI read ("1990 Topps"); the
  // model sometimes takes the last stats season instead.
  const setYears = [result.property, result.subfranchise, result.collection].join(' ').match(/\b(19|20)\d{2}\b/g) || []
  if (setYears.length && result.release_year && !setYears.includes(String(result.release_year))) add(-25, `Year ${result.release_year} doesn't match the set (${setYears[0]})`)

  // 2. Fields the AI highlighted as uncertain. Rookie is flagged out of
  //    caution on most cards, so it costs little.
  for (const field of new Set(result.uncertain_fields || [])) {
    const label = FIELD_LABELS[field] || field
    if (field === 'rookie') add(-5, 'Rookie flag to confirm')
    else if (['subject', 'subjects', 'id_number', 'release_year'].includes(field)) add(-20, `AI unsure of ${label}`)
    else add(-12, `AI unsure of ${label}`)
  }

  // 3. Cross-check against the text read off the card (stack scans).
  const ocr = draft.feed?.ocrText
  const allText = text([ocr?.front, ocr?.back].filter(Boolean).join(' '))
  if (allText.split(/\s+/).length >= 12) {
    const number = cardNumber(result.id_number)
    if (number) {
      if (new RegExp(`(^|[^a-z0-9])${escapeRegex(number)}([^a-z0-9]|$)`).test(allText)) add(0, 'Card number found on the card', true)
      else add(-12, 'Card number not found in the card text')
    }
    const surnames = String(result.subject || '').split('/').map((name) => text(name).split(/\s+/).filter((part) => !/^(jr\.?|sr\.?|ii|iii|iv)$/.test(part)).pop()).filter((name) => name && name.length >= 3)
    if (surnames.length) {
      const found = surnames.filter((name) => allText.includes(name))
      if (found.length === surnames.length) add(0, 'Player name found on the card', true)
      else add(-10, 'Player name not found in the card text')
    }
  }

  // 4. Other scans of the same card.
  const others = copies.filter((other) => other.id !== draft.id && other.recognition?.result)
  if (others.length) {
    const fields = ['team', 'card_type', 'collection', 'parallel', 'serial_numbering']
    const disagree = fields.filter((field) => others.some((other) => text(other.recognition.result[field]) !== text(result[field])))
    if (disagree.length) add(-20, `Copies disagree on ${disagree.map((field) => FIELD_LABELS[field] || field).join(', ')}`)
    else add(0, `${others.length + 1} scans agree`, true)
  }

  // 5. How much the scan needed fixing.
  if (draft.feed?.checkRotation && !draft.feed?.uprightChecked) add(-15, 'Rotation not confirmed')
  if (draft.feed?.swappedByAi) add(-5, 'Front and back were swapped during scanning')
  if (draft.frontImage?.cardStatus && draft.frontImage.cardStatus !== 'ok') add(-10, 'Card edges unclear in the scan')

  // 6. A possible (not exact) catalogue match might be this card.
  const matchStatus = exactMatch ? 'exact' : draft.scanAnalysis?.matchStatus || 'none'
  if (matchStatus === 'likely' || matchStatus === 'multiple') add(-10, 'Similar catalogue item to compare')
  if (matchStatus === 'exact' && differentPhoto(draft, (exactMatch || draft.scanAnalysis?.bestMatch)?.item?.item_id)) add(-40, 'The item already has a different photo')

  score = Math.max(0, Math.min(100, Math.round(score)))
  const tier = score >= HIGH ? 'high' : score >= MEDIUM ? 'medium' : 'low'

  // What approving would do.
  const unresolved = draft.recognition?.taxonomy?.unresolved || {}
  let readiness = 'add'
  if (matchStatus === 'exact') readiness = 'link'
  else if (matchStatus === 'likely' || matchStatus === 'multiple') readiness = 'check'
  else if (unresolved.property || unresolved.subset || unresolved.franchise || unresolved.subcategory) readiness = 'needs-set'

  return { score, tier, reasons, readiness }
}

export const CONFIDENCE_TIERS = { HIGH, MEDIUM }
