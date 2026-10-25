// Single cards: an ungraded card's physical condition is assessed by staff on
// the six-step scale; a graded card keeps its grading company, grade and cert
// number. Market pricing still groups every raw condition together as
// "Ungraded" (ungradedStat) until there is reliable condition-specific sold
// data, and never mixes certified grades.
//
// "Ungraded" is also the condition of cards saved while the scale was off
// (v0.1.85-0.1.88); it stays valid and shows as itself, but new cards get a
// condition from the scale.

export const UNGRADED = 'Ungraded'
export const GRADED = 'Graded'
export const RAW_CARD_CONDITIONS = ['Mint', 'Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged']
export const DEFAULT_RAW_CONDITION = 'Near Mint'
export const CARD_CONDITIONS = [...RAW_CARD_CONDITIONS, GRADED]

export function isCardCategory(category) {
  return /card/i.test(String(category || ''))
}

// A raw condition written any common way ("NM", "lightly-played", "SP") as
// its name on the scale, or '' when it isn't one.
const CANONICAL = {
  mint: 'Mint', gemmint: 'Mint', m: 'Mint',
  nearmint: 'Near Mint', nm: 'Near Mint', nmmt: 'Near Mint', nearmintmint: 'Near Mint', excellent: 'Near Mint', ex: 'Near Mint',
  lightlyplayed: 'Lightly Played', lightplayed: 'Lightly Played', lp: 'Lightly Played', slightlyplayed: 'Lightly Played', sp: 'Lightly Played', verygood: 'Lightly Played', vg: 'Lightly Played',
  moderatelyplayed: 'Moderately Played', mp: 'Moderately Played', good: 'Moderately Played',
  heavilyplayed: 'Heavily Played', hp: 'Heavily Played', poor: 'Heavily Played',
  damaged: 'Damaged', dmg: 'Damaged',
}
export function canonicalRawCondition(condition) {
  return CANONICAL[String(condition || '').toLowerCase().replace(/[^a-z0-9]/g, '')] || ''
}

// The older raw-card conditions, and the ways market sales describe a raw
// card: all of them count as Ungraded.
const RAW = new Set([
  'ungraded', 'raw', 'mint', 'nearmint', 'nm', 'nmmt', 'nearmintmint', 'lightlyplayed', 'lightplayed', 'lp',
  'slightlyplayed', 'sp', 'moderatelyplayed', 'mp', 'heavilyplayed', 'hp', 'damaged', 'dmg', 'excellent', 'ex',
  'verygood', 'vg', 'good', 'poor',
])

export function isRawCardCondition(condition) {
  return RAW.has(String(condition || '').toLowerCase().replace(/[^a-z0-9]/g, ''))
}

// One Ungraded price stat from per-condition sale stats (count-weighted), or
// null when there are no raw sales.
export function ungradedStat(byCondition = {}) {
  const stats = Object.entries(byCondition || {}).filter(([key]) => isRawCardCondition(key)).map(([, stat]) => stat).filter(Boolean)
  if (!stats.length) return null
  const count = stats.reduce((sum, stat) => sum + Number(stat.count || 0), 0)
  const recent = stats.filter((stat) => stat.average30Day != null && Number(stat.recentCount || 0) > 0)
  const recentCount = recent.reduce((sum, stat) => sum + Number(stat.recentCount), 0)
  const weighted = (rows, value, weight) => {
    const total = rows.reduce((sum, stat) => sum + Number(stat[weight] || 0), 0)
    return total ? Math.round((rows.reduce((sum, stat) => sum + Number(stat[value]) * Number(stat[weight] || 0), 0) / total) * 100) / 100 : null
  }
  const lows = stats.map((stat) => stat.low).filter((value) => value != null).map(Number)
  const highs = stats.map((stat) => stat.high).filter((value) => value != null).map(Number)
  return {
    condition: UNGRADED,
    count,
    recentCount,
    average: weighted(stats.filter((stat) => stat.average != null), 'average', 'count'),
    average30Day: recentCount ? weighted(recent, 'average30Day', 'recentCount') : null,
    low: lows.length ? Math.min(...lows) : null,
    high: highs.length ? Math.max(...highs) : null,
  }
}
