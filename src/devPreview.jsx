import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { supabase } from './lib/supabaseClient'
import ClockInGate from './ClockInGate'
import MyHRView from './MyHR'
import MyHRPay from './MyHRPay'
import MyHROrgEmployees from './MyHROrgEmployees'

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
    { id: 'm1', starts_at: day(monday, 10), ends_at: day(monday, 18) },
    { id: 'm2', starts_at: day(monday + 2, 12), ends_at: day(monday + 2, 20), note: 'Card night' },
    { id: 'm3', starts_at: day(monday + 5, 9), ends_at: day(monday + 5, 17) },
  ],
  myhr_store_schedule: [
    { id: 'm1', employee_name: 'HaydenM8', starts_at: day(monday, 10), ends_at: day(monday, 18) },
    { id: 'x1', employee_name: 'Jordan Smith', starts_at: day(monday, 12), ends_at: day(monday, 20) },
    { id: 'x2', employee_name: 'Casey Lee', starts_at: day(monday + 1, 10), ends_at: day(monday + 1, 18) },
    { id: 'm2', employee_name: 'HaydenM8', starts_at: day(monday + 2, 12), ends_at: day(monday + 2, 20) },
    { id: 'x3', employee_name: 'Jordan Smith', starts_at: day(monday + 3, 10), ends_at: day(monday + 3, 16) },
    { id: 'x4', employee_name: 'Casey Lee', starts_at: day(monday + 4, 12), ends_at: day(monday + 4, 20) },
    { id: 'm3', employee_name: 'HaydenM8', starts_at: day(monday + 5, 9), ends_at: day(monday + 5, 17) },
    { id: 'x5', employee_name: 'Jordan Smith', starts_at: day(monday + 5, 12), ends_at: day(monday + 5, 20) },
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
const payViews = { pay: 'home', time: 'time', leave: 'leave', leaveinfo: 'leaveinfo', schedule: 'schedule', personal: 'personal', addresses: 'addresses', family: 'family', job: 'job', emergency: 'emergency' }

function OrgEmployeesPreview() {
  const [ready, setReady] = React.useState(false)
  React.useEffect(() => { setReady(true) }, [])
  return ready ? <MyHROrgEmployees orgId="org" orgName="Nordvik Collectibles" onBack={() => {}} initialSelectedId="e2" /> : null
}

function Preview() {
  let content
  if (screen === 'org-employees') content = <OrgEmployeesPreview />
  else if (screen === 'clockin') content = <ClockInGate name="HaydenM8" onClockIn={async () => {}} onOpenMyHR={() => {}} />
  else if (payViews[screen]) content = <MyHRPay storeId={storeId} initialView={payViews[screen]} />
  else content = <MyHRView session={session} />
  return (
    <main className="app-shell preview-shell">
      <aside className="sidebar preview-sidebar"><strong>CollectorsHub POS</strong><small>Preview · sample data</small></aside>
      <section className="workspace">{content}</section>
    </main>
  )
}

createRoot(document.getElementById('root')).render(<Preview />)
