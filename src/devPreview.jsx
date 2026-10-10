import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { supabase } from './lib/supabaseClient'
import ClockInGate from './ClockInGate'
import CreateCustomerModal from './CreateCustomer'
import IdentityWizard from './identity/IdentityWizard'
import IdentityCustomerCard from './identity/IdentityCustomerCard'
import ManualIdCheck from './identity/ManualIdCheck'
import BuybackRulesModal from './org/BuybackRules'
import StoreFeaturesModal from './org/StoreFeatures'
import ScanCentre from './scan/ScanCentre'
import CustomersView from './customers/CustomersView'
import TransactionsView from './transactions/TransactionsView'
import PawnView from './pawn/PawnView'
import { DEFAULT_RULES } from './lib/buybackIdentification'
import MyHRView from './MyHR'
import MyHRPay from './MyHRPay'
import MyHROrgEmployees from './MyHROrgEmployees'
import ScheduleBuilder from './ScheduleBuilder'
import StoreHoursModal from './org/StoreHours'
import MyHRSchedule from './MyHRSchedule'
import OrgPortal, { NAV as ORG_NAV } from './org/OrgPortal'

// Dev-only preview (dev-preview.html?screen=…): screens with made-up sample
// data, no sign-in and nothing saved, so they can be looked at and
// screenshotted. Supabase calls are answered here and never sent.

const storeId = 'preview-store'
const session = { type: 'store_employee', storeId, storeName: 'Nordvik Test Store', username: 'HaydenM8', role: 'manager' }

const day = (offsetDays, hour, minute = 0) => {
  const date = new Date()
  date.setHours(hour, minute, 0, 0)
  date.setDate(date.getDate() + offsetDays)
  return date.toISOString()
}
const isoDay = (offsetDays) => day(offsetDays, 12).slice(0, 10)
const monday = (() => { const date = new Date(); return -((date.getDay() + 6) % 7) })()

