// Run with: node scripts/test-checklist-import.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Exercise the real parser without initializing the browser's database client.
const source = (await readFile(new URL('../src/lib/adminData.js', import.meta.url), 'utf8'))
  .replace("import { supabase } from './supabaseClient'", 'const supabase = null')
const { parseChecklist } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

for (const number of ['NNO', 'SP-JA', 'N/A', '1', 'BLLR-EN033', 'sw0001a', '02/60']) {
  for (const line of [`${number} Aaron Jones`, `#${number} Aaron Jones`, `${number}, Aaron Jones`, `Aaron Jones #${number}`, `${number}\tAaron Jones`]) {
    const [row] = parseChecklist(line)
    assert.equal(row.error, undefined, line)
    assert.equal(row.number, number, line)
    assert.equal(row.name, 'Aaron Jones', line)
  }
}

const [variant] = parseChecklist('Aaron Jones [Cracked Ice Ticket] #NNO /25')
assert.equal(variant.number, 'NNO')
assert.equal(variant.name, 'Aaron Jones')
assert.equal(variant.collection, 'Cracked Ice Ticket')
assert.equal(variant.serial, '/25')

const [sports] = parseChecklist('SP-JA Aaron Jones - Green Bay Packers RC')
assert.equal(sports.team, 'Green Bay Packers')
assert.equal(sports.rookie, true)
const [trading] = parseChecklist('NNO Sadion, the Timelord', { teams: false })
assert.equal(trading.name, 'Sadion, the Timelord')
const [lego] = parseChecklist('pha009, Mummy Warrior, 7306', { sets: true })
assert.deepEqual(lego.sets, [{ number: '7306', quantity: 1 }])

const repeated = parseChecklist('NNO Aaron Jones\nNNO Aaron Jones\nNNO Aaron Jones [Gold]')
assert.equal(repeated[1].error, 'Card NNO is listed twice')
assert.equal(repeated[2].error, undefined)
assert.equal(parseChecklist('NNO')[0].error, 'No card number')
assert.deepEqual(parseChecklist('$12.50\n+ Collection\n+ Wishlist\nUngraded'), [])
console.log('Checklist import regression checks passed.')
