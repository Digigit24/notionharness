import type { BlockModel, Doc } from '@/lib/blocksuite-store'
import type { EditorHost } from '@/lib/blocksuite-block-std'

/**
 * ROADMAP 6.2 — what the toolbar trigger hands off once a user picks "Ask
 * agent" on a real selection. `selectedBlockModels` comes straight from
 * BlockSuite's own format-bar context (`FormatBarContext.selectedBlockModels`),
 * so it's already correct for both a text-range-within-one-block selection
 * and a genuine multi-block selection — no separate selection-reading logic
 * needed on the consuming side.
 */
export interface AskAgentSelection {
  selectedBlockModels: BlockModel[]
  doc: Doc
  host: EditorHost
}

export type AskAgentHandler = (selection: AskAgentSelection) => void | Promise<void>

/**
 * ROADMAP B3.5 — `/ask` opens the docked *page*-agent panel (the parallel
 * `b3-docked-agent` workstream), which is a different surface from
 * `AskAgentSelection` above: that one always carries a real, non-empty
 * `selectedBlockModels` (a floating popover anchored to a selection); this
 * one fires from the slash menu at a cursor position with no selection at
 * all — "whole page" context, not "this selection" context. `anchorElement`
 * is the block the slash command was typed into, so the panel/handler can
 * anchor itself sensibly if it wants to (it's free to ignore it and dock to
 * the page edge instead).
 */
export interface AskAgentPageContext {
  doc: Doc
  host: EditorHost
  pageId: number | null
  anchorElement: HTMLElement
}

export type AskAgentPageHandler = (context: AskAgentPageContext) => void | Promise<void>
