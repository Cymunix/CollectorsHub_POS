import React, { useEffect, useState } from 'react'
import { AlertTriangle, BarChart3, Check, X } from 'lucide-react'
import { REPORT_PERMISSIONS, reportStaff, setReportAccess } from '../lib/reports'

// Org portal → Stores → Reports: which reports each employee may see. Managers start
// with everything, assistant managers and supervisors with the operational reports,
// other staff with their own sales figures only. The server enforces it.
export default function ReportAccess({ store, onClose }) {
  const [rows, setRows] = useState(null)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  async function load() { try { setRows(await reportStaff(store.storeId)); setProblem('') } catch (error) { setProblem(error.message); setRows([]) } }
  useEffect(() => { load() }, [store.storeId])
  async function toggle(employee, key, value) {
    setProblem(''); setNotice('')
    try { await setReportAccess(store.storeId, employee.id, { ...employee.permissions, [key]: value }); setNotice(`Report access saved for ${employee.name}.`); load() } catch (error) { setProblem(error.message) }
  }
  return (
    <div className="register-modal cu-modal wide rp-access" role="dialog" aria-modal="true" aria-labelledby="rp-access-title">
      <section>
        <button className="modal-close" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <h2 id="rp-access-title"><BarChart3 size={20} /> Report access · {store.storeName}</h2>
        <p className="cs-muted">Managers start with every report; assistant managers and supervisors with store sales, employees, inventory and registers; other staff only with their own sales figures. Tick or untick to change anyone.</p>
        {notice ? <p className="cu-notice"><Check size={15} /> {notice}</p> : null}
        {problem ? <p className="cs-error"><AlertTriangle size={14} /> {problem}</p> : null}
        {rows === null ? <p className="cs-muted">Loading…</p> : !rows.length ? <p className="cs-muted">No staff at this store yet.</p> : (
          <div className="tx-table-wrap">
            <table className="cs-table tx-items pw-perms">
              <thead><tr><th>Employee</th>{REPORT_PERMISSIONS.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead>
              <tbody>{rows.map((employee) => (
                <tr key={employee.id}><td><strong>{employee.name}</strong><small className="tx-sku">{employee.role}</small></td>
                  {REPORT_PERMISSIONS.map(([key]) => <td key={key}><input type="checkbox" checked={Boolean(employee.permissions?.[key])} title={employee.defaults?.[key] ? 'On by default for this role' : ''} onChange={(event) => toggle(employee, key, event.target.checked)} /></td>)}</tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
