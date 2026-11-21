// Run with: node scripts/test-scan-name-fallback.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

globalThis.scanSetTestClient = {}
const source = (await readFile(new URL('../src/lib/adminData.js', import.meta.url), 'utf8'))
  .replace("import { supabase } from './supabaseClient'", 'const supabase = globalThis.scanSetTestClient')
const { matchScanInTargetSet } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const item = (id, number, name) => ({ item_id: id, name, dynamic_fields: { card_number: number }, id_number: number, card_number: number })
const items = [item('a', '1', 'Connor Bedard'), item('b', '2', 'Macklin Celebrini'), item('c', '3', 'Connor McDavid'), item('d', '4', 'Connor McDavid')]
const run = (result) => matchScanInTargetSet({ result, target: {}, items })

// Number unreadable, name unique in the set: found by name, scored lower.
const byName = run({ subject: 'Macklin Celebrini', id_number: '' })
assert.equal(byName.matchStatus, 'exact')
assert.equal(byName.bestMatch.item.item_id, 'b')
assert.equal(byName.setCheck.numberFrom, 'name')

// Number not in the set but name unique: still found by name.
assert.equal(run({ subject: 'Connor Bedard', id_number: '99' }).bestMatch?.item.item_id, 'a')

// Name on two different numbers: no guess.
assert.equal(run({ subject: 'Connor McDavid', id_number: '' }).matchStatus, 'none')

// Single-word names are too weak.
assert.equal(run({ subject: 'Bedard', id_number: '' }).matchStatus, 'none')

// A readable number still wins and is not marked as name-found.
const byNumber = run({ subject: 'Macklin Celebrini', id_number: '2' })
assert.equal(byNumber.setCheck.numberFrom, 'ai')
assert.ok(byName.bestMatch.score < byNumber.bestMatch.score)
console.log('scan name fallback ok')
