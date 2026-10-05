import React, { useEffect, useState } from 'react'

// "Check for updates": runs the same check as start-up. A newer version
// downloads in the background, then the Update ready prompt appears.
export default function UpdateCheck({ compact = false }) {
  const api = typeof window !== 'undefined' ? window.nordvikDesktop : null
  const [version, setVersion] = useState('')
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api?.getVersion?.().then((value) => setVersion(value || '')).catch(() => {})
  }, [])

  if (!api?.checkForUpdates) return null

  async function check() {
    setBusy(true)
    setStatus(null)
    try {
      setStatus(await api.checkForUpdates())
    } catch (error) {
      setStatus({ state: 'error', message: error?.message || 'The update check failed.' })
    } finally {
      setBusy(false)
    }
  }

  const message = !status ? '' : {
    'up-to-date': "You're up to date.",
    downloading: `Version ${status.version} found, downloading… The update prompt appears when it's ready.`,
    ready: `Version ${status.version} is ready to install.`,
    dev: 'Updates are off in the development build.',
    error: `Couldn't check for updates: ${status.message}`,
  }[status.state] || ''

  return (
    <div className={`update-check${compact ? ' compact' : ''}`}>
      <span className="update-check-version">CollectorsHub POS {version ? `v${version}` : ''}</span>
      <span className="update-check-actions">
        <button type="button" onClick={check} disabled={busy}>{busy ? 'Checking…' : 'Check for updates'}</button>
        {status?.state === 'ready' ? <button type="button" className="gold-button" onClick={() => api.installUpdate?.()}>Restart and install</button> : null}
      </span>
      {message ? <small className={`update-check-status ${status.state}`}>{message}</small> : null}
    </div>
  )
}
