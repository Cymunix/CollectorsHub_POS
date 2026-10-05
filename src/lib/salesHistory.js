import { supabase } from './supabaseClient'

// Sales history for one catalogue card:
//   - this store's own sales (store_transaction_items of completed sales), and
//   - all CollectorsHub sales (item_market_sales, from every store, test
//     stores excluded) plus imported market sales (market_sales).
// Rows come back as { soldAt, price, quantity, condition, source, reference }.
// Column names are read flexibly, since the shared tables vary in naming.

const pick = (row, keys) => keys.map((key) => row?.[key]).find((value) => value !== undefined && value !== null && value !== '')

function normalise(row, source) {
  const quantity = Number(pick(row, ['quantity', 'qty']) || 1)
  const total = pick(row, ['line_total'])
  const unit = pick(row, ['unit_price', 'sold_price', 'sale_price', 'price', 'amount'])
  return {
    soldAt: pick(row, ['completed_at', 'sold_at', 'date_of_sale', 'sale_date', 'transaction_date', 'created_at']) || '',
    price: Number(unit ?? (total != null ? Number(total) / quantity : 0)) || 0,
    quantity,
    condition: pick(row, ['condition', 'condition_code', 'grade']) || '',
    source,
    reference: pick(row, ['transaction_number', 'reference', 'listing_title', 'title', 'source_name', 'marketplace']) || '',
  }
}

const newestFirst = (a, b) => String(b.soldAt).localeCompare(String(a.soldAt))

export async function loadStoreSalesHistory(storeId, catalogItemId, limit = 500) {
  if (!storeId || !catalogItemId) return []
  const { data, error } = await supabase
    .from('store_transaction_items')
    .select('unit_price, quantity, line_total, condition, grade, direction, store_transactions!inner(transaction_number, transaction_type, status, completed_at, created_at, store_id)')
    .eq('catalog_item_id', catalogItemId)
    .eq('direction', 'out')
    .eq('store_transactions.store_id', storeId)
    .eq('store_transactions.status', 'completed')
    .limit(limit)
  if (error) throw error
  return (data || [])
    .filter((row) => !['refund', 'return'].includes(row.store_transactions?.transaction_type))
    .map((row) => normalise({ ...row, ...row.store_transactions }, 'This store'))
    .sort(newestFirst)
}

export async function loadAllSalesHistory(catalogItemId, limit = 500) {
  if (!catalogItemId) return []
  const [inStore, byItem, byCatalogue] = await Promise.all([
    supabase.from('item_market_sales').select('*').eq('item_id', catalogItemId).limit(limit),
    supabase.from('market_sales').select('*').eq('item_id', catalogItemId).limit(limit),
    supabase.from('market_sales').select('*').eq('catalogue_item_id', catalogItemId).limit(limit),
  ])
  const rows = []
  if (!inStore.error) {
    for (const row of inStore.data || []) {
      if (row.is_test_data || row.is_excluded) continue
      rows.push(normalise(row, 'CollectorsHub stores'))
    }
  }
  const seen = new Set()
  for (const response of [byItem, byCatalogue]) {
    if (response.error) continue
    for (const row of response.data || []) {
      if (row.is_excluded || row.match_status === 'excluded') continue
      const key = row.sale_id || `${row.sold_at || row.date_of_sale}-${row.sold_price || row.price}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(normalise(row, pick(row, ['source', 'marketplace', 'source_name']) || 'Market'))
    }
  }
  if (inStore.error && byItem.error && byCatalogue.error) throw inStore.error
  return rows.sort(newestFirst)
}

export function summariseSales(rows = []) {
  const priced = rows.filter((row) => row.price > 0)
  const units = priced.reduce((sum, row) => sum + row.quantity, 0)
  const average = units ? priced.reduce((sum, row) => sum + row.price * row.quantity, 0) / units : 0
  return { count: rows.length, units, average: Math.round(average * 100) / 100, last: priced[0] || null }
}
