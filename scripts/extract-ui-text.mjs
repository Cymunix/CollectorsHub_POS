// Collects the app's on-screen English text into src/i18n/strings.json, for translation.
// Run: node scripts/extract-ui-text.mjs   (re-run after adding screens; strings that still
// need French are listed in src/i18n/missing-fr.json).
// Uses the TypeScript parser to read the JSX: text between tags, UI attributes
// (placeholder, title, aria-label, alt, label) and sentence-like strings/templates.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const files = []
const walkDir = (dir) => { for (const name of fs.readdirSync(dir)) { const full = path.join(dir, name); if (fs.statSync(full).isDirectory()) { if (!['i18n', 'node_modules'].includes(name)) walkDir(full) } else if (/\.(jsx|js)$/.test(name) && !/devPreview|supabaseClient/.test(name)) files.push(full) } }
walkDir(path.join(root, 'src'))

const UI_ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label', 'hint', 'note', 'text', 'caption', 'subtitle', 'heading', 'description', 'message', 'emptyText', 'axisLabel', 'backLabel', 'confirmLabel', 'tooltip'])
const SKIP_ATTRS = new Set(['className', 'type', 'name', 'id', 'key', 'href', 'src', 'value', 'style', 'inputMode', 'autoComplete', 'role', 'rel', 'target', 'htmlFor', 'accept', 'method', 'mode', 'variant', 'tone', 'icon', 'size', 'min', 'max', 'step', 'pattern', 'lang', 'dir', 'data-testid', 'preserveAspectRatio', 'viewBox', 'd', 'fill', 'stroke', 'textAnchor', 'fontSize', 'transform'])
const SKIP_CALLS = /^(rpc|from|select|eq|neq|in|is|order|call|setItem|getItem|removeItem|querySelector|querySelectorAll|getElementById|includes|startsWith|endsWith|split|join|replace|replaceAll|test|match|invoke|storage|upload|createSignedUrl|createSignedUrls|getPublicUrl|channel|on|toLocaleString|toLocaleDateString|toLocaleTimeString|padStart|getAttribute|setAttribute|addEventListener|removeEventListener|require|import|dispatchEvent|Event|fetch|log|warn|error|debug|matchAll|localeCompare|createElement|toDataURL|define|Intl|NumberFormat|DateTimeFormat|postMessage|send|handle|ipcRenderer|exposeInMainWorld|filter|find|some|every|findIndex|indexOf|has|get|set|delete|startsWith|keys|lower|upper|toggle|contains)$/
const norm = (s) => s.replace(/\s+/g, ' ').trim()
const strings = new Set()
const isText = (t) => t.length >= 2 && t.length <= 500 && /[A-Za-z]{2}/.test(t) && !/^[a-z0-9_.:/-]+$/.test(t) && !/^[a-z]+([A-Z][a-z0-9]+)+$/.test(t)
  && !/^(https?:|mailto:|data:|\/|\.\/|#[0-9a-f]{3})/i.test(t) && !/[{};]|=>|\b(SELECT|FROM|WHERE)\b/.test(t) && !/^[\w-]+(\s+[\w-]+)*$/.test(t) === false || (t.length >= 2 && /^[A-Z][a-z]/.test(t) && !/[{};]|=>/.test(t))
const sentence = (t) => / /.test(t) || /^[A-Z][a-z']+[.!?…:]?$/.test(t) || /^[A-Z][a-z]+(\/[A-Z][a-z]+)+$/.test(t)

function calleeName(node) {
  const expr = node.expression
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return ''
}
function context(node) {
  const p = node.parent
  if (!p) return 'other'
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return 'skip'
  if (ts.isJsxAttribute(p)) { const n = p.name.getText(); return UI_ATTRS.has(n) ? 'ui' : SKIP_ATTRS.has(n) || /^on[A-Z]/.test(n) ? 'skip' : 'attr' }
  if (ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent)) { const n = p.parent.name.getText(); return UI_ATTRS.has(n) ? 'ui' : SKIP_ATTRS.has(n) ? 'skip' : 'attr' }
  if (ts.isPropertyAssignment(p) && p.name === node) return 'skip'
  if (ts.isElementAccessExpression(p)) return 'skip'
  if (ts.isCaseClause(p)) return 'skip'
  if (ts.isBinaryExpression(p) && ['===', '!==', '==', '!=', 'in', 'instanceof'].includes(p.operatorToken.getText())) return 'skip'
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) { const name = calleeName(p); if (SKIP_CALLS.test(name)) return 'skip' }
  if (ts.isArrayLiteralExpression(p) && p.parent && ts.isCallExpression(p.parent) && SKIP_CALLS.test(calleeName(p.parent))) return 'skip'
  return 'other'
}
function templatePattern(node) {
  let out = node.head.text
  node.templateSpans.forEach((span, i) => { out += `{${i}}` + span.literal.text })
  return norm(out)
}
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS)
  const visit = (node) => {
    if (ts.isJsxText(node)) { const t = norm(node.text); if (t && /[A-Za-z]/.test(t) && !/^[)\],.;:]+$/.test(t)) strings.add(t) }
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const where = context(node)
      const t = norm(node.text)
      if (where !== 'skip' && t && (isText(t) || (where === 'ui' && / /.test(t) && /[A-Za-z]{2}/.test(t) && !/[{}]|=>/.test(t))) && (where === 'ui' || sentence(t)) && !/^[a-z_]+(\.[a-z_]+)+$/.test(t) && !/\.(png|jpg|svg|json|sql|js|jsx|html|css)\b/.test(t) && !/^--|^[.#]\w|\s\.\w|px\b|rgba?\(|#[0-9a-f]{6}|\b(var|calc)\(/i.test(t)) strings.add(t)
    } else if (ts.isTemplateExpression(node)) {
      const where = context(node)
      const t = templatePattern(node)
      const words = t.replace(/\{\d+\}/g, ' ')
      if (where !== 'skip' && /[A-Za-z]{2}/.test(words) && (/ /.test(norm(words)) || where === 'ui') && !/[<>]|\bpx\b|--|\.(png|jpg|svg|json)|^\/|https?:|rgba?\(|#[0-9a-f]{6}/i.test(t) && !/^\{\d+\}[\w-]*$/.test(t)) strings.add(t)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
const list = [...strings].filter((s) => /[A-Za-z]/.test(s)).sort((a, b) => a.localeCompare(b))
fs.mkdirSync(path.join(root, 'src/i18n'), { recursive: true })
fs.writeFileSync(path.join(root, 'src/i18n/strings.json'), JSON.stringify(list, null, 1))
const frFile = path.join(root, 'src/i18n/fr.json')
const fr = fs.existsSync(frFile) ? JSON.parse(fs.readFileSync(frFile, 'utf8')) : {}
const missing = list.filter((s) => !(s in fr))
fs.writeFileSync(path.join(root, 'src/i18n/missing-fr.json'), JSON.stringify(missing, null, 1))
console.log(`${list.length} strings; ${missing.length} without French`)
