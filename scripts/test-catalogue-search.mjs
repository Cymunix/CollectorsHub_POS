// Run with: node scripts/test-catalogue-search.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const rows = [
  ...Array.from({ length: 20 }, (_, index) => ({ item_id: `base-${index}`, name: 'Trevor Etienne', card_number: '369', dynamic_fields: { collection: 'Base' } })),
  { item_id: 'rated', name: 'Trevor Etienne', card_number: '369', dynamic_fields: { collection: 'Rated Rookie', set_name: 'Donruss Optic' } },
  { item_id: 'other-player', name: 'Other Player', dynamic_fields: { collection: 'Rated Rookie' } },
  { item_id: 'subject-only', subject: 'Trevor Etienne', card_number: '370', dynamic_fields: { collection: 'Rated Rookie' } },
]
const valueAt = (row, field) => field.split('->>').reduce((value, key) => value?.[key], row)
const like = (value, pattern) => new RegExp(`^${pattern.split('%').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(String(value || ''))
globalThis.catalogueSearchTestClient = {
  from(table) {
    let matches = table === 'items' ? [...rows] : []
    let limit = Infinity
    let offset = 0
    const query = {
      select() { return query },
      ilike(field, pattern) { matches = matches.filter((row) => like(valueAt(row, field), pattern)); return query },
      in(field, values) { matches = matches.filter((row) => values.includes(row[field])); return query },
      or(expression) {
        const alternatives = expression.split(',').map((part) => {
          const [, field, pattern] = part.match(/^(.+)\.ilike\."(.*)"$/)
          return { field, pattern }
        })
        matches = matches.filter((row) => alternatives.some(({ field, pattern }) => like(valueAt(row, field), pattern)))
        return query
      },
      limit(value) { limit = value; return query },
      order(field) { matches.sort((a, b) => String(a[field]).localeCompare(String(b[field]))); return query },
      range(from, to) { offset = from; limit = to - from + 1; return query },
      then(resolve, reject) { return Promise.resolve({ data: matches.slice(offset, offset + limit), error: null }).then(resolve, reject) },
    }
    return query
  },
}

// Exercise the real search queries with an in-memory catalogue; candidate
// enrichment (photos and pricing) is unrelated to matching these words.
const source = (await readFile(new URL('../src/lib/registerBackend.js', import.meta.url), 'utf8'))
  .split('// Catalogue rows -> register candidates')[0]
  .replace(/^import .*\r?\n/gm, '')
const moduleSource = `const supabase = globalThis.catalogueSearchTestClient;\n${source}\nasync function buildDesktopCatalogueCandidates(rows) { return rows }`
const { searchDesktopTradeCatalogue } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`)
const ids = async (query) => (await searchDesktopTradeCatalogue(query)).map((row) => row.item_id)

assert.deepEqual(await ids('Trevor Etienne rated Rookie'), ['rated', 'subject-only'])
assert.deepEqual(await ids('Rated Rookie Trevor Etienne'), ['rated', 'subject-only'])
assert.deepEqual(await ids('Trevor Etienne Rated Rookie #369'), ['rated'])
assert.deepEqual(await ids('Trevor Etienne Donruss Optic'), ['rated'])
assert.deepEqual(await ids('Trevor Etienne nonexistent'), [])
assert.equal((await ids('Trevor Etienne')).length, 15)
assert.deepEqual(await ids('x'), [])

// Base is stored after more than a page of matching coloured parallels.
rows.unshift(...Array.from({ length: 205 }, (_, index) => ({
  item_id: `parallel-${String(index).padStart(3, '0')}`,
  name: 'Trevor Etienne',
  dynamic_fields: { collection: 'Rated Rookie', parallel: `Colour ${index}` },
})))
rows.push({ item_id: 'zz-rated-base', name: 'Trevor Etienne', dynamic_fields: { collection: 'Rated Rookie', parallel: 'Base' } })
const allPrintings = await searchDesktopTradeCatalogue('Trevor Etienne Rated Rookie', { allMatches: true })
assert.equal(allPrintings.length, 208)
assert.ok(allPrintings.some((row) => row.item_id === 'zz-rated-base'))
assert.equal(new Set(allPrintings.map((row) => row.item_id)).size, allPrintings.length)
assert.equal((await ids('Trevor Etienne Rated Rookie')).length, 15)
rows.push(
  { item_id: 'hawes-rated-base', name: 'Jackson Hawes', dynamic_fields: { collection: 'Rated Rookie', parallel: 'Base' } },
  { item_id: 'hawes-rated-blue', name: 'Jackson Hawes', dynamic_fields: { collection: 'Rated Rookies', parallel: 'Blue' } },
  { item_id: 'hawes-rated-red', name: 'Jackson Hawes', dynamic_fields: { collection: 'Rated Rookies - Press Proof Red' } },
  { item_id: 'hawes-other-rookie', name: 'Jackson Hawes Rookie', description: 'Rated Rookies', dynamic_fields: { collection: 'Rookie Kings' } },
  { item_id: 'hawes-name-only', name: 'Jackson Hawes Rated Rookies', dynamic_fields: { collection: 'Base' } },
  { item_id: 'wrong-player-rated', name: 'Other Player', dynamic_fields: { collection: 'Rated Rookie' } },
)
for (const query of ['Jackson Hawes Rated Rookies', 'Jackson Hawes Rated Rookie', 'Rated Rookies Jackson Hawes']) {
  assert.deepEqual(await ids(query), ['hawes-rated-base', 'hawes-rated-blue', 'hawes-rated-red'])
  const matches = await searchDesktopTradeCatalogue(query, { allMatches: true })
  assert.deepEqual(matches.map((row) => row.item_id), ['hawes-rated-base', 'hawes-rated-blue', 'hawes-rated-red'])
}
assert.deepEqual(await ids('Jackson Hawes Rated Rookies Blue'), ['hawes-rated-blue'])

delete globalThis.catalogueSearchTestClient
console.log('Catalogue search regression checks passed.')
