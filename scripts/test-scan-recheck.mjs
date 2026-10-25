// Run with: node scripts/test-scan-recheck.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../src/StoreScanIntake.jsx', import.meta.url), 'utf8')
const eligibility = source.match(/^const canRecheck = .*$/m)[0]
const start = source.indexOf('  function recheckCards(')
const recheck = source.slice(start, source.indexOf('  async function addAllReady(', start))
const original = ['ready', 'choose', 'unmatched', 'failed', 'added', 'skipped', 'adding', 'analysing', 'queued'].map((status) => ({
  id: status, status, frontImage: { url: `${status}.png` }, backImage: { url: `${status}-back.png` },
  result: { subject: 'Old reading' }, item: { item_id: 'old-match' }, candidates: ['old'], error: 'Old error',
  sellPrice: '12.50', buyPrice: '4', quantity: 3, condition: 'Near Mint', conditionTouched: true,
}))
let cards = original
let runs = 0
const context = vm.createContext({
  aiState: 'ready',
  save: (update) => { cards = update(cards) },
  setSearching() {}, setError() {}, setMessage() {},
  analyseQueued() { runs += 1 },
})
vm.runInContext(`${eligibility}\n${recheck}`, context)
context.recheckCards('ready')
assert.equal(cards[0].status, 'queued')
assert.equal(cards[1], original[1])
context.recheckCards()
for (const card of cards.slice(0, 4)) {
  assert.equal(card.status, 'queued')
  assert.equal(card.recheckOrientation, true)
  assert.equal(card.result, null)
  assert.equal(card.item, null)
  assert.equal(card.candidates.length, 0)
  assert.equal(card.error, '')
  for (const key of ['sellPrice', 'buyPrice', 'quantity', 'condition', 'conditionTouched', 'frontImage', 'backImage']) {
    assert.equal(card[key], original.find((entry) => entry.id === card.id)[key])
  }
}
for (let index = 4; index < cards.length; index += 1) assert.equal(cards[index], original[index])
context.recheckCards()
assert.equal(runs, 2) // Already queued cards are not restarted or duplicated.
cards = original
context.aiState = 'error'
context.recheckCards()
assert.equal(cards, original)
assert.equal(runs, 2)
console.log('Scan recheck regression checks passed.')
