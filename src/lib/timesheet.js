// Record Working Times: builds an employee's week automatically, then applies
// their edits.
//   * Attendance: hours worked each day, from clock in/out (by clock-in day).
//   * Overtime: hours over OVERTIME_AFTER_HOURS in a day move from attendance
//     to overtime.
//   * Paid leave: approved leave of a paid type, as its own row, spread over
//     its days.
//   * Planned: scheduled hours (shown, not counted).
// Edits ("overrides") replace single cells; extra rows can be added and auto
// rows hidden. Weeks run Sunday to Saturday.

export const OVERTIME_AFTER_HOURS = 7

export const TIMESHEET_ROWS = [
  ['attendance', 'Attendance'],
  ['overtime', 'Overtime'],
  ['vacation', 'Vacation'],
  ['sick', 'General Illness/Sick'],
  ['medical', 'Medical/Dental'],
  ['family_illness', 'Family Illness'],
  ['lieu', 'Time in Lieu'],
  ['statutory', 'Statutory Holiday'],
  ['training', 'Training'],
  ['other', 'Other (paid)'],
]
export const PAID_LEAVE_TYPES = ['vacation', 'sick', 'medical', 'family_illness', 'lieu', 'statutory']
export const rowLabel = (key) => (TIMESHEET_ROWS.find(([value]) => value === key) || [key, key])[1]

const pad = (number) => String(number).padStart(2, '0')
export const isoDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const round = (value) => Math.round(value * 100) / 100

// The Sunday of the week containing a date.
export function sundayOf(date) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  day.setDate(day.getDate() - day.getDay())
  return day
}

export function weekDays(weekStart) {
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(weekStart)
    day.setDate(day.getDate() + index)
    return isoDay(day)
  })
}

// Every date from start to end ("YYYY-MM-DD"), inclusive.
function datesBetween(start, end) {
  const out = []
  const day = new Date(`${start}T00:00:00`)
  const last = new Date(`${end}T00:00:00`)
  while (day <= last && out.length < 400) {
    out.push(isoDay(day))
    day.setDate(day.getDate() + 1)
  }
  return out
}

// The automatic week: { days, rows: { key: { date: hours } }, planned: { date: hours } }.
export function autoWeek({ weekStart, entries = [], leave = [], shifts = [], now = Date.now() }) {
  const days = weekDays(weekStart)
  const inWeek = new Set(days)
  const blank = () => Object.fromEntries(days.map((day) => [day, 0]))
  const rows = { attendance: blank(), overtime: blank() }
  const planned = blank()

  // Hours worked per day.
  for (const entry of entries) {
    const start = new Date(entry.clock_in)
    const day = isoDay(start)
    if (!inWeek.has(day)) continue
    const end = entry.clock_out ? new Date(entry.clock_out).getTime() : now
    rows.attendance[day] += Math.max(0, (end - start.getTime()) / 3600000)
  }
  // Over 7 hours a day is overtime.
  for (const day of days) {
    const worked = rows.attendance[day]
    rows.overtime[day] = round(Math.max(0, worked - OVERTIME_AFTER_HOURS))
    rows.attendance[day] = round(Math.min(worked, OVERTIME_AFTER_HOURS))
  }

  // Approved paid leave, spread evenly over its days.
  for (const request of leave) {
    if (request.status !== 'approved' || !PAID_LEAVE_TYPES.includes(request.leave_type)) continue
    const span = datesBetween(request.start_date, request.end_date)
    const hours = Number(request.hours ?? Number(request.days || 0) * 8)
    const perDay = span.length ? hours / span.length : 0
    for (const day of span) {
      if (!inWeek.has(day)) continue
      rows[request.leave_type] = rows[request.leave_type] || blank()
      rows[request.leave_type][day] = round(rows[request.leave_type][day] + perDay)
    }
  }

  // Scheduled hours.
  for (const shift of shifts) {
    const day = isoDay(new Date(shift.starts_at))
    if (!inWeek.has(day)) continue
    planned[day] = round(planned[day] + (new Date(shift.ends_at) - new Date(shift.starts_at)) / 3600000)
  }

  return { days, rows, planned }
}

// The week as shown: the automatic rows with the employee's edits applied.
// overrides: { cells: { row: { date: hours } }, extraRows: [row], hiddenRows: [row] }
export function applyOverrides(auto, overrides = {}) {
  const cells = overrides.cells || {}
  const hidden = new Set(overrides.hiddenRows || [])
  const keys = [...new Set([...Object.keys(auto.rows), ...(overrides.extraRows || []), ...Object.keys(cells)])]
    .filter((key) => !hidden.has(key))
    .sort((a, b) => TIMESHEET_ROWS.findIndex(([k]) => k === a) - TIMESHEET_ROWS.findIndex(([k]) => k === b))
  const lines = keys.map((key) => {
    const daysOut = {}
    const edited = {}
    for (const day of auto.days) {
      const base = Number(auto.rows[key]?.[day] || 0)
      const override = cells[key]?.[day]
      const hasOverride = override !== undefined && override !== null && override !== ''
      daysOut[day] = hasOverride ? round(Number(override) || 0) : base
      edited[day] = hasOverride && round(Number(override) || 0) !== base
    }
    const total = round(Object.values(daysOut).reduce((sum, value) => sum + value, 0))
    return { row: key, label: rowLabel(key), days: daysOut, edited, total, auto: Boolean(auto.rows[key]) }
  })
  // Rows the employee didn't add, with nothing in them, aren't worth showing
  // (except attendance and overtime, which always show).
  const shown = lines.filter((line) => ['attendance', 'overtime'].includes(line.row) || line.total || (overrides.extraRows || []).includes(line.row) || Object.values(line.edited).some(Boolean))
  const actual = Object.fromEntries(auto.days.map((day) => [day, round(shown.reduce((sum, line) => sum + line.days[day], 0))]))
  const total = round(Object.values(actual).reduce((sum, value) => sum + value, 0))
  const overtime = shown.find((line) => line.row === 'overtime')?.total || 0
  return { days: auto.days, lines: shown, planned: auto.planned, actual, total, overtime }
}
