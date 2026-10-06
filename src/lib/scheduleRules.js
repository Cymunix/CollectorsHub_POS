// Schedule Builder rules: what coverage the store needs versus what's
// scheduled, and per-employee checks. Pure functions (no Supabase), so the
// builder can re-check on every drag.
//
// staff:  { id, name, short_name, schedule_role, can_cover[], target_hours, min_hours, max_hours, availability, hourly_cost }
// shifts: { id, employee_id, starts_at, ends_at, role, break_minutes }
// rules:  { id, weekday (0 = Sunday), start_time 'HH:MM[:SS]', end_time, role, needed, label }
// leave:  { employee_name?, employee_id?, start_date, end_date, status }

const SLOT = 15 // minutes
const ANYONE = 'employee'

const minutesOf = (time) => { const [h, m] = String(time).split(':').map(Number); return h * 60 + (m || 0) }
export const clock = (minutes) => {
  const h = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  const suffix = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${suffix}`
}
const pad = (n) => String(n).padStart(2, '0')
export const isoDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const round = (value) => Math.round(value * 100) / 100

// Paid hours of a shift (minus its unpaid break).
export const shiftHours = (shift) => Math.max(0, (new Date(shift.ends_at) - new Date(shift.starts_at)) / 3600000 - Number(shift.break_minutes || 0) / 60)

// The role a shift is worked as (its own, else the employee's).
export const shiftRole = (shift, person) => shift.role || person?.schedule_role || 'Employee'

// Can this person, on this shift, fill a requirement for `role`?
export function canFill(role, shift, person) {
  const wanted = String(role || 'Employee').toLowerCase()
  if (wanted === ANYONE) return true
  const roles = [shiftRole(shift, person), ...(person?.can_cover || [])].map((value) => String(value).toLowerCase())
  return roles.includes(wanted)
}

// Minutes from local midnight of `day` for a shift, clipped to that day.
function shiftWindowOn(shift, day) {
  const dayStart = new Date(`${day}T00:00:00`).getTime()
  const start = (new Date(shift.starts_at).getTime() - dayStart) / 60000
  const end = (new Date(shift.ends_at).getTime() - dayStart) / 60000
  return [Math.max(0, start), Math.min(24 * 60, end)]
}

// Coverage for one day: who fills which requirement at each 15-minute slot.
// Specific roles are filled first; "Employee" requirements take anyone left.
export function coverageForDay(day, rules, shifts, staffById) {
  const weekday = new Date(`${day}T00:00:00`).getDay()
  const dayRules = rules.filter((rule) => Number(rule.weekday) === weekday)
  if (!dayRules.length) return { day, results: [], surplus: [] }
  const windows = shifts.map((shift) => ({ shift, person: staffById[shift.employee_id], range: shiftWindowOn(shift, day) }))
    .filter(({ range }) => range[1] > range[0])
  const specificFirst = [...dayRules].sort((a, b) => (String(a.role).toLowerCase() === ANYONE) - (String(b.role).toLowerCase() === ANYONE))
  const first = Math.min(...dayRules.map((rule) => minutesOf(rule.start_time)))
  const last = Math.max(...dayRules.map((rule) => minutesOf(rule.end_time)))

  const filled = Object.fromEntries(dayRules.map((rule) => [rule.id, []])) // per slot counts
  const surplusSlots = []
  for (let t = first; t < last; t += SLOT) {
    // Each person counts once, even with overlapping shifts.
    const seen = new Set()
    const working = windows.filter(({ shift, range }) => {
      if (!(range[0] <= t && range[1] >= t + SLOT) || seen.has(shift.employee_id)) return false
      seen.add(shift.employee_id)
      return true
    })
    const free = new Set(working.map((_, index) => index))
    let needed = 0
    for (const rule of specificFirst) {
      if (!(minutesOf(rule.start_time) <= t && minutesOf(rule.end_time) >= t + SLOT)) continue
      needed += Number(rule.needed)
      let count = 0
      for (const index of [...free]) {
        if (count >= Number(rule.needed)) break
        const { shift, person } = working[index]
        if (canFill(rule.role, shift, person)) { free.delete(index); count += 1 }
      }
      filled[rule.id].push({ t, count })
    }
    if (needed && working.length > needed) surplusSlots.push({ t, extra: working.length - needed })
  }

  const results = dayRules.map((rule) => {
    const slots = filled[rule.id]
    const short = slots.filter((slot) => slot.count < Number(rule.needed))
    const worst = short.length ? Math.max(...short.map((slot) => Number(rule.needed) - slot.count)) : 0
    return {
      rule,
      ok: !short.length,
      missing: worst,
      gaps: mergeSlots(short.map((slot) => ({ t: slot.t, value: Number(rule.needed) - slot.count }))),
    }
  })
  const surplus = mergeSlots(surplusSlots.map((slot) => ({ t: slot.t, value: slot.extra })))
    .map((segment) => ({ ...segment, extraHours: round(((segment.to - segment.from) / 60) * segment.value) }))
  return { day, results, surplus }
}

// Joins neighbouring slots with the same value into ranges { from, to, value }.
function mergeSlots(slots) {
  const out = []
  for (const slot of slots) {
    const previous = out[out.length - 1]
    if (previous && previous.to === slot.t && previous.value === slot.value) previous.to = slot.t + SLOT
    else out.push({ from: slot.t, to: slot.t + SLOT, value: slot.value })
  }
  return out
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Opening and closing on a day: coverage needs labelled "Opening"/"Closing"
// if there are any, else the store's opening hours (set by the organization),
// else the day's first coverage start / last end. null when none of those exist.
function openCloseOf(day, rules, storeHours = {}) {
  const weekday = new Date(`${day}T00:00:00`).getDay()
  const dayRules = rules.filter((rule) => Number(rule.weekday) === weekday)
  const hours = storeHours?.[String(weekday)]
  const labelled = dayRules.some((rule) => /clos|open/i.test(rule.label || ''))
  if (!labelled && hours && hours.open && hours.close) {
    return {
      isClosing: (from, to) => to >= minutesOf(hours.close),
      isOpening: (from) => from <= minutesOf(hours.open),
    }
  }
  if (!dayRules.length) return null
  const closing = dayRules.filter((rule) => /clos/i.test(rule.label || ''))
  const opening = dayRules.filter((rule) => /open/i.test(rule.label || ''))
  const firstStart = Math.min(...dayRules.map((rule) => minutesOf(rule.start_time)))
  const lastEnd = Math.max(...dayRules.map((rule) => minutesOf(rule.end_time)))
  const overlaps = (list, from, to) => list.some((rule) => from < minutesOf(rule.end_time) && to > minutesOf(rule.start_time))
  return {
    isClosing: (from, to) => (closing.length ? overlaps(closing, from, to) : to >= lastEnd),
    isOpening: (from, to) => (opening.length ? overlaps(opening, from, to) : from <= firstStart),
  }
}

// Everything to warn about for a week. Each warning: { id, kind, day?, employeeId?, text, severity }.
export function weekWarnings({ days, staff, shifts, rules, leave = [], storeHours = {} }) {
  const staffById = Object.fromEntries(staff.map((person) => [person.id, person]))
  const warnings = []
  const coverage = {}

  for (const day of days) {
    const result = coverageForDay(day, rules, shifts, staffById)
    coverage[day] = result
    const dayName = DAY_NAMES[new Date(`${day}T00:00:00`).getDay()]
    for (const item of result.results) {
      if (item.ok) continue
      const label = item.rule.label ? `${item.rule.label}: ` : ''
      const role = String(item.rule.role || 'Employee')
      const range = `${clock(minutesOf(item.rule.start_time))}–${clock(minutesOf(item.rule.end_time))}`
      warnings.push({
        id: `cov-${item.rule.id}-${day}`, kind: 'coverage', day, severity: 'error',
        text: `${dayName} ${range} · ${label}${item.missing > 1 ? `${item.missing} ${role}s short` : `${role} coverage missing`}`,
      })
    }
    for (const segment of result.surplus) {
      warnings.push({
        id: `over-${day}-${segment.from}`, kind: 'overstaffed', day, severity: 'info',
        text: `${dayName} ${clock(segment.from)}–${clock(segment.to)} · Overstaffed by ${segment.value} · +${segment.extraHours} labour hours`,
      })
    }
  }

  for (const person of staff) {
    const mine = shifts.filter((shift) => shift.employee_id === person.id)
    const hours = round(mine.reduce((sum, shift) => sum + shiftHours(shift), 0))
    const target = person.target_hours != null ? Number(person.target_hours) : null
    const name = person.short_name || person.name
    if (person.max_hours != null && hours > Number(person.max_hours)) {
      warnings.push({ id: `max-${person.id}`, kind: 'hours', employeeId: person.id, severity: 'error', text: `${name}: ${hours} hrs, over their maximum of ${Number(person.max_hours)}` })
    } else if (target != null && hours - target >= 1) {
      warnings.push({ id: `over-${person.id}`, kind: 'hours', employeeId: person.id, severity: 'warn', text: `${name}: ${hours} hrs, ${round(hours - target)} hrs over target` })
    }
    if (person.min_hours != null && hours < Number(person.min_hours)) {
      warnings.push({ id: `min-${person.id}`, kind: 'hours', employeeId: person.id, severity: 'warn', text: `${name}: only ${hours} hrs, under their minimum of ${Number(person.min_hours)}` })
    } else if (target != null && target - hours >= 1) {
      warnings.push({ id: `under-${person.id}`, kind: 'hours', employeeId: person.id, severity: 'warn', text: `${name}: only ${hours} hrs, ${round(target - hours)} hrs under target` })
    }

    // Availability: a weekday with windows set means only those times.
    for (const shift of mine) {
      const start = new Date(shift.starts_at)
      const day = isoDay(start)
      const windows = person.availability?.[String(start.getDay())]
      if (!Array.isArray(windows)) continue
      const [from, to] = shiftWindowOn(shift, day)
      const fits = windows.some((window) => minutesOf(window.from) <= from && minutesOf(window.to) >= to)
      if (!fits) {
        const text = windows.length
          ? `${name} is only available ${windows.map((window) => `${clock(minutesOf(window.from))}–${clock(minutesOf(window.to))}`).join(', ')} on ${DAY_NAMES[start.getDay()]}s`
          : `${name} is unavailable on ${DAY_NAMES[start.getDay()]}s`
        warnings.push({ id: `avail-${shift.id}`, kind: 'availability', day, employeeId: person.id, shiftId: shift.id, severity: 'warn', text })
      }
    }

    // Their own availability profile: most hours, and restrictions.
    if (person.most_hours != null && hours > Number(person.most_hours)) {
      warnings.push({ id: `most-${person.id}`, kind: 'hours', employeeId: person.id, severity: 'warn', text: `${name}: ${hours} hrs, but can work at most ${Number(person.most_hours)}` })
    }
    const restrictions = new Set(person.restrictions || [])
    for (const shift of mine) {
      const day = isoDay(new Date(shift.starts_at))
      const dayName = DAY_NAMES[new Date(`${day}T00:00:00`).getDay()]
      const [from, to] = shiftWindowOn(shift, day)
      const edges = openCloseOf(day, rules, storeHours)
      if (restrictions.has('no_close') && edges && edges.isClosing(from, to)) {
        warnings.push({ id: `close-${shift.id}`, kind: 'restriction', day, employeeId: person.id, shiftId: shift.id, severity: 'warn', text: `${name} can't close (${dayName})` })
      }
      if (restrictions.has('no_open') && edges && edges.isOpening(from, to)) {
        warnings.push({ id: `open-${shift.id}`, kind: 'restriction', day, employeeId: person.id, shiftId: shift.id, severity: 'warn', text: `${name} can't open (${dayName})` })
      }
      if (restrictions.has('needs_keyholder') || restrictions.has('not_alone')) {
        const others = shifts.filter((other) => other.employee_id !== person.id)
          .map((other) => ({ other, person: staffById[other.employee_id], range: shiftWindowOn(other, day) }))
        const noKeyholder = []
        const alone = []
        for (let t = Math.floor(from / SLOT) * SLOT; t < to; t += SLOT) {
          const present = others.filter(({ range }) => range[0] <= t && range[1] >= t + SLOT)
          if (!present.length) alone.push({ t, value: 1 })
          if (!present.some(({ other, person: coworker }) => canFill('Keyholder', other, coworker) || String(shiftRole(other, coworker)).toLowerCase() === 'manager')) noKeyholder.push({ t, value: 1 })
        }
        const ranges = (slots) => mergeSlots(slots).map((segment) => `${clock(segment.from)}–${clock(segment.to)}`).join(', ')
        if (restrictions.has('needs_keyholder') && noKeyholder.length) {
          warnings.push({ id: `key-${shift.id}`, kind: 'restriction', day, employeeId: person.id, shiftId: shift.id, severity: 'warn', text: `${name} needs a keyholder on shift: none ${dayName} ${ranges(noKeyholder)}` })
        }
        if (restrictions.has('not_alone') && alone.length) {
          warnings.push({ id: `alone-${shift.id}`, kind: 'restriction', day, employeeId: person.id, shiftId: shift.id, severity: 'warn', text: `${name} can't work alone: alone ${dayName} ${ranges(alone)}` })
        }
      }
    }

    // Time off (once per day).
    const offDays = new Set()
    for (const shift of mine) {
      const day = isoDay(new Date(shift.starts_at))
      if (offDays.has(day)) continue
      const off = leave.find((request) => (request.employee_id === person.id || request.employee_name === person.name) && request.start_date <= day && request.end_date >= day && ['approved', 'pending'].includes(request.status))
      if (off) offDays.add(day)
      if (off) warnings.push({ id: `leave-${person.id}-${day}`, kind: 'leave', day, employeeId: person.id, shiftId: shift.id, severity: off.status === 'approved' ? 'error' : 'warn', text: `${name} has ${off.status === 'approved' ? 'approved' : 'requested'} time off on ${DAY_NAMES[new Date(`${day}T00:00:00`).getDay()]}` })
    }

    // Two shifts at once.
    const sorted = [...mine].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
    for (let index = 1; index < sorted.length; index += 1) {
      if (new Date(sorted[index].starts_at) < new Date(sorted[index - 1].ends_at)) {
        warnings.push({ id: `overlap-${sorted[index].id}`, kind: 'overlap', day: isoDay(new Date(sorted[index].starts_at)), employeeId: person.id, shiftId: sorted[index].id, severity: 'error', text: `${name} has overlapping shifts` })
      }
    }
  }
  return { warnings, coverage }
}

