import React, { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink } from 'lucide-react'
import { GRADERS, certLookupUrl, fetchCertMatches, normalizeCert, normalizeGrader } from './lib/certs'

// Grading company, grade and cert number for a slab being bought, with the
// checks staff make before paying: the grader's own cert page, and whether the
// cert is already on record somewhere else (in stock or a collector's collection).
export default function SlabCertFields({ storeId, gradingCompany, grade, cert, onChange }) {
  const grader = normalizeGrader(gradingCompany)
  const lookupUrl = certLookupUrl(grader, cert)
  const check = useCertMatches(storeId, cert)
  return (
    <div className="slab-cert">
      <div className="slab-cert-fields">
        <select value={GRADERS.includes(grader) ? grader : grader ? 'other' : ''} onChange={(event) => onChange({ gradingCompany: event.target.value === 'other' ? gradingCompany : event.target.value })} aria-label="Grading company">
          <option value="">Grader</option>
          {GRADERS.map((name) => <option key={name} value={name}>{name}</option>)}
          {grader && !GRADERS.includes(grader) ? <option value="other">{gradingCompany}</option> : null}
        </select>
        <input value={grade || ''} onChange={(event) => onChange({ grade: event.target.value })} placeholder="Grade" aria-label="Grade" />
        <input value={cert || ''} onChange={(event) => onChange({ certificationNumber: event.target.value })} placeholder="Cert #" aria-label="Cert number" />
        {lookupUrl ? <a className="slab-cert-lookup" href={lookupUrl} target="_blank" rel="noreferrer" title={`Open this cert on ${grader}'s website`}>Check on {grader} <ExternalLink size={12} /></a> : null}
      </div>
      <CertMatches check={check} grader={grader} grade={grade} />
    </div>
  )
}

function useCertMatches(storeId, cert) {
  const value = normalizeCert(cert)
  const [check, setCheck] = useState({ state: 'idle' })
  useEffect(() => {
    if (!storeId || value.length < 4) { setCheck({ state: 'idle' }); return undefined }
    let cancelled = false
    setCheck({ state: 'checking' })
    const timer = window.setTimeout(() => {
      fetchCertMatches(storeId, value)
        .then((result) => { if (!cancelled) setCheck({ state: 'done', matches: result.matches || [] }) })
        .catch((error) => { if (!cancelled) setCheck({ state: 'error', message: error.message }) })
    }, 450)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [storeId, value])
  return check
}

function matchLabel(match) {
  if (match.source === 'this_store') return Number(match.on_hand) > 0 ? 'Already in your stock' : 'Your store had this slab before (none in stock now)'
  if (match.source === 'other_store') return 'In another store’s stock'
  return match.from_store ? 'In a collector’s collection (bought from a store)' : 'In a collector’s collection (could be the seller’s own)'
}

function CertMatches({ check, grader, grade }) {
  if (check.state === 'idle') return null
  if (check.state === 'checking') return <small className="slab-cert-note">Checking where this cert is on record…</small>
  if (check.state === 'error') return <small className="slab-cert-note">The cert record check isn’t available: {check.message}</small>
  if (!check.matches.length) return <small className="slab-cert-note ok"><CheckCircle2 size={13} /> No other record of this cert.</small>
  const serious = check.matches.some((match) => match.source === 'other_store' || (match.source === 'this_store' && Number(match.on_hand) > 0))
  return (
    <div className={`slab-cert-matches ${serious ? 'serious' : ''}`}>
      <strong><AlertTriangle size={14} /> This cert is already on record</strong>
      <ul>
        {check.matches.map((match, index) => {
          const recorded = [normalizeGrader(match.grading_company), match.grade].filter(Boolean).join(' ')
          const differs = (match.grading_company && grader && normalizeGrader(match.grading_company) !== grader)
            || (match.grade && grade && String(match.grade).trim() !== String(grade).trim())
          return (
            <li key={index}>
              <span>{matchLabel(match)}</span>
              <small>{[match.name, recorded, match.sku ? `SKU ${match.sku}` : ''].filter(Boolean).join(' · ')}</small>
              {differs ? <em>Recorded with a different grader or grade.</em> : null}
            </li>
          )
        })}
      </ul>
      <small>Check the slab and the grader’s record before buying.</small>
    </div>
  )
}
