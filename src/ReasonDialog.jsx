import React, { useState } from 'react'

// Asks for a reason in the page (window.prompt isn't supported in the desktop app).
export default function ReasonDialog({ title, message, label = 'Reason', confirmLabel = 'Confirm', onSubmit, onCancel }) {
  const [reason, setReason] = useState('')
  const ready = reason.trim().length > 0
  return (
    <div className="reason-dialog-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <form className="reason-dialog" onSubmit={(event) => { event.preventDefault(); if (ready) onSubmit(reason.trim()) }}>
        <h3>{title}</h3>
        {message ? <p>{message}</p> : null}
        <label>
          <span>{label}</span>
          <textarea autoFocus rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <div className="reason-dialog-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="gold-button" disabled={!ready}>{confirmLabel}</button>
        </div>
      </form>
    </div>
  )
}
