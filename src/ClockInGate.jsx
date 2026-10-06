import React, { useEffect, useState } from 'react'
import { Clock3 } from 'lucide-react'

// Shown in place of the Register until a store employee clocks in.
export default function ClockInGate({ name, onClockIn, onOpenMyHR }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(timer)
  }, [])

  async function clockIn() {
    setBusy(true)
    setProblem('')
    try {
      await onClockIn()
    } catch (error) {
      setProblem(error?.message || String(error))
      setBusy(false)
    }
  }

  return (
    <section className="clock-gate">
      <div className="clock-gate-card">
        <span className="clock-gate-icon" aria-hidden="true"><Clock3 size={34} /></span>
        <h2>Clock in to start your shift</h2>
        <p>Hi {name}. Clock in before opening the register or using the rest of the POS.</p>
        <strong className="clock-gate-time">{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</strong>
        <small>{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</small>
        {problem ? <p className="clock-gate-problem">{problem}</p> : null}
        <button type="button" className="clock-gate-button" onClick={clockIn} disabled={busy} autoFocus>
          {busy ? 'Clocking in…' : 'Clock in'}
        </button>
        <button type="button" className="clock-gate-link" onClick={onOpenMyHR}>Open MyHR instead (schedule, time off)</button>
      </div>
    </section>
  )
}
