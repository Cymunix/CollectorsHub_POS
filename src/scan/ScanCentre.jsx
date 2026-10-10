import React, { useState } from 'react'
import StoreScanIntake from '../StoreScanIntake'
import ExpressScan from './ExpressScan'
import DropOff from './DropOff'

// Scan Centre: Store Inventory (the existing stock intake, unchanged) and
// Collector Collection (Express Scan and Collection Drop-Off), all on the
// same scanner, local AI and catalogue matching.

const TAB_KEY = 'scan-centre-tab'
const readTab = (fallback) => { try { return window.localStorage.getItem(TAB_KEY) || fallback } catch { return fallback } }
const writeTab = (value) => { try { window.localStorage.setItem(TAB_KEY, value) } catch {} }

export default function ScanCentre({ session, storeQueue, onSaveStoreQueue, onStockChanged, collectorQueues, onSaveCollectorQueue, collectorScanning = false }) {
  const [savedTab, setTab] = useState(() => readTab('store'))
  // Collector Collection only when the organization turned it on for this store.
  const tab = collectorScanning ? savedTab : 'store'
  const choose = (value) => { setTab(value); writeTab(value) }
  return (
    <section className="scan-centre">
      <header className="scan-centre-head">
        <h1>Scan Centre</h1>
        {collectorScanning ? (
          <div className="cs-tabs">
            <button type="button" className={tab === 'store' ? 'active' : ''} onClick={() => choose('store')}>Store Inventory</button>
            <button type="button" className={tab !== 'store' ? 'active' : ''} onClick={() => choose(tab === 'store' ? 'express' : tab)}>Collector Collection</button>
          </div>
        ) : null}
        {tab !== 'store' ? (
          <div className="cs-subnav" aria-label="Collector Collection">
            <span className="cs-subnav-label">Collector Collection</span>
            <div className="cs-tabs small">
              <button type="button" className={tab === 'express' ? 'active' : ''} onClick={() => choose('express')}>Express Scan</button>
              <button type="button" className={tab === 'dropoff' ? 'active' : ''} onClick={() => choose('dropoff')}>Collection Drop-Off</button>
            </div>
          </div>
        ) : null}
      </header>
      {tab === 'store' ? <StoreScanIntake session={session} savedQueue={storeQueue} onSaveQueue={onSaveStoreQueue} onStockChanged={onStockChanged} /> : null}
      {tab === 'express' ? <ExpressScan session={session} queues={collectorQueues} onSaveQueue={onSaveCollectorQueue} /> : null}
      {tab === 'dropoff' ? <DropOff session={session} queues={collectorQueues} onSaveQueue={onSaveCollectorQueue} /> : null}
    </section>
  )
}