const SAMPLE = {
  store_myhr_settings: [{
    organization_id: 'org', organization_name: 'Nordvik Collectibles', enabled_sections: null, can_edit: true, is_test_store: true,
    section_content: {
      pay: {
        button: { label: 'Payroll portal', url: 'https://example.com' },
        notice: '2025 T4s are now available in the payroll portal.',
        intro: 'Pay stubs, tax forms and direct deposit changes are handled through our payroll provider.',
        groups: [{ title: 'Forms', links: [{ label: 'Direct deposit form', url: 'https://example.com' }, { label: 'Understanding your pay stub', url: 'https://example.com' }] }],
      },
    },
  }],
  myhr_clock_status: [{ is_employee: true, clocked_in_at: null }],
  myhr_am_manager: true,
  myhr_my_time: [
    { id: 't1', clock_in: day(0, 9, 2), clock_out: null },
    { id: 't2', clock_in: day(-1, 10, 0), clock_out: day(-1, 18, 4) },
    { id: 't3', clock_in: day(-2, 9, 58), clock_out: day(-2, 17, 30) },
    { id: 't4', clock_in: day(-8, 12, 0), clock_out: day(-8, 20, 0) },
    { id: 't5', clock_in: day(-9, 12, 0), clock_out: day(-9, 19, 15) },
  ],
  myhr_my_leave: [
    { id: 'l1', leave_type: 'vacation', start_date: isoDay(20), end_date: isoDay(20), start_time: '09:00:00', end_time: '14:00:00', hours: 5, status: 'pending' },
    { id: 'l2', leave_type: 'vacation', start_date: isoDay(-7), end_date: isoDay(-7), start_time: '09:00:00', end_time: '14:00:00', hours: 4, status: 'approved', processor: 'Store owner' },
    { id: 'l3', leave_type: 'medical', start_date: isoDay(-8), end_date: isoDay(-8), start_time: '09:00:00', end_time: '12:00:00', hours: 3, status: 'approved', processor: 'Store owner' },
    { id: 'l4', leave_type: 'lieu', start_date: isoDay(-18), end_date: isoDay(-18), start_time: '06:30:00', end_time: '07:00:00', hours: 0.5, status: 'approved', processor: 'Store owner' },
  ],
  myhr_my_time_accounts: [
    ['banked_overtime', 3.75, 0.5], ['vacation', 76.46, 4], ['carryover_vacation', 8.25, 8.25], ['accumulated_vacation', 17.88, 0],
    ['sick', 71.35, 2.5], ['medical', 20.39, 3], ['family_illness', 25.49, 0], ['statutory', 18.42, 11],
  ].map(([account, entitlement, used]) => ({ account, year_start: '2026-04-01', year_end: '2027-03-31', entitlement_hours: entitlement, used_hours: used, remainder_hours: Math.round((entitlement - used) * 100) / 100 })),
  myhr_org_leave_year: 4,
  org_location_hours: [{ location_id: 'loc1', location_name: 'Main Store', store_id: 'st1', store_name: 'Nordvik Test Store', opening_hours: { 1: { open: '10:00', close: '18:00' }, 2: { open: '10:00', close: '18:00' }, 3: { open: '10:00', close: '18:00' }, 4: { open: '10:00', close: '20:00' }, 5: { open: '10:00', close: '20:00' }, 6: { open: '10:00', close: '17:00' }, 0: null } }],
  store_opening_hours: { 1: { open: '10:00', close: '18:00' }, 2: { open: '10:00', close: '18:00' }, 3: { open: '10:00', close: '18:00' }, 4: { open: '10:00', close: '20:00' }, 5: { open: '10:00', close: '20:00' }, 6: { open: '10:00', close: '17:00' }, 0: null },
  myhr_my_onboarding: { pay: true, scheduling: false, leave: false, personal: true, address: false, emergency: false, availability: true },
  myhr_org_onboarding: [
    { employee_id: 'e1', added_at: '2026-08-31T12:00:00Z', onboarding: { pay: true, scheduling: true, leave: true, personal: true, address: true, emergency: true, availability: true } },
    { employee_id: 'e2', added_at: '2026-10-05T12:00:00Z', onboarding: { pay: false, scheduling: false, leave: false, personal: true, address: false, emergency: false, availability: false } },
    { employee_id: 'e3', added_at: '2026-10-06T12:00:00Z', onboarding: { pay: false, scheduling: false, leave: false, personal: false, address: false, emergency: false, availability: false } },
  ],
  organization_stores: [
    { store_id: 'st1', store_code: 'NOR001', store_name: 'Nordvik Test Store', status: 'active', region_id: null, notification_region_id: 'ns-northern', primary_province: 'NS', primary_location: 'Main Store', location_count: 1, staff_count: 4, inventory_count: 49 },
    { store_id: 'st2', store_code: 'NOR002', store_name: 'Nordvik Dartmouth', status: 'setup', region_id: null, notification_region_id: null, primary_province: 'NS', primary_location: null, location_count: 0, staff_count: 0, inventory_count: 0 },
  ],
  my_unattached_stores: [],
  list_org_regions: [],
  org_sales_kpis: { today: 412.5, transactions_today: 9, week: 2210, month: 8840, net_sales: 8840, gross_sales: 9100, transactions: 214, average_basket: 41.3 },
  org_order_kpis: { ready_for_pickup: 2, outstanding_layaway: 360, outstanding_preorder: 145, created_today: 1 },
  org_tradein_kpis: { today: 3, this_week: 11 },
  org_sales_by_store: [{ store_id: 'st1', store_name: 'Nordvik Test Store', transactions: 9, sales: 412.5, avg_basket: 45.83 }],
  myhr_my_availability_profile: { availability: { 1: [{ from: '15:30', to: '22:00' }], 2: [{ from: '15:30', to: '22:00' }], 3: [{ from: '07:00', to: '09:00' }, { from: '15:30', to: '22:00' }], 4: [{ from: '15:30', to: '22:00' }], 5: [{ from: '15:30', to: '22:00' }], 0: [] }, preferred_hours: 18, most_hours: 20, restrictions: ['no_close'], note: 'Student: classes until 3 on weekdays, exams Dec 8–19', updated_at: new Date().toISOString() },
  myhr_schedule_staff: [
    { id: 'm1', name: 'Morgan Lee', short_name: 'Morgan L.', schedule_role: 'Manager', can_cover: ['Keyholder'], target_hours: 40, min_hours: 32, max_hours: 44, availability: {}, hourly_cost: 26 },
    { id: 's1', name: 'Sarah Moss', short_name: 'Sarah M.', schedule_role: 'Supervisor', can_cover: ['Keyholder'], target_hours: 40, max_hours: 44, availability: {}, hourly_cost: 20 },
    { id: 'j1', name: 'Jake Ray', short_name: 'Jake R.', schedule_role: 'Employee', can_cover: [], target_hours: 25, min_hours: 20, availability: { 1: [{ from: '15:30', to: '22:00' }], 2: [{ from: '15:30', to: '22:00' }], 3: [{ from: '15:30', to: '22:00' }], 4: [{ from: '15:30', to: '22:00' }], 5: [{ from: '15:30', to: '22:00' }] }, hourly_cost: 16.5, preferred_hours: 18, most_hours: 20, restrictions: ['no_close', 'needs_keyholder'], availability_note: 'Student: classes until 3 on weekdays' },
    { id: 'a1', name: 'Alex Kim', short_name: 'Alex K.', schedule_role: 'Employee', can_cover: [], target_hours: 24, availability: { 1: [{ from: '09:00', to: '17:00' }], 2: [{ from: '09:00', to: '17:00' }], 3: [{ from: '09:00', to: '17:00' }], 4: [{ from: '09:00', to: '17:00' }], 5: [{ from: '09:00', to: '17:00' }], 6: [{ from: '09:00', to: '17:00' }] }, hourly_cost: 16 },
  ],
  myhr_coverage_rules: [
    ...[1, 2, 3, 4, 5].map((weekday) => ({ id: 'w' + weekday, weekday, start_time: '10:00:00', end_time: '18:00:00', role: 'Manager', needed: 1, label: null })),
    ...[1, 2, 3, 4, 5].map((weekday) => ({ id: 'e' + weekday, weekday, start_time: '12:00:00', end_time: '16:00:00', role: 'Employee', needed: 1, label: null })),
    { id: 's-m', weekday: 6, start_time: '09:00:00', end_time: '17:00:00', role: 'Manager', needed: 1, label: null },
    { id: 's-e', weekday: 6, start_time: '09:00:00', end_time: '17:00:00', role: 'Employee', needed: 2, label: null },
    { id: 's-c', weekday: 6, start_time: '17:00:00', end_time: '21:00:00', role: 'Keyholder', needed: 1, label: 'Closing' },
  ],
  myhr_store_schedule: () => {
    const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) + 7)
    const at = (dayOffset, h, m = 0) => { const date = new Date(monday); date.setDate(monday.getDate() + dayOffset); date.setHours(h, m, 0, 0); return date.toISOString() }
    const list = []
    let n = 0
    const add = (employee_id, d, from, to, role = null, breakMinutes = 30) => list.push({ id: 'sh' + (n += 1), employee_id, starts_at: at(d, from), ends_at: at(d, to), role, break_minutes: breakMinutes })
    for (const d of [0, 1, 2, 3, 4]) add('m1', d, 10, 18)
    add('s1', 0, 12, 20, null, 30); add('s1', 1, 9, 21, null, 60); add('s1', 2, 9, 21, null, 60); add('s1', 3, 9, 19); add('s1', 5, 9, 17)
    add('j1', 0, 12, 16, null, 0); add('j1', 2, 12, 16, null, 0); add('j1', 5, 9, 17)
    add('a1', 1, 12, 16, null, 0); add('a1', 4, 12, 16, null, 0); add('a1', 4, 13, 17, null, 0); add('a1', 5, 12, 19)
    return list
  },
  myhr_schedule_week: [{ version: 1, published_at: new Date(Date.now() - 86400000).toISOString(), shifts: [] }],
  myhr_team_members: [
    { id: 'e1', name: 'Mx Jordan Sample', first_name: 'Jordan', last_name: 'Sample', is_me: true },
    { id: 'e2', name: 'Casey Lee', first_name: 'Casey', last_name: 'Lee', is_me: false },
    { id: 'e3', name: 'Sam Patel', first_name: 'Sam', last_name: 'Patel', is_me: false },
    { id: 'e4', name: 'Riley Morgan', first_name: 'Riley', last_name: 'Morgan', is_me: false },
  ],
  myhr_team_absences: [
    { employee_id: 'e1', start_date: isoDay(20), end_date: isoDay(20), status: 'pending', leave_type: 'vacation' },
    { employee_id: 'e3', start_date: isoDay(15), end_date: isoDay(19), status: 'approved', leave_type: null },
    { employee_id: 'e2', start_date: isoDay(4), end_date: isoDay(4), status: 'pending', leave_type: null },
    { employee_id: 'e4', start_date: isoDay(-5), end_date: isoDay(30), status: 'approved', leave_type: null },
  ],
  myhr_team_shift_days: ({ p_from }) => {
    const out = []
    const start = new Date(p_from + 'T00:00:00')
    for (let d = 0; d < 31; d += 1) {
      const date = new Date(start); date.setDate(start.getDate() + d)
      if (date.getMonth() !== start.getMonth()) break
      const iso = date.toISOString().slice(0, 10)
      const dow = date.getDay()
      if (dow !== 0 && dow !== 1) { out.push({ employee_id: 'e1', day: iso }); out.push({ employee_id: 'e2', day: iso }) }
      if (dow >= 3) out.push({ employee_id: 'e3', day: iso })
      if (dow !== 6) out.push({ employee_id: 'e4', day: iso })
    }
    return out
  },
  myhr_store_approvers: [{ name: 'Store owner' }],
  myhr_my_timesheets: ({ p_from, p_to }) => {
    const sunday = (offsetWeeks) => { const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() - date.getDay() + offsetWeeks * 7); return date.toISOString().slice(0, 10) }
    const weeks = [
      { week_start: sunday(-5), status: 'approved', processor: 'Store owner' },
      { week_start: sunday(-4), status: 'approved', processor: 'Store owner' },
      { week_start: sunday(-3), status: 'rejected', processor: 'Store owner', decision_note: 'Missing Thursday' },
      { week_start: sunday(-2), status: 'approved', processor: 'Store owner' },
      { week_start: sunday(-1), status: 'submitted' },
    ]
    return weeks.filter((week) => (!p_from || week.week_start >= p_from) && (!p_to || week.week_start <= p_to)).map((week) => ({ id: week.week_start, overrides: {}, ...week }))
  },
  myhr_store_timesheets: [
    { id: 'w1', employee_name: 'Casey Lee', week_start: (() => { const date = new Date(); date.setDate(date.getDate() - date.getDay() - 7); return date.toISOString().slice(0, 10) })(), status: 'submitted', total_hours: 30.5, overtime_hours: 1.5, submitted_lines: [] },
  ],
  myhr_store_leave: [
    { id: 's1', employee_name: 'Jordan Smith', leave_type: 'vacation', start_date: isoDay(10), end_date: isoDay(12), days: 3, note: 'Family trip', status: 'pending' },
    { id: 's2', employee_name: 'Casey Lee', leave_type: 'personal', start_date: isoDay(4), end_date: isoDay(4), days: 1, status: 'pending' },
    { id: 's3', employee_name: 'Sam Patel', leave_type: 'vacation', start_date: isoDay(15), end_date: isoDay(19), days: 5, status: 'approved' },
  ],
  myhr_store_staff: [
    { id: 'e1', name: 'HaydenM8', role: 'manager' },
    { id: 'e2', name: 'Jordan Smith', role: 'cashier' },
    { id: 'e3', name: 'Casey Lee', role: 'cashier' },
  ],
  myhr_my_schedule: [
    { id: 'm1', starts_at: day(monday, 10), ends_at: day(monday, 18), role: 'Manager', break_minutes: 30 },
    { id: 'm2', starts_at: day(monday + 2, 12), ends_at: day(monday + 2, 20), note: 'Card night', role: 'Manager', break_minutes: 30, changed: true },
    { id: 'm3', starts_at: day(monday + 5, 9), ends_at: day(monday + 5, 17), role: 'Keyholder', break_minutes: 30 },
  ],

  myhr_my_job: [{ employee_id: 'e1', personnel_number: '4000001', name: 'Mx Jordan Sample', personnel_area: 'Nordvik Collectibles', business_area: 'Main Store', employee_group: 'Employee', employee_subgroup: 'Part-time hourly', position_title: 'Store Manager', pay_type: 'hourly', pay_rate: 21.5, hours_per_period: 56, pay_period: 'biweekly', next_increase: '2027-01-01', changed_by_name: 'Store owner', changed_at: '2026-09-01T12:00:00Z' }],
  get myhr_org_employee_accounts() { return this.myhr_my_time_accounts },
  myhr_org_staff: [
    { id: 'e1', name: 'Jordan Sample', role: 'manager', status: 'active', personnel_number: '4000001', store_name: 'Nordvik Test Store', position_title: 'Store Manager' },
    { id: 'e2', name: 'Casey Lee', role: 'cashier', status: 'active', personnel_number: '4000002', store_name: 'Nordvik Test Store', position_title: 'Sales Associate' },
    { id: 'e3', name: 'Sam Patel', role: 'cashier', status: 'active', personnel_number: '4000003', store_name: 'Nordvik Dartmouth', position_title: null },
  ],
  myhr_org_staff_job: [{ employee_id: 'e1', personnel_number: '4000001', name: 'Mx Jordan Sample', personnel_area: 'Nordvik Collectibles', business_area: 'Main Store', employee_group: 'Employee', employee_subgroup: 'Part-time hourly', position_title: 'Store Manager', pay_type: 'hourly', pay_rate: 21.5, hours_per_period: 56, pay_period: 'biweekly', next_increase: '2027-01-01', changed_by_name: 'Store owner', changed_at: '2026-09-01T12:00:00Z' }],
  myhr_my_family: [
    { id: 'f1', relationship: 'Father', name: 'Pat Sample', date_of_birth: '1968-02-03', gender: 'Male' },
    { id: 'f2', relationship: 'Mother', name: 'Robin Sample', date_of_birth: '1970-09-21', gender: 'Female' },
  ],
  myhr_my_details: [{
    first_name: 'Jordan', last_name: 'Sample', email: 'staff@example.com', username: 'HaydenM8', role: 'manager', status: 'active', personnel_number: '4000001',
    form_of_address: 'Mx', initials: 'JS', language: 'English', date_of_birth: '1995-04-12', gender: 'Prefer not to say', marital_status: 'Single', country: 'Canada', phone_area: '902',
    employee_since: '2026-08-31T12:00:00Z', store_name: 'Nordvik Test Store',
    phone: '555-0142', address_line1: '123 Main Street', city: 'Halifax', province: 'Nova Scotia', postal_code: 'B3H 1A1',
    emergency_first_name: 'Alex', emergency_last_name: 'Sample', emergency_phone_area: '902', emergency_phone: '555-0199',
  }],
}
SAMPLE.is_username_available = ({ p_username }) => String(p_username).toLowerCase() !== 'jordansample'
SAMPLE.identity_begin = () => 'v-preview'
SAMPLE.identity_cancel = () => null
SAMPLE.identity_submit_manual_review = ({ p_details }) => (p_details.expiry_date < new Date().toISOString().slice(0, 10) ? 'failed' : 'manual_review')
// MOCK NORDVIK Identity for the preview only (dev-preview.html). It behaves
// like the real API with no provider connected: it can never return
// "verified", only manual_review / failed. Not used by the app.
const mockIdentity = { session: null, consents: {}, evidence: {}, mobile: null }
const realFunctions = supabase.functions
const mockFunctions = { invoke: null }
Object.defineProperty(supabase, 'functions', { configurable: true, get: () => mockFunctions })
const realInvoke = realFunctions.invoke.bind(realFunctions)
mockFunctions.invoke = async (name, options = {}) => {
  if (!['nordvik-identity/', 'bright-action/'].some((prefix) => String(name).startsWith(prefix))) return realInvoke(name, options)
  const path = String(name).split('/v1/identity/')[1] || ''
  const body = options.body || {}
  const view = () => ({ ...mockIdentity.session, consents: { ...mockIdentity.consents }, evidence: { ...mockIdentity.evidence }, mobile: mockIdentity.mobile, automatedAvailable: false, mocked: true })
  await new Promise((resolve) => setTimeout(resolve, 150))
  if (path === 'verifications') {
    mockIdentity.session = { id: 'mock-session-0001', status: 'pending', documentType: null, captureMethod: null, biometricConsent: null, discrepancies: [], expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), profileStatus: 'unverified' }
    mockIdentity.consents = {}; mockIdentity.evidence = {}; mockIdentity.mobile = null
    return { data: { ...view(), noticeVersion: 'nordvik-identity-consent-2026-10-v2' }, error: null }
  }
  const [, , action] = path.split('/')
  const s = mockIdentity.session
  if (path.startsWith('profiles/joetest/portrait')) return { data: { url: '/nordvik-identity/demo/joetest-demo-headshot.png', processed: true, demo: true }, error: null }
  if (path.startsWith('profiles/') && path.includes('/portrait')) { const c = document.createElement('canvas'); c.width = 400; c.height = 500; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 400, 500); x.fillStyle = '#c8d2e0'; x.beginPath(); x.arc(200, 190, 90, 0, Math.PI * 2); x.fill(); x.fillRect(80, 320, 240, 180); x.fillStyle = '#b42318'; x.font = 'bold 22px sans-serif'; x.fillText('MOCK PHOTO', 128, 470); return { data: { url: c.toDataURL('image/png'), processed: true }, error: null } }
  if (path.startsWith('profiles/')) return { data: { status: s?.status === 'manual_review' ? 'manual_review' : 'unverified', buybackAllowed: false, portraitAvailable: false }, error: null }
  if (!action) return { data: view(), error: null }
  if (action === 'consent') { mockIdentity.consents[body.consentType] = body.status; if (body.consentType === 'biometric') s.biometricConsent = body.status === 'given'; return { data: view(), error: null } }
  if (action === 'document') {
    s.documentType = body.documentType; s.status = 'awaiting_capture'
    s.discrepancies = body.details.full_name.toLowerCase() !== 'jordan sample' ? ['name_differs_from_account'] : []
    if (body.details.expiry_date < new Date().toISOString().slice(0, 10)) s.status = 'failed'
    return { data: view(), error: null }
  }
  if (action === 'documents' || action === 'photo') return { data: { bucket: 'identity-evidence', path: `mock/${body.kind}`, token: 'mock' }, error: null }
  if (action === 'uploaded') { mockIdentity.evidence[body.kind] = true; return { data: view(), error: null } }
  if (action === 'mobile-capture') { mockIdentity.mobile = { opened: false, completed: false, expiresAt: new Date(Date.now() + 600000).toISOString() }; return { data: { url: 'https://example.invalid/identity/verify#t=MOCK-NOT-A-REAL-TOKEN', expiresAt: mockIdentity.mobile.expiresAt }, error: null } }
  if (action === 'submit') { s.status = 'manual_review'; return { data: { ...view(), message: 'Sent to an authorised NORDVIK Identity reviewer.' }, error: null } }
  if (action === 'cancel') { s.status = 'cancelled'; return { data: view(), error: null } }
  return { data: null, error: { message: 'mock: unknown route', context: { status: 404 } } }
}
Object.defineProperty(supabase, 'storage', { configurable: true, get: () => ({ from: () => ({ uploadToSignedUrl: async () => ({ data: {}, error: null }), upload: async () => ({ data: {}, error: null }), createSignedUrls: async (paths) => ({ data: paths.map(() => ({ signedUrl: '/nordvik-identity/demo/joetest-demo-headshot.png' })), error: null }) }) }) })
window.__mockIdentity = mockIdentity