// The bar at the top: scheduled vs target hours, labour cost, warnings.
export function weekSummary({ staff, shifts, warnings }) {
  const scheduled = round(shifts.reduce((sum, shift) => sum + shiftHours(shift), 0))
  const target = round(staff.reduce((sum, person) => sum + (person.target_hours != null ? Number(person.target_hours) : 0), 0))
  const costById = Object.fromEntries(staff.map((person) => [person.id, Number(person.hourly_cost) || 0]))
  const labour = round(shifts.reduce((sum, shift) => sum + shiftHours(shift) * (costById[shift.employee_id] || 0), 0))
  const missingRates = staff.some((person) => shifts.some((shift) => shift.employee_id === person.id) && !Number(person.hourly_cost))
  return { scheduled, target, diff: round(scheduled - target), labour, missingRates, coverageWarnings: warnings.filter((warning) => warning.kind === 'coverage').length, total: warnings.filter((warning) => warning.severity !== 'info').length }
}

// A colour per role (the same role always gets the same colour).
const ROLE_COLOURS = ['#d6a632', '#3f7cc9', '#2e9a6b', '#9b59b6', '#d9653b', '#2aa5b5', '#c2477d']
export function roleColour(role) {
  const text = String(role || 'Employee').toLowerCase()
  if (text === 'manager') return '#172235'
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return ROLE_COLOURS[hash % ROLE_COLOURS.length]
}
