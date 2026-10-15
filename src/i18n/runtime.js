import fr from './fr.json'

// On-screen translation. The app's text is written in English; when French is chosen,
// this swaps English text for the French in fr.json as screens appear (text, placeholders,
// tooltips, labels and confirm/alert messages). Text with values mixed in uses patterns
// like "{0} items" -> "{0} articles". Anything without a translation stays in English.
// Data (names, prices, notes people type) is never translated: it doesn't match the dictionary.

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const norm = (s) => s.replace(/\s+/g, ' ').trim()
const exact = new Map()
const patterns = []
for (const [en, fr2] of Object.entries(fr)) {
  if (!fr2) continue
  const key = norm(decode(en))
  const value = decode(fr2)
  if (/\{\d+\}/.test(key)) {
    const parts = key.split(/(\{\d+\})/)
    const order = []
    const source = parts.map((part) => { const m = part.match(/^\{(\d+)\}$/); if (m) { order.push(Number(m[1])); return '(.+?)' } return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }).join('')
    // Only patterns with real words, so "{0}{1}" never matches everything.
    if (key.replace(/\{\d+\}/g, '').replace(/[^A-Za-z]/g, '').length >= 3) patterns.push({ re: new RegExp(`^${source}$`), order, value, weight: key.length })
  } else exact.set(key, value)
}
patterns.sort((a, b) => b.weight - a.weight)

export function translateText(text) {
  const key = norm(text)
  if (!key) return null
  if (exact.has(key)) return exact.get(key)
  // "Label:" / "Label…" variants of a known label.
  const tail = key.match(/^(.*?)([:…]|\.{3})$/)
  if (tail && exact.has(tail[1])) return exact.get(tail[1]) + tail[2]
  for (const p of patterns) {
    const m = key.match(p.re)
    if (m) return p.value.replace(/\{(\d+)\}/g, (_, n) => { const i = p.order.indexOf(Number(n)); const v = i >= 0 ? m[i + 1] : ''; return translateText(v) ?? v })
  }
  return null
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'NOSCRIPT'])
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt']
let language = 'en'
let observer = null
const textOriginals = new Map() // node -> { en, fr }
const attrOriginals = new Map() // element -> { attr: { en, fr } }

function skipped(node) {
  for (let el = node.nodeType === 1 ? node : node.parentElement; el; el = el.parentElement) {
    if (SKIP.has(el.tagName) || el.isContentEditable || el.hasAttribute?.('data-no-translate')) return true
  }
  return false
}
function translateTextNode(node) {
  const seen = textOriginals.get(node)
  if (seen && node.data === seen.fr) return
  const fr2 = translateText(node.data)
  if (fr2 == null || skipped(node)) { textOriginals.delete(node); return }
  const lead = node.data.match(/^\s*/)[0]
  const trail = node.data.match(/\s*$/)[0]
  const value = lead + fr2 + trail
  textOriginals.set(node, { en: node.data, fr: value })
  if (node.data !== value) node.data = value
  if (node.parentElement) toFit.add(node.parentElement)
}

