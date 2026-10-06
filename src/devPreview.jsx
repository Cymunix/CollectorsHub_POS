import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { supabase } from './lib/supabaseClient'
import ClockInGate from './ClockInGate'
import MyHRView from './MyHR'
import MyHRPay from './MyHRPay'
import MyHROrgEmployees from './MyHROrgEmployees'
import ScheduleBuilder from './ScheduleBuilder'
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
  myhr_my_onboarding: { job: true, pay: true, scheduling: false, leave: false, personal: true, address: false, emergency: false, availability: true },
  myhr_org_onboarding: [
    { employee_id: 'e1', added_at: '2026-08-31T12:00:00Z', onboarding: { job: true, pay: true, scheduling: true, leave: true, personal: true, address: true, emergency: true, availability: true } },
    { employee_id: 'e2', added_at: '2026-10-05T12:00:00Z', onboarding: { job: true, pay: false, scheduling: false, leave: false, personal: true, address: false, emergency: false, availability: false } },
    { employee_id: 'e3', added_at: '2026-10-06T12:00:00Z', onboarding: { job: false, pay: false, scheduling: false, leave: false, personal: false, address: false, emergency: false, availability: false } },
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
supabase.rpc = async (name, params) => {
  const value = SAMPLE[name]
  return { data: typeof value === 'function' ? value(params || {}) : value ?? null, error: null }
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
  else if (screen === 'builder') content = <ScheduleBuilder storeId={storeId} />
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

createRoot(document.getElementById('root')).render(<Preview />)
