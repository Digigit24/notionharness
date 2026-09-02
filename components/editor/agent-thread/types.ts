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
