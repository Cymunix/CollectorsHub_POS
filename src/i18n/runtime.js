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
  }
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
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'characterData') translateTextNode(m.target)
        else if (m.type === 'attributes') translateAttrs(m.target)
        else m.addedNodes.forEach(translateTree)
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS })
  } else {
    observer?.disconnect()
    observer = null
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
