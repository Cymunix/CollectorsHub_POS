import React, { useState } from 'react'
import StoreScanIntake from '../StoreScanIntake'
import { GRADED } from '../lib/cardCondition'
import { addItems, createBatch, priceText } from '../lib/onboarding'

// Scan Centre -> Onboarding: the store scan intake (same scanner, local AI and
// catalogue matching, cards only), but cards are captured into the onboarding
// project's queue for verification instead of going into stock. A day's
// scanning on a register is one batch.

const batchKey = (projectId) => `onboarding-scan-batch:${projectId}:${new Date().toISOString().slice(0, 10)}`
const readBatch = (projectId) => { try { return window.localStorage.getItem(batchKey(projectId)) || '' } catch { return '' } }
const writeBatch = (projectId, id) => { try { window.localStorage.setItem(batchKey(projectId), id) } catch {} }

export default function OnboardingScan({ session, projects, queues = {}, onSaveQueue }) {
  const [projectId, setProjectId] = useState(() => projects[0]?.id || '')
  const project = projects.find((row) => row.id === projectId) || projects[0]
  if (!project) return <p className="store-scan-error">There's no open onboarding project for this store.</p>
  const queueKey = `onboarding:${project.id}`

  async function ensureBatch() {
    const saved = readBatch(project.id)
    if (saved) return saved
    const id = await createBatch({ projectId: project.id, source: 'scan', label: `Scanning ${new Date().toLocaleDateString()}`, items: [] })
    writeBatch(project.id, id)
    return id
  }

  async function add(card) {
    const result = card.result || {}
    const graded = card.condition === GRADED
    const item = {
      source_ref: card.id,
      // What the AI read, kept with the item for verification.
      source_row: { ai_subject: result.subject || '', ai_number: result.id_number || '', ai_year: result.release_year || '', ai_set: result.property || result.subfranchise || '', ai_parallel: result.parallel || '' },
      catalog_item_id: card.item?.item_id || '',
      name: card.item?.name || card.item?.subject || result.subject || 'Unidentified card',
      item_number: card.item?.card_number || result.id_number || '',
      category_name: card.category,
      condition: card.condition,
      grading_company: graded ? card.gradingCompany || '' : '',
      grade: graded ? card.grade || '' : '',
      cert_number: graded ? card.certificationNumber || '' : '',
      quantity: Math.max(1, parseInt(card.quantity, 10) || 1),
      in_store_price: priceText(card.sellPrice),
      cost: priceText(card.buyPrice),
    }
    let batchId = await ensureBatch()
    try {
      await addItems(batchId, [item], true)
    } catch (error) {
      // Yesterday's or a removed batch: start a new one and try once more.
      if (!/batch not found/i.test(error.message)) throw error
      writeBatch(project.id, '')
      batchId = await ensureBatch()
      await addItems(batchId, [item], true)
    }
  }

  return (
    <StoreScanIntake
      key={project.id}
      session={session}
      savedQueue={queues[queueKey] || []}
      onSaveQueue={(queue) => onSaveQueue(queueKey, queue)}
      destination={{
        stock: true,
        kicker: `Onboarding · ${session?.storeName || 'Store'}`,
        title: 'Scan Cards into Onboarding',
        description: "Cards are identified by the local AI and matched to the catalogue, then captured for verification. Nothing goes on sale until it's verified, priced and approved. Enter the retailer's own price; leave it blank to flag it.",
        addedLabel: 'Captured',
        toLabel: 'to onboarding',
        controls: projects.length > 1 ? (
          <label>Project
            <select value={project.id} onChange={(event) => setProjectId(event.target.value)}>
              {projects.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </label>
        ) : null,
        add,
      }}
    />
  )
}
