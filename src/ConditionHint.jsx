import React, { useEffect, useRef, useState } from 'react'

// "Why this condition?": the AI's suggested condition for a scanned card and
// what it saw (corners, edges, surface, centring), behind a small ? button.
// Hover or click it to read; click again, click elsewhere or Esc to close.

const CAVEAT = "Centring and fine surface scratches can't be judged reliably from a scan, so check the card under light before settling the condition."

export function conditionReason(suggestion) {
  if (!suggestion?.condition) return ''
  const notes = (suggestion.notes || []).join('; ')
  return `Suggested ${suggestion.condition} from the scan${notes ? `: ${notes}` : ''}. ${CAVEAT}`
}

export default function ConditionHint({ suggestion, current }) {
  const buttonRef = useRef(null)
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [position, setPosition] = useState(null)
  const open = pinned || hovered

  useEffect(() => {
    if (!open || !buttonRef.current) return undefined
    // Fixed position, so a scrolling list or panel can't clip it.
    const rect = buttonRef.current.getBoundingClientRect()
    const width = 300
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8))
    const below = rect.bottom + 8
    setPosition(below + 220 > window.innerHeight ? { left, bottom: window.innerHeight - rect.top + 8, width } : { left, top: below, width })
    if (!pinned) return undefined
    const close = (event) => {
      if (event.type === 'keydown' ? event.key === 'Escape' : !buttonRef.current?.contains(event.target)) setPinned(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open, pinned])

  if (!suggestion?.condition) return null
  const notes = suggestion.notes || []
  const changed = current && current !== suggestion.condition

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`condition-hint${open ? ' open' : ''}`}
        aria-label={conditionReason(suggestion)}
        aria-expanded={open}
        onClick={(event) => { event.stopPropagation(); setPinned((value) => !value) }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
      >?</button>
      {open && position ? (
        <span className="condition-hint-popover" role="tooltip" style={position}>
          <strong>Why {suggestion.condition}?</strong>
          {notes.length ? (
            <ul>{notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
          ) : (
            <span>The AI didn't say what it saw for this card. Check it by eye.</span>
          )}
          {changed ? <em>Changed by staff to {current}.</em> : null}
          <small>{CAVEAT}</small>
        </span>
      ) : null}
    </>
  )
}
