import { supabase } from './supabaseClient'

// MyHR "My Pay, Vacation & Leaves" (supabase/myhr_pay.sql): the signed-in
// employee's time clock and leave requests, and managers' approvals.

async function call(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    // The SQL isn't installed yet.
    if (/could not find the function|does not exist/i.test(error.message || '')) {
      throw new Error('MyHR time and leave isn’t set up in Supabase yet (run supabase/myhr_pay.sql).')
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
