// Run with: node scripts/test-scan-orientation.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const adminSource = await readFile(new URL('../src/AdminWorkspace.jsx', import.meta.url), 'utf8')
const policies = adminSource.slice(adminSource.indexOf('export function needsSideCheck('), adminSource.indexOf('function createLocalId('))
const policyContext = vm.createContext({})
vm.runInContext(policies.replaceAll('export function', 'function'), policyContext)
const weakCard = { category: 'Sports Cards', frontImage: 'front', backImage: 'back', feed: { checkRotation: true, frontBackBy: 'text', words: { front: 1, back: 40 } } }
assert.equal(policyContext.needsUprightCheck(weakCard).front, true)
assert.equal(policyContext.needsUprightCheck({ ...weakCard, feed: { ...weakCard.feed, checkRotation: false } }).front, true)
assert.equal(policyContext.needsUprightCheck({ ...weakCard, feed: { ...weakCard.feed, adjusted: true } }), null)

const mainSource = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8')
const start = mainSource.indexOf("ipcMain.handle('ai:recognize-card'")
const handlerSource = mainSource.slice(start, mainSource.indexOf("ipcMain.handle('ai:warm-up'", start))
let handler
let calls = []
let orientationError = false
const jobs = new Map()
const context = vm.createContext({
  AbortController,
  ipcMain: { handle(name, callback) { handler = callback } },
  recognitionJobs: jobs,
  resolveScanImagePath: (image) => image,
  checkCardImages: async () => {
    calls.push('orientation')
    if (orientationError) throw new Error('Orientation failed')
    return { images: { front: 'upright-front', back: 'upright-back' }, turns: { front: 90, back: 0 }, sidesSwapped: true, changed: true }
  },
  cardRecognition: {
    id: 'test', label: 'Test',
    identifyCard: async (paths) => { calls.push({ mode: 'identify', ...paths }); return { result: { subject: 'Test Player' } } },
    recognizeCard: async (paths) => { calls.push({ mode: 'full', ...paths }); return { result: { subject: 'Test Player' } } },
  },
})
vm.runInContext(handlerSource, context)
for (const mode of ['identify', 'full']) {
  calls = []
  const reply = await handler(null, { jobId: 'job', front: 'sideways-front', back: 'sideways-back', mode, checkUpright: { front: true } })
  assert.equal(reply.ok, true)
  assert.equal(calls[0], 'orientation')
  assert.equal(calls[1].mode, mode)
  assert.equal(calls[1].frontPath, 'upright-front')
  assert.equal(calls[1].backPath, 'upright-back')
  assert.equal(reply.orientation.images.front, 'upright-front')
  assert.equal(reply.sidesSwapped, true)
  assert.equal(jobs.size, 0)
}
calls = []
const unchanged = await handler(null, { front: 'front', mode: 'identify' })
assert.equal(unchanged.orientation, null)
assert.equal(calls.length, 1)
assert.equal(calls[0].frontPath, 'front')
orientationError = true
calls = []
const failed = await handler(null, { jobId: 'failed-job', front: 'front', mode: 'identify', checkSides: true })
assert.equal(failed.ok, false)
assert.equal(calls.length, 1)
assert.equal(jobs.size, 0)
// The register must request the same checks and retain corrected previews
// before its Buy / Trade-In and sale callers consume the scan event.
const registerSource = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8')
const registerStart = registerSource.indexOf('  async function recognizeScanEvent(')
const registerFunction = registerSource.slice(registerStart, registerSource.indexOf('  // FastFoto stacks:', registerStart))
let registerRequest
const registerContext = vm.createContext({
  createId: () => 'register-job',
  needsSideCheck: policyContext.needsSideCheck,
  needsUprightCheck: policyContext.needsUprightCheck,
  desktopApi: () => ({ recognizeCard: async (request) => {
    registerRequest = request
    return { ok: true, result: { category: 'Sports Cards', subject: 'Jackson Hawes' }, orientation: { images: { front: { path: 'upright-front', url: 'upright-front-url' }, back: { path: 'upright-back', url: 'upright-back-url' } } } }
  } }),
  analyseRecognizedCard: async () => ({ scanAnalysis: { matchStatus: 'exact' } }),
})
vm.runInContext(registerFunction, registerContext)
const registerEvent = { image: { path: 'sideways-front' }, backImage: { path: 'sideways-back' }, feed: weakCard.feed }
const registerResult = await registerContext.recognizeScanEvent(registerEvent)
assert.equal(registerRequest.mode, 'identify')
assert.equal(registerRequest.checkUpright.front, true)
assert.equal(registerRequest.category, 'Sports Cards')
assert.equal(registerEvent.image.url, 'upright-front-url')
assert.equal(registerEvent.backImage.url, 'upright-back-url')
assert.equal(registerResult.scanAnalysis.matchStatus, 'exact')
console.log('Scan orientation regression checks passed (Scan Centre and register).')
