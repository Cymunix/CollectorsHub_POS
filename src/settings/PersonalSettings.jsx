import React, { useEffect, useState } from 'react'
import { AlertTriangle, Camera, Check, KeyRound, LogOut, Monitor, ShieldCheck, Smartphone, UserRound, X } from 'lucide-react'
import {
  DEFAULT_PREFERENCES, changeMyPassword, loadPreferences, mfaFactors, mfaRemove, mfaStart, mfaVerify, myProfile, photoUrl, savePreferences,
  signOutOtherDevices, updateMyPhoto, uploadMyPhoto,
} from '../lib/personalSettings'

// Settings: the signed-in employee's own account only. Store, organization, tax,
// register, inventory, pawn and staff settings are managed by the organization.

const when = (value) => (value ? new Date(value).toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
const titleCase = (value) => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export default function PersonalSettings({ session, dataPath, onLogout, onProfileChanged, updateCheck }) {
  const storeId = session?.storeId
  const [profile, setProfile] = useState(null)
  const [problem, setProblem] = useState('')
  async function load() { try { setProfile(await myProfile(storeId)); setProblem('') } catch (error) { setProblem(error.message) } }
  useEffect(() => { if (storeId) load() }, [storeId])

  if (!storeId) return <section className="cu-page ps-page"><h1>Settings</h1><p className="cs-muted">Sign in to a store to see your settings.</p></section>
  return (
    <section className="cu-page ps-page">
      <header className="ps-head"><h1>Settings</h1><p>Your own account: profile, security and preferences. Store and organization settings are managed by your organization.</p></header>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      {!profile && !problem ? <p className="cs-muted">Loading…</p> : null}
      {profile ? (
        <div className="ps-grid">
          <div className="ps-column">
          <ProfileCard storeId={storeId} profile={profile} onSaved={async () => { await load(); onProfileChanged?.() }} />
          <PreferencesCard />
          <div className="tx-card ps-card">
            <h2><Monitor size={18} /> About this app</h2>
            <dl className="cs-facts">
              <dt>App version</dt><dd>{updateCheck}</dd>
              <dt>Data on this PC</dt><dd><code>{dataPath || '—'}</code></dd>
            </dl>
          </div>
          </div>
          <div className="ps-column">
            <SecurityCard storeId={storeId} profile={profile} onLogout={onLogout} />
            <EmploymentCard profile={profile} session={session} />
          </div>
        </div>
      ) : null}
    </section>
  )
}

function ProfileCard({ storeId, profile, onSaved }) {
  const e = profile.employee
  const [photoPath, setPhotoPath] = useState(e.photo_path || '')
  const [photo, setPhoto] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [problem, setProblem] = useState('')
  useEffect(() => { photoUrl(photoPath).then(setPhoto).catch(() => setPhoto('')) }, [photoPath])
  const changed = photoPath !== (e.photo_path || '')
  async function pick(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true); setProblem('')
    try { setPhotoPath(await uploadMyPhoto(file)) } catch (error) { setProblem(error.message) } finally { setBusy(false) }
  }
  async function save() {
    setBusy(true); setProblem(''); setMessage('')
    try { await updateMyPhoto(storeId, photoPath); setMessage('Photo saved.'); await onSaved() } catch (error) { setProblem(error.message) } finally { setBusy(false) }
  }
  return (
    <div className="tx-card ps-card">
      <h2><UserRound size={18} /> My Profile</h2>
      <div className="ps-profile">
        <div className="ps-photo">
          {photo ? <img src={photo} alt="" /> : <span><UserRound size={40} /></span>}
          <label className="ps-photo-button"><Camera size={14} /> {photo ? 'Change' : 'Add photo'}<input type="file" accept="image/*" hidden onChange={pick} /></label>
          {photo ? <button type="button" className="tx-link" onClick={() => setPhotoPath('')}>Remove</button> : null}
        </div>
        <div className="ps-fields">
          <dl className="cs-facts">
            <dt>Name</dt><dd>{[e.first_name, e.last_name].filter(Boolean).join(' ') || '—'}</dd>
            <dt>Username</dt><dd>{e.username || '—'}</dd>
            <dt>Email</dt><dd>{e.email || profile.account?.email || '—'}</dd>
            <dt>Role</dt><dd>{titleCase(e.role)} <small className="cs-muted">(set by your organization)</small></dd>
          </dl>
        </div>
      </div>
      <p className="cs-muted ps-small">Your name, username, email and role are kept by your organization. Ask your manager or HR to change them. You can change your photo.</p>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      {message ? <p className="cu-notice"><Check size={15} /> {message}</p> : null}
      <div className="cs-actions left"><button type="button" className="gold-button" disabled={busy || !changed} onClick={save}>{busy ? 'Saving…' : 'Save photo'}</button></div>
    </div>
  )
}

