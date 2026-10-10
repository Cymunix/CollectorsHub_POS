import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { AlertTriangle, ArrowLeft, Camera, CheckCircle2, Clock3, IdCard, RefreshCw, ScanLine, ShieldCheck, Smartphone, Video, X, XCircle } from 'lucide-react'
import {
  DISCREPANCY_TEXT,
  DOCUMENT_TYPES,
  IdentityUnavailableError,
  NOTICE_VERSION,
  cancelSession,
  countFaces,
  documentLabel,
  imageQuality,
  qualityProblem,
  readSession,
  recordConsent,
  recordDocument,
  requestMobileCapture,
  startVerification,
  submitVerification,
  uploadEvidence,
} from './nordvikIdentity'

// NORDVIK Identity verification wizard (reusable by NORDVIK apps). Opens over
// the current screen, so the POS cart and selected customer are untouched.
//
// 1 Consent  2 Government ID  3 Capture method  4 Capture  5 Result
//
// Images exist only in memory until they're uploaded to NORDVIK Identity;
// cameras run only while a capture step is open. This component never
// decides "verified": the result always comes from NORDVIK Identity.

const STEPS = [
  { id: 'consent', label: 'Consent' },
  { id: 'document', label: 'Government ID' },
  { id: 'method', label: 'Capture method' },
  { id: 'capture', label: 'Capture' },
  { id: 'result', label: 'Result' },
]
const PROVINCES = ['Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland and Labrador', 'Northwest Territories', 'Nova Scotia', 'Nunavut', 'Ontario', 'Prince Edward Island', 'Quebec', 'Saskatchewan', 'Yukon']
const CAMERA_PREF = 'nordvik-identity-camera'
const readPref = () => { try { return window.localStorage.getItem(CAMERA_PREF) || '' } catch { return '' } }
const writePref = (value) => { try { window.localStorage.setItem(CAMERA_PREF, value) } catch {} }

export function PrivacyNotice() {
  return (
    <div className="nid-notice">
      <p><strong>Why this is needed.</strong> Before a store buys items from you, it must confirm who you are. This helps prevent the sale of stolen goods. You don't need it to buy from the store.</p>
      <p><strong>What's processed.</strong> Your ID type, the full name, date of birth, expiry date and issuing province, state or country on your ID, and images of your ID.</p>
      <p><strong>Why a live photo.</strong> To confirm the person holding the ID is you. NORDVIK Identity compares your live photo with the photo on your ID: automatically when an approved verification service is connected, otherwise by an authorised NORDVIK Identity reviewer.</p>
      <p><strong>Who processes it.</strong> NORDVIK Identity, not the store.</p>
      <p><strong>What stores see.</strong> Stores where you sell items see that you're verified, your verified legal name and date of birth, and a portrait made from your verification photo, so staff can confirm it's you. Never your ID images. Your portrait is never shown on your public CollectorsHub profile and is separate from your profile picture.</p>
      <p><strong>How long it's kept.</strong> ID images and your photo are deleted within 7 days of the decision. Details read from your ID are deleted after 90 days. No face templates are kept. Your verified status and portrait stay on your account until your ID expires or the verification is withdrawn.</p>
      <p><strong>Your rights.</strong> You can ask NORDVIK to see, correct or delete the information held about you, or withdraw your consent.</p>
      <p><strong>Alternative.</strong> If you'd rather not have a photo taken or compared, the store can examine your ID in person instead, for review by NORDVIK Identity.</p>
    </div>
  )
}

function Progress({ current }) {
  const index = STEPS.findIndex((step) => step.id === current)
  return (
    <ol className="nid-progress">
      {STEPS.map((step, position) => (
        <li key={step.id} className={position < index ? 'done' : position === index ? 'current' : ''}>
          <span>{position < index ? <CheckCircle2 size={14} /> : position + 1}</span>{step.label}
        </li>
      ))}
    </ol>
  )
}

