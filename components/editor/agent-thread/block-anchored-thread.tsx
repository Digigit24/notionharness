'use client'

import { useState, useEffect } from 'react'
import { Thread } from '@/components/hermes'
import { adaptRunEventsToThread } from '@/lib/hermes/runEvent-adapter'
import { sendTurnWithIdentity } from '@/lib/hermes/run-with-identity'
import { createRunSubtree, appendBlockToSubtree } from '@/lib/agent-page-writes'
import { getPayloadClient } from '@/lib/payload'
import { registerAskAgentHandler } from './registry'
import type { AskAgentSelection, AskAgentHandler } from './types'
import type { ChatThread } from '@/lib/hermes/runEvent-adapter'
import type { BlockModel, Doc } from '@/lib/blocksuite-store'

/**
 * ROADMAP 6.2 — Block-anchored thread handler + popover chrome.
 *
 * Converts selected blocks → run input → thread popover anchored to run-card.
 * Wired into the toolbar via registerAskAgentHandler().
 */

/**
 * Serialize selected blocks into a prompt string.
 * Handles both text-range selections (partial block) and multi-block selections.
 */
function serializeSelectedBlocks(blocks: BlockModel[]): string {
  return blocks
    .map((block) => {
      const text = block.text?.toString() ?? ''
      const flavour = block.flavour ?? 'unknown'
      return text ? `[${flavour}] ${text}` : `[${flavour}] (empty)`
    })
    .join('\n\n')
}

/**
 * Create a run with page-scoped blocks as input.
 * Returns the run ID and creates a run-card block in the doc.
 */
async function createBlockAnchoredRun(
  doc: Doc,
  selectedBlocks: BlockModel[],
  pageId: number,
  workspaceId: number,
): Promise<{ runId: number; runCardBlockId: string }> {
  const payload = await getPayloadClient()

  // Serialize blocks into prompt
  const prompt = serializeSelectedBlocks(selectedBlocks)

  // Create page-scoped run (taskId optional for block-anchored)
  // Note: getCurrentPayloadUser() and getCurrentUser() needed for accountableUser
  // TODO: get current user from context or auth
  const userId = 1 // Placeholder — needs real user context

  // Placeholder for enqueueRun call — this part depends on broker API
  // For now, assume we can call sendTurnWithIdentity directly
  // In real impl, we'd call enqueueRun first to get the run ID

  // Insert run-card block after last selected block
  const lastBlock = selectedBlocks[selectedBlocks.length - 1]
  const parentId = (lastBlock.parentId ?? doc.root?.id) as string | undefined
  if (!parentId) {
    throw new Error('Cannot determine parent block for run-card')
  }

  // For now, just return placeholder
  // Real implementation will create the run first, then insert run-card
  return { runId: 0, runCardBlockId: '' }
}

/**
 * The handler function called by the toolbar when user clicks "Ask agent".
 */
const handleAskAgent: AskAgentHandler = async (selection: AskAgentSelection) => {
  try {
    // TODO: implement run creation and popover display
    console.log('Ask agent handler called with selection:', selection)

    // Placeholder implementation
    const serialized = serializeSelectedBlocks(selection.selectedBlockModels)
    console.log('Serialized blocks:', serialized)
  } catch (err) {
    console.error('Failed to create block-anchored thread:', err)
  }
}

/**
 * Register the handler at module load.
 * This runs when this module is imported, connecting the toolbar trigger to our implementation.
 */
registerAskAgentHandler(handleAskAgent)

/**
 * ThreadPopover component — renders a Thread inside a popover anchored to a run-card.
 * Not yet integrated; placeholder for future popover attachment logic.
 */
export interface ThreadPopoverProps {
  thread: ChatThread
  isOpen: boolean
  onClose: () => void
  // Anchor element (run-card block) position would come from editor context
}

export function ThreadPopover({ thread, isOpen, onClose }: ThreadPopoverProps) {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
      <div className="w-[600px] h-[600px] bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 flex flex-col">
        <div className="border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex justify-between items-center">
          <h2 className="font-semibold">Agent Thread</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-900 dark:hover:text-gray-100"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          <Thread thread={thread} showUsage={false} showRunId={false} />
        </div>
      </div>
    </div>
  )
}
