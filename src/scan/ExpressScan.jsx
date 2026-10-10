import React, { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, ListChecks, Send } from 'lucide-react'
import { cancelJob, createJob, finaliseImport, listJobs } from '../lib/collectionScanning'
import { AuthorisationPanel, CollectorCard, CollectorPicker, ImportDialog, JobScanner, ProgressStrip, ReviewItems, clearImportKey, importKey, useJob } from './collectorParts'

// Express Scan: the collector is at the counter. Find them, request
// authorisation (they approve on their own account, 60 minutes), scan,
// review, Add to Collection.

export default function ExpressScan({ session, queues, onSaveQueue }) {
  const [jobId, setJobId] = useState('')
  const [collector, setCollector] = useState(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const [openJobs, setOpenJobs] = useState([])

  useEffect(() => {
    if (jobId || !session?.storeId) return
    listJobs(session.storeId, { kind: 'express', filter: 'all' })
      .then((rows) => setOpenJobs((rows || []).filter((row) => !['completed', 'cancelled'].includes(row.status)).slice(0, 10)))
      .catch(() => setOpenJobs([]))
  }, [jobId, session?.storeId])

  async function requestAuthorisation() {
    setBusy(true)
    setProblem('')
    try {
      const created = await createJob(session.storeId, session.locationId, collector.id, 'express', {})
      setJobId(created.job_id)
    } catch (error) {
      setProblem(error?.message || String(error))
    } finally {
      setBusy(false)
    }
  }

  if (jobId) return <ExpressSession session={session} jobId={jobId} queues={queues} onSaveQueue={onSaveQueue} onDone={() => { setJobId(''); setCollector(null) }} />
  return (
    <div className="cs-panel">
      <div><h3>Express Scan</h3><p className="cs-muted">Find a collector and request permission to scan items into their collection.</p></div>
      {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
      {collector ? (
        <CollectorCard collector={collector} status="not_requested" onChange={() => setCollector(null)}>
          <button type="button" className="gold-button" onClick={requestAuthorisation} disabled={busy}><Send size={15} /> {busy ? 'Requesting…' : 'Request Authorisation'}</button>
        </CollectorCard>
      ) : <CollectorPicker storeId={session?.storeId} onPick={setCollector} />}
      {!collector && openJobs.length ? (
        <div className="cs-open">
          <h4>Express sessions still open</h4>
          {openJobs.map((row) => <button type="button" key={row.id} onClick={() => setJobId(row.id)}>{row.reference} · {row.collector_name} · {row.status.replace(/_/g, ' ')}</button>)}
        </div>
      ) : null}
    </div>
  )
}

function ExpressSession({ session, jobId, queues, onSaveQueue, onDone }) {
  const { data, problem, reload } = useJob(jobId)
  const [step, setStep] = useState('scan') // scan | review | done
  const [result, setResult] = useState(null)
  const [importing, setImporting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!data) return <div className="cs-panel">{problem ? <p className="cs-error">{problem}</p> : <p className="cs-muted">Loading…</p>}</div>
  const { job, collector, authorisation, counts } = data
  const status = authorisation?.status || 'missing'
  const approved = status === 'approved'

  async function add(leaveOut) {
    setBusy(true)
    setError('')
    try {
      const outcome = await finaliseImport(job.id, importKey(job.id), leaveOut)
      clearImportKey(job.id)
      setResult(outcome)
      setImporting(false)
      setStep('done')
      reload()
    } catch (importError) {
      setError(importError?.message || String(importError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cs-panel">
      <p className="cs-kicker">Express Scan · {job.reference}</p>
      <CollectorCard collector={collector} status={status} />
      {step !== 'done' ? <AuthorisationPanel jobId={job.id} authorisation={authorisation} kind="express" onChange={reload} /> : null}
      {error && !importing ? <p className="cs-error"><AlertTriangle size={14} /> {error}</p> : null}

      {step === 'done' ? (
        <div className="cs-done">
          <CheckCircle2 size={40} />
          <h3>Added to {collector.name}'s collection</h3>
          <p>{result?.copies_created || 0} item{result?.copies_created === 1 ? '' : 's'}{result?.repeated ? ' (already added earlier, nothing added twice)' : ''}. Their collection completion and XP update on their account.</p>
          <p className="cs-muted">Reference {job.reference}</p>
          <button type="button" className="gold-button" onClick={onDone}>Next collector</button>
        </div>
      ) : null}

      {step === 'scan' && approved ? (
        <>
          <ProgressStrip counts={counts} />
          <JobScanner session={session} job={job} queues={queues} onSaveQueue={onSaveQueue} onChanged={reload} />
          <div className="cs-actions">
            <button type="button" onClick={async () => { if (window.confirm('Cancel this session? Nothing is added to the collection.')) { await cancelJob(job.id, 'Cancelled at the counter').catch(() => {}); onDone() } }}>Cancel session</button>
            <button type="button" className="gold-button" onClick={() => { reload(); setStep('review') }} disabled={!counts.scanned}><ListChecks size={15} /> Review and add to collection</button>
          </div>
        </>
      ) : null}

      {step === 'review' ? (
        <>
          <ProgressStrip counts={counts} />
          <ReviewItems jobId={job.id} onChanged={reload} initialFilter={counts.needs_review ? 'needs_review' : 'draft'} />
          <div className="cs-actions">
            <button type="button" onClick={() => setStep('scan')}>Back to scanning</button>
            <button type="button" className="gold-button" onClick={() => { setError(''); setImporting(true) }} disabled={!approved || !counts.ready}>Add to Collection</button>
          </div>
        </>
      ) : null}
      {step === 'scan' && !approved ? <div className="cs-actions"><button type="button" onClick={async () => { await cancelJob(job.id, 'Not authorised').catch(() => {}); onDone() }}>Cancel</button></div> : null}
      {importing ? <ImportDialog jobId={job.id} collectorName={collector.name} busy={busy} error={error} onCancel={() => setImporting(false)} onConfirm={add} /> : null}
    </div>
  )
}
