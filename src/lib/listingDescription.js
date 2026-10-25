// The customer-facing condition note for a bought item, from its purchase
// inspection: what's missing, damaged or included. It's shown on the website
// and used for online listings, so it never contains prices, buying details
// or the private inspection notes. Pure functions (tested in
// scripts/test-market-intelligence.mjs) plus the local-AI call.

const checked = (value) => (value === 'present' || value === 'missing' ? value : null)
const clean = (value) => String(value || '').trim()

// Facts the description may use (and nothing else).
export function inspectionFacts({ name = '', setNumber = '', condition = '', figures = [], research = {} } = {}) {
  const minifigs = figures.map((figure) => ({ name: figure.name, required: figure.required, present: figure.present, missing: figure.missing, unverified: figure.unverified }))
  return {
    item: clean(name),
    set_number: clean(setNumber) || undefined,
    condition: clean(condition) || undefined,
    minifigures: minifigs.length ? {
      total: minifigs.reduce((sum, figure) => sum + figure.required, 0),
      missing: minifigs.filter((figure) => figure.missing > 0).map((figure) => (figure.required > 1 ? `${figure.name} (${figure.missing} of ${figure.required})` : figure.name)),
      not_checked: minifigs.reduce((sum, figure) => sum + figure.unverified, 0),
    } : undefined,
    missing_or_damaged_pieces: clean(research.missing_pieces) || undefined,
    missing_accessories: clean(research.missing_accessories) || undefined,
    // Unchecked box/instructions are left out entirely (the model mentioned
    // "not checked" when told to skip them, so it never sees them).
    instructions: checked(research.instructions) || undefined,
    original_box: checked(research.box) || undefined,
    damage: clean(research.damage) || undefined,
  }
}

// The plain version, written straight from the answers (also the fallback
// when the local AI isn't available).
export function templateDescription(facts = {}) {
  const parts = []
  if (facts.condition) parts.push(`${facts.condition}.`)
  const figs = facts.minifigures
  if (figs) {
    if (figs.missing.length) parts.push(`Missing minifigure${figs.missing.length === 1 ? '' : 's'}: ${figs.missing.join(', ')}.`)
    else if (!figs.not_checked) parts.push(`All ${figs.total} minifigure${figs.total === 1 ? ' is' : 's are'} included.`)
  }
  if (facts.missing_or_damaged_pieces) parts.push(`Missing or damaged pieces: ${facts.missing_or_damaged_pieces}.`)
  if (facts.missing_accessories) parts.push(`Missing accessories: ${facts.missing_accessories}.`)
  if (facts.instructions === 'present') parts.push('Instructions included.')
  if (facts.instructions === 'missing') parts.push('No instructions.')
  if (facts.original_box === 'present') parts.push('Original box included.')
  if (facts.original_box === 'missing') parts.push('No original box.')
  if (facts.damage) parts.push(`Damage: ${facts.damage}.`)
  return parts.join(' ').replace(/\.\./g, '.')
}

// The local AI's version when it's available; otherwise the plain one.
export async function writeDescription(facts) {
  const api = typeof window !== 'undefined' ? window.nordvikDesktop : null
  if (api?.writeListingDescription) {
    const result = await api.writeListingDescription(facts).catch((error) => ({ ok: false, message: error.message }))
    if (result?.ok && result.text) return { text: result.text, source: 'ai' }
    return { text: templateDescription(facts), source: 'template', note: `The local AI wasn't available (${result?.message || 'no response'}), so this was written from your answers.` }
  }
  return { text: templateDescription(facts), source: 'template', note: 'Written from your answers (the local AI only runs in the desktop app).' }
}