function SecurityCard({ storeId, profile, onLogout }) {
  const [password, setPassword] = useState({ current: '', next: '', confirm: '' })
  const [factors, setFactors] = useState(null)
  const [setup, setSetup] = useState(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [problem, setProblem] = useState('')
  const loadFactors = () => mfaFactors().then(setFactors).catch(() => setFactors([]))
  useEffect(() => { loadFactors() }, [])
  const verified = (factors || []).find((factor) => factor.status === 'verified')
  async function run(key, task, done) { setBusy(key); setProblem(''); setMessage(''); try { await task(); if (done) setMessage(done) } catch (error) { setProblem(error.message) } finally { setBusy('') } }

  return (
    <div className="tx-card ps-card">
      <h2><ShieldCheck size={18} /> Security</h2>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      {message ? <p className="cu-notice"><Check size={15} /> {message}</p> : null}

      <h3><KeyRound size={15} /> Change password</h3>
      <p className="cs-muted ps-small">The password you sign in to the POS with. You'll need your current one.</p>
      <div className="cs-form-grid">
        <label className="wide"><span>Current password</span><input type="password" autoComplete="current-password" value={password.current} onChange={(event) => setPassword({ ...password, current: event.target.value })} /></label>
                <label><span>New password (6+ characters)</span><input type="password" autoComplete="new-password" value={password.next} onChange={(event) => setPassword({ ...password, next: event.target.value })} /></label>
        <label><span>Confirm new password</span><input type="password" autoComplete="new-password" value={password.confirm} onChange={(event) => setPassword({ ...password, confirm: event.target.value })} /></label>
      </div>
      {password.confirm && password.next !== password.confirm ? <p className="cs-error ps-small">The new passwords don't match.</p> : null}
      <div className="cs-actions left"><button type="button" className="gold-button" disabled={busy === 'password' || !password.current || password.next.trim().length < 6 || password.next !== password.confirm}
        onClick={() => run('password', async () => { await changeMyPassword(storeId, password.current, password.next); setPassword({ current: '', next: '', confirm: '' }) }, 'Password changed. Use the new one next time you sign in.')}>{busy === 'password' ? 'Changing…' : 'Change password'}</button></div>

      <h3><Smartphone size={15} /> Two-step sign-in</h3>
      {factors === null ? <p className="cs-muted">Checking…</p> : verified ? (
        <>
          <p className="ps-small"><Check size={14} /> On. After your password, you'll enter a code from your authenticator app.</p>
          <div className="cs-actions left"><button type="button" disabled={busy === 'mfa'} onClick={() => { if (window.confirm('Turn off two-step sign-in?')) run('mfa', async () => { await mfaRemove(verified.id); await loadFactors() }, 'Two-step sign-in is off.') }}>Turn off</button></div>
        </>
      ) : setup ? (
        <div className="ps-mfa">
          {setup.qr ? <img src={setup.qr} alt="Scan with your authenticator app" /> : null}
          <div>
            <p className="ps-small">Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), or enter the key <code>{setup.secret}</code>. Then type the 6-digit code it shows.</p>
            <label className="tx-field"><span>Code</span><input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={8} /></label>
            <div className="cs-actions left"><button type="button" onClick={() => { setSetup(null); setCode('') }}>Cancel</button><button type="button" className="gold-button" disabled={busy === 'mfa' || code.replace(/\s/g, '').length < 6} onClick={() => run('mfa', async () => { await mfaVerify(setup.factorId, code); setSetup(null); setCode(''); await loadFactors() }, 'Two-step sign-in is on.')}>Turn on</button></div>
          </div>
        </div>
      ) : (
        <>
          <p className="cs-muted ps-small">Off. Add a code from your phone when you sign in, so a password alone can't open your account.</p>
          <div className="cs-actions left"><button type="button" disabled={busy === 'mfa'} onClick={() => run('mfa', async () => setSetup(await mfaStart()))}>Set up two-step sign-in</button></div>
        </>
      )}

      <h3><Monitor size={15} /> Sessions</h3>
      <dl className="cs-facts">
        <dt>Last sign-in</dt><dd>{when(profile.account?.last_sign_in_at)}</dd>
        <dt>Account created</dt><dd>{when(profile.account?.created_at)}</dd>
      </dl>
      <div className="cs-actions left">
        <button type="button" disabled={busy === 'others'} onClick={() => { if (window.confirm('Sign out of your account on every other register and device?')) run('others', signOutOtherDevices, 'Signed out of every other device. This register stays signed in.') }}><LogOut size={15} /> Sign out of other devices</button>
        <button type="button" onClick={onLogout}><LogOut size={15} /> Sign out here</button>
      </div>
    </div>
  )
}

function PreferencesCard() {
  const [prefs, setPrefs] = useState(null)
  const [saved, setSaved] = useState(null)
  const [message, setMessage] = useState('')
  const [problem, setProblem] = useState('')
  useEffect(() => { loadPreferences().then((value) => { setPrefs(value); setSaved(value) }).catch(() => { setPrefs(DEFAULT_PREFERENCES); setSaved(DEFAULT_PREFERENCES) }) }, [])
  if (!prefs) return <div className="tx-card ps-card"><h2>Preferences</h2><p className="cs-muted">Loading…</p></div>
  const changed = JSON.stringify(prefs) !== JSON.stringify(saved)
  return (
    <div className="tx-card ps-card">
      <h2>Preferences</h2>
      <p className="cs-muted ps-small">Saved on your account, so they follow you to any register. They only change what you see.</p>
      <div className="cs-form-grid">
        <label><span>Appearance</span><select value="light" disabled title="Only the light theme is available for now"><option value="light">Light</option><option value="dark">Dark (not available yet)</option><option value="system">System (not available yet)</option></select></label>
        <label><span>Language</span><select value={prefs.language || 'en'} onChange={(event) => setPrefs({ ...prefs, language: event.target.value })} data-no-translate><option value="en">English (Canada)</option><option value="fr">Français (Canada)</option></select></label>
        <label><span>Text size</span><select value={prefs.textSize} onChange={(event) => setPrefs({ ...prefs, textSize: event.target.value })}><option value="normal">Normal</option><option value="large">Large</option><option value="larger">Larger</option></select></label>
      </div>
      <label className="tx-check"><input type="checkbox" checked={prefs.reduceMotion} onChange={(event) => setPrefs({ ...prefs, reduceMotion: event.target.checked })} /> Reduce motion (no animations or transitions)</label>
      <label className="tx-check"><input type="checkbox" checked={prefs.strongFocus} onChange={(event) => setPrefs({ ...prefs, strongFocus: event.target.checked })} /> Strong keyboard focus outline</label>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      {message ? <p className="cu-notice"><Check size={15} /> {message}</p> : null}
      <div className="cs-actions left"><button type="button" className="gold-button" disabled={!changed} onClick={async () => { setProblem(''); setMessage(''); try { await savePreferences(prefs); setSaved(prefs); setMessage('Preferences saved.') } catch (error) { setProblem(error.message) } }}>Save preferences</button></div>
    </div>
  )
}

function EmploymentCard({ profile, session }) {
  const e = profile.employee
  return (
    <div className="tx-card ps-card">
      <h2>My Employment Information</h2>
      <p className="cs-muted ps-small">Read-only. Your organization manages your role, store and locations.</p>
      <dl className="cs-facts">
        <dt>Organization</dt><dd>{profile.store?.organization || '—'}</dd>
        <dt>Store</dt><dd>{profile.store?.name}{profile.store?.code ? ` (${profile.store.code})` : ''}</dd>
        <dt>Locations</dt><dd>{e.all_locations ? `All locations${profile.locations?.length ? ` (${profile.locations.join(', ')})` : ''}` : (profile.locations || []).join(', ') || 'None assigned'}</dd>
        <dt>Role</dt><dd>{titleCase(e.role)}</dd>
        <dt>Status</dt><dd>{titleCase(e.status)}</dd>
        <dt>With the store since</dt><dd>{when(e.since)}</dd>
      </dl>
      {(profile.assignments || []).length > 1 ? (
        <>
          <h3>All my assignments</h3>
          <table className="cs-table tx-items">
            <thead><tr><th>Store</th><th>Organization</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>{profile.assignments.map((a, index) => <tr key={index}><td><strong>{a.store}</strong>{a.current ? <small className="tx-sku">signed in here</small> : <small className="tx-sku">store code {a.code}</small>}</td><td>{a.organization || '—'}</td><td>{titleCase(a.role)}</td><td>{titleCase(a.status)}</td></tr>)}</tbody>
          </table>
          <p className="cs-muted ps-small">To work at another store, sign out and sign in with that store's code.</p>
        </>
      ) : null}
    </div>
  )
}
