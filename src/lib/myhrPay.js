import { supabase } from './supabaseClient'

// MyHR "My Pay, Vacation & Leaves" (supabase/myhr_pay.sql): the signed-in
// employee's time clock and leave requests, and managers' approvals.

async function call(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    // The SQL isn't installed yet.
    if (/could not find the function|does not exist/i.test(error.message || '')) {
      throw new Error('MyHR time and leave isn’t set up in Supabase yet (run the supabase/myhr_*.sql files).')
    }
    throw error
  }
  return data
}

export const LEAVE_TYPES = [
  ['vacation', 'Vacation'],
  ['sick', 'General Illness/Sick'],
  ['medical', 'Medical/Dental Appointment'],
  ['family_illness', 'Family Illness'],
  ['lieu', 'Time in Lieu'],
  ['statutory', 'Statutory Holiday'],
  ['personal', 'Personal'],
  ['unpaid', 'Unpaid'],
  ['other', 'Other'],
]

// Time accounts (entitlements set by the organization), in display order.
export const TIME_ACCOUNTS = [
  ['banked_overtime', 'Banked Overtime'],
  ['vacation', 'Vacation'],
  ['carryover_vacation', 'Carryover Vacation'],
  ['accumulated_vacation', 'Accumulated Vacation'],
  ['sick', 'General Illness/Sick'],
  ['medical', 'Medical/Dental'],
  ['family_illness', 'Family Illness'],
  ['statutory', 'Statutory Holiday'],
]
export const accountLabel = (key) => (TIME_ACCOUNTS.find(([value]) => value === key) || [key, key])[1]
export const leaveTypeLabel = (type) => (LEAVE_TYPES.find(([key]) => key === type) || [type, type])[1]

export const clock = (storeId, action) => call('myhr_clock', { p_store_id: storeId, p_action: action })
export const loadMyTime = async (storeId, since) => (await call('myhr_my_time', { p_store_id: storeId, p_since: since })) || []
// Leave in hours, with start/end times (part 5: supabase/myhr_leave_accounts.sql).
const leaveParams = ({ type, start, end, startTime, endTime, hours, note }) => ({
  p_type: type, p_start: start, p_end: end, p_start_time: startTime || null, p_end_time: endTime || null, p_hours: hours, p_note: note || null,
})
export const requestLeave = (storeId, request) => call('myhr_request_leave', { p_store_id: storeId, ...leaveParams(request) })
export const updateLeave = (storeId, requestId, request) => call('myhr_update_leave', { p_store_id: storeId, p_request_id: requestId, ...leaveParams(request) })
export const loadMyTimeAccounts = async (storeId, keyDate) => (await call('myhr_my_time_accounts', { p_store_id: storeId, p_key_date: keyDate })) || []

// Hours between two times on one day ("09:00", "14:00" → 5).
export function hoursBetween(startTime, endTime) {
  if (!startTime || !endTime) return 0
  const [h1, m1] = startTime.split(':').map(Number)
  const [h2, m2] = endTime.split(':').map(Number)
  return Math.max(0, (h2 * 60 + m2 - (h1 * 60 + m1)) / 60)
}
// A leave's hours (older requests only have days).
export const leaveHours = (request) => Number(request?.hours ?? (Number(request?.days || 0) * 8))
export const loadMyLeave = async (storeId) => (await call('myhr_my_leave', { p_store_id: storeId })) || []
export const cancelLeave = (storeId, requestId) => call('myhr_cancel_leave', { p_store_id: storeId, p_request_id: requestId })
export const amManager = async (storeId) => Boolean(await call('myhr_am_manager', { p_store_id: storeId }))
export const loadStoreLeave = async (storeId) => (await call('myhr_store_leave', { p_store_id: storeId })) || []
export const decideLeave = (storeId, requestId, approve, note) => call('myhr_decide_leave', {
  p_store_id: storeId, p_request_id: requestId, p_approve: approve, p_note: note || null,
})

// Hours of a shift (an open one counts up to now).
export function shiftHours(entry, now = Date.now()) {
  const start = new Date(entry.clock_in).getTime()
  const end = entry.clock_out ? new Date(entry.clock_out).getTime() : now
  return Math.max(0, (end - start) / 3600000)
}

// Monday 00:00 of the week containing a date (local time).
export function weekStart(date = new Date()) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const offset = (day.getDay() + 6) % 7
  day.setDate(day.getDate() - offset)
  return day
}

// Calendar days from start to end, inclusive ("2026-10-06" strings).
export function daysBetween(start, end) {
  if (!start || !end) return 0
  const a = new Date(`${start}T00:00:00`)
  const b = new Date(`${end}T00:00:00`)
  return Math.round((b - a) / 86400000) + 1
}

export const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

