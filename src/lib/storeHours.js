import { supabase } from './supabaseClient'

// Store opening hours per location (supabase/store_hours.sql), set by the
// organization. hours: { "0".."6" (0 = Sunday): { open: "HH:MM", close: "HH:MM" } | null }.

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] // Monday first

async function rpc(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    if (/could not find the function|does not exist/i.test(error.message || '')) throw new Error('Store hours aren’t set up in Supabase yet (run supabase/store_hours.sql).')
    throw error
  }
  return data
}

export const loadOrgLocationHours = async (orgId) => (await rpc('org_location_hours', { p_org_id: orgId })) || []
export const saveLocationHours = (orgId, locationId, hours) => rpc('org_set_location_hours', {
  p_org_id: orgId, p_location_id: locationId, p_hours: hours, p_summary: summarizeHours(hours),
})
// Staff and managers: their store's hours ({} when none are set, or on error).
export async function loadStoreOpeningHours(storeId) {
  if (!storeId) return {}
  try { return (await rpc('store_opening_hours', { p_store_id: storeId })) || {} } catch { return {} }
}

export const dayHours = (hours, weekday) => {
  const day = hours?.[String(weekday)]
  return day && day.open && day.close ? day : null
}

// "Mon–Fri 10:00–18:00, Sat 10:00–17:00, Sun closed" (days in a row with the
// same hours are grouped). Empty when no hours are set at all.
export function summarizeHours(hours) {
  if (!hours || !WEEK_ORDER.some((weekday) => hours[String(weekday)] !== undefined)) return ''
  const groups = []
  for (const weekday of WEEK_ORDER) {
    const day = dayHours(hours, weekday)
    const text = day ? `${day.open}–${day.close}` : 'closed'
    const last = groups[groups.length - 1]
    if (last && last.text === text) last.to = weekday
    else groups.push({ from: weekday, to: weekday, text })
  }
  return groups.map((group) => `${DAY_SHORT[group.from]}${group.to !== group.from ? `–${DAY_SHORT[group.to]}` : ''} ${group.text}`).join(', ')
}
