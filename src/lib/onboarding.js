import { supabase } from './supabaseClient'
import { DEFAULT_RAW_CONDITION, GRADED, canonicalRawCondition, isCardCategory } from './cardCondition'

// Retailer inventory onboarding (supabase/retailer_onboarding.sql). Staged
// items move Captured -> Awaiting Verification -> Awaiting Pricing -> Awaiting
// Retailer Approval -> Ready for Sale; only Ready for Sale creates stock. The
// server checks every permission; the app only hides what a person can't do.

export const STAGES = [
  ['captured', 'Captured'],
  ['awaiting_verification', 'Awaiting Verification'],
  ['awaiting_pricing', 'Awaiting Pricing'],
  ['awaiting_approval', 'Awaiting Retailer Approval'],
  ['ready_for_sale', 'Ready for Sale'],
]
export const STAGE_LABEL = Object.fromEntries([...STAGES, ['excluded', 'Excluded']])
export const NEXT_STAGE = { captured: 'awaiting_verification', awaiting_verification: 'awaiting_pricing', awaiting_pricing: 'awaiting_approval', awaiting_approval: 'ready_for_sale' }
export const MARKETPLACE_LABEL = { not_listed: 'Not listed', draft: 'Draft', awaiting_approval: 'Awaiting approval', publishing: 'Publishing', published: 'Published', failed: 'Failed', ended: 'Ended' }

export const ONBOARDING_PERMISSIONS = [
  ['onboarding_scan', 'Scanning', 'Capture and submit items'],
  ['onboarding_verify', 'Verification', 'Confirm catalogue identity, condition and quantities'],
  ['onboarding_price', 'Pricing', 'Copy existing prices'],
  ['onboarding_approve', 'Store manager', 'Approve prices and stock, assign work, QA checks'],
]
export const DATA_SOURCES = [['spreadsheet', 'Spreadsheet'], ['pos_export', 'Existing POS export'], ['scanning', 'Scanning'], ['manual', 'Manual entry']]
export const PROJECT_STATUSES = [['assessment', 'Assessment'], ['active', 'Active'], ['paused', 'Paused'], ['completed', 'Completed'], ['cancelled', 'Cancelled']]

async function call(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    if (/could not find the function/i.test(error.message || '')) throw new Error(`Retailer onboarding is not installed in Supabase yet (${name} wasn't found). Run supabase/retailer_onboarding.sql.`)
    throw new Error(error.message)
  }
  return data
}

// What this person can do on a store's onboarding (for showing actions; the
// server decides). Administrators oversee but never price or approve.
export function onboardingAccess(session) {
  if (!session) return {}
  if (session.type !== 'store_employee') return { admin: true, scan: true, verify: true, price: false, approve: false, oversee: true }
  const boss = ['owner', 'manager'].includes(String(session.role || '').toLowerCase())
  const has = (key) => boss || session.permissions?.[key] === true || session.permissions?.[key] === 'true'
  return { admin: false, scan: has('onboarding_scan'), verify: has('onboarding_verify'), price: has('onboarding_price'), approve: has('onboarding_approve'), oversee: has('onboarding_approve') }
}

// ── Projects ────────────────────────────────────────────────────────────────
export async function loadProjects(storeId = null) {
  let query = supabase.from('onboarding_projects').select('*').order('created_at', { ascending: false })
  if (storeId) query = query.eq('store_id', storeId)
  const { data, error } = await query
  if (error) throw new Error(/does not exist|schema cache/i.test(error.message) ? 'Retailer onboarding is not installed in Supabase yet. Run supabase/retailer_onboarding.sql.' : error.message)
  return data || []
}
export async function loadProject(projectId) {
  const { data, error } = await supabase.from('onboarding_projects').select('*').eq('id', projectId).maybeSingle()
  if (error) throw error
  return data
}
export const adminStores = () => call('onboarding_admin_stores', {})
export const saveProject = ({ projectId = null, storeId = null, details }) => call('onboarding_save_project', { p_project_id: projectId, p_store_id: storeId, p_details: details })
export const projectSummary = (projectId) => call('onboarding_project_summary', { p_project_id: projectId })
export const projectEvents = (projectId, { itemId = null, limit = 200 } = {}) => call('onboarding_events', { p_project_id: projectId, p_item_id: itemId, p_limit: limit })
export const logHours = (projectId, { hours, workDate = null, stage = '', note = '' }) => call('onboarding_log_hours', { p_project_id: projectId, p_hours: Number(hours), p_work_date: workDate || null, p_stage: stage, p_note: note })
export async function loadLabour(projectId) {
  const { data, error } = await supabase.from('onboarding_labour').select('*').eq('project_id', projectId).order('work_date', { ascending: false }).limit(500)
  if (error) throw error
  return data || []
}
export async function loadBatches(projectId) {
  const { data, error } = await supabase.from('onboarding_batches').select('*').eq('project_id', projectId).order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

// ── Staff ───────────────────────────────────────────────────────────────────
export const onboardingStaff = (storeId) => call('onboarding_staff', { p_store_id: storeId })
export const setStaffPermissions = (storeId, employeeId, permissions) => call('onboarding_set_staff_permissions', { p_store_id: storeId, p_employee_id: employeeId, p_permissions: permissions })

// ── Items ───────────────────────────────────────────────────────────────────
export const ITEM_PAGE = 100

export async function loadItems(projectId, { stage = '', search = '', batchId = '', flag = '', page = 0 } = {}) {
  let query = supabase.from('onboarding_items').select('*', { count: 'exact' }).eq('project_id', projectId)
  if (stage) query = query.eq('stage', stage)
  if (batchId) query = query.eq('batch_id', batchId)
  if (flag === 'missing_price') query = query.eq('price_missing', true)
  if (flag === 'exception') query = query.not('exception', 'is', null)
  if (flag === 'qa_failed') query = query.eq('qa_status', 'failed')
  if (flag === 'unassigned') query = query.is('assigned_employee_id', null)
  const term = search.trim().replace(/[%,()]/g, ' ')
  if (term) query = query.or(`name.ilike.%${term}%,item_number.ilike.%${term}%,barcode.ilike.%${term}%,cert_number.ilike.%${term}%`)
  const { data, error, count } = await query.order('created_at').range(page * ITEM_PAGE, page * ITEM_PAGE + ITEM_PAGE - 1)
  if (error) throw error
  return { items: data || [], total: count || 0 }
}

// A random sample of items at a stage that haven't been checked yet.
export async function sampleForQa(projectId, { stage = 'ready_for_sale', size = 10 } = {}) {
  const { data, error } = await supabase.from('onboarding_items').select('*').eq('project_id', projectId).eq('stage', stage).eq('qa_status', 'unchecked').limit(1000)
  if (error) throw error
  const rows = [...(data || [])]
  for (let i = rows.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]] }
  return rows.slice(0, size)
}

