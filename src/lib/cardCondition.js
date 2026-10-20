// Single cards are Ungraded or Graded. A graded card keeps its grading company,
// grade and cert number on the record; an ungraded card has no condition scale
// (Near Mint, Lightly Played… are no longer used for cards).

export const UNGRADED = 'Ungraded'
export const GRADED = 'Graded'
export const CARD_CONDITIONS = [UNGRADED, GRADED]

export function isCardCategory(category) {
  return /card/i.test(String(category || ''))
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