// French runs 20–30% longer than English. Where translated text no longer fits its box
// (fixed-width buttons, tabs, chips, table headers), its text is shrunk a little, down to 80%,
// and as a last resort allowed to wrap onto a second line. English is never touched.
const toFit = new Set()
const fitted = new Map() // element whose font was changed -> its original inline styles
let fitQueued = false
const overflowing = (el) => el.scrollWidth > el.clientWidth + 1
// The box that cuts this element's text off, if any: the element itself, or a parent it spills out of
// (not a parent that overflows because of some other child).
function clippingBox(el) {
  const own = el.getBoundingClientRect()
  for (let box = el, i = 0; box && i < 4; box = box.parentElement, i += 1) {
    if (box === document.body) return null
    const cs = getComputedStyle(box)
    // Scrolling areas (tables, lists, pages) are meant to scroll, not shrink.
    if (/auto|scroll/.test(cs.overflowX)) return null
    if (!(box.clientWidth > 0 && box.clientWidth < 600 && overflowing(box) && box.scrollWidth < box.clientWidth * 1.8)) continue
    if (box === el || overflowing(el)) return box
    const rect = box.getBoundingClientRect()
    if (own.right > rect.right + 1 || own.left < rect.left - 1) return box
  }
  return null
}
// How many lines an element's text takes up.
function lineCount(el) {
  const range = document.createRange()
  range.selectNodeContents(el)
  const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)))
  return tops.size
}
const COMPACT = 'button, [role="tab"], th, label, .chip, [class*="pill"], [class*="tab"], [class*="badge"], [class*="kicker"]'
// A button or tab label that fit on one line in English but wraps in French: try a slightly
// smaller font first; if it still wraps, leave it at its normal size, wrapped.
function unwrapCompact(el) {
  const control = el.closest(COMPACT)
  if (!control || control.contains(el) === false || lineCount(el) < 2) return
  const saved = { fontSize: el.style.fontSize, whiteSpace: el.style.whiteSpace, lineHeight: el.style.lineHeight, boxWhiteSpace: el.style.whiteSpace, box: el }
  const base = parseFloat(getComputedStyle(el).fontSize) || 14
  for (const scale of [0.93, 0.86]) {
    el.style.fontSize = `${(base * scale).toFixed(1)}px`
    if (lineCount(el) < 2) { fitted.set(el, saved); return }
  }
  el.style.fontSize = saved.fontSize
}
function fitElement(el) {
  if (!el.isConnected || fitted.has(el) || skipped(el)) return
  if (el.clientWidth === 0) return
  const box = clippingBox(el)
  if (!box) { unwrapCompact(el); return }
  const target = el
  const saved = { fontSize: target.style.fontSize, whiteSpace: target.style.whiteSpace, lineHeight: target.style.lineHeight, boxWhiteSpace: box.style.whiteSpace, box }
  fitted.set(target, saved)
  const base = parseFloat(getComputedStyle(target).fontSize) || 14
  for (const scale of [0.93, 0.86, 0.8]) {
    target.style.fontSize = `${(base * scale).toFixed(1)}px`
    if (!overflowing(box)) return
  }
  target.style.whiteSpace = 'normal'
  target.style.lineHeight = '1.15'
  box.style.whiteSpace = 'normal'
}
function unfitAll() {
  fitted.forEach((saved, el) => {
    el.style.fontSize = saved.fontSize
    el.style.whiteSpace = saved.whiteSpace
    el.style.lineHeight = saved.lineHeight
    saved.box.style.whiteSpace = saved.boxWhiteSpace
  })
  fitted.clear()
}
function queueFit() {
  if (fitQueued || language !== 'fr') return
  fitQueued = true
  requestAnimationFrame(() => {
    fitQueued = false
    const batch = [...toFit]
    toFit.clear()
    batch.forEach(fitElement)
    const inputs = [...placeholdersToFit]
    placeholdersToFit.clear()
    inputs.forEach(fitPlaceholder)
  })
}
// Something was added or removed (a badge, a number loading in): French text near it may no
// longer fit, so check the translated text in that part of the screen again.
function recheckAround(target) {
  const scope = target?.parentElement || target
  if (!scope || scope === document.body || scope.nodeType !== 1) return
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(), n = 0; node && n < 300; node = walker.nextNode(), n += 1) {
    if (textOriginals.has(node) && node.parentElement) toFit.add(node.parentElement)
  }
}
let resizeTimer = null
function refitAll() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (language !== 'fr') return
    unfitAll()
    textOriginals.forEach((_, node) => { if (!node.isConnected) textOriginals.delete(node); else if (node.parentElement) toFit.add(node.parentElement) })
    attrOriginals.forEach((attrs, el) => { if (!el.isConnected) attrOriginals.delete(el); else if (attrs.placeholder) placeholdersToFit.add(el) })
    queueFit()
  }, 150)
}
function translateAttrs(el) {
  for (const attr of ATTRS) {
    if (!el.hasAttribute(attr)) continue
    const current = el.getAttribute(attr)
    const saved = attrOriginals.get(el)?.[attr]
    if (saved && current === saved.fr) continue
    const fr2 = translateText(current)
    if (fr2 == null) continue
    attrOriginals.set(el, { ...(attrOriginals.get(el) || {}), [attr]: { en: current, fr: fr2 } })
    el.setAttribute(attr, fr2)
    if (attr === 'placeholder') placeholdersToFit.add(el)
  }
}