// Part 2 (supabase/myhr_schedule_profile.sql): schedule, personal details,
// clock-in status.
export const loadMySchedule = async (storeId, from, to) => (await call('myhr_my_schedule', { p_store_id: storeId, p_from: from.toISOString(), p_to: to.toISOString() })) || []
export const loadStoreStaff = async (storeId) => (await call('myhr_store_staff', { p_store_id: storeId })) || []
export const loadStoreSchedule = async (storeId, from, to) => (await call('myhr_store_schedule', { p_store_id: storeId, p_from: from.toISOString(), p_to: to.toISOString() })) || []
export const deleteShift = (storeId, shiftId) => call('myhr_delete_shift', { p_store_id: storeId, p_shift_id: shiftId })
export const loadMyDetails = async (storeId) => {
  const data = await call('myhr_my_details', { p_store_id: storeId })
  return (Array.isArray(data) ? data[0] : data) || null
}
export const saveMyDetails = (storeId, details) => call('myhr_save_details', { p_store_id: storeId, p_details: details })

// Whether this user must clock in, and since when they're clocked in. When
// MyHR isn't installed in Supabase (or anything fails), nobody is held up.
export async function loadClockStatus(storeId) {
  if (!storeId) return { required: false, clockedInAt: null }
  try {
    const { data, error } = await supabase.rpc('myhr_clock_status', { p_store_id: storeId })
    if (error) throw error
    const row = (Array.isArray(data) ? data[0] : data) || {}
    return { required: Boolean(row.is_employee), clockedInAt: row.clocked_in_at || null }
  } catch (error) {
    console.warn('[MyHR] clock status unavailable:', error?.message || error)
    return { required: false, clockedInAt: null }
  }
}

// Part 3 (supabase/myhr_personal_data.sql): family members / dependents.
export const loadMyFamily = async (storeId) => (await call('myhr_my_family', { p_store_id: storeId })) || []
export const saveFamilyMember = (storeId, { id, relationship, name, dateOfBirth, gender }) => call('myhr_save_family_member', {
  p_store_id: storeId, p_id: id || null, p_relationship: relationship, p_name: name, p_date_of_birth: dateOfBirth || null, p_gender: gender || null,
})
export const deleteFamilyMember = (storeId, id) => call('myhr_delete_family_member', { p_store_id: storeId, p_id: id })

// Part 4 (supabase/myhr_job.sql): job information.
const firstRow = (data) => (Array.isArray(data) ? data[0] : data) || null
export const loadMyJob = async (storeId) => firstRow(await call('myhr_my_job', { p_store_id: storeId }))
// The organization (its owner) edits employees' job and pay, not the store.
export const loadOrgStaff = async (orgId) => (await call('myhr_org_staff', { p_org_id: orgId })) || []
export const loadOrgStaffJob = async (orgId, employeeId) => firstRow(await call('myhr_org_staff_job', { p_org_id: orgId, p_employee_id: employeeId }))
export const saveOrgStaffJob = (orgId, employeeId, job) => call('myhr_org_save_staff_job', { p_org_id: orgId, p_employee_id: employeeId, p_job: job })

export const PAY_PERIODS = [['weekly', 'Weekly', 52], ['biweekly', 'Bi-weekly', 26], ['semimonthly', 'Semi-monthly', 24], ['monthly', 'Monthly', 12]]
// Pay for one pay period, and the projected annual pay (null when not enough is set).
export function payFigures(job) {
  const rate = Number(job?.pay_rate)
  const periods = (PAY_PERIODS.find(([key]) => key === job?.pay_period) || [])[2]
  if (!(rate > 0) || !periods) return { perPeriod: null, annual: null }
  if (job.pay_type === 'salary') return { perPeriod: rate / periods, annual: rate }
  const hours = Number(job?.hours_per_period)
  if (!(hours > 0)) return { perPeriod: null, annual: null }
  return { perPeriod: rate * hours, annual: rate * hours * periods }
}

// Part 5, the organization: leave year and entitlements.
export const loadOrgLeaveYear = async (orgId) => Number(await call('myhr_org_leave_year', { p_org_id: orgId })) || 1
export const setOrgLeaveYear = (orgId, month) => call('myhr_org_set_leave_year', { p_org_id: orgId, p_start_month: month })
export const loadOrgEmployeeAccounts = async (orgId, employeeId, keyDate) => (await call('myhr_org_employee_accounts', { p_org_id: orgId, p_employee_id: employeeId, p_key_date: keyDate })) || []
export const setOrgEntitlement = (orgId, employeeId, account, yearStart, hours) => call('myhr_org_set_entitlement', { p_org_id: orgId, p_employee_id: employeeId, p_account: account, p_year_start: yearStart, p_hours: hours })

