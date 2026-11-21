// Run with: node scripts/test-scan-set-inference.mjs
import assert from 'node:assert/strict'
import { inferredSetTarget, printingFromStackRun } from '../src/lib/scanSetInference.js'

const ids = { subcategory_id: 's', franchise_id: 'f', subset_id: 'u', property_id: 'p', item_type_id: 't' }
const matched = (n, over = {}) => ({
  id: `d${n}`, createdAt: `2026-11-21T10:0${n}:00Z`, category: 'Sports Cards',
  scanAnalysis: { matchStatus: 'exact', confidence: 90, bestMatch: { item: { release_year: 2024, season: '' } } },
  recognition: { taxonomy: { categoryId: 'c', category: 'Sports Cards', ids, names: { property: 'Upper Deck' } } },
  ...over,
})
const current = { id: 'now', createdAt: '2026-11-21T10:09:00Z', category: 'Sports Cards' }

const target = inferredSetTarget(current, [matched(1), matched(2), matched(3)])
assert.equal(target.propertyId, 'p')
assert.equal(target.releaseYear, 2024)

assert.equal(inferredSetTarget(current, [matched(1), matched(2)]), null, 'needs 3 agreeing cards')
assert.equal(inferredSetTarget(current, [matched(1), matched(2), matched(3, { scanAnalysis: { matchStatus: 'exact', confidence: 70, bestMatch: { item: { release_year: 2024 } } } })]), null, 'low confidence does not count')
assert.equal(inferredSetTarget(current, [matched(1), matched(2), matched(3, { category: 'Trading Cards' })]), null, 'other category does not count')
const noYear = (n) => matched(n, { scanAnalysis: { matchStatus: 'exact', confidence: 90, bestMatch: { item: {} } } })
assert.equal(inferredSetTarget(current, [noYear(1), noYear(2), noYear(3)]), null, 'needs a year or season')
assert.equal(inferredSetTarget(current, [matched(1), matched(2), matched(3, { createdAt: '2026-11-21T11:00:00Z' })]), null, 'later scans are ignored')

// Printings sharing a number: follow the Collection of the cards just before.
const withCollection = (n, collection) => matched(n, { scanAnalysis: { matchStatus: 'exact', confidence: 90, bestMatch: { item: { dynamic_fields: { collection } } } } })
const cand = (id, collection) => ({ item: { item_id: id, dynamic_fields: { collection } } })
const candidates = [cand('base', 'Base'), cand('ref', 'Refractor')]
assert.equal(printingFromStackRun(candidates, current, [withCollection(1, 'Refractor'), withCollection(2, 'Refractor')]).item.item_id, 'ref')
assert.equal(printingFromStackRun(candidates, current, [withCollection(1, 'Refractor'), withCollection(2, 'Base')]), null, 'mixed run decides nothing')
assert.equal(printingFromStackRun(candidates, current, [withCollection(1, 'Refractor')]), null, 'needs two cards')
assert.equal(printingFromStackRun([cand('a', 'Refractor'), cand('b', 'Refractor')], current, [withCollection(1, 'Refractor'), withCollection(2, 'Refractor')]), null, 'two printings in that Collection stay undecided')
console.log('scan set inference ok')
