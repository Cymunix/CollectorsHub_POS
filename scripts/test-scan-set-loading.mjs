// Run with: node scripts/test-scan-set-loading.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const calls = []
let failItems = false
const items = [
  { item_id: 'base', release_year: 2024, series: '1', dynamic_fields: { collection: 'Base' } },
  { item_id: 'gold', release_year: 2024, series: '1', dynamic_fields: { collection: 'Gold' } },
  { item_id: 'series2', release_year: 2024, series: '2', dynamic_fields: { collection: 'Base' } },
]
globalThis.scanSetTestClient = {
  from(table) {
    const query = {
      select: () => query, eq: () => query, order: () => query, range: () => query,
      then(resolve, reject) {
        calls.push(table)
        return Promise.resolve(table === 'items'
          ? failItems ? { error: new Error('database unavailable') } : { data: items }
          : { data: [{ subcategory_id: 'hockey', name: 'Hockey' }] }).then(resolve, reject)
      },
    }
    return query
  },
}
const source = (await readFile(new URL('../src/lib/adminData.js', import.meta.url), 'utf8'))
  .replace("import { supabase } from './supabaseClient'", 'const supabase = globalThis.scanSetTestClient')
const { loadTargetSetItems, loadScanSetOptions } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

await Promise.all([1, 2].map(() => loadScanSetOptions({ category: 'Sports Cards', categoryId: 'sports' })))
assert.deepEqual(calls, ['subcategories'], 'Scanner options share a request and omit unused global lists')
calls.length = 0
const target = { categoryId: 'sports', subcategoryId: 'hockey', subsetId: 'set', season: '2024-25' }
const [whole, base, gold] = await Promise.all([
  loadTargetSetItems(target),
  loadTargetSetItems({ ...target, series: '1', collection: 'Base' }),
  loadTargetSetItems({ ...target, collection: 'Gold' }),
])
assert.deepEqual(calls, ['items'], 'All collection views share the same database request')
assert.equal(whole.length, 3)
assert.deepEqual(base.map((item) => item.item_id), ['base'])
assert.deepEqual(gold.map((item) => item.item_id), ['gold'])
await loadTargetSetItems(target, { refresh: true })
assert.equal(calls.length, 2, 'Explicit refresh fetches fresh items')
failItems = true
await assert.rejects(loadTargetSetItems(target, { refresh: true }), /database unavailable/)
failItems = false
assert.equal((await loadTargetSetItems(target)).length, 3, 'Failed loads can be retried')
delete globalThis.scanSetTestClient
console.log('Scan set loading regression checks passed.')
