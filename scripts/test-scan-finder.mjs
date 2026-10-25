// Run with: node scripts/test-scan-finder.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const requests = []
let itemResponses = []
globalThis.scanFinderTestClient = {
  from(table) {
    const calls = []
    const query = new Proxy({}, {
      get(target, method) {
        if (method === 'then') return (resolve, reject) => {
          requests.push({ table, calls })
          return Promise.resolve({ data: table === 'categories' ? { category_id: 'cards' } : itemResponses.shift() || [], error: null }).then(resolve, reject)
        }
        return (...args) => { calls.push([method, ...args]); return query }
      },
    })
    return query
  },
}
const source = (await readFile(new URL('../src/lib/adminData.js', import.meta.url), 'utf8'))
  .replace("import { supabase } from './supabaseClient'", 'const supabase = globalThis.scanFinderTestClient')
const { findItemsByCardNumber, loadScanFinderCollections } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

await findItemsByCardNumber({}, 'Sports Cards', { name: 'Aaron', collection: 'Gold', franchiseId: 'f', subsetId: 's' })
let queries = requests.filter((request) => request.table === 'items')
assert.equal(queries.length, 1)
const filter = queries[0].calls.find(([method]) => method === 'or')[1]
assert.ok(filter.includes('or(name.ilike."%Aaron%",subject.ilike."%Aaron%")'))
assert.ok(filter.includes('dynamic_fields->>collection.ilike."Gold"'))
assert.ok(queries[0].calls.some(([method, column, value]) => method === 'eq' && column === 'franchise_id' && value === 'f'))
assert.ok(queries[0].calls.some(([method, column, value]) => method === 'eq' && column === 'subset_id' && value === 's'))

requests.length = 0
await findItemsByCardNumber({}, 'Sports Cards', { cardNumber: '12', name: 'Aaron', collection: 'Base' })
queries = requests.filter((request) => request.table === 'items')
assert.equal(queries.length, 2) // Empty exact search falls back to number contains.
assert.ok(queries[0].calls.find(([method]) => method === 'or')[1].includes('card_number.ilike."12",card_number.ilike."12/%"'))
for (const query of queries) {
  const combined = query.calls.find(([method]) => method === 'or')[1]
  assert.ok(combined.includes('name.ilike."%Aaron%"'))
  assert.match(combined, /dynamic_fields->>collection\.is\.null/)
  assert.match(combined, /dynamic_fields->>collection\.eq\.""/)
}

requests.length = 0
await findItemsByCardNumber({}, 'Sports Cards')
assert.equal(requests.length, 0)
itemResponses = [[{ collection: 'Gold' }, { collection: 'gold' }, { collection: null }, { collection: 'Base' }]]
assert.deepEqual(await loadScanFinderCollections({ categoryId: 'cards', name: 'Aaron' }), ['Base', 'Gold'])
assert.ok(requests.at(-1).calls.find(([method]) => method === 'or')[1].includes('or(name.ilike."%Aaron%",subject.ilike."%Aaron%")'))

requests.length = 0
itemResponses = [[], [{ collection: 'Silver' }]]
assert.deepEqual(await loadScanFinderCollections({ categoryId: 'cards', cardNumber: 'NNO', name: 'Aaron', franchiseId: 'f', subsetId: 's' }), ['Silver'])
assert.equal(requests.length, 2)
assert.ok(requests[0].calls.find(([method]) => method === 'or')[1].includes('card_number.ilike."NNO",card_number.ilike."NNO/%"'))
assert.ok(requests[1].calls.find(([method]) => method === 'or')[1].includes('card_number.ilike."%NNO%"'))
for (const request of requests) {
  assert.ok(request.calls.find(([method]) => method === 'or')[1].includes('name.ilike."%Aaron%"'))
  assert.ok(request.calls.some(([method, column, value]) => method === 'eq' && column === 'franchise_id' && value === 'f'))
  assert.ok(request.calls.some(([method, column, value]) => method === 'eq' && column === 'subset_id' && value === 's'))
}

requests.length = 0
assert.deepEqual(await loadScanFinderCollections({ categoryId: 'cards' }), [])
assert.equal(requests.length, 0)

itemResponses = [Array.from({ length: 1000 }, () => ({ collection: 'Gold' })), [{ collection: 'Silver' }]]
assert.deepEqual(await loadScanFinderCollections({ categoryId: 'cards', cardNumber: '12' }), ['Gold', 'Silver'])
assert.deepEqual(requests.at(-1).calls.find(([method]) => method === 'range'), ['range', 1000, 1999])
delete globalThis.scanFinderTestClient
console.log('Scan finder regression checks passed.')
