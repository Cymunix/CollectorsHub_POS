import React from 'react'

// A jurisdiction configuration, read-only (what CollectorsHub set for the province).
const money = (value) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(Number(value || 0))
const yes = (value) => (value == null ? 'Not set' : value ? 'Yes' : 'No')

export function TermsSummary({ config }) {
  const r = config.rules || {}
  const rows = [
    ['Status', `${config.status}${config.reviewed_by ? ` · reviewed by ${config.reviewed_by}` : ''}`],
    ['Loan term', r.term_days_default != null ? `${r.term_days_default} days (up to ${r.term_days_max ?? '—'})` : 'Not set'],
    ['Maximum interest', r.interest_monthly_pct_max != null ? `${r.interest_monthly_pct_max}% a month` : 'Not set'],
    ['Charges at issue', (r.fees || []).length ? r.fees.map((fee) => `${fee.label}: ${fee.basis === 'percent' ? `${fee.amount}%` : money(fee.amount)}`).join(', ') : 'None'],
    ['Grace · forfeiture wait', `${r.grace_days ?? '—'} days · ${r.forfeiture_wait_days ?? '—'} days`],
    ['Partial payments · renewals', `${yes(r.partial_payments_allowed)} · ${yes(r.renewals_allowed)}${r.max_renewals ? ` (up to ${r.max_renewals})` : ''}`],
    ['Electronic signatures', yes(r.electronic_signature_allowed)],
    ['Licence required', yes(r.licence_required)],
  ]
  return <ul className="tx-mini-list pw-terms">{rows.map(([label, value]) => <li key={label}><span>{label}</span><strong>{value}</strong></li>)}</ul>
}