// Part 6 (supabase/myhr_timesheets.sql): Record Working Times.
export const loadMyTimesheets = async (storeId, from, to) => (await call('myhr_my_timesheets', { p_store_id: storeId, p_from: from, p_to: to })) || []
export const saveTimesheet = (storeId, { weekStart, overrides, lines, total, overtime, submit }) => call('myhr_save_timesheet', {
  p_store_id: storeId, p_week_start: weekStart, p_overrides: overrides, p_lines: lines, p_total: total, p_overtime: overtime, p_submit: Boolean(submit),
})
export const loadStoreTimesheets = async (storeId) => (await call('myhr_store_timesheets', { p_store_id: storeId })) || []
export const decideTimesheet = (storeId, weekId, approve, note) => call('myhr_decide_timesheet', { p_store_id: storeId, p_week_id: weekId, p_approve: approve, p_note: note || null })

// Part 7 (supabase/myhr_team_calendar.sql): team calendar and approvers.
export const loadTeamMembers = async (storeId) => (await call('myhr_team_members', { p_store_id: storeId })) || []
export const loadTeamAbsences = async (storeId, from, to) => (await call('myhr_team_absences', { p_store_id: storeId, p_from: from, p_to: to })) || []
export const loadTeamShiftDays = async (storeId, from, to) => (await call('myhr_team_shift_days', { p_store_id: storeId, p_from: from, p_to: to })) || []
export const loadStoreApprovers = async (storeId) => ((await call('myhr_store_approvers', { p_store_id: storeId })) || []).map((row) => row.name).filter(Boolean)

export const LEAVE_DESCRIPTIONS = {
  vacation: 'Vacation',
  sick: 'General illness or a sick day',
  medical: 'Medical or dental appointment',
  family_illness: 'Caring for a sick family member',
  lieu: 'Time off instead of overtime pay (banked overtime)',
  statutory: 'Statutory holiday',
  personal: 'Personal day',
  unpaid: 'Unpaid leave',
  other: 'Other leave (explain in the comments)',
}

// Part 8 (supabase/myhr_schedule_builder.sql): the Schedule Builder.
export const loadScheduleStaff = async (storeId) => (await call('myhr_schedule_staff', { p_store_id: storeId })) || []
export const loadCoverageRules = async (storeId) => (await call('myhr_coverage_rules', { p_store_id: storeId })) || []
export const saveCoverageRule = (storeId, { id, weekday, start, end, role, needed, label }) => call('myhr_save_coverage_rule', {
  p_store_id: storeId, p_id: id || null, p_weekday: weekday, p_start: start, p_end: end, p_role: role, p_needed: needed, p_label: label || null,
})
export const deleteCoverageRule = (storeId, id) => call('myhr_delete_coverage_rule', { p_store_id: storeId, p_id: id })
export const saveShift = (storeId, { id, employeeId, startsAt, endsAt, role, breakMinutes, note }) => call('myhr_save_shift', {
  p_store_id: storeId, p_shift_id: id || null, p_employee_id: employeeId, p_starts_at: new Date(startsAt).toISOString(), p_ends_at: new Date(endsAt).toISOString(),
  p_role: role || null, p_break_minutes: Number(breakMinutes || 0), p_note: note || null,
})
export const loadScheduleWeek = async (storeId, weekStart) => firstRow(await call('myhr_schedule_week', { p_store_id: storeId, p_week_start: weekStart }))
export const publishSchedule = (storeId, weekStart) => call('myhr_publish_schedule', { p_store_id: storeId, p_week_start: weekStart })
export const loadMyAvailability = async (storeId) => (await call('myhr_my_availability', { p_store_id: storeId })) || {}
export const saveMyAvailability = (storeId, availability) => call('myhr_save_my_availability', { p_store_id: storeId, p_availability: availability })
export const loadOrgScheduleProfile = async (orgId, employeeId) => firstRow(await call('myhr_org_schedule_profile', { p_org_id: orgId, p_employee_id: employeeId }))
export const saveOrgScheduleProfile = (orgId, employeeId, profile) => call('myhr_org_save_schedule_profile', { p_org_id: orgId, p_employee_id: employeeId, p_profile: profile })

// Part 9 (supabase/myhr_availability.sql): the employee's availability profile.
export const loadMyAvailabilityProfile = async (storeId) => (await call('myhr_my_availability_profile', { p_store_id: storeId })) || {}
export const saveMyAvailabilityProfile = (storeId, profile) => call('myhr_save_my_availability_profile', { p_store_id: storeId, p_profile: profile })
export const RESTRICTIONS = [
  ['no_open', "Can't open"],
  ['no_close', "Can't close"],
  ['needs_keyholder', 'Needs a keyholder on shift'],
  ['not_alone', "Can't work alone"],
]