// Placeholders can't wrap, so a French one that's wider than its box gets a smaller placeholder font.
const placeholdersToFit = new Set()
let measureCanvas = null
function ensurePlaceholderStyles() {
  if (document.getElementById('i18n-fit-styles')) return
  const style = document.createElement('style')
  style.id = 'i18n-fit-styles'
  style.textContent = '.i18n-ph-1::placeholder{font-size:.88em}.i18n-ph-2::placeholder{font-size:.78em}'
  document.head.appendChild(style)
}
function fitPlaceholder(el) {
  el.classList.remove('i18n-ph-1', 'i18n-ph-2')
  if (!el.isConnected || !el.placeholder || el.clientWidth === 0) return
  const cs = getComputedStyle(el)
  measureCanvas = measureCanvas || document.createElement('canvas')
  const ctx = measureCanvas.getContext('2d')
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  const width = ctx.measureText(el.placeholder).width
  if (width <= room) return
  ensurePlaceholderStyles()
  el.classList.add(width * 0.88 <= room ? 'i18n-ph-1' : 'i18n-ph-2')
}
function translateTree(root) {
  if (!root) return
  if (root.nodeType === 3) { translateTextNode(root); return }
  if (root.nodeType !== 1 || skipped(root)) return
  translateAttrs(root)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 3) { if (/[A-Za-z]/.test(node.data)) translateTextNode(node) } else translateAttrs(node)
  }
}

const nativeConfirm = window.confirm.bind(window)
const nativeAlert = window.alert.bind(window)
const nativePrompt = window.prompt.bind(window)
const tr = (message) => (language === 'fr' && typeof message === 'string' ? (translateText(message) ?? message) : message)

export function setLanguage(next) {
  const lang = next === 'fr' ? 'fr' : 'en'
  if (lang === language) return
  language = lang
  document.documentElement.lang = lang === 'fr' ? 'fr-CA' : 'en-CA'
  try { window.localStorage.setItem('pos-language', lang) } catch {}
  if (lang === 'fr') {
    window.confirm = (message) => nativeConfirm(tr(message))
    window.alert = (message) => nativeAlert(tr(message))
    window.prompt = (message, value) => nativePrompt(tr(message), value)
    translateTree(document.body)
    queueFit()
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'characterData') translateTextNode(m.target)
        else if (m.type === 'attributes') translateAttrs(m.target)
        else {
          m.addedNodes.forEach(translateTree)
          recheckAround(m.target)
        }
      }
      queueFit()
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS })
    window.addEventListener('resize', refitAll)
  } else {
    observer?.disconnect()
    observer = null
    window.removeEventListener('resize', refitAll)
    unfitAll()
    toFit.clear()
    placeholdersToFit.clear()
    document.querySelectorAll('.i18n-ph-1, .i18n-ph-2').forEach((el) => el.classList.remove('i18n-ph-1', 'i18n-ph-2'))
    window.confirm = nativeConfirm
    window.alert = nativeAlert
    window.prompt = nativePrompt
    // Put the English back on everything still on screen.
    textOriginals.forEach((value, node) => { if (node.isConnected && node.data === value.fr) node.data = value.en })
    attrOriginals.forEach((attrs, el) => { if (el.isConnected) Object.entries(attrs).forEach(([attr, value]) => { if (el.getAttribute(attr) === value.fr) el.setAttribute(attr, value.en) }) })
    textOriginals.clear()
    attrOriginals.clear()
  }
}
export const currentLanguage = () => language
// The last language used on this computer, for the sign-in screen (before anyone is signed in).
export function deviceLanguage() { try { return window.localStorage.getItem('pos-language') === 'fr' ? 'fr' : 'en' } catch { return 'en' } }
