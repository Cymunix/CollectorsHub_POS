// Run with: node scripts/test-rated-rookie-matching.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const items = [
  { item_id: 'hawes-base', name: 'Jackson Hawes', card_number: '357', season: '2025', release_year: 2025, dynamic_fields: { collection: 'Rated Rookies' } },
  { item_id: 'hawes-red', name: 'Jackson Hawes', card_number: '357', season: '2025', release_year: 2025, dynamic_fields: { collection: 'Rated Rookies - Press Proof Red' } },
  { item_id: 'hawes-optic', name: 'Jackson Hawes', card_number: '357', season: '2025', release_year: 2025, subset_id: 'optic', dynamic_fields: { collection: 'Rated Rookies' } },
  { item_id: 'jt-base', name: 'JT Tuimoloau', card_number: '398', season: '2025', release_year: 2025, dynamic_fields: { collection: 'Rated Rookies' } },
].map((item) => ({ category_id: 'sports', subset_id: 'donruss', ...item }))
const calls = []
globalThis.ratedRookieClient = {
  from(table) {
    let rows = table === 'items' ? items : table === 'subsets' ? [{ subset_id: 'donruss', name: 'Donruss Football' }, { subset_id: 'optic', name: 'Donruss Optic Football' }] : []
    const query = {
      select() { return query },
      eq(field, value) { rows = rows.filter((row) => row[field] === value); return query },
      in(field, values) { rows = rows.filter((row) => values.includes(row[field])); return query },
      or(filter) {
        calls.push(filter)
        const terms = [...filter.matchAll(/(name|subject)\.ilike\."%([^"%]+)%"/g)]
        if (terms.length) rows = rows.filter((row) => terms.some(([, field, term]) => String(row[field] || '').toLowerCase().includes(term.toLowerCase())))
        return query
      },
      limit() { return query },
      then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject) },
    }
    return query
  },
}
const source = (await readFile(new URL('../src/lib/adminData.js', import.meta.url), 'utf8'))
  .replace("import { supabase } from './supabaseClient'", 'const supabase = globalThis.ratedRookieClient')
const { matchRecognizedCard } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const base = { category: 'Sports Cards', subject: 'Jackson Hawes', id_number: '357', release_year: 2025, season: '2025', collection: 'Rated Rookie', uncertain_fields: [] }
const match = (card) => matchRecognizedCard({ categoryId: 'sports', ids: { subset_id: 'donruss' }, card: { ...base, ...card } })

for (const collection of ['Rated Rookie', 'Rated Rookies', 'RATED ROOKIES']) {
  const result = await match({ collection })
  assert.equal(result.status, 'exact')
  assert.equal(result.best.item.item_id, 'hawes-base')
  assert.equal(result.best.differences.length, 0)
  assert.equal(result.candidates.find((row) => row.item.item_id === 'hawes-red').exact, false)
  assert.equal(result.candidates.find((row) => row.item.item_id === 'hawes-optic').exact, false)
}
const red = await match({ collection: 'Rated Rookie - Press Proof Red' })
assert.equal(red.status, 'exact')
assert.equal(red.best.item.item_id, 'hawes-red')
assert.notEqual((await match({ collection: 'Rookie Kings' })).status, 'exact')
assert.notEqual((await match({ season: '2024' })).status, 'exact') // Real season disagreements still require review.
const jt = await match({ subject: 'JT TUIMOLOAU • DE', id_number: '398' })
assert.equal(jt.status, 'exact')
assert.equal(jt.best.item.item_id, 'jt-base')
assert.ok(calls.some((filter) => filter.includes('JT TUIMOLOAU') && !filter.includes('• DE')))
delete globalThis.ratedRookieClient
console.log('Rated Rookie matching regression checks passed.')
