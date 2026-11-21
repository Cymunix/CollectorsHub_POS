// The set a scan probably belongs to, from the scans just before it (newest first, up to 5): at least 3 of them
// exact matches with a confidence of 85+, in one category, set and year. Needs a known year or season so the set's
// card numbers can't collide across years. Returns a target (as Scan Intake builds) or null.
export function inferredSetTarget(draft, drafts = []) {
  const earlier = drafts
    .filter((other) => other.id !== draft.id && String(other.createdAt || '') < String(draft.createdAt || ''))
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
    .slice(0, 5)
  const groups = new Map()
  for (const other of earlier) {
    const analysis = other.scanAnalysis
    const taxonomy = other.recognition?.taxonomy
    const ids = taxonomy?.ids || {}
    const item = analysis?.bestMatch?.item || {}
    const year = item.release_year ?? ''
    const season = item.season ?? ''
    if (analysis?.matchStatus !== 'exact' || (analysis.confidence || 0) < 85) continue
    if (!taxonomy?.categoryId || !ids.property_id || (!year && !season) || other.category !== draft.category) continue
    const key = [taxonomy.categoryId, ids.subcategory_id, ids.franchise_id, ids.subset_id, ids.property_id, ids.item_type_id, year, season].join('|')
    const group = groups.get(key) || { count: 0, taxonomy, year, season }
    group.count += 1
    groups.set(key, group)
  }
  const best = [...groups.values()].sort((left, right) => right.count - left.count)[0]
  if (!best || best.count < 3) return null
  const { taxonomy, year, season } = best
  return {
    categoryId: taxonomy.categoryId,
    category: taxonomy.category,
    subcategoryId: taxonomy.ids.subcategory_id || '',
    franchiseId: taxonomy.ids.franchise_id || '',
    subsetId: taxonomy.ids.subset_id || '',
    propertyId: taxonomy.ids.property_id || '',
    itemTypeId: taxonomy.ids.item_type_id || '',
    releaseYear: year || '',
    season: season || '',
    series: '',
    collection: '',
    names: taxonomy.names || {},
    label: [taxonomy.names?.property, season || year].filter(Boolean).join(' ') || 'Set inferred from earlier scans',
  }
}

// Printings of one card number that are still undecided (the photo didn't settle it): stacks tend to run through one
// Collection (a Refractor run, a Gold run). When the last 2-3 exact matches before this scan all share one Collection
// and exactly one candidate printing has it, that printing is chosen. Returns the candidate or null.
export function printingFromStackRun(candidates = [], draft = {}, drafts = []) {
  const collectionOf = (item) => String(item?.dynamic_fields?.collection ?? '').trim().toLowerCase()
  const run = drafts
    .filter((other) => other.id !== draft.id && String(other.createdAt || '') < String(draft.createdAt || '') && other.scanAnalysis?.matchStatus === 'exact')
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
    .slice(0, 3)
    .map((other) => collectionOf(other.scanAnalysis.bestMatch?.item))
  if (run.length < 2 || !run[0] || run.some((value) => value !== run[0])) return null
  const same = candidates.filter((candidate) => collectionOf(candidate.item) === run[0])
  return same.length === 1 ? same[0] : null
}