SAMPLE.buyback_id_record = (params) => { window.__lastIdentification = params; return 'mock-identification-0001' }
SAMPLE.org_buyback_id_rules = () => []
SAMPLE.org_store_features = () => [{ store_id: 'st1', feature: 'pawns_loans', enabled: true }]
SAMPLE.org_set_store_feature = () => null
SAMPLE.org_set_buyback_id_rules = (params) => { window.__savedRules = params; return null }
SAMPLE.org_location_hours = () => [{ location_id: 'loc1', location_name: 'Main Store', store_id: 'st1', store_name: 'Nordvik Test Store', opening_hours: {} }]
SAMPLE.buyback_id_log = () => [
  { id: 'b3', created_at: new Date().toISOString(), method: 'guest_manual_id_check', id_type: 'drivers_licence', customer_name: 'Pat Walker', guest_details: { full_name: 'Pat Walker', date_of_birth: '1988-02-01' }, employee_name: 'Sarah Moss', transaction_number: 'TRD-1042' },
  { id: 'b2', created_at: new Date(Date.now() - 3600000).toISOString(), method: 'manual_id_check', id_type: 'passport', customer_name: 'Jordan Sample', username: 'Jordan_S', employee_name: 'Morgan Lee', transaction_number: 'TRD-1041' },
  { id: 'b1', created_at: new Date(Date.now() - 7200000).toISOString(), method: 'nordvik_identity', customer_name: 'Casey Lee', username: 'CaseyL', employee_name: 'Morgan Lee', transaction_number: 'TRD-1040' },
]
// MOCK collector scanning (preview only): a tiny in-memory version of supabase/collection_scanning.sql.
const csMock = { jobs: {}, n: 141 }
window.__csMock = csMock
const csCounts = (job) => {
  const live = job.items.filter((i) => i.status !== 'excluded')
  const sum = (list) => list.reduce((t, i) => t + i.quantity, 0)
  return { scanned: sum(live), recognised: sum(job.items.filter((i) => ['draft', 'imported'].includes(i.status))), needs_review: job.items.filter((i) => i.status === 'needs_review').length, imported: sum(job.items.filter((i) => i.status === 'imported')), ready: sum(job.items.filter((i) => i.status === 'draft' && i.catalog_item_id)), excluded: job.items.filter((i) => i.status === 'excluded').length }
}
SAMPLE.search_store_credit_profiles = ({ p_query }) => [{ id: 'col1', username: 'TestJoe', display_name: 'Joe Test', avatar_url: '' }].filter((row) => row.username.toLowerCase().includes(String(p_query).toLowerCase()))
SAMPLE.cs_create_job = ({ p_kind, p_details }) => {
  csMock.n += 1
  const id = 'job' + csMock.n
  const reference = 'CH-2026-00' + csMock.n
  const kinds = {}
  const containers = (p_details?.containers || []).map((c, index) => { const k = c.kind || 'box'; kinds[k] = (kinds[k] || 0) + 1; return { id: id + 'c' + index, code: reference + '-' + ({ box: 'B', binder: 'C' }[k] || 'X') + String(kinds[k]).padStart(2, '0'), kind: k, description: c.description, condition_notes: c.condition_notes, estimated_items: c.estimated_items } })
  csMock.jobs[id] = { job: { id, reference, kind: p_kind, status: 'pending_authorisation', custody_status: p_kind === 'express' ? 'not_applicable' : 'not_received', categories: p_details?.categories || [], estimated_items: p_details?.estimated_items ?? null, handling_instructions: p_details?.handling_instructions, customer_notes: p_details?.customer_notes, contact: p_details?.contact || {}, last_activity_at: new Date().toISOString(), created_at: new Date().toISOString() }, authorisation: { id: 'auth-' + id, status: 'pending', duration_minutes: p_kind === 'express' ? 60 : 43200 }, containers, items: [], events: [{ id: 1, created_at: new Date().toISOString(), actor_type: 'employee', action: 'job_created', detail: {}, employee_name: 'HaydenM8' }] }
  return { job_id: id, reference, authorisation_id: 'auth-' + id }
}
SAMPLE.cs_job = ({ p_job_id }) => { const j = csMock.jobs[p_job_id]; return { job: j.job, collector: { id: 'col1', username: 'TestJoe', name: 'Joe Test' }, store: { name: 'Nordvik Test Store' }, location: { name: 'Main Store', address: '1 Main St, Halifax, NS' }, authorisation: j.authorisation, containers: j.containers, counts: csCounts(j), events: j.events } }
SAMPLE.cs_jobs = ({ p_kind }) => Object.values(csMock.jobs).filter((j) => j.job.kind === p_kind).map((j) => ({ id: j.job.id, reference: j.job.reference, kind: j.job.kind, status: j.job.status, custody_status: j.job.custody_status, collector_name: 'Joe Test', collector_username: 'TestJoe', location_name: 'Main Store', received_at: j.job.received_at, created_at: j.job.created_at, container_count: j.containers.length, authorisation_status: j.authorisation.status, estimated_items: j.job.estimated_items, scanned: csCounts(j).scanned, needs_review: csCounts(j).needs_review, imported: csCounts(j).imported, assigned_employee_name: 'HaydenM8', last_activity_at: j.job.last_activity_at }))
SAMPLE.cs_job_items = ({ p_job_id, p_status }) => csMock.jobs[p_job_id].items.filter((i) => !p_status || i.status === p_status)
SAMPLE.cs_record_receipt = ({ p_job_id, p_acknowledged_by }) => { const j = csMock.jobs[p_job_id].job; j.custody_status = 'in_store'; j.received_at = new Date().toISOString(); j.received_acknowledged_by = p_acknowledged_by; if (j.status !== 'pending_authorisation') j.status = 'received'; return null }
SAMPLE.cs_update_item = ({ p_item_id, p_patch }) => { for (const j of Object.values(csMock.jobs)) { const i = j.items.find((x) => x.id === p_item_id); if (i) { Object.assign(i, p_patch.catalog_item_id ? { catalog_item_id: p_patch.catalog_item_id, name_snapshot: p_patch.name || i.name_snapshot, status: 'draft' } : {}, p_patch.condition ? { condition: p_patch.condition } : {}, p_patch.quantity ? { quantity: p_patch.quantity } : {}, p_patch.status ? { status: p_patch.status } : {}); return i } } return null }
SAMPLE.cs_set_status = ({ p_job_id, p_status }) => { csMock.jobs[p_job_id].job.status = p_status; return null }
SAMPLE.cs_finalise_import = ({ p_job_id, p_exclude_unresolved }) => { const j = csMock.jobs[p_job_id]; if (j.items.some((i) => i.status === 'needs_review') && !p_exclude_unresolved) throw new Error('Some entries still need review.'); let copies = 0; let entries = 0; j.items.forEach((i) => { if (i.status === 'needs_review') i.status = 'excluded'; if (i.status === 'draft' && i.catalog_item_id) { i.status = 'imported'; copies += i.quantity; entries += 1 } }); j.job.status = j.job.kind === 'express' ? 'completed' : 'ready_for_collection'; j.events.unshift({ id: j.events.length + 1, created_at: new Date().toISOString(), actor_type: 'employee', action: 'import_completed', detail: { copies }, employee_name: 'HaydenM8' }); return { entries_imported: entries, copies_created: copies, repeated: false } }
SAMPLE.cs_record_return = ({ p_job_id, p_container_ids, p_recipient_name }) => { const j = csMock.jobs[p_job_id]; j.containers.forEach((c) => { if (p_container_ids.includes(c.id)) c.returned_at = new Date().toISOString() }); const left = j.containers.filter((c) => !c.returned_at).length; j.job.custody_status = left ? 'partially_returned' : 'returned'; if (!left && j.job.status === 'ready_for_collection') j.job.status = 'completed'; j.events.unshift({ id: j.events.length + 1, created_at: new Date().toISOString(), actor_type: 'employee', action: left ? 'collection_partly_returned' : 'collection_returned', detail: { recipient: p_recipient_name }, employee_name: 'HaydenM8' }); return null }
SAMPLE.cs_import_preview = ({ p_job_id }) => { const j = csMock.jobs[p_job_id]; const ready = j.items.filter((i) => i.status === 'draft' && i.catalog_item_id); return { authorisation: { status: j.authorisation.status, valid: j.authorisation.status === 'approved' }, ready_entries: ready.length, ready_items: ready.reduce((t, i) => t + i.quantity, 0), needs_review: j.items.filter((i) => i.status === 'needs_review').length, missing_condition: 0, already_imported: 0, duplicates: ready.filter((i) => i.quantity > 1).map((i) => ({ catalog_item_id: i.catalog_item_id, name: i.name_snapshot, copies: i.quantity, conditions: [i.condition] })), by_condition: ready.reduce((acc, i) => ({ ...acc, [i.condition]: (acc[i.condition] || 0) + i.quantity }), {}) } }
SAMPLE.cs_add_photos = () => 1
// Test helpers: the collector approves; some scans arrive.
window.__csApprove = (jobId) => { const j = csMock.jobs[jobId]; j.authorisation.status = 'approved'; j.authorisation.expires_at = new Date(Date.now() + 30 * 86400000).toISOString(); j.job.status = j.job.custody_status === 'in_store' || j.job.custody_status === 'not_applicable' ? 'received' : 'awaiting_intake' }
window.__csScan = (jobId) => { const j = csMock.jobs[jobId]; j.job.status = 'scanning'; j.items.push({ id: jobId + 'i1', name_snapshot: 'Connor Bedard #1', catalog_item_id: 'cat1', condition: 'Near Mint', quantity: 2, status: 'draft', container_id: j.containers[0]?.id, identification: {} }, { id: jobId + 'i2', name_snapshot: 'Unidentified card', catalog_item_id: null, condition: 'Lightly Played', quantity: 1, status: 'needs_review', container_id: j.containers[0]?.id, identification: { subject: 'Sidney Crosby', number: '87', year: 2005 } }) }
// MOCK customers (preview only), standing in for supabase/customers.sql.
const cuMock = {
  customers: [
    { id: 'cu1', customer_number: 'C-000001', name: 'Joe Test', first_name: 'Joe', last_name: 'Test', username: 'TestJoe', avatar_url: '', is_member: true, status: 'active', email: 'joe@example.com', phone: '902-555-0101', balance: 42.5, last_purchase: new Date(Date.now() - 86400000 * 3).toISOString(), transactions: 7, created_at: '2026-08-02T15:00:00Z', profile_id: 'col1', wishlist_access: 'granted', wishlist_matches: 2 },
    { id: 'cu4', customer_number: 'C-000004', name: 'Riley Chen', first_name: 'Riley', last_name: 'Chen', username: 'RileyC', avatar_url: '', is_member: true, status: 'active', email: null, phone: null, balance: 0, last_purchase: new Date(Date.now() - 86400000 * 1).toISOString(), transactions: 3, created_at: '2026-09-02T15:00:00Z', profile_id: 'col4', wishlist_access: 'revoked', wishlist_matches: null },
    { id: 'cu2', customer_number: 'C-000002', name: 'Pat Walker', first_name: 'Pat', last_name: 'Walker', username: null, avatar_url: '', is_member: false, status: 'active', email: 'pat@example.com', phone: '902-555-0177', balance: 0, last_purchase: new Date(Date.now() - 86400000 * 20).toISOString(), transactions: 2, created_at: '2026-10-01T15:00:00Z' },
    { id: 'cu3', customer_number: 'C-000003', name: 'Sam Lee', first_name: 'Sam', last_name: 'Lee', username: null, avatar_url: '', is_member: false, status: 'inactive', email: null, phone: null, balance: 0, last_purchase: null, transactions: 0, created_at: '2026-05-01T15:00:00Z' },
  ],
  notes: [{ id: 'n1', body: 'Collects 1990s Upper Deck hockey. Prefers store credit for trade-ins.', created_at: '2026-09-20T15:00:00Z', created_by: 'Morgan Lee', mine: true }],
}
window.__cuMock = cuMock
SAMPLE.customers_summary = () => ({ total: cuMock.customers.length, members: cuMock.customers.filter((c) => c.is_member).length, outstanding_credit: 42.5, new_this_month: 1 })
SAMPLE.customers_list = ({ p_search, p_filter, p_sort }) => { const q = String(p_search || '').toLowerCase(); const rows = cuMock.customers.filter((c) => (!q || [c.name, c.username, c.customer_number, c.email, c.phone].some((v) => String(v || '').toLowerCase().includes(q))) && ({ members: c.is_member, store: !c.is_member, active: c.status === 'active', inactive: c.status === 'inactive', wishlist: c.wishlist_matches > 0 }[p_filter] ?? true)); if (p_sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name)); if (p_sort === 'transactions') rows.sort((a, b) => b.transactions - a.transactions); if (p_sort === 'matches') rows.sort((a, b) => (b.wishlist_matches ?? -1) - (a.wishlist_matches ?? -1)); return rows.map((r) => ({ ...r, total_count: rows.length })) }
SAMPLE.customer_profile = ({ p_customer_id }) => { const c = cuMock.customers.find((x) => x.id === p_customer_id); return { customer: { ...c, display_name: c.name }, member: c.is_member ? { username: c.username, display_name: c.name, avatar_url: '', level: 7 } : null, stats: { transactions: c.transactions, purchases: Math.max(0, c.transactions - 1), total_spent: 318.4, trade_ins: c.is_member ? 1 : 0, last_purchase: c.last_purchase }, balance: c.balance, can_manage: true, link_request: c.link ? { id: 'lr1', status: 'pending', expires_at: new Date(Date.now() + 2 * 86400000).toISOString(), username: 'TestJoe' } : null, notices: c.is_member ? { collection_held: 1 } : {} } }
const wishMock = [
  { catalog_item_id: 'w1', name: 'Connor Bedard', card_number: '201', release_year: 2023, set_name: '2023-24 Upper Deck Young Guns', image_path: '', notes: 'Raw, near mint or better', priority: 2, available: 3, price_min: 149.99, price_max: 179.99, stock: [{ inventory_id: 'inv1', sku: 'UD-YG-201-A', condition: 'Near Mint', price: 149.99, available: 2 }, { inventory_id: 'inv2', sku: 'UD-YG-201-G', condition: 'Graded', grade: 'PSA 9', price: 179.99, available: 1 }] },
  { catalog_item_id: 'w2', name: 'Sidney Crosby', card_number: '87', release_year: 2005, set_name: '2005-06 Upper Deck', image_path: '', notes: null, priority: 1, available: 1, price_min: 42.5, price_max: 42.5, stock: [{ inventory_id: 'inv3', sku: 'UD-05-87', condition: 'Lightly Played', price: 42.5, available: 1 }] },
  { catalog_item_id: 'w3', name: 'Wayne Gretzky', card_number: '18', release_year: 1979, set_name: '1979-80 O-Pee-Chee', image_path: '', notes: 'Any condition', priority: 0, available: 0, price_min: null, price_max: null, stock: [] },
]
window.__wishAccess = { cu1: 'granted', cu4: 'revoked' }
SAMPLE.customer_wishlist = ({ p_customer_id, p_filter }) => {
  const status = window.__wishAccess[p_customer_id] || 'none'
  if (status !== 'granted') return { access: { status, id: status === 'pending' ? 'wa-mock-1' : null }, items: [] }
  const items = wishMock.filter((i) => (p_filter === 'in_store' ? i.available > 0 : p_filter === 'not_in_store' ? !i.available : true))
  return { access: { status: 'granted', id: null, automatic: true }, counts: { all: 3, in_store: 2, not_in_store: 1 }, items }
}
SAMPLE.customer_wishlist_access_request = ({ p_customer_id }) => { window.__wishAccess[p_customer_id] = 'pending'; return 'wa-mock-1' }
SAMPLE.customer_transactions = () => [
  { id: 't1', transaction_number: 'CH-001042', created_at: new Date(Date.now() - 86400000 * 3).toISOString(), transaction_type: 'sale', status: 'completed', items: '2 × Connor Bedard #1, 1 × Card sleeves', item_count: 3, subtotal: 34.98, tax: 5.25, total: 40.23, payments: 'card', refunded: false, employee_name: 'Morgan Lee', total_count: 2 },
  { id: 't2', transaction_number: 'TRD-1041', created_at: new Date(Date.now() - 86400000 * 9).toISOString(), transaction_type: 'trade_in', status: 'completed', items: '1 × Sidney Crosby #87 (in)', item_count: 1, subtotal: 0, tax: 0, total: -42.5, payments: 'trade credit', refunded: false, employee_name: 'Sarah Moss', total_count: 2 },
]
SAMPLE.customer_transaction_detail = () => ({ items: [{ name: 'Connor Bedard #1', condition: 'Near Mint', quantity: 2, line_total: 29.98, direction: 'out' }, { name: 'Card sleeves', quantity: 1, line_total: 5, direction: 'out' }], payments: [{ method: 'card', amount: 40.23 }], refunds: [] })
SAMPLE.customer_trade_ins = () => [{ transaction_id: 't2', transaction_number: 'TRD-1041', created_at: new Date(Date.now() - 86400000 * 9).toISOString(), name: 'Sidney Crosby #87', condition: 'Lightly Played', quantity: 1, amount: 42.5, paid_as: 'Store credit', status: 'completed' }]
SAMPLE.customer_collection_jobs = () => [{ id: 'j1', reference: 'CH-2026-00142', kind: 'dropoff', status: 'ready_for_collection', custody_status: 'in_store', created_at: '2026-10-02T15:00:00Z', scanned: 2140, imported: 2101 }]
SAMPLE.customer_loyalty = () => ({ username: 'TestJoe', level: 7, items_from_store: 2103, items_from_purchases: 2, items_from_scanning: 2101 })
SAMPLE.store_credit_balance = () => 42.5
SAMPLE.store_credit_history = () => [{ id: 'l1', entry_type: 'trade_credit_issued', amount: 42.5, transaction_number: 'TRD-1041', note: 'Trade-in paid as Store Credit', created_at: new Date(Date.now() - 86400000 * 9).toISOString() }]
SAMPLE.customer_notes = () => cuMock.notes
SAMPLE.customer_note_save = ({ p_body, p_note_id }) => { if (p_note_id) cuMock.notes = cuMock.notes.map((n) => (n.id === p_note_id ? { ...n, body: p_body, updated_at: new Date().toISOString(), updated_by: 'HaydenM8' } : n)); else cuMock.notes = [{ id: 'n' + Date.now(), body: p_body, created_at: new Date().toISOString(), created_by: 'HaydenM8', mine: true }, ...cuMock.notes]; return 'ok' }
SAMPLE.customer_create = ({ p_data, p_force }) => { const dupe = cuMock.customers.find((c) => (p_data.email && c.email === p_data.email) || (c.first_name === p_data.first_name && c.last_name === p_data.last_name)); if (dupe && !p_force) return { duplicates: [{ id: dupe.id, customer_number: dupe.customer_number, name: dupe.name, email: dupe.email, phone: dupe.phone }] }; const id = 'cu' + (cuMock.customers.length + 1); cuMock.customers.unshift({ id, customer_number: 'C-00000' + (cuMock.customers.length + 1), name: [p_data.first_name, p_data.last_name].filter(Boolean).join(' ') || p_data.display_name, first_name: p_data.first_name, last_name: p_data.last_name, is_member: false, status: 'active', email: p_data.email, phone: p_data.phone, balance: 0, transactions: 0, created_at: new Date().toISOString() }); return { id, customer_number: 'C-00000' + cuMock.customers.length } }
SAMPLE.customer_link_request = ({ p_customer_id }) => { const c = cuMock.customers.find((x) => x.id === p_customer_id); c.link = true; return 'lr1' }
SAMPLE.customer_duplicates = () => [{ reason: 'Same phone', key: '9025550101', customers: [{ id: 'cu1', customer_number: 'C-000001', name: 'Joe Test', phone: '902-555-0101', is_member: true, created_at: '2026-08-02T15:00:00Z' }, { id: 'cu9', customer_number: 'C-000009', name: 'Joseph Test', phone: '902 555 0101', is_member: false, created_at: '2026-09-12T15:00:00Z' }] }]
// MOCK transactions (preview only), standing in for supabase/transactions.sql.
const txAgo = (hours) => new Date(Date.now() - hours * 3600000).toISOString()
const txMock = {
  refunds: [],
  rows: [
    { id: 't1', number: 'TXN-20261009-00142', created_at: txAgo(1), kind: 'sale', state: 'completed', payment: 'card', total: 40.23, refunded: 0, items: 3, employee: 'Morgan Lee', customer: 'Joe Test', username: 'TestJoe', customer_id: 'cu1' },
    { id: 't2', number: 'TXN-20261009-00141', created_at: txAgo(2), kind: 'trade', state: 'partially_refunded', payment: 'mixed', total: 57.5, refunded: 20, items: 4, employee: 'Sarah Moss', customer: 'Pat Walker', customer_id: 'cu2' },
    { id: 't3', number: 'TXN-20261009-00140', created_at: txAgo(3), kind: 'buy', state: 'completed', payment: 'cash', total: -85, refunded: 0, items: 6, employee: 'Morgan Lee', customer: null },
    { id: 't4', number: 'TXN-20261009-00139', created_at: txAgo(4), kind: 'refund', state: 'completed', payment: 'cash', total: -20, refunded: 0, items: 0, employee: 'Sarah Moss', customer: 'Pat Walker', customer_id: 'cu2' },
    { id: 't5', number: 'TXN-20261008-00133', created_at: txAgo(26), kind: 'trade_in', state: 'completed', payment: 'store_credit', total: 0, refunded: 0, items: 2, employee: 'HaydenM8', customer: 'Joe Test', username: 'TestJoe', customer_id: 'cu1' },
    { id: 't6', number: 'TXN-20261008-00130', created_at: txAgo(30), kind: 'sale', state: 'pending', payment: 'none', total: 129.99, refunded: 0, items: 1, employee: 'HaydenM8', customer: null },
  ],
}
window.__txMock = txMock
SAMPLE.tx_summary = () => ({ sales: 412.6, refunds: 20, items_sold: 14, transactions: 9, time_zone: 'America/Halifax' })
SAMPLE.tx_list = ({ p_filter, p_search }) => {
  const q = String(p_search || '').toLowerCase()
  const rows = txMock.rows.filter((r) => (!q || [r.number, r.customer, r.username].some((v) => String(v || '').toLowerCase().includes(q)))
    && ({ sales: ['sale', 'trade'].includes(r.kind), buys: ['buy', 'trade_in', 'trade'].includes(r.kind), refunds: r.kind === 'refund', voided: r.state === 'voided', pending: r.state === 'pending', mine: r.employee === 'HaydenM8' }[p_filter] ?? true))
  return { total: rows.length, rows, employees: [{ id: 'e1', name: 'HaydenM8' }, { id: 'e2', name: 'Morgan Lee' }, { id: 'e3', name: 'Sarah Moss' }], access: { view_all: true, refund: true, void: true, sensitive: true, refund_limit: 50 } }
}
SAMPLE.tx_detail = ({ p_transaction_id }) => {
  const r = txMock.rows.find((x) => x.id === p_transaction_id) || txMock.rows[0]
  const sale = r.kind === 'sale' || r.kind === 'trade'
  const items = r.kind === 'refund' ? [] : r.kind === 'buy' || r.kind === 'trade_in'
    ? [{ id: 'i9', direction: 'in', name: 'Wayne Gretzky 1979-80 O-Pee-Chee #18', sku: 'TI-7F3A', catalog_item_id: '3f1c2b7e-1111-4bbb-9ccc-000000000018', inventory_id: 'inv9', condition: 'Lightly Played', quantity: 1, unit_price: 85, discount: 0, line_total: 85, refunded_qty: 0 }]
    : [{ id: 'i1', direction: 'out', name: 'Connor Bedard 2023-24 Young Guns #201', sku: 'UD-YG-201-A', catalog_item_id: '7a9d0c1e-2222-4bbb-9ccc-000000000201', inventory_id: 'inv1', condition: 'Near Mint', quantity: 2, unit_price: 14.99, discount: 0, line_total: 29.98, refunded_qty: r.state === 'partially_refunded' ? 1 : 0 },
       { id: 'i2', direction: 'out', name: 'Card sleeves (100)', sku: 'SLV-100', catalog_item_id: null, inventory_id: 'inv2', condition: 'New', quantity: 1, unit_price: 5, discount: 0, line_total: 5, refunded_qty: 0 },
       ...(r.kind === 'trade' ? [{ id: 'i3', direction: 'in', name: 'Sidney Crosby 2005-06 Upper Deck #87', sku: 'TI-88A1', catalog_item_id: null, inventory_id: 'inv3', condition: 'Lightly Played', quantity: 1, unit_price: 42.5, discount: 0, line_total: 42.5, refunded_qty: 0 }] : [])]
  const paid = sale ? Number(r.total) + (r.kind === 'trade' ? 0 : 0) : 0
  return {
    access: { view_all: true, refund: true, void: true, sensitive: true, refund_limit: 50, employee_id: 'e1' },
    transaction: { id: r.id, number: r.number, kind: r.kind, type: { sale: 'sale', trade: 'exchange', buy: 'trade_in', trade_in: 'trade_in', refund: 'return' }[r.kind], state: r.state, status: r.state === 'pending' ? 'hold' : 'completed',
      created_at: r.created_at, completed_at: r.created_at, subtotal: sale ? 34.98 : r.total, discount_total: 0, tax_total: sale ? 5.25 : 0, trade_credit_total: r.kind === 'trade' ? 42.5 : 0, store_credit_total: 0,
      total: r.total, paid, refunded: r.refunded, refundable: Math.max(paid - r.refunded, 0), group_number: r.kind === 'trade' ? 'CHK-000088' : null, store_name: 'Nordvik Test Store', location_name: 'Main Store', register: 'Till 1', employee: r.employee,
      original: r.kind === 'refund' ? { id: 't2', number: 'TXN-20261009-00141' } : null },
    customer: r.customer ? { id: r.customer_id, customer_number: r.customer_id === 'cu1' ? 'C-000001' : 'C-000002', is_member: Boolean(r.username), name: r.customer, username: r.username, email: r.username ? 'joe@example.com' : null } : null,
    items,
    payments: r.kind === 'buy' ? [{ method: 'cash', amount: -85 }] : r.kind === 'trade_in' ? [{ method: 'trade_credit', amount: 0 }] : r.kind === 'refund' ? [{ method: 'cash', amount: -20 }] : r.kind === 'trade' ? [{ method: 'trade_credit', amount: 42.5 }, { method: 'card', amount: 15 }] : r.state === 'pending' ? [] : [{ method: 'card', amount: 40.23 }],
    refunds: r.state === 'partially_refunded' ? [{ id: 'rr1', transaction_id: 't4', number: 'TXN-20261009-00139', created_at: txAgo(4), method: 'cash', amount: 20, reason: 'Damaged corner', employee: 'Sarah Moss', lines: [{ name: 'Connor Bedard 2023-24 Young Guns #201', quantity: 1, amount: 17.24, restocked: false }] }] : [],
    store_credit: r.kind === 'trade_in' ? [{ entry_type: 'trade_credit_issued', amount: 60, created_at: r.created_at }] : [],
    identification: r.kind === 'buy' ? { seller: { name: 'Pat Walker', photo_id_shown: true, id_type: 'drivers_licence', verified_by: 'Morgan Lee' }, buyback: { method: 'guest_manual_id_check', id_type: 'drivers_licence', employee: 'Morgan Lee' } } : null,
    audit: [{ action: 'completed', created_at: r.created_at, employee: r.employee }, ...(r.state === 'partially_refunded' ? [{ action: 'refund_completed', created_at: txAgo(4), employee: 'Sarah Moss', reason: 'Damaged corner' }] : [])],
  }
}
SAMPLE.tx_refund = ({ p_amount, p_method, p_request_id, p_approver }) => {
  const prior = txMock.refunds.find((x) => x.request_id === p_request_id)
  if (prior) return { ...prior.result, repeated: true }
  const amount = Number(p_amount || 17.24)
  if (amount > 50 && !p_approver) throw new Error('APPROVAL_REQUIRED: Refunds over $50.00 need a supervisor or manager.')
  const result = { transaction_id: 't4', transaction_number: 'TXN-20261009-00150', amount, method: p_method, remaining: 0 }
  txMock.refunds.push({ request_id: p_request_id, result })
  return result
}
SAMPLE.tx_log_receipt = () => null
// MOCK pawn loans (preview only), standing in for supabase/pawn_loans.sql. TEST values, not legal terms.
const pawnPerms = { pawn_view: true, pawn_create: true, pawn_approve: true, pawn_disburse: true, pawn_payments: true, pawn_renew: true, pawn_release: true, pawn_overdue: true, pawn_forfeit: true, pawn_transfer: true, pawn_reports: true, boss: true }
const pawnRules = { term_days_default: 30, term_days_max: 90, interest_monthly_pct_max: 4, grace_days: 10, forfeiture_wait_days: 20, forfeiture_notice_required: true, forfeiture_notice_days: 10, partial_payments_allowed: true, renewals_allowed: true, max_renewals: 3, electronic_signature_allowed: true, licence_required: true, id_fields: ['name', 'date_of_birth', 'address', 'id_type'], fees: [{ code: 'fee1', label: 'Appraisal fee (TEST)', basis: 'flat', amount: 5 }], disclosures: 'TEST DISCLOSURES: sample text for trying the system. Not legal wording.', agreement_template: '' }
const pawnReadiness = { ready: true, test_mode: true, reasons: [], config: { id: 'cfg1', name: 'Test configuration', jurisdiction: 'CA-NS', status: 'test', rules: pawnRules }, settings: { store_id: 's1', lending_enabled: false, config_id: 'cfg1', interest_monthly_pct: 3, licence_number: '', licence_verified: false, due_soon_days: 7 } }
const pd = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10) }
const pawnRows = [
  { id: 'pl1', loan_number: 'PL-2026-000014', state: 'overdue', status: 'active', is_test: true, principal: 250, balance: 279.5, issue_date: pd(-40), due_date: pd(-10), days_overdue: 10, employee: 'Morgan Lee', customer: 'Joe Test', username: 'TestJoe', customer_id: 'cu1', collateral: { count: 3, first: 'Connor Bedard Young Guns #201' } },
  { id: 'pl2', loan_number: 'PL-2026-000015', state: 'due_soon', status: 'active', is_test: true, principal: 120, balance: 128.2, issue_date: pd(-26), due_date: pd(4), employee: 'Sarah Moss', customer: 'Pat Walker', customer_id: 'cu2', collateral: { count: 1, first: 'LEGO 75192 Millennium Falcon' } },
  { id: 'pl3', loan_number: 'PL-2026-000016', state: 'active', status: 'active', is_test: true, principal: 80, balance: 81.6, issue_date: pd(-5), due_date: pd(25), employee: 'HaydenM8', customer: 'Riley Chen', username: 'RileyC', customer_id: 'cu4', collateral: { count: 2, first: 'Pokémon Charizard Base Set 4/102' } },
  { id: 'pl4', loan_number: 'PL-2026-000011', state: 'redeemed', status: 'redeemed', is_test: true, principal: 60, balance: 0, issue_date: pd(-60), due_date: pd(-30), employee: 'Morgan Lee', customer: 'Joe Test', username: 'TestJoe', customer_id: 'cu1', collateral: { count: 1, first: 'Wayne Gretzky O-Pee-Chee #18' } },
  { id: 'pl5', loan_number: 'PL-2026-000017', state: 'draft', status: 'draft', is_test: true, principal: 0, balance: 0, issue_date: null, due_date: null, employee: 'HaydenM8', customer: 'Sam Lee', customer_id: 'cu3', collateral: { count: 1, first: 'Sidney Crosby Young Guns' } },
]
SAMPLE.pawn_summary = () => ({ active: 3, principal_outstanding: 450, due_soon: 1, overdue: 1, forfeiture_review: 0, drafts: 1, readiness: pawnReadiness, perms: pawnPerms, due_soon_days: 7 })
SAMPLE.pawn_list = ({ p_filter, p_search }) => { const q = String(p_search || '').toLowerCase(); const rows = pawnRows.filter((r) => (!q || [r.loan_number, r.customer, r.collateral.first].some((v) => String(v).toLowerCase().includes(q))) && (p_filter === 'all' || !p_filter || (p_filter === 'active' ? r.status === 'active' : p_filter === 'drafts' ? ['draft', 'approved'].includes(r.status) : r.state === p_filter))); return { total: rows.length, rows, perms: pawnPerms } }
SAMPLE.pawn_detail = ({ p_loan_id }) => {
  const r = pawnRows.find((x) => x.id === p_loan_id) || pawnRows[0]
  const terms = { principal: r.principal, term_days: 30, issue_date: r.issue_date, due_date: r.due_date, interest_monthly_pct: 3, interest_for_term: 7.5, fees: [{ code: 'fee1', label: 'Appraisal fee (TEST)', amount: 5 }], fees_total: 5, cost_of_borrowing: 12.5, redemption_at_due: r.principal + 12.5, grace_days: 10, forfeiture_wait_days: 20, partial_payments_allowed: true, renewals_allowed: true, max_renewals: 3, config_name: 'Test configuration', jurisdiction: 'CA-NS', config_status: 'test' }
  return {
    perms: pawnPerms, readiness: pawnReadiness, today: pd(0), config_rules: pawnRules,
    loan: { id: r.id, loan_number: r.loan_number, status: r.status, state: r.state, is_test: true, principal: r.principal, term_days: 30, interest_monthly_pct: 3, issue_date: r.issue_date, due_date: r.due_date, renewals: 0, legal_hold: false, disbursement_method: 'cash', disbursed_at: r.issue_date ? r.issue_date + 'T15:00:00Z' : null, employee: r.employee, approved_by: 'HaydenM8', days_overdue: r.days_overdue, earliest_forfeiture: r.due_date ? pd(-10 + 30) : null, terms, version: 2 },
    borrower: { name: 'Joe Test', id_type: 'drivers_licence', checked_at: (r.issue_date || pd(0)) + 'T15:00:00Z' },
    balance: { principal_outstanding: r.state === 'redeemed' ? 0 : r.principal, charges_unpaid: Math.max(r.balance - r.principal, 0), redemption_amount: r.balance },
    customer: { id: r.customer_id, name: r.customer, username: r.username, customer_number: 'C-000001', phone: '902-555-0101' },
    collateral: [
      { id: 'c1', collateral_code: r.loan_number + '-01', name: r.collateral.first, category: 'Trading cards', condition: 'Near Mint', quantity: 1, photos: [], estimated_value: 200, valuation_source: 'CollectorsHub sold prices (14 sales, Near Mint)', valuation_date: r.issue_date, allocated_loan_value: 75, storage: { room: 'Vault', cabinet: 'B', shelf: '2', bin: '14' }, status: r.state === 'redeemed' ? 'released' : 'in_custody' },
      ...(r.collateral.count > 1 ? [{ id: 'c2', collateral_code: r.loan_number + '-02', name: 'LEGO 10497 Galaxy Explorer', category: 'LEGO', brand: 'LEGO', model: '10497', serial_number: '', condition: 'Sealed', quantity: 1, photos: [], estimated_value: 250, valuation_source: 'Staff appraisal', valuation_date: r.issue_date, allocated_loan_value: 125, storage: { room: 'Vault', cabinet: 'C', shelf: '1' }, status: 'in_custody' }] : []),
    ],
    ledger: [
      { id: 1, created_at: (r.issue_date || pd(0)) + 'T15:00:00Z', entry_type: 'disbursement', amount: -r.principal, principal_part: r.principal, charges_part: 0, principal_after: r.principal, charges_after: 0, method: 'cash', transaction_number: 'TXN-20260830-00120', employee: r.employee },
      { id: 2, created_at: (r.issue_date || pd(0)) + 'T15:00:01Z', entry_type: 'fee_assessed', amount: 0, principal_part: 0, charges_part: 5, principal_after: r.principal, charges_after: 5, note: 'Appraisal fee (TEST)', employee: r.employee },
    ],
    agreements: [{ id: 'a1', kind: 'original', loan_version: 2, document_html: '<p class="pa-test">TEST LOAN: not a legal agreement.</p><h1>Pawn Agreement ' + r.loan_number + '</h1><p class="pa-warning">No approved agreement template is configured. This layout is a placeholder and is not a legal agreement.</p><p><b>Borrower:</b> ' + r.customer + '</p>', sha256: '9f2c4e1ab3d5c6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7', signature_method: 'electronic', customer_signature: r.customer, employee: r.employee, created_at: (r.issue_date || pd(0)) + 'T14:58:00Z' }],
    events: [{ action: 'draft_created', created_at: (r.issue_date || pd(0)) + 'T14:40:00Z', employee: r.employee }, { action: 'approved', created_at: (r.issue_date || pd(0)) + 'T14:50:00Z', employee: 'HaydenM8' }, { action: 'agreement_signed', created_at: (r.issue_date || pd(0)) + 'T14:58:00Z', employee: r.employee }, { action: 'issued', created_at: (r.issue_date || pd(0)) + 'T15:00:00Z', employee: r.employee }],
    notices: r.state === 'overdue' ? [{ id: 'n1', kind: 'overdue_notice', method: 'mail', delivery: 'sent', sent_at: pd(-3) + 'T12:00:00Z' }] : [],
  }
}
SAMPLE.pawn_settings = () => ({ perms: pawnPerms, readiness: pawnReadiness, configs: [{ id: 'cfg1', name: 'Test configuration', jurisdiction: 'CA-NS', status: 'test', rules: pawnRules, missing: ['Approved agreement template'] }], employees: [{ id: 'e2', name: 'Morgan Lee', role: 'manager', permissions: { pawn_view: true, pawn_create: true, pawn_approve: true, pawn_disburse: true, pawn_payments: true } }, { id: 'e3', name: 'Sarah Moss', role: 'cashier', permissions: { pawn_view: true, pawn_payments: true } }] })
SAMPLE.pawn_quote = ({ p_principal, p_term_days }) => { const term = Number(p_term_days || 30); const interest = Math.round(p_principal * 0.03 / 30 * term * 100) / 100; return { principal: p_principal, term_days: term, issue_date: pd(0), due_date: pd(term), interest_monthly_pct: 3, interest_for_term: interest, fees: [{ code: 'fee1', label: 'Appraisal fee (TEST)', amount: 5 }], fees_total: 5, cost_of_borrowing: interest + 5, redemption_at_due: p_principal + interest + 5, grace_days: 10, forfeiture_wait_days: 20, partial_payments_allowed: true, renewals_allowed: true, max_renewals: 3, config_name: 'Test configuration', jurisdiction: 'CA-NS', config_status: 'test' } }
SAMPLE.pawn_save_draft = () => ({ id: 'pl9', loan_number: 'PL-2026-000018', version: 1 })
SAMPLE.pawn_report = () => ({ active_loans: 3, principal_outstanding: 450, overdue: 1, forfeiture_reviews: 0, originations: 6, disbursed: 690, cash_disbursed: 610, repayments: 318.4, principal_repaid: 240, charges_income: 78.4, redeemed: 3, reversals: 0, forfeited: 0, lawfully_acquired_items: 0, transferred_items: 0, collateral_estimated_value: 1350, collateral_loan_value: 450, transactions_total: -371.6, ledger_cash_total: -371.6, categories: ['Trading cards', 'LEGO'] })
supabase.rpc = async (name, params) => {
  const value = SAMPLE[name]
  try {
    return { data: typeof value === 'function' ? value(params || {}) : value ?? null, error: null }
  } catch (error) {
    return { data: null, error: { message: error.message } }
  }
}