export const createBatch = ({ projectId, source, label = '', fileName = '', items = [], submit = false }) => call('onboarding_create_batch', { p_project_id: projectId, p_source: source, p_label: label, p_file_name: fileName, p_items: items, p_submit: submit })
export const addItems = (batchId, items, submit = false) => call('onboarding_add_items', { p_batch_id: batchId, p_items: items, p_submit: submit })
export const updateItem = (itemId, changes, note = '') => call('onboarding_update_item', { p_item_id: itemId, p_changes: changes, p_note: note })
export const advanceItems = (itemIds, toStage, { note = '', locationId = null } = {}) => call('onboarding_advance', { p_item_ids: itemIds, p_to_stage: toStage, p_note: note, p_location_id: locationId })
export const assignItems = (itemIds, employeeId) => call('onboarding_assign', { p_item_ids: itemIds, p_employee_id: employeeId || null })
export const qaCheck = (itemId, passed, checks, note = '') => call('onboarding_qa_check', { p_item_id: itemId, p_passed: passed, p_checks: checks, p_note: note })
export const setException = (itemId, exception, note = '') => call('onboarding_set_exception', { p_item_id: itemId, p_exception: exception || null, p_note: note })

// Large imports go up in batches of 5,000 rows (the server's limit per call).
export async function importRows({ projectId, source, label, fileName, rows, submit, onProgress = () => {} }) {
  const batches = []
  for (let i = 0; i < rows.length; i += 5000) {
    const part = rows.slice(i, i + 5000)
    const count = Math.ceil(rows.length / 5000)
    batches.push(await createBatch({ projectId, source, label: count > 1 ? `${label || fileName || 'Import'} (${batches.length + 1} of ${count})` : label, fileName, items: part, submit }))
    onProgress(Math.min(i + 5000, rows.length), rows.length)
  }
  return batches
}

// ── Spreadsheet / POS export import ─────────────────────────────────────────
// CSV (comma, semicolon or tab separated, quoted fields) or rows pasted from
// a spreadsheet. Returns { headers, rows: [[...]] }.
export function parseDelimited(text) {
  const source = String(text || '').replace(/^﻿/, '')
  const firstLine = source.split(/\r?\n/, 1)[0] || ''
  const delimiter = firstLine.includes('\t') ? '\t' : (firstLine.split(';').length > firstLine.split(',').length ? ';' : ',')
  const records = []
  let field = ''
  let record = []
  let quoted = false
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i += 1 }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"' && field === '') quoted = true
    else if (char === delimiter) { record.push(field); field = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1
      record.push(field); field = ''
      if (record.some((value) => value.trim() !== '')) records.push(record)
      record = []
    } else field += char
  }
  record.push(field)
  if (record.some((value) => value.trim() !== '')) records.push(record)
  const [headers = [], ...rows] = records
  return { headers: headers.map((header) => header.trim()), rows }
}

