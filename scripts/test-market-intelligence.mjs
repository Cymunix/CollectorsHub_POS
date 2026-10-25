// node scripts/test-market-intelligence.mjs
// Calculation tests for src/lib/marketMath.js (Market Intelligence and the
// LEGO missing-minifigure adjustment). Exits non-zero on any failure.
import assert from 'node:assert/strict'
import {
  toCents, medianCents, applyPercent, pricingGroupFor, legoGroupFromCondition, buyPercentFor,
  minifigCounts, legoAdjustment, simpleBaseline, DEFAULT_BUY_PERCENT,
} from '../src/lib/marketMath.js'
import { inspectionFacts, templateDescription } from '../src/lib/listingDescription.js'

let passed = 0
const test = (name, fn) => { fn(); passed += 1; console.log('ok -', name) }
const fig = (name, required, present, missing, price) => ({ name, required, present, missing, priceCents: price == null ? null : toCents(price) })

test('cents parsing avoids floating point', () => {
  assert.equal(toCents('$1,234.50'), 123450)
  assert.equal(toCents(0.1 + 0.2), 30)
  assert.equal(toCents('19.995'), 2000)
  assert.equal(toCents(''), null)
  assert.equal(toCents('abc'), null)
})

test('median of odd and even sets', () => {
  assert.equal(medianCents([500, 100, 300]), 300)
  assert.equal(medianCents([100, 201, 300, 400]), 251)
  assert.equal(medianCents([]), null)
})

test('percent applied once, with decimals', () => {
  assert.equal(applyPercent(16000, 80), 12800)
  assert.equal(applyPercent(999, 77.5), 774)
  assert.equal(applyPercent(null, 80), null)
})

test('spec example: $200 complete, two missing ($25, $15), 80%', () => {
  const result = legoAdjustment({ referenceCents: 20000, buyPercent: 80, minifigs: [fig('A', 1, 0, 1, 25), fig('B', 1, 0, 1, 15), fig('C', 1, 1, 0, 30)] })
  assert.equal(result.deductionCents, 4000)
  assert.equal(result.adjustedCents, 16000)
  assert.equal(result.baselineCents, 12800)
  assert.equal(result.deductionComplete, true)
  assert.equal(result.suggestedCondition, 'Used Incomplete')
})

test('all minifigures present: no deduction, not incomplete', () => {
  const result = legoAdjustment({ referenceCents: 20000, buyPercent: 80, minifigs: [fig('A', 1, 1, 0, 25), fig('B', 2, 2, 0, 15)] })
  assert.equal(result.deductionCents, 0)
  assert.equal(result.adjustedCents, 20000)
  assert.equal(result.baselineCents, 16000)
  assert.equal(result.suggestedCondition, null)
  assert.equal(result.unverified, 0)
})

test('one missing minifigure', () => {
  const result = legoAdjustment({ referenceCents: 10000, buyPercent: 75, minifigs: [fig('A', 1, 0, 1, 12.5), fig('B', 1, 1, 0, 5)] })
  assert.equal(result.deductionCents, 1250)
  assert.equal(result.adjustedCents, 8750)
  assert.equal(result.baselineCents, 6563)
})

test('duplicate minifigures: quantity multiplies the deduction', () => {
  const result = legoAdjustment({ referenceCents: 30000, buyPercent: 80, minifigs: [fig('Clone Trooper', 4, 1, 3, 8.25)] })
  assert.equal(result.missingCount, 3)
  assert.equal(result.deductionCents, 2475)
  assert.equal(result.adjustedCents, 27525)
  assert.equal(result.baselineCents, 22020)
})

test('missing minifigure with no price is flagged, never deducted as $0', () => {
  const result = legoAdjustment({ referenceCents: 20000, buyPercent: 80, minifigs: [fig('A', 1, 0, 1, null), fig('B', 1, 0, 1, 15)] })
  assert.equal(result.deductionComplete, false)
  assert.equal(result.unpriced.length, 1)
  assert.equal(result.deductionCents, 1500)
  assert.equal(result.missing.find((figure) => figure.name === 'A').deductionCents, null)
})

test('no complete-set median: no adjusted value and no baseline', () => {
  const result = legoAdjustment({ referenceCents: null, buyPercent: 80, minifigs: [fig('A', 1, 0, 1, 25)] })
  assert.equal(result.adjustedCents, null)
  assert.equal(result.baselineCents, null)
  assert.equal(result.deductionCents, 2500)
})

test('adjusted value never goes below zero', () => {
  const result = legoAdjustment({ referenceCents: 3000, buyPercent: 80, minifigs: [fig('A', 2, 0, 2, 25)] })
  assert.equal(result.adjustedCents, 0)
  assert.equal(result.baselineCents, 0)
})

