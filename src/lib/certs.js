import { supabase } from './supabaseClient'

// Graded slab certs. The grader's own cert page is the check that counts (the
// website links to the same pages); pos_cert_matches adds where else the cert
// already appears - any store's stock or a collector's collection - because a
// copied cert label is a common fake.

export const GRADERS = ['PSA', 'BGS', 'CGC', 'SGC', 'TAG']

const ALIASES = { BECKETT: 'BGS', 'BECKETT GRADING SERVICES': 'BGS', 'PROFESSIONAL SPORTS AUTHENTICATOR': 'PSA', 'CERTIFIED GUARANTY COMPANY': 'CGC', 'TAG GRADING': 'TAG' }

export function normalizeGrader(value) {
  const text = String(value || '').trim().toUpperCase()
  return ALIASES[text] || text
}

// Same normalising as the website and the database (normalize_cert_number).
export function normalizeCert(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// The grader's public cert lookup page, or '' when there isn't one we can link to.
export function certLookupUrl(grader, cert) {
  const value = encodeURIComponent(String(cert || '').trim())
  if (!value) return ''
  switch (normalizeGrader(grader)) {
    case 'PSA': return `https://www.psacard.com/cert/${value}`
    case 'BGS': return `https://www.beckett.com/grading/card-lookup?item_type=BGS&item_id=${value}`
    case 'CGC': return `https://www.cgccards.com/certlookup/${value}/`
    case 'TAG': return `https://my.taggrading.com/card/${value}`
    default: return ''
  }
}

// { cert, matches: [{ source: 'this_store' | 'other_store' | 'collector', name, grading_company, grade, sku, on_hand, added_at, from_store }] }
export async function fetchCertMatches(storeId, cert) {
  const { data, error } = await supabase.rpc('pos_cert_matches', { p_store_id: storeId, p_cert: cert })
  if (error) throw error
  return data || { cert: normalizeCert(cert), matches: [] }
}
