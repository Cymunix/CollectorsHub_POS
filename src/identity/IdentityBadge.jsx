import { Clock3, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'
import { IDENTITY_STATUS } from './nordvikIdentity'

// A customer's NORDVIK Identity status: green shield "Identity Verified",
// amber for unverified / pending / expired, red for failed / revoked.
export default function IdentityBadge({ status = 'unverified', onClick }) {
  const info = IDENTITY_STATUS[status] || IDENTITY_STATUS.unverified
  const Icon = status === 'verified' || status === 'demo_verified' ? ShieldCheck : ['pending', 'processing', 'manual_review'].includes(status) ? Clock3 : info.tone === 'red' ? ShieldX : ShieldAlert
  const content = <><Icon size={14} /> {info.label}</>
  return onClick
    ? <button type="button" className={`nid-badge ${info.tone}`} onClick={onClick} title="Verification details">{content}</button>
    : <span className={`nid-badge ${info.tone}`}>{content}</span>
}
