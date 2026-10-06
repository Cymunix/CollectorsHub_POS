// Nova Scotia holidays for the team calendar (shown as "Holiday"): the
// province's statutory holidays plus the other days stores commonly close or
// pay for. Dates are "YYYY-MM-DD".

const pad = (number) => String(number).padStart(2, '0')
const iso = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`

// The nth (1-based) weekday (0 = Sunday) of a month.
function nthWeekday(year, month, weekday, nth) {
  const first = new Date(year, month - 1, 1).getDay()
  return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7
}

// The Monday on or before a date (Victoria Day: the Monday before May 25).
function mondayBefore(year, month, day) {
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7 || 7))
  return date
}

// Easter Sunday (Gregorian, anonymous algorithm).
function easter(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(year, month - 1, day)
}

export function novaScotiaHolidays(year) {
  const goodFriday = easter(year)
  goodFriday.setDate(goodFriday.getDate() - 2)
  const victoria = mondayBefore(year, 5, 25)
  return {
    [iso(year, 1, 1)]: "New Year's Day",
    [iso(year, 2, nthWeekday(year, 2, 1, 3))]: 'Heritage Day',
    [iso(year, goodFriday.getMonth() + 1, goodFriday.getDate())]: 'Good Friday',
    [iso(year, victoria.getMonth() + 1, victoria.getDate())]: 'Victoria Day',
    [iso(year, 7, 1)]: 'Canada Day',
    [iso(year, 8, nthWeekday(year, 8, 1, 1))]: 'Natal Day',
    [iso(year, 9, nthWeekday(year, 9, 1, 1))]: 'Labour Day',
    [iso(year, 10, nthWeekday(year, 10, 1, 2))]: 'Thanksgiving',
    [iso(year, 11, 11)]: 'Remembrance Day',
    [iso(year, 12, 25)]: 'Christmas Day',
    [iso(year, 12, 26)]: 'Boxing Day',
  }
}
