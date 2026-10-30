// Shared by the admin scanner, store scan intake and the Register. Kept out of
// AdminWorkspace so importing them doesn't load that whole screen.

// Stack scans decide front/back from how much text each side has. When that
// was a close call (or fell back to feed order) the AI double-checks it.
export function needsSideCheck(draft) {
  const feed = draft.feed
  if (!feed || feed.singleSided || feed.adjusted || !draft.frontImage || !draft.backImage) return false
  // Trading cards: always checked (text amount says less about which side
  // is the back than it does for sports cards).
  if (/trading/i.test(String(draft.category || ''))) return true
  if (feed.frontBackBy !== 'text' || !feed.words) return true
  return feed.words.back < feed.words.front * 2 + 5
}

// Sides whose text-based orientation was weak get the AI upright check:
// photo-heavy fronts (often with the name printed sideways) and backs whose
// text didn't read well (light text on colour).
export function needsUprightCheck(draft) {
  const feed = draft.feed
  if (!feed || feed.uprightChecked || feed.adjusted) return null
  const weak = (words) => feed.checkRotation || !feed.words || words == null || words < 15
  return { front: Boolean(draft.frontImage) && weak(feed.words?.front), back: Boolean(draft.backImage) && weak(feed.words?.back) }
}

// Per-computer scanner preferences (scan mode, card position): remembered in
// this browser profile only; the app works the same without them.
export function readScannerPref(key, fallback) {
  try {
    const raw = window.localStorage.getItem(`collectorshub-scanner-${key}`)
    return raw == null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function writeScannerPref(key, value) {
  try {
    window.localStorage.setItem(`collectorshub-scanner-${key}`, JSON.stringify(value))
  } catch {}
}