const screen = new URLSearchParams(window.location.search).get('screen') || 'myhr'
const payViews = { availability: 'availability', pay: 'home', time: 'time', leave: 'leave', leaveinfo: 'leaveinfo', schedule: 'schedule', personal: 'personal', addresses: 'addresses', family: 'family', job: 'job', emergency: 'emergency' }

function OrgEmployeesPreview() {
  const [ready, setReady] = React.useState(false)
  React.useEffect(() => { setReady(true) }, [])
  return ready ? <MyHROrgEmployees orgId="org" orgName="Nordvik Collectibles" onBack={() => {}} initialSelectedId="e2" /> : null
}

function Preview() {
  let content
  if (screen === 'org-employees') content = <OrgEmployeesPreview />
  else if (screen === 'org') content = <OrgPortal session={{ type: 'organization', orgId: 'org', orgCode: 'ORG-0001', orgName: 'Nordvik Collectibles' }} activeModule={new URLSearchParams(window.location.search).get('module') || 'overview'} />
  else if (screen === 'store-hours') content = <StoreHoursModal orgId="org" store={{ storeId: 'st1', storeName: 'Nordvik Test Store' }} onClose={() => {}} />
  else if (screen === 'myhr-builder') content = <section className="myhr-page"><div className="myhr-pay myhr-pay-schedule"><MyHRSchedule storeId={storeId} isManager storeName="Nordvik Test Store" initialTab="builder" /></div></section>
  else if (screen === 'builder') content = <ScheduleBuilder storeId={storeId} />
  else if (screen === 'manual-id') content = <ManualIdCheck kind="manual" customer={{ name: 'Jordan Sample', fullName: 'Jordan Sample', username: 'Jordan_S', collectorshub_user_id: 'p1' }} rules={DEFAULT_RULES} storeId={storeId} locationId="loc1" onDone={(record) => { window.__done = record }} onCancel={() => {}} />
  else if (screen === 'guest-id') content = <ManualIdCheck kind="guest" customer={{ guest: true, name: 'Guest' }} rules={{ ...DEFAULT_RULES, require_address: true, require_contact: true, policy_note: 'Sample policy: record name, address, phone and DOB for every buyback.' }} storeId={storeId} locationId="loc1" onDone={(record) => { window.__done = record }} onCancel={() => {}} />
  else if (screen === 'pawn') content = <PawnView session={{ storeId, locationId: 'loc1', storeName: 'Nordvik Test Store' }} onOpenCustomer={() => {}} />
  else if (screen === 'transactions') content = <TransactionsView session={{ storeId, locationId: 'loc1' }} receiptBranding={{ storeName: 'Nordvik Test Store' }} renderReceipt={(receipt) => <article className="receipt-paper"><h2>{receipt.number}</h2><p>{receipt.items.length} items · total {receipt.total}</p></article>} onOpenCustomer={() => {}} />
  else if (screen === 'customers') content = <CustomersView session={{ storeId, storeName: 'Nordvik Test Store', locationId: 'loc1' }} onScanForCollector={() => {}} />
  else if (screen === 'scan-centre') content = <ScanCentre session={{ storeId, storeName: 'Nordvik Test Store', locationId: 'loc1' }} storeQueue={[]} onSaveStoreQueue={() => {}} onStockChanged={() => {}} collectorQueues={{}} onSaveCollectorQueue={() => {}} collectorScanning={new URLSearchParams(window.location.search).get('feature') !== 'off'} />
  else if (screen === 'store-features') content = <StoreFeaturesModal orgId="org" store={{ storeId: 'st1', storeName: 'Nordvik Test Store' }} onClose={() => {}} />
  else if (screen === 'id-rules') content = <BuybackRulesModal orgId="org" store={{ storeId: 'st1', storeName: 'Nordvik Test Store' }} onClose={() => {}} />
  else if (screen === 'idcard-buy') content = <div className="checkout-columns" style={{ gridTemplateColumns: '340px 340px', alignItems: 'start' }}>{[null, { id: 'x', method: 'manual_id_check' }].map((manual, index) => <section className="customer-card" key={index}><div className="side-title"><strong>Customer</strong></div><IdentityCustomerCard customer={{ name: 'Jordan Sample', fullName: 'Jordan Sample', username: 'Jordan_S', collectorshub_user_id: 'p' + index, storeCredit: 0, identityStatus: 'unverified', identity: { status: 'unverified' } }} storeId={storeId} mode="buy" buyback manualCheck={manual} onManualCheck={() => {}} money={new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })} onVerify={() => {}} onDetails={() => {}} onRemove={() => {}} /></section>)}</div>
  else if (screen === 'checkout-scroll') content = (
    <section className="register-workspace">
      <header className="register-header"><h1>Register</h1></header>
      <div className="register-grid register-dashboard-grid checkout-stage">
        <section className="register-checkout-screen">
          <div className="checkout-head"><button type="button">Back to cart</button><h2>Checkout · Sale</h2></div>
          <div className="checkout-columns">
            <section className="customer-card"><div className="side-title"><strong>Customer</strong></div></section>
            <section className="checkout-lines">
              <div className="side-title"><strong>40 ITEMS</strong></div>
              <div className="checkout-lines-list">{Array.from({ length: 40 }, (_, index) => <div className="checkout-line" key={index}><span><strong>Sample item {index + 1}</strong><small>Near Mint</small></span><span>$1.00</span></div>)}</div>
            </section>
            <section className="totals-card"><div className="side-title"><strong>Current sale</strong></div></section>
          </div>
        </section>
      </div>
    </section>
  )
  else if (screen === 'idcard-demo') content = <div className="checkout-columns" style={{ gridTemplateColumns: '340px', alignItems: 'start' }}><section className="customer-card"><div className="side-title"><strong>Customer</strong></div><IdentityCustomerCard customer={{ name: 'Joe Test', fullName: 'Joe Test', username: 'JoeTest', collectorshub_user_id: 'joetest', storeCredit: 0, identityStatus: 'verified', identity: { status: 'verified', demo: true, portraitAvailable: true, legalName: 'Joe Test', dateOfBirth: '1990-04-12' } }} storeId={storeId} mode="buy" buyback money={new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })} onVerify={() => {}} onDetails={() => {}} onRemove={() => {}} /></section></div>
  else if (screen === 'idcard') content = <div className="checkout-columns" style={{ gridTemplateColumns: '340px 340px', alignItems: 'start' }}>{[{ identityStatus: 'verified', identity: { status: 'verified', portraitAvailable: true, legalName: 'Jordan Alexander Sample', dateOfBirth: '1995-03-15' } }, { identityStatus: 'unverified', identity: { status: 'unverified' } }].map((extra, index) => <section className="customer-card" key={index}><div className="side-title"><strong>Customer</strong></div><IdentityCustomerCard customer={{ name: 'Jordan Sample', fullName: 'Jordan Sample', username: 'Jordan_S', collectorshub_user_id: 'p' + index, storeCredit: 12.5, ...extra }} storeId={storeId} mode="buy" money={new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })} onVerify={() => {}} onDetails={() => {}} onRemove={() => {}} /></section>)}</div>
  else if (screen === 'identity') content = <IdentityWizard storeId={storeId} customer={{ profileId: 'p1', username: 'Jordan_S', name: 'Jordan Sample', fullName: 'Jordan Sample' }} onClose={() => {}} />
  else if (screen === 'create-customer') content = <CreateCustomerModal storeId={storeId} onCancel={() => {}} onCreated={() => {}} />
  else if (screen === 'clockin') content = <ClockInGate name="HaydenM8" onClockIn={async () => {}} onOpenMyHR={() => {}} />
  else if (payViews[screen]) content = <MyHRPay storeId={storeId} initialView={payViews[screen]} />
  else content = <MyHRView session={session} />
  return (
    <main className="app-shell preview-shell">
      <aside className="sidebar preview-sidebar"><strong>CollectorsHub POS</strong><small>Preview · sample data</small>{screen === 'org' ? <nav className="nav-list">{[...ORG_NAV, ['myhr', 'MyHR']].map(([id, label]) => <button key={id} type="button" className={`nav-button${id === 'overview' ? ' active' : ''}`}><span>{label}</span></button>)}</nav> : null}</aside>
      <section className="workspace">{content}</section>
    </main>
  )
}

const previewRoot = document.getElementById('root')
;(previewRoot.__previewRoot || (previewRoot.__previewRoot = createRoot(previewRoot))).render(<Preview />)