// The fields an imported row can fill, with header names that usually mean them.
export const IMPORT_FIELDS = [
  ['name', 'Item name', /^(item ?)?(name|title|description|product( name)?|item)$/i],
  ['item_number', 'Item / card number', /^(card ?(no|number|#)|number|no\.?|#|set ?number|item ?number|sku|part ?number|code)$/i],
  ['barcode', 'Barcode / UPC', /^(barcode|upc|ean|gtin|upc ?code)$/i],
  ['category_name', 'Category', /^(category|department|type|product ?type)$/i],
  ['condition', 'Condition', /^(condition|cond\.?|state)$/i],
  ['grading_company', 'Grading company', /^(grader|grading ?company|grading)$/i],
  ['grade', 'Grade', /^grade$/i],
  ['cert_number', 'Cert number', /^(cert|cert ?(no|number|#)|certification( number)?)$/i],
  ['quantity', 'Quantity', /^(qty|quantity|on ?hand|stock|count|qoh|in ?stock)$/i],
  ['in_store_price', 'In-store price', /^(price|retail( price)?|in[- ]?store( price)?|store price|sell ?price|selling price|pos price)$/i],
  ['online_price', 'Online price', /^(online( price)?|web( price)?|ebay( price)?|website price|shopify price)$/i],
  ['cost', 'Cost', /^(cost|cost price|buy ?price|unit cost|avg cost|average cost)$/i],
]

export function guessMapping(headers = []) {
  const mapping = {}
  IMPORT_FIELDS.forEach(([key, , pattern]) => {
    const index = headers.findIndex((header, i) => pattern.test(header.trim()) && !Object.values(mapping).includes(i))
    if (index >= 0) mapping[key] = index
  })
  return mapping
}

// A retailer's price as written: "$1,234.50", "12,50" (comma decimals), "12.5".
// Returns a string the server stores as-is, or '' (missing).
export function priceText(value) {
  let text = String(value ?? '').replace(/[^0-9.,-]/g, '')
  if (!text) return ''
  if (text.includes(',') && !text.includes('.') && /,\d{1,2}$/.test(text)) text = text.replace(',', '.')
  else text = text.replace(/,/g, '')
  const number = Number(text)
  return Number.isFinite(number) && number >= 0 ? number.toFixed(2) : ''
}

// Turns mapped rows into items for the server, keeping each original row.
// Rows with an unreadable quantity are returned as errors, not imported.
export function rowsToItems(headers, rows, mapping, { defaultCategory = '' } = {}) {
  const items = []
  const errors = []
  rows.forEach((cells, index) => {
    const get = (key) => (mapping[key] == null ? '' : String(cells[mapping[key]] ?? '').trim())
    const original = Object.fromEntries(headers.map((header, i) => [header || `Column ${i + 1}`, cells[i] ?? '']))
    const name = get('name')
    const number = get('item_number')
    if (!name && !number && !get('barcode')) return
    const qtyText = get('quantity')
    const quantity = qtyText === '' ? 1 : Number(qtyText.replace(/,/g, ''))
    if (!Number.isInteger(quantity) || quantity < 0) { errors.push({ row: index + 2, reason: `quantity "${qtyText}" is not a whole number`, original }); return }
    const category = get('category_name') || defaultCategory
    let condition = get('condition')
    const gradingCompany = get('grading_company')
    const grade = get('grade')
    // Cards are Ungraded or Graded; the original condition stays in the source row.
    if (isCardCategory(category)) condition = gradingCompany || grade || /^graded$/i.test(condition) ? GRADED : canonicalRawCondition(condition) || (condition && !/^ungraded$/i.test(condition) ? condition : DEFAULT_RAW_CONDITION)
    items.push({
      source_ref: `Row ${index + 2}`,
      source_row: original,
      name, item_number: number, barcode: get('barcode'), category_name: category, condition,
      grading_company: gradingCompany, grade, cert_number: get('cert_number'), quantity,
      in_store_price: priceText(get('in_store_price')), online_price: priceText(get('online_price')), cost: priceText(get('cost')),
    })
  })
  return { items, errors }
}

// Barcodes that match a catalogue item's UPC exactly: a starting point for
// verification (staff still confirm the identity).
export async function matchBarcodes(items) {
  const codes = [...new Set(items.map((item) => item.barcode).filter(Boolean))]
  const byCode = new Map()
  for (let i = 0; i < codes.length; i += 200) {
    const { data } = await supabase.from('items').select('item_id, upc').in('upc', codes.slice(i, i + 200))
    ;(data || []).forEach((row) => { if (!byCode.has(row.upc)) byCode.set(row.upc, row.item_id) })
  }
  return items.map((item) => (item.barcode && byCode.has(item.barcode) ? { ...item, catalog_item_id: byCode.get(item.barcode) } : item))
}

// Catalogue names for linked items (for showing what an item was matched to).
export async function catalogueNames(itemIds) {
  const ids = [...new Set(itemIds.filter(Boolean))]
  if (!ids.length) return {}
  const { data } = await supabase.from('items').select('item_id, name, subject, card_number, release_year').in('item_id', ids)
  return Object.fromEntries((data || []).map((row) => [row.item_id, [row.name || row.subject, row.card_number ? `#${row.card_number}` : '', row.release_year].filter(Boolean).join(' · ')]))
}

export function money(value) {
  return value == null || value === '' ? '' : `$${Number(value).toFixed(2)}`
}