test('changing the inspection recalculates', () => {
  const before = legoAdjustment({ referenceCents: 20000, buyPercent: 80, minifigs: [fig('A', 1, 0, 1, 25)] })
  const after = legoAdjustment({ referenceCents: 20000, buyPercent: 80, minifigs: [fig('A', 1, 1, 0, 25)] })
  assert.equal(before.baselineCents, 14000)
  assert.equal(after.baselineCents, 16000)
})

test('unverified minifigures are counted, not assumed present or missing', () => {
  assert.deepEqual(minifigCounts({ required: 3, present: 1, missing: 1 }), { required: 3, present: 1, missing: 1, unverified: 1 })
  assert.deepEqual(minifigCounts({ required: 2, present: 5, missing: 5 }), { required: 2, present: 2, missing: 0, unverified: 0 })
  const result = legoAdjustment({ referenceCents: 20000, buyPercent: 80, minifigs: [fig('A', 2, 0, 0, 25)] })
  assert.equal(result.unverified, 2)
  assert.equal(result.deductionCents, 0)
})

test('pricing groups: graded never mixed, raw cards share Ungraded, LEGO three groups', () => {
  assert.equal(pricingGroupFor({ category: 'Sports Cards', condition: 'Graded', gradingCompany: 'psa', grade: '10' }).key, 'graded:PSA:10')
  assert.equal(pricingGroupFor({ category: 'Sports Cards', condition: 'Graded', gradingCompany: 'BGS', grade: '9.5' }).key, 'graded:BGS:9.5')
  assert.equal(pricingGroupFor({ category: 'Trading Cards', condition: 'Graded', gradingCompany: 'PSA' }).key, null)
  assert.equal(pricingGroupFor({ category: 'Sports Cards', graded: true, gradingCompany: 'PSA', grade: '10.0' }).key, 'graded:PSA:10')
  assert.equal(pricingGroupFor({ category: 'Trading Cards', condition: 'Lightly Played' }).key, 'ungraded')
  assert.equal(pricingGroupFor({ category: 'Building Blocks', condition: 'Used Complete' }).key, 'used_complete')
  assert.equal(legoGroupFromCondition('New/Sealed'), 'sealed')
  assert.equal(legoGroupFromCondition('Pre-Owned 100%'), 'used_complete')
  assert.equal(legoGroupFromCondition('Pre-Owned - Missing Parts'), 'used_incomplete')
  assert.equal(legoGroupFromCondition('Used Incomplete'), 'used_incomplete')
})

test('buying percentage: LEGO rule, then category rule, then store default', () => {
  const policy = { default_percent: 80, category_percents: { 'Sports Cards': 70 }, lego_percents: { sealed: 85, used_incomplete: '' } }
  assert.equal(buyPercentFor(policy, { category: 'Building Blocks', legoGroup: 'sealed' }).percent, 85)
  assert.equal(buyPercentFor(policy, { category: 'Building Blocks', legoGroup: 'used_incomplete' }).percent, 80)
  assert.equal(buyPercentFor(policy, { category: 'Sports Cards' }).percent, 70)
  assert.equal(buyPercentFor(null, { category: 'Comics' }).percent, DEFAULT_BUY_PERCENT)
})

test('plain baseline from a median', () => {
  assert.equal(simpleBaseline({ referenceCents: 4999, buyPercent: 80 }), 3999)
  assert.equal(simpleBaseline({ referenceCents: null, buyPercent: 80 }), null)
})

test('listing description: only the facts, missing minifigures named, unchecked left out', () => {
  const figures = [{ name: 'Jake Raines', required: 1, present: 0, missing: 1, unverified: 0 }, { name: 'Mummy Warrior', required: 2, present: 1, missing: 1, unverified: 0 }, { name: 'Pharaoh Hotep', required: 1, present: 1, missing: 0, unverified: 0 }]
  const facts = inspectionFacts({ name: 'Scorpion Pyramid', condition: 'Used Incomplete', figures, research: { missing_accessories: 'Anubis staff', instructions: 'present', box: 'unknown', notes: 'PRIVATE: paid too much' } })
  const text = templateDescription(facts)
  assert.equal(text, 'Used Incomplete. Missing minifigures: Jake Raines, Mummy Warrior (1 of 2). Missing accessories: Anubis staff. Instructions included.')
  assert.ok(!JSON.stringify(facts).includes('PRIVATE'))
  assert.equal(facts.original_box, undefined)
  assert.ok(!JSON.stringify(facts).includes('not checked'))
})

test('listing description: all minifigures present', () => {
  const facts = inspectionFacts({ condition: 'Used Complete', figures: [{ name: 'A', required: 2, present: 2, missing: 0, unverified: 0 }], research: { box: 'missing' } })
  assert.equal(templateDescription(facts), 'Used Complete. All 2 minifigures are included. No original box.')
})

console.log(`\n${passed} tests passed`)
