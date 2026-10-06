import { supabase } from './supabaseClient'

// MyHR "My Pay, Vacation & Leaves" (supabase/myhr_pay.sql): the signed-in
// employee's time clock and leave requests, and managers' approvals.

async function call(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    // The SQL isn't installed yet.
    if (/could not find the function|does not exist/i.test(error.message || '')) {
      throw new Error('MyHR time and leave isn’t set up in Supabase yet (run supabase/myhr_pay.sql, then supabase/myhr_schedule_profile.sql).')
    }
    throw error
  }
  return data
}

export const LEAVE_TYPES = [
  ['vacation', 'Vacation'],
  ['sick', 'Sick'],
  ['personal', 'Personal'],
  ['unpaid', 'Unpaid'],
  ['other', 'Other'],
]
export const leaveTypeLabel = (type) => (LEAVE_TYPES.find(([key]) => key === type) || [type, type])[1]

export const clock = (storeId, action) => call('myhr_clock', { p_store_id: storeId, p_action: action })
export const loadMyTime = async (storeId, since) => (await call('myhr_my_time', { p_store_id: storeId, p_since: since })) || []
export const requestLeave = (storeId, { type, start, end, days, note }) => call('myhr_request_leave', {
  p_store_id: storeId, p_type: type, p_start: start, p_end: end, p_days: days, p_note: note || null,
})
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
export const addShift = (storeId, { employeeId, startsAt, endsAt, note }) => call('myhr_add_shift', {
  p_store_id: storeId, p_employee_id: employeeId, p_starts_at: startsAt.toISOString(), p_ends_at: endsAt.toISOString(), p_note: note || null,
})
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