// Camera (store webcam): pick a camera, preview, capture, check, retake.
export function CameraCapture({ purpose = 'face', title, hint, onConfirm, busy = false }) {
  const videoRef = useRef(null)
  const [devices, setDevices] = useState([])
  const [deviceId, setDeviceId] = useState(readPref())
  const [stream, setStream] = useState(null)
  const [shot, setShot] = useState('')
  const [problem, setProblem] = useState('')
  const [warning, setWarning] = useState('')
  const [attempt, setAttempt] = useState(0)

  async function listCameras() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      setDevices(all.filter((device) => device.kind === 'videoinput'))
    } catch { setDevices([]) }
  }
  useEffect(() => {
    listCameras()
    navigator.mediaDevices?.addEventListener?.('devicechange', listCameras)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', listCameras)
  }, [])

  useEffect(() => {
    if (shot) return undefined
    let active = true
    let opened = null
    setProblem('')
    if (!navigator.mediaDevices?.getUserMedia) { setProblem('This computer has no camera access.'); return undefined }
    navigator.mediaDevices.getUserMedia({ video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((media) => {
        opened = media
        if (!active) { media.getTracks().forEach((track) => track.stop()); return }
        media.getVideoTracks()[0]?.addEventListener('ended', () => setProblem('The camera was disconnected. Reconnect it and choose it again.'))
        setStream(media)
        listCameras() // labels appear once permission is granted
      })
      .catch((error) => {
        if (error?.name === 'NotAllowedError') setProblem('Camera access was denied. Allow the camera for CollectorsHub POS in Windows Settings > Privacy > Camera.')
        else if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') { if (deviceId) { setDeviceId(''); writePref('') } else setProblem('No camera found. Connect a camera, or use the customer\'s phone.') }
        else if (error?.name === 'NotReadableError') setProblem('The camera is in use by another program. Close it and try again.')
        else setProblem('The camera could not start.')
      })
    return () => { active = false; opened?.getTracks().forEach((track) => track.stop()); setStream(null) }
  }, [deviceId, shot, attempt])
  useEffect(() => { if (videoRef.current && stream) videoRef.current.srcObject = stream }, [stream])

  async function capture() {
    const video = videoRef.current
    if (!video?.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0) // original frame, no filters
    const issue = qualityProblem(imageQuality(canvas), purpose === 'face' ? await countFaces(canvas) : null, { face: purpose === 'face' })
    if (issue) { setWarning(issue); return }
    setWarning('')
    setShot(canvas.toDataURL('image/jpeg', 0.92))
  }

  return (
    <div className="nid-capture">
      <div className="nid-capture-head">
        <div><h3>{title}</h3><p className="nid-muted">{hint}</p></div>
        {devices.length > 1 ? (
          <label className="nid-camera-pick">
            <span>Camera</span>
            <select value={deviceId} onChange={(event) => { setDeviceId(event.target.value); writePref(event.target.value) }}>
              <option value="">Default camera</option>
              {devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      {problem ? <p className="nid-error"><AlertTriangle size={15} /> {problem}</p> : null}
      <div className={`nid-preview ${purpose}`}>
        {shot ? <img src={shot} alt="Captured" /> : <video ref={videoRef} autoPlay playsInline muted />}
        {!shot && stream ? <span className={`nid-guide ${purpose}`} /> : null}
        {!shot && stream ? <span className="nid-live"><Video size={13} /> Camera on</span> : null}
      </div>
      {warning ? <p className="nid-hint bad">{warning}</p> : null}
      <div className="nid-actions">
        {shot ? (
          <>
            <button type="button" onClick={() => setShot('')} disabled={busy}><RefreshCw size={15} /> Retake</button>
            <button type="button" className="gold-button" onClick={() => onConfirm(shot)} disabled={busy}><CheckCircle2 size={15} /> {busy ? 'Uploading…' : 'Use this photo'}</button>
          </>
        ) : (
          <>
            {problem ? <button type="button" onClick={() => { setProblem(''); listCameras(); setAttempt((count) => count + 1) }}><RefreshCw size={15} /> Try again</button> : null}
            <button type="button" className="gold-button" disabled={!stream} onClick={capture}><Camera size={15} /> {purpose === 'face' ? 'Take photo' : 'Capture'}</button>
          </>
        )}
      </div>
    </div>
  )
}

// One side of an ID: flatbed scanner (when available) or camera.
function DocumentSide({ side, documentType, onConfirm, busy }) {
  const canScan = Boolean(window.nordvikDesktop?.scanIdentityDocument)
  const [source, setSource] = useState(canScan ? '' : 'camera')
  const [scan, setScan] = useState('')
  const [scanning, setScanning] = useState(false)
  const [problem, setProblem] = useState('')
  const title = `${side === 'document_front' ? 'Front' : 'Back'} of the ${documentLabel(documentType)}`
  async function runScan() {
    setScanning(true)
    setProblem('')
    try {
      const result = await window.nordvikDesktop.scanIdentityDocument()
      if (result?.needsSelection) throw new Error('Choose a scanner first (Scan to Inventory > scanner settings), or use the camera.')
      if (!result?.dataUrl) throw new Error('The scan did not return an image.')
      setScan(result.dataUrl)
    } catch (error) {
      setProblem(`${error?.message || error} You can use the camera instead.`)
    } finally {
      setScanning(false)
    }
  }
  if (!source) {
    return (
      <div className="nid-step">
        <h3>{title}</h3>
        <p className="nid-muted">{side === 'document_back' ? 'Include the barcode.' : 'The whole card, flat, no glare.'}</p>
        <div className="nid-choice">
          <button type="button" onClick={() => setSource('scanner')}><ScanLine size={22} /><strong>Scanner</strong><small>Place the ID face down on the flatbed</small></button>
          <button type="button" onClick={() => setSource('camera')}><Camera size={22} /><strong>Camera</strong><small>Hold the ID up to the store camera</small></button>
        </div>
      </div>
    )
  }
  if (source === 'camera') return <CameraCapture key={side} purpose="document" title={title} hint="Fill the frame with the ID. Avoid glare and shadows." onConfirm={onConfirm} busy={busy} />
  return (
    <div className="nid-step">
      <h3>{title}</h3>
      <p className="nid-muted">Place the ID face down in the top corner of the scanner bed.</p>
      {problem ? <p className="nid-error"><AlertTriangle size={15} /> {problem}</p> : null}
      <div className="nid-preview document">{scan ? <img src={scan} alt="Scanned ID" /> : <p className="nid-muted">{scanning ? 'Scanning…' : 'Ready to scan'}</p>}</div>
      <div className="nid-actions">
        <button type="button" onClick={() => setSource('camera')}><Camera size={15} /> Use camera</button>
        {scan ? <button type="button" onClick={() => setScan('')} disabled={busy}><RefreshCw size={15} /> Rescan</button> : null}
        {scan
          ? <button type="button" className="gold-button" onClick={() => onConfirm(scan)} disabled={busy}><CheckCircle2 size={15} /> {busy ? 'Uploading…' : 'Use this scan'}</button>
          : <button type="button" className="gold-button" onClick={runScan} disabled={scanning}><ScanLine size={15} /> {scanning ? 'Scanning…' : 'Scan'}</button>}
      </div>
    </div>
  )
}

// Customer's phone: QR code, expiry, live status.
function PhoneCapture({ session, onRefresh, onDone, onDeclined }) {
  const [link, setLink] = useState(null) // { url, expiresAt }
  const [qr, setQr] = useState('')
  const [now, setNow] = useState(Date.now())
  const [problem, setProblem] = useState('')
  async function generate() {
    setProblem('')
    try {
      const created = await requestMobileCapture(session.id)
      setLink(created)
      setQr(await QRCode.toDataURL(created.url, { margin: 1, width: 280, errorCorrectionLevel: 'M', color: { dark: '#0B111B', light: '#FFFFFF' } }))
    } catch (error) {
      setProblem(error?.message || String(error))
    }
  }
  useEffect(() => { generate() }, [])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  // Live status: an authenticated status request every few seconds (the
  // POS never trusts anything the phone says directly).
  useEffect(() => {
    if (!link) return undefined
    let stopped = false
    const poll = async () => {
      if (stopped) return
      try {
        const latest = await onRefresh()
        if (latest?.evidence?.live_photo) { onDone(); return }
        if (latest?.consents?.biometric === 'declined') { onDeclined(); return }
      } catch {}
      if (!stopped) timer = setTimeout(poll, 2500)
    }
    let timer = setTimeout(poll, 2500)
    return () => { stopped = true; clearTimeout(timer) }
  }, [link])
  const secondsLeft = link ? Math.max(0, Math.round((new Date(link.expiresAt).getTime() - now) / 1000)) : 0
  const expired = link && secondsLeft === 0
  return (
    <div className="nid-step nid-phone">
      <h3>Scan with the customer's phone</h3>
      <p className="nid-muted">The customer scans this code with their phone camera, agrees on their phone, and takes their own photo. Their phone doesn't need the store's Wi-Fi.</p>
      {problem ? <p className="nid-error"><AlertTriangle size={15} /> {problem}</p> : null}
      <div className="nid-qr">
        {qr && !expired ? <img src={qr} alt="Verification QR code" /> : <div className="nid-qr-empty">{expired ? 'Code expired' : problem ? 'No code' : 'Creating code…'}</div>}
        <div className="nid-qr-status">
          {link && !expired ? (
            <>
              <p className="nid-waiting"><Clock3 size={16} /> {session.mobile?.opened ? 'Customer opened the link…' : 'Waiting for customer'}</p>
              <p className="nid-muted">Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</p>
              <div className="nid-expiry"><span style={{ width: `${Math.min(100, (secondsLeft / 600) * 100)}%` }} /></div>
            </>
          ) : null}
          <button type="button" onClick={generate}><RefreshCw size={15} /> {expired ? 'New code' : 'Regenerate code'}</button>
          <p className="nid-muted nid-small">Single use. Contains no personal information.</p>
        </div>
      </div>
    </div>
  )
}

export default function IdentityWizard({ storeId, customer, onClose }) {
  const [step, setStep] = useState('consent')
  const [session, setSession] = useState(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const [signedName, setSignedName] = useState('')
  const [biometric, setBiometric] = useState('given') // given | declined
  const [documentType, setDocumentType] = useState('')
  const [sides, setSides] = useState({}) // kind -> true once uploaded
  const [details, setDetails] = useState({ full_name: customer?.fullName || '', date_of_birth: '', expiry_date: '', jurisdiction: 'Nova Scotia' })
  const [method, setMethod] = useState('')
  const [attest, setAttest] = useState({ examined: false, photoMatches: false })
  const [result, setResult] = useState(null)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    startVerification(storeId, customer.profileId)
      .then(setSession)
      .catch((error) => setProblem(error instanceof IdentityUnavailableError ? `${error.message} Verification can't continue without it.` : (error?.message || String(error))))
  }, [])

  const refresh = async () => { const latest = await readSession(session.id); setSession(latest); return latest }
  async function run(action) {
    setBusy(true)
    setProblem('')
    try { await action() } catch (error) { setProblem(error?.message || String(error)) } finally { setBusy(false) }
  }
  async function close() {
    if (session && !result && ['pending', 'awaiting_capture'].includes(session.status)) await cancelSession(session.id, 'Closed before finishing').catch(() => {})
    onClose(result?.status || session?.profileStatus || null)
  }

  const docType = DOCUMENT_TYPES.find((type) => type.id === documentType)
  const neededSides = docType ? (docType.hasBack ? ['document_front', 'document_back'] : ['document_front']) : []
  const nextSide = neededSides.find((side) => !sides[side])
  const detailsReady = details.full_name.trim().length > 1 && details.date_of_birth && details.expiry_date && details.jurisdiction.trim()

  const consentStep = () => run(async () => {
    await recordConsent(session.id, 'identity_check', 'given', signedName.trim())
    await recordConsent(session.id, 'biometric', biometric, biometric === 'given' ? signedName.trim() : '')
    await refresh()
    setStep('document')
  })
  const uploadSide = (side, dataUrl) => run(async () => {
    await uploadEvidence(session.id, side, dataUrl)
    setSides((current) => ({ ...current, [side]: true }))
  })
  const saveDocument = () => run(async () => {
    const latest = await recordDocument(session.id, documentType, { ...details, full_name: details.full_name.trim(), jurisdiction: details.jurisdiction.trim(), source: 'manual_entry' })
    setSession(latest)
    if (latest.status === 'failed') { setResult({ status: 'failed', message: "The ID has expired, so it can't be used. Verify again with a valid ID." }); setStep('result'); return }
    setStep(biometric === 'given' ? 'method' : 'capture')
    if (biometric !== 'given') setMethod('in_person')
  })
  const doSubmit = async () => {
    let latest = await submitVerification(session.id)
    for (let tries = 0; latest.status === 'processing' && tries < 20; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      latest = await readSession(session.id)
    }
    setSession(latest)
    setResult({
      status: latest.status,
      message: latest.status === 'verified' ? 'NORDVIK Identity verified this customer. They can now sell items to the store.'
        : latest.status === 'failed' ? 'NORDVIK Identity could not verify this customer.'
          : latest.status === 'manual_review' ? 'Sent to an authorised NORDVIK Identity reviewer. The customer can keep buying; they can sell to the store once approved.'
            : 'Still processing. The customer card will update when NORDVIK Identity finishes.',
    })
    setStep('result')
  }
  const submit = () => run(doSubmit)
  const uploadFace = (dataUrl) => run(async () => { await uploadEvidence(session.id, 'live_photo', dataUrl); await doSubmit() })

  function back() {
    setProblem('')
    if (step === 'document') setStep('consent')
    else if (step === 'method') setStep('document')
    else if (step === 'capture') { setMethod(''); setStep(biometric === 'given' ? 'method' : 'document') }
  }
  const canGoBack = ['document', 'method', 'capture'].includes(step) && !busy && step !== 'consent'

  return (
    <div className="register-modal nid-modal" role="dialog" aria-modal="true" aria-labelledby="nid-title">
      <section>
        <button className="modal-close" type="button" onClick={close} aria-label="Cancel verification"><X size={18} /></button>
        <div className="nid-head">
          <ShieldCheck size={24} />
          <div>
            <h2 id="nid-title">NORDVIK Identity</h2>
            <p>{customer?.fullName || customer?.name || 'Customer'}{customer?.username ? ` · @${customer.username}` : ''}</p>
          </div>
        </div>
        <Progress current={step} />
        {session && !session.automatedAvailable && step !== 'result' ? (
          <p className="nid-banner"><AlertTriangle size={15} /> No automated verification service is connected yet: an authorised NORDVIK Identity reviewer will make the decision.</p>
        ) : null}
        {problem ? <p className="nid-error"><AlertTriangle size={15} /> {problem}</p> : null}

        {!session && !problem ? <p className="nid-muted nid-working">Starting a verification session…</p> : null}

        {session && step === 'consent' ? (
          <div className="nid-step">
            <h3>Customer consent</h3>
            <p className="nid-muted">Turn the screen to the customer. They read the notice, choose, and type their own name.</p>
            <PrivacyNotice />
            <div className="nid-consent-choice">
              <label className={biometric === 'given' ? 'active' : ''}><input type="radio" name="nid-bio" checked={biometric === 'given'} onChange={() => setBiometric('given')} /><span><strong>Photo verification</strong><small>A live photo is compared with my ID photo.</small></span></label>
              <label className={biometric === 'declined' ? 'active' : ''}><input type="radio" name="nid-bio" checked={biometric === 'declined'} onChange={() => setBiometric('declined')} /><span><strong>No photo</strong><small>The store examines my ID in person instead.</small></span></label>
            </div>
            <label className="nid-signature">
              <span>Customer: type your full name to agree</span>
              <input value={signedName} onChange={(event) => setSignedName(event.target.value)} autoComplete="off" placeholder="Your full name" />
            </label>
            <div className="nid-actions">
              <button type="button" onClick={close}>Cancel</button>
              <button type="button" className="gold-button" disabled={busy || signedName.trim().length < 2} onClick={consentStep}>{busy ? 'Saving…' : 'I agree'}</button>
            </div>
          </div>
        ) : null}

        {session && step === 'document' ? (
          !documentType ? (
            <div className="nid-step">
              <h3>Government photo ID</h3>
              <p className="nid-muted">Valid (not expired) government-issued photo ID.</p>
              <div className="nid-doc-types">
                {DOCUMENT_TYPES.map((type) => (
                  <button key={type.id} type="button" onClick={() => { setDocumentType(type.id); setSides({}); setDetails((current) => ({ ...current, jurisdiction: type.id === 'passport' ? 'Canada' : 'Nova Scotia' })) }}>
                    <IdCard size={24} /><span>{type.label}</span>
                  </button>
                ))}
              </div>
              <div className="nid-actions"><button type="button" onClick={back}><ArrowLeft size={15} /> Back</button><button type="button" onClick={close}>Cancel</button></div>
            </div>
          ) : nextSide ? (
            <>
              <DocumentSide key={nextSide} side={nextSide} documentType={documentType} busy={busy} onConfirm={(image) => uploadSide(nextSide, image)} />
              <div className="nid-actions nid-actions-left"><button type="button" onClick={() => setDocumentType('')} disabled={busy}><ArrowLeft size={15} /> Change ID type</button></div>
            </>
          ) : (
            <div className="nid-step nid-details">
              <h3>Details on the {documentLabel(documentType)}</h3>
              <p className="nid-muted">Enter exactly what the ID shows. NORDVIK Identity compares them with the account; nothing on the account changes.</p>
              <label className="wide"><span>Full legal name</span><input value={details.full_name} onChange={(event) => setDetails((current) => ({ ...current, full_name: event.target.value }))} /></label>
              <label><span>Date of birth</span><input type="date" value={details.date_of_birth} onChange={(event) => setDetails((current) => ({ ...current, date_of_birth: event.target.value }))} /></label>
              <label><span>Expiry date</span><input type="date" value={details.expiry_date} onChange={(event) => setDetails((current) => ({ ...current, expiry_date: event.target.value }))} /></label>
              <label className="wide"><span>Issued by</span><input list={documentType === 'passport' ? undefined : 'nid-provinces'} value={details.jurisdiction} onChange={(event) => setDetails((current) => ({ ...current, jurisdiction: event.target.value }))} /></label>
              <datalist id="nid-provinces">{PROVINCES.map((name) => <option key={name} value={name} />)}</datalist>
              <p className="nid-muted wide nid-small">Captured: {neededSides.map((side) => (side === 'document_front' ? 'front' : 'back')).join(' and ')} of the ID. <button type="button" className="nid-link" onClick={() => setSides({})}>Recapture</button></p>
              <div className="nid-actions wide">
                <button type="button" onClick={() => setDocumentType('')}><ArrowLeft size={15} /> Back</button>
                <button type="button" onClick={close}>Cancel</button>
                <button type="button" className="gold-button" disabled={!detailsReady || busy} onClick={saveDocument}>{busy ? 'Checking…' : 'Continue'}</button>
              </div>
            </div>
          )
        ) : null}

        {session && step === 'method' ? (
          <div className="nid-step">
            <h3>Customer photo</h3>
            {session.discrepancies?.length ? (
              <div className="nid-discrepancies"><strong><AlertTriangle size={15} /> Flagged for review</strong><ul>{session.discrepancies.map((code) => <li key={code}>{DISCREPANCY_TEXT[code] || code}</li>)}</ul></div>
            ) : null}
            <div className="nid-choice">
              <button type="button" onClick={() => { setMethod('webcam'); setStep('capture') }}><Camera size={24} /><strong>Store webcam</strong><small>Take photo using the store's camera</small></button>
              <button type="button" onClick={() => { setMethod('mobile'); setStep('capture') }}><Smartphone size={24} /><strong>Customer phone</strong><small>Send secure verification link</small></button>
            </div>
            <div className="nid-actions"><button type="button" onClick={back}><ArrowLeft size={15} /> Back</button><button type="button" onClick={close}>Cancel</button></div>
          </div>
        ) : null}

        {session && step === 'capture' && method === 'webcam' ? (
          <>
            <CameraCapture purpose="face" title="Photograph the customer" hint="Tell the customer you're taking the photo. One face, looking at the camera, good light, nothing covering the face." busy={busy} onConfirm={uploadFace} />
            <div className="nid-actions nid-actions-left"><button type="button" onClick={back} disabled={busy}><ArrowLeft size={15} /> Back</button></div>
          </>
        ) : null}

        {session && step === 'capture' && method === 'mobile' ? (
          <>
            <PhoneCapture session={session} onRefresh={refresh} onDone={submit} onDeclined={() => { setBiometric('declined'); setMethod('in_person') }} />
            <div className="nid-actions nid-actions-left"><button type="button" onClick={back}><ArrowLeft size={15} /> Back</button><button type="button" onClick={close}>Cancel</button></div>
          </>
        ) : null}

        {session && step === 'capture' && method === 'in_person' ? (
          <div className="nid-step">
            <h3>In-person ID check</h3>
            <p className="nid-muted">The customer chose not to have a photo taken. Examine their physical ID; an authorised NORDVIK Identity reviewer makes the decision.</p>
            <label className="nid-check"><input type="checkbox" checked={attest.examined} onChange={(event) => setAttest((current) => ({ ...current, examined: event.target.checked }))} /><span>I examined the physical ID in person and it appears genuine and unaltered.</span></label>
            <label className="nid-check"><input type="checkbox" checked={attest.photoMatches} onChange={(event) => setAttest((current) => ({ ...current, photoMatches: event.target.checked }))} /><span>The photo on the ID matches the customer in front of me.</span></label>
            <div className="nid-actions">
              <button type="button" onClick={back}><ArrowLeft size={15} /> Back</button>
              <button type="button" onClick={close}>Cancel</button>
              <button type="button" className="gold-button" disabled={!attest.examined || !attest.photoMatches || busy} onClick={submit}>{busy ? 'Submitting…' : 'Submit for review'}</button>
            </div>
          </div>
        ) : null}

        {step === 'result' && result ? (
          <div className={`nid-result ${result.status}`}>
            {result.status === 'verified' ? <ShieldCheck size={44} /> : result.status === 'failed' ? <XCircle size={44} /> : <Clock3 size={44} />}
            <h3>{result.status === 'verified' ? 'Identity Verified' : result.status === 'failed' ? 'Verification failed' : result.status === 'manual_review' ? 'Waiting for review' : 'Processing'}</h3>
            <p>{result.message}</p>
            <div className="nid-actions">
              {result.status === 'failed' ? <button type="button" onClick={() => { onClose('failed'); }}><RefreshCw size={15} /> Close and verify again later</button> : null}
              <button type="button" className="gold-button" onClick={() => onClose(result.status)}>Back to the sale</button>
            </div>
          </div>
        ) : null}
        <p className="nid-foot">NORDVIK Identity · consent notice {NOTICE_VERSION}{session ? ` · session ${String(session.id).slice(0, 8)}` : ''}</p>
      </section>
    </div>
  )
}
