import React, { useState } from 'react'
import StoreScanIntake from '../StoreScanIntake'
import ExpressScan from './ExpressScan'
import DropOff from './DropOff'
import OnboardingScan from '../onboarding/OnboardingScan'

// Scan Centre: Store Inventory (the existing stock intake, unchanged),
// Collector Collection (Express Scan and Collection Drop-Off) and, while the
// store is being onboarded, Onboarding (cards captured for verification), all
// on the same scanner, local AI and catalogue matching.

const TAB_KEY = 'scan-centre-tab'
const readTab = (fallback) => { try { return window.localStorage.getItem(TAB_KEY) || fallback } catch { return fallback } }
const writeTab = (value) => { try { window.localStorage.setItem(TAB_KEY, value) } catch {} }

export default function ScanCentre({ session, storeQueue, onSaveStoreQueue, onStockChanged, collectorQueues, onSaveCollectorQueue, collectorScanning = false, onboardingProjects = [] }) {
  const [savedTab, setTab] = useState(() => readTab('store'))
  const onboarding = onboardingProjects.length > 0
  // Collector Collection only when the organization turned it on for this
  // store; Onboarding only while the store has an open onboarding project.
  const tab = savedTab === 'onboarding' ? (onboarding ? 'onboarding' : 'store') : collectorScanning ? savedTab : 'store'
  const collectorTab = tab !== 'store' && tab !== 'onboarding'
  const choose = (value) => { setTab(value); writeTab(value) }
  return (
    <section className="scan-centre">
      <header className="scan-centre-head">
        <h1>Scan Centre</h1>
        {collectorScanning || onboarding ? (
          <div className="cs-tabs">
            <button type="button" className={tab === 'store' ? 'active' : ''} onClick={() => choose('store')}>Store Inventory</button>
            {collectorScanning ? <button type="button" className={collectorTab ? 'active' : ''} onClick={() => choose(collectorTab ? tab : 'express')}>Collector Collection</button> : null}
            {onboarding ? <button type="button" className={tab === 'onboarding' ? 'active' : ''} onClick={() => choose('onboarding')}>Onboarding</button> : null}
          </div>
        ) : null}
        {collectorTab ? (
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
      {tab === 'onboarding' ? <OnboardingScan session={session} projects={onboardingProjects} queues={collectorQueues} onSaveQueue={onSaveCollectorQueue} /> : null}
    </section>
  )
}
