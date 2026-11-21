// Run with: node scripts/test-scan-set-inference.mjs
import assert from 'node:assert/strict'
import { inferredSetTarget } from '../src/lib/scanSetInference.js'

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
console.log('scan set inference ok')
