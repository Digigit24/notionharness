'use client'

import { createElement, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { Thread } from '@/components/hermes'
import { useRunEventStream, type RunEventSnapshot } from '@/components/runs/use-run-event-stream'
import { adaptRunEventsToThread } from '@/lib/hermes/runEvent-adapter'
import type { RunEventEnvelope } from '@/lib/run-events'
import { getRunSnapshot, enqueuePageRun } from '@/app/(app)/actions'
import { createPopup, popupTargetFromElement } from '@/lib/blocksuite-affine-components'
import { registerAskAgentHandler } from './registry'
import type { AskAgentSelection, AskAgentHandler } from './types'
import type { BlockModel, Doc } from '@/lib/blocksuite-store'

/**
 * ROADMAP 6.2 — block-anchored thread: "Ask agent" on a selection creates a
 * run scoped to the page, drops a run-card block right after the selection
 * referencing it, and opens a popover (anchored to that run-card) showing
 * its live output via the same `<Thread>` component P5.1/5.2 already built
 * for the Sessions drawer — a new chrome around existing UI, not a rebuild.
 */

/**
 * Flattens selected blocks into a plain-text prompt. Handles both a
 * text-range selection inside one block and a genuine multi-block
 * selection identically, since `BlockModel.text` is present on both.
 */
function serializeSelectedBlocks(blocks: BlockModel[]): string {
  return blocks
    .map((block) => {
      const text = block.text?.toString().trim()
      return text ? text : `[${block.flavour}]`
    })
    .filter(Boolean)
    .join('\n\n')
}

/** Client-side docs are created as `page-${pageId}` (see BlockSuiteEditor.tsx
 * and lib/blocksuite-doc.ts's `loadDoc`) — parsing this back out avoids
 * needing a second way to thread the page id through the selection context. */
function pageIdFromDoc(doc: Doc): number | null {
  const match = /^page-(\d+)$/.exec(doc.id)
  return match ? Number(match[1]) : null
}

const handleAskAgent: AskAgentHandler = async (selection: AskAgentSelection) => {
  const { selectedBlockModels, doc, host } = selection
  if (selectedBlockModels.length === 0) return

  const pageId = pageIdFromDoc(doc)
  if (pageId === null) {
    console.error('[ask-agent] Could not resolve a page id from the doc — aborting.')
    return
  }

  const prompt = serializeSelectedBlocks(selectedBlockModels)
  if (!prompt) return

  let runId: number
  try {
    ;({ runId } = await enqueuePageRun(prompt, pageId))
  } catch (err) {
    console.error('[ask-agent] Failed to enqueue a run for this selection.', err)
    return
  }

  const lastBlock = selectedBlockModels[selectedBlockModels.length - 1]
  const parent = lastBlock.parent
  if (!parent) {
    console.error('[ask-agent] Selected block has no parent — cannot place a run-card next to it.')
    return
  }
  const insertAt = parent.children.indexOf(lastBlock) + 1
  const runCardBlockId = doc.addBlock('affine:embed-run-card', { runId }, parent.id, insertAt)

  // Lit's block-view registration reacts to the Yjs change asynchronously —
  // `getBlock` can miss the block that was just added in the same tick.
  const resolveCardElement = async (): Promise<HTMLElement | null> => {
    const immediate = host.view.getBlock(runCardBlockId)
    if (immediate) return immediate
    await host.updateComplete
    return host.view.getBlock(runCardBlockId)
  }

  const cardElement = await resolveCardElement()
  if (!cardElement) {
    console.error('[ask-agent] Run-card block never mounted — cannot anchor the thread popover.')
    return
  }

  openThreadPopover(cardElement, runId)
}

registerAskAgentHandler(handleAskAgent)

function BlockAnchoredThreadPanel({ runId, onClose }: { runId: number; onClose: () => void }) {
  const snapshots = useRunEventStream(runId, true, async (id): Promise<RunEventSnapshot[]> => {
    const snapshot = await getRunSnapshot(id)
    return snapshot ? [snapshot] : []
  })

  const thread = useMemo(() => {
    const snapshot = snapshots[0]
    const envelopes: RunEventEnvelope[] = (snapshot?.events ?? []).map((row) => ({
      runId: String(runId),
      seq: row.seq,
      event: row.event,
    }))
    return adaptRunEventsToThread(envelopes)
  }, [snapshots, runId])

  return (
    <div className="flex h-[480px] w-[380px] flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Run #{runId}</span>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-900 dark:hover:text-gray-100"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        <Thread thread={thread} showUsage={false} showRunId={false} />
      </div>
    </div>
  )
}

function openThreadPopover(anchor: HTMLElement, runId: number) {
  const container = document.createElement('div')
  const root = createRoot(container)
  const target = popupTargetFromElement(anchor)
  let close: () => void = () => {}
  root.render(createElement(BlockAnchoredThreadPanel, { runId, onClose: () => close() }))
  close = createPopup(target, container, {
    onClose: () => root.unmount(),
  })
}
