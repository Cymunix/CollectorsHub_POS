import React from 'react'

// "Why this condition?": the AI's suggested condition for a scanned card and
// what it saw, behind a small ? icon (hover or focus to read).

export function conditionReason(suggestion) {
  if (!suggestion?.condition) return ''
  const notes = (suggestion.notes || []).join('; ')
  return `Suggested ${suggestion.condition} from the scan${notes ? `: ${notes}` : ''}. Centering and fine surface scratches can't be judged reliably from a scan, so check the card under light before settling the condition.`
}

export default function ConditionHint({ suggestion, current }) {
  const text = conditionReason(suggestion)
  if (!text) return null
  const changed = current && current !== suggestion.condition
  const full = changed ? `${text} (Changed by staff to ${current}.)` : text
  return <span className="condition-hint" tabIndex={0} title={full} aria-label={full}>?</span>
}
