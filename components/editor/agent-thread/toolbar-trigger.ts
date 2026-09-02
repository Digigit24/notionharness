import { ConfigExtension, type ExtensionType, type EditorHost } from '@/lib/blocksuite-block-std'
import type { AdvancedMenuItem, MenuItemGroup } from '@/lib/blocksuite-blocks'
import type { BlockModel, Doc } from '@/lib/blocksuite-store'
import { getAskAgentHandler } from './registry'

/**
 * The subset of BlockSuite's internal `MenuContext` (format-bar/toolbar
 * "more menu" context — `@blocksuite/blocks/root-block/configs/toolbar`,
 * not part of the package's public export map so it can't be imported by
 * name) this trigger actually needs. Structural typing makes this safe:
 * every real context BlockSuite passes in (`FormatBarContext`, etc.)
 * satisfies this shape, since they all extend the same base class.
 */
interface ToolbarMenuContext {
  selectedBlockModels: BlockModel[]
  doc: Doc
  host: EditorHost
  isEmpty(): boolean
}

/**
 * ROADMAP 6.2 — "Ask agent" lives in the same floating selection toolbar's
 * "more" menu that already has bold/italic/etc., gated on there being an
 * actual selection (`!context.isEmpty()`). This is the multi-block-selection
 * toolbar, not a per-block hover toolbar — the latter never has more than
 * one block's context, which is the wrong fit for "block-anchored" threads
 * that may span a range.
 */
function buildAskAgentGroup<T extends ToolbarMenuContext>(): MenuItemGroup<T> {
  const item: AdvancedMenuItem<T> = {
    type: 'ask-agent',
    label: 'Ask agent',
    action: (context) => {
      const handler = getAskAgentHandler()
      if (!handler) {
        console.warn('[ask-agent] No handler registered — the P6.2 popover/run-creation module has not mounted.')
        return
      }
      void handler({ selectedBlockModels: context.selectedBlockModels, doc: context.doc, host: context.host })
    },
  }
  return {
    type: 'ask-agent',
    when: (context) => !context.isEmpty(),
    items: [item],
  }
}

export const AskAgentToolbarSpec: ExtensionType[] = [
  ConfigExtension('affine:page', {
    toolbarMoreMenu: {
      configure: <T extends ToolbarMenuContext>(groups: MenuItemGroup<T>[]): MenuItemGroup<T>[] => [
        ...groups,
        buildAskAgentGroup<T>(),
      ],
    },
  }),
]
