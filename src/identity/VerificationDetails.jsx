import { ShieldCheck, X } from 'lucide-react'
import IdentityBadge from './IdentityBadge'
import { IDENTITY_STATUS } from './nordvikIdentity'

// Verification details for staff: status, when, and whether re-verification
// is needed. No ID details, images or history beyond that.
const when = (value) => (value ? new Date(value).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }) : '—')

export default function VerificationDetails({ customer, identity, onVerify, onClose }) {
  const status = identity?.status || 'unverified'
  const needsVerification = status !== 'verified' && !['pending', 'processing', 'manual_review'].includes(status)
  return (
    <div className="register-modal nid-modal nid-details-modal" role="dialog" aria-modal="true" aria-labelledby="nid-details-title">
      <section>
        <button className="modal-close" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <div className="nid-head">
          <ShieldCheck size={22} />
          <div><h2 id="nid-details-title">Identity verification</h2><p>{customer?.fullName || customer?.name}{customer?.username ? ` · @${customer.username}` : ''}</p></div>
        </div>
        <dl className="nid-facts">
          <dt>Status</dt><dd><IdentityBadge status={identity?.demo && status === 'verified' ? 'demo_verified' : status} /></dd>
          {identity?.demo ? <><dt>Demo</dt><dd>Development / testing record, shown only at test stores. Not a government identity check.</dd></> : null}
          <dt>Verified on</dt><dd>{status === 'verified' || status === 'expired' ? when(identity?.verifiedAt) : '—'}</dd>
          <dt>Re-verification</dt>
          <dd>
            {status === 'revoked' ? 'Required: the verification was withdrawn.'
              : status === 'expired' ? 'Required: the ID used has expired.'
                : status === 'verified' && identity?.expiresAt ? `Needed after ${when(identity.expiresAt)} (when the ID used expires)`
                  : status === 'verified' ? 'Not currently required' : '—'}
          </dd>
          <dt>Selling to the store</dt><dd>{identity?.buybackAllowed ? 'Allowed' : 'Not allowed until verified'}</dd>
          {identity?.openSession ? <><dt>In progress</dt><dd>{IDENTITY_STATUS[identity.openSession.status]?.label || identity.openSession.status.replace('_', ' ')}</dd></> : null}
        </dl>
        <p className="nid-muted nid-small">Verified by NORDVIK Identity. Identification details and images are never shown to stores.</p>
        <div className="nid-actions">
          {needsVerification && onVerify ? <button type="button" className="gold-button" onClick={onVerify}>Verify Customer</button> : null}
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  )
}
