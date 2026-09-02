'use client'

import { registerAskAgentHandler, getPagePanelOpener } from './registry'
import type { AskAgentSelection, AskAgentHandler } from './types'
import type { BlockModel, Doc } from '@/lib/blocksuite-store'

/**
 * ROADMAP B-3 "Surface" — this used to be the whole "Ask agent" flow: create
 * a page-scoped run straight from the selection, drop a run-card block after
 * it, and pop open a floating thread anchored to that card. The plan calls
 * that "the right idea buried at the wrong depth" and replaces it with a
 * single docked panel per page (`page-docked-panel.tsx`) that a conversation
 * about the page lives in permanently. Per the plan's own wording:
 * "Selection-scoped asks still work — they just become a shortcut into the
 * same panel with the selection pre-attached as context."
 *
 * So this file's job shrank to exactly that: turn a selection into a plain-
 * text excerpt and hand it to whichever `PageDockedPanel` is currently
 * mounted (via `registerPagePanelOpener`/`getPagePanelOpener` in
 * `registry.ts` — the same "cross the BlockSuite/Lit boundary" shape this
 * file already used for `registerAskAgentHandler` itself). No run is
 * enqueued here anymore, no run-card block is inserted, and there is no
 * separate popover implementation left to maintain — sending the message is
 * now entirely the docked panel's composer's job, same as it is for a
 * whole-page ask with no selection at all.
 */

/**
 * Flattens selected blocks into a plain-text excerpt. Handles both a
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
 * needing a second way to thread the page id through the selection context.
 * Kept even though the handler below no longer needs a page id itself
 * (`getPagePanelOpener` routes to whichever page is mounted) — still used to
 * fail fast with a clear error if a selection somehow comes from a doc that
 * isn't a real page doc. */
function pageIdFromDoc(doc: Doc): number | null {
  const match = /^page-(\d+)$/.exec(doc.id)
  return match ? Number(match[1]) : null
}

const handleAskAgent: AskAgentHandler = (selection: AskAgentSelection) => {
  const { selectedBlockModels, doc } = selection
  if (selectedBlockModels.length === 0) return

  if (pageIdFromDoc(doc) === null) {
    console.error('[ask-agent] Could not resolve a page id from the doc — aborting.')
    return
  }

  const excerpt = serializeSelectedBlocks(selectedBlockModels)
  if (!excerpt) return

  const opener = getPagePanelOpener()
  if (!opener) {
    console.warn('[ask-agent] No docked panel is mounted for this page — cannot open it with the selection.')
    return
  }
  opener(excerpt)
}

registerAskAgentHandler(handleAskAgent)
