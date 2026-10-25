// Market Intelligence calculations. Pure functions with no app imports, so
// they can be tested directly (scripts/test-market-intelligence.mjs).
//
// Money is handled in whole cents (integers) throughout; dollars only at the
// edges. Nothing here predicts prices: every figure comes from recorded
// completed sales, the employee's inspection and the store's own buying
// percentages.

export const LEGO_GROUPS = [
  ['sealed', 'Sealed'],
  ['used_complete', 'Used Complete'],
  ['used_incomplete', 'Used Incomplete'],
]
export const LEGO_CONDITIONS = LEGO_GROUPS.map(([, label]) => label)
export const DEFAULT_BUY_PERCENT = 75

// "$1,234.50", 12.5, "12" -> 1250 / 1250 / 1200 cents; '' or invalid -> null.
export function toCents(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null
  const text = String(value).replace(/[^0-9.-]/g, '')
  if (!text || !/^-?\d*\.?\d+$/.test(text)) return null
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.')
  const cents = Number(whole || 0) * 100 + Number((fraction + '00').slice(0, 2)) + (Number(fraction.charAt(2) || 0) >= 5 ? 1 : 0)
  return text.startsWith('-') ? -cents : cents
}

export function fromCents(cents) {
  return cents == null ? null : cents / 100
}

export function formatCents(cents, currency = 'CAD') {
  if (cents == null) return 'N/A'
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100)
}

// Median of cents values (the middle one, or the rounded mean of the two).
export function medianCents(values = []) {
  const list = values.filter((value) => Number.isInteger(value)).sort((a, b) => a - b)
  if (!list.length) return null
  const middle = Math.floor(list.length / 2)
  return list.length % 2 ? list[middle] : Math.round((list[middle - 1] + list[middle]) / 2)
}

// percent may have decimals (77.5): applied in basis points, then rounded once.
export function applyPercent(cents, percent) {
  if (cents == null || percent == null || !Number.isFinite(Number(percent))) return null
  const basisPoints = Math.round(Number(percent) * 100)
  return Math.round((cents * basisPoints) / 10000)
}

export function isLegoCategoryName(category = '') {
  return /lego|building block/i.test(String(category || ''))
}

export function isCardCategoryName(category = '') {
  return /card/i.test(String(category || ''))
}

// LEGO condition text -> its pricing group (older register wording included).
export function legoGroupFromCondition(condition = '') {
  const text = String(condition || '').toLowerCase()
  if (!text) return null
  if (/seal|new\b|new\//.test(text) && !/missing|incomplete/.test(text)) return 'sealed'
  if (/incomplete|missing|damaged/.test(text)) return 'used_incomplete'
  if (/complete|100%|pre-owned|used/.test(text)) return 'used_complete'
  return null
}

// The market pricing group an item is valued in:
//   cards  - "graded:PSA:10" (exact company and grade) or "ungraded" (all raw conditions together)
//   LEGO   - sealed / used_complete / used_incomplete
//   other  - the condition itself, or every sale when there is none
export function pricingGroupFor({ category = '', condition = '', graded = false, gradingCompany = '', grade = '' } = {}) {
  if (isCardCategoryName(category)) {
    if (graded || /^graded$/i.test(condition)) {
      const company = String(gradingCompany || '').trim().toUpperCase()
      // "10.0" and "10" are the same grade (the database groups them the same way).
      const raw = String(grade || '').trim()
      const value = raw && Number.isFinite(Number(raw)) ? String(Number(raw)) : raw
      if (!company || !value) return { key: null, label: 'Graded: choose the grading company and grade' }
      return { key: `graded:${company}:${value}`, label: `${company} ${value}` }
    }
    return { key: 'ungraded', label: 'Ungraded' }
  }
  if (isLegoCategoryName(category)) {
    const group = legoGroupFromCondition(condition)
    return group ? { key: group, label: LEGO_GROUPS.find(([key]) => key === group)[1] } : { key: null, label: 'Choose Sealed, Used Complete or Used Incomplete' }
  }
  const text = String(condition || '').trim()
  return text && !/^n\/?a$/i.test(text) ? { key: `condition:${text.toLowerCase()}`, label: text } : { key: 'all', label: 'All sales' }
}

// The store's buying percentage for an item: a LEGO group rule, then a
// category rule, then the store default (75% when nothing is set).
export function buyPercentFor(policy, { category = '', legoGroup = null } = {}) {
  const lego = policy?.lego_percents || {}
  if (legoGroup && lego[legoGroup] != null && lego[legoGroup] !== '') return { percent: Number(lego[legoGroup]), rule: `${LEGO_GROUPS.find(([key]) => key === legoGroup)?.[1] || legoGroup} rule` }
  const byCategory = policy?.category_percents || {}
  const match = Object.entries(byCategory).find(([name, value]) => value != null && value !== '' && name.toLowerCase() === String(category || '').toLowerCase())
  if (match) return { percent: Number(match[1]), rule: `${match[0]} rule` }
  if (policy?.default_percent != null) return { percent: Number(policy.default_percent), rule: 'Store default' }
  return { percent: DEFAULT_BUY_PERCENT, rule: 'Default (not set by the store)' }
}

// One minifigure's inspection: required quantity, how many are present and
// how many are missing; the rest are unverified.
export function minifigCounts({ required = 1, present = 0, missing = 0 } = {}) {
  const need = Math.max(0, Number(required) || 0)
  const has = Math.min(need, Math.max(0, Number(present) || 0))
  const gone = Math.min(need - has, Math.max(0, Number(missing) || 0))
  return { required: need, present: has, missing: gone, unverified: need - has - gone }
}

// The missing-minifigure adjustment for a LEGO set:
//   reference  = the Used Complete median (cents, or null when there isn't one)
//   deductions = each missing minifigure's price x the missing quantity
//   adjusted   = max(reference - deductions, 0)
//   baseline   = adjusted x the store's buying percentage
// A missing minifigure with no price is flagged (the adjustment is then
// incomplete), never counted as $0. With no reference there is no baseline:
// the employee enters the offer by hand.
export function legoAdjustment({ referenceCents = null, minifigs = [], buyPercent = null } = {}) {
  let deductionCents = 0
  const unpriced = []
  const missing = []
  let unverified = 0
  for (const figure of minifigs) {
    const counts = minifigCounts(figure)
    unverified += counts.unverified
    if (!counts.missing) continue
    const priceCents = Number.isInteger(figure.priceCents) ? figure.priceCents : null
    missing.push({ ...figure, ...counts, priceCents, deductionCents: priceCents == null ? null : priceCents * counts.missing })
    if (priceCents == null) unpriced.push(figure)
    else deductionCents += priceCents * counts.missing
  }
  const hasReference = Number.isInteger(referenceCents)
  const adjustedCents = hasReference ? Math.max(referenceCents - deductionCents, 0) : null
  return {
    missing,
    missingCount: missing.reduce((sum, figure) => sum + figure.missing, 0),
    unverified,
    unpriced,
    deductionCents,
    deductionComplete: unpriced.length === 0,
    adjustedCents,
    baselineCents: hasReference && buyPercent != null ? applyPercent(adjustedCents, buyPercent) : null,
    // Missing minifigures make the set Used Incomplete unless the store corrects the inspection.
    suggestedCondition: missing.length ? 'Used Incomplete' : null,
  }
}

// A plain item's baseline: the group's median x the buying percentage.
export function simpleBaseline({ referenceCents = null, buyPercent = null } = {}) {
  return Number.isInteger(referenceCents) && buyPercent != null ? applyPercent(referenceCents, buyPercent) : null
}
