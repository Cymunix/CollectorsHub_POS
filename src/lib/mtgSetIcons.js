// Magic set symbols, from Scryfall's own set → icon table (public/data/mtg-set-icons.json, the
// website's copy: refresh both with `node scripts/build-mtg-set-icons.mjs` in the website repo and
// copy the file here). Many sets borrow an icon (a set's promos and tokens use the set's, event
// promos a star), so the code alone isn't always a valid icon address.
import { useEffect, useState } from 'react'

const ICON_BASE = 'https://svgs.scryfall.io/sets/'
let table = null
let loading = null

function loadIcons() {
  if (!loading) {
    loading = fetch('./data/mtg-set-icons.json')
      .then((response) => (response.ok ? response.json() : {}))
      .catch(() => ({}))
      .then((icons) => { table = icons; return icons })
  }
  return loading
}

// The icon URL for a set code ('' without one); <code>.svg until the table has loaded.
export function mtgSetIconUrl(code) {
  const key = String(code || '').toLowerCase()
  if (!key) return ''
  return `${ICON_BASE}${table?.[key] || key}.svg`
}

// Re-renders the caller once the table has loaded.
export function useMtgSetIcons() {
  const [, setReady] = useState(Boolean(table))
  useEffect(() => {
    if (table) return undefined
    let live = true
    loadIcons().then(() => { if (live) setReady(true) })
    return () => { live = false }
  }, [])
  return mtgSetIconUrl
}
