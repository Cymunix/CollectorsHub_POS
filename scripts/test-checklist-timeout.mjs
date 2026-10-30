// Run with: node scripts/test-checklist-timeout.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = (await readFile(new URL('../src/lib/adminData.js', import.meta.url), 'utf8'))
  .replace("import { supabase } from './supabaseClient'", 'const supabase = globalThis.checklistTestClient')
const timeout = { code: '57014', message: 'canceling statement due to statement timeout' }
let mode = 'split'
let calls = []
let saved = []
let links = []
globalThis.checklistTestClient = {
  from(table) {
    if (table === 'categories') {
      const query = { select: () => query, ilike: () => query, limit: () => query, maybeSingle: async () => ({ data: { category_id: 'category' } }) }
      return query
    }
    return {
      insert(rows) {
        const run = async () => {
          calls.push({ table, count: rows.length })
          if (mode === 'network') return { error: { message: 'Failed to fetch' } }
          if (mode === 'single' || rows.length > 3) return { error: timeout }
          if (table === 'item_properties') { links.push(...rows); return { data: null } }
          const data = rows.map((row) => ({ ...row, item_id: `id-${row.card_number}` }))
          saved.push(...data)
          return { data }
        }
        return { select: run, then: (resolve, reject) => run().then(resolve, reject) }
      },
    }
  },
}
const { createChecklistPlaceholders, writeChecklistBatch } = await import(`data:text/javascript;base64,${Buffer.from(`${source}\nexport { writeChecklistBatch }`).toString('base64')}`)
const rows = Array.from({ length: 125 }, (_, i) => ({ number: String(i + 1), name: `Card ${i + 1}` }))
const input = { category: 'Trading Cards', ids: { subcategory_id: 'sub', property_id: 'property' }, rows }
const result = await createChecklistPlaceholders(input)
assert.equal(result.created.length, 125)
assert.equal(saved.length, 125)
assert.equal(new Set(saved.map((row) => row.item_id)).size, 125)
assert.equal(links.length, 125)
assert.ok(calls.some((call) => call.count === 25))
assert.ok(calls.some((call) => call.count <= 3))

// Rechecking after successful writes must skip existing items.
calls = []
assert.equal((await createChecklistPlaceholders({ ...input, existing: saved })).created.length, 0)
assert.equal(calls.length, 0)

// Ambiguous failures and even single-row timeouts terminate without looping.
for (const failureMode of ['network', 'single']) {
  mode = failureMode
  calls = []
  await assert.rejects(createChecklistPlaceholders({ ...input, rows: rows.slice(0, 1) }), /stopped after creating 0/)
  assert.equal(calls.length, 1)
}

// A later failure must never replay the already committed first half.
const committed = []
await assert.rejects(writeChecklistBatch([1, 2, 3, 4], async (part) => {
  if (part.length > 2) return { error: timeout }
  if (part[0] === 3) return { error: { message: 'permission denied' } }
  committed.push(...part)
  return { data: part }
}), (error) => error.message === 'permission denied')
assert.deepEqual(committed, [1, 2])
delete globalThis.checklistTestClient
console.log('Checklist timeout regression checks passed.')
