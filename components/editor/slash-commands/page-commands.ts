// Same DOM-query mechanism as `native-database/slash-menu.ts` and
// `task/slash-menu.ts` (see either file's comment for why: no clean
// extension point for the slash menu in this BlockSuite version).
//
// ROADMAP B3.5 — "`/ask`, `/task`, `/run`, `/summarise`, `/table`, `/agent`.
// The slash menu is where a Notion user already looks for capability, so
// agentic actions belong there rather than in a separate toolbar." `/task`
// lives in `task/slash-menu.ts` (it owns a block flavour); `/table` is a
// second item on `native-database/slash-menu.ts` (it reuses that block's
// own flavour). This file owns the four that don't belong to any single
// block: `/ask`, `/run`, `/summarise` (all page-scoped agent actions) and
// `/agent` (a mention shortcut).

import { enqueuePageRun } from '@/app/(app)/actions'
import { insertContent, getInlineEditorByModel } from '@/lib/blocksuite-affine-components'
import type { EditorHost } from '@/lib/blocksuite-block-std'
import type { BlockModel, Doc } from '@/lib/blocksuite-store'
import { pageIdFromDoc } from '../agent-thread/page-context'
import { resolveAgent } from '../agent-thread/resolve-agent'
import { getPagePanelOpener } from '../agent-thread/registry'

interface SlashMenuActionContext {
  rootComponent: {
    host: EditorHost
    doc: Doc
    /** The root `affine:page` block's own model — same thing BlockSuite's
     * own stock "Linked Doc" slash item reads `rootComponent.model.id`
     * from, to look up the `affine-linked-doc-widget` instance mounted on
     * the page root. */
    model: { id: string }
    std: {
      view: {
        getWidget: (widgetName: string, hostBlockId: string) => { show?: () => void } | null
      }
    }
  }
  model: BlockModel
}

interface SlashMenuActionItem {
  name: string
  description?: string
  alias?: string[]
  action: (ctx: SlashMenuActionContext) => void | Promise<void>
}

interface SlashMenuWidgetLike extends HTMLElement {
  config: { items: unknown[] }
}

function insertRunCardAfter(doc: Doc, model: BlockModel, runId: number) {
  const parent = model.parent
  if (!parent) return
  const index = parent.children.indexOf(model) + 1
  doc.addBlock('affine:embed-run-card', { runId }, parent.id, index)
}

/**
 * Shared by `/run` and `/summarise`: resolves an agent, enqueues a real
 * page-scoped run via `enqueuePageRun` (the same primitive `agent-thread/
 * block-anchored-thread.tsx`'s "Ask agent" popover uses), and drops a
 * run-card block referencing it right after the current block — visible,
 * real feedback, not a fire-and-forget toast.
 */
async function startPageRun(ctx: SlashMenuActionContext, prompt: string) {
  const { rootComponent, model } = ctx
  const { host, doc } = rootComponent
  const pageId = pageIdFromDoc(doc)
  if (pageId === null) {
    console.error('[page-commands] Could not resolve a page id from the doc — aborting.')
    return
  }
  const anchorElement = host.view.getBlock(model.id) ?? host
  const agent = await resolveAgent(host, anchorElement)
  if (!agent) return

  let runId: number
  try {
    ;({ runId } = await enqueuePageRun(prompt, pageId, agent.id))
  } catch (err) {
    console.error('[page-commands] Failed to enqueue a page run.', err)
    return
  }
  insertRunCardAfter(doc, model, runId)
}

function alreadyPresent(widget: SlashMenuWidgetLike, name: string): boolean {
  return widget.config.items.some((item) => typeof item === 'object' && item !== null && (item as { name?: unknown }).name === name)
}

function pushItems(widget: SlashMenuWidgetLike) {
  if (!alreadyPresent(widget, 'Ask agent')) {
    widget.config.items.push({
      name: 'Ask agent',
      description: 'Open the agent panel for this page',
      action: (ctx) => {
        const { rootComponent } = ctx
        const { doc } = rootComponent
        // The docked page-agent panel (`page-docked-panel.tsx`) registers
        // itself here on mount via the same excerpt-opener seam the
        // selection-anchored "Ask agent" toolbar item already uses
        // (`block-anchored-thread.tsx`) — one panel, one opener, reachable
        // from both a selection and a bare cursor position. A slash-typed
        // `/ask` has no selection to excerpt, so it opens with no
        // pre-attached context; the panel's composer already defaults to
        // whole-page context when nothing is attached.
        if (pageIdFromDoc(doc) === null) {
          console.error('[ask-agent-page] Could not resolve a page id from the doc — aborting.')
          return
        }
        const opener = getPagePanelOpener()
        if (!opener) {
          console.warn('[ask-agent-page] No docked panel is mounted for this page — cannot open it.')
          return
        }
        opener('')
      },
    } satisfies SlashMenuActionItem)
  }

  if (!alreadyPresent(widget, 'Run agent')) {
    widget.config.items.push({
      name: 'Run agent',
      description: 'Start an agent run on this page',
      alias: ['run'],
      action: (ctx) => startPageRun(ctx, 'Continue working on this page based on its current content.'),
    } satisfies SlashMenuActionItem)
  }

  if (!alreadyPresent(widget, 'Summarise page')) {
    widget.config.items.push({
      name: 'Summarise page',
      description: 'Start an agent run that summarises this page',
      alias: ['summarize', 'summarise', 'summary'],
      action: (ctx) => startPageRun(ctx, 'Summarise this page.'),
    } satisfies SlashMenuActionItem)
  }

  if (!alreadyPresent(widget, 'Mention agent')) {
    widget.config.items.push({
      name: 'Mention agent',
      description: 'Mention a person or agent — reuses the @ menu',
      alias: ['agent'],
      // Exactly BlockSuite's own "Linked Doc" slash item's trick (see
      // `@blocksuite/blocks`'s `slash-menu/config.js`): insert the `@`
      // trigger character at the cursor, then open the widget it triggers.
      // `mentions/spec.ts`'s `mentionPageConfig` already overrides that
      // widget's menu to include a real "Agents" group (`mentions/menu.ts`),
      // so this reuses the existing mention infrastructure end to end
      // instead of building a second, parallel one.
      action: ({ rootComponent, model }) => {
        insertContent(rootComponent.host, model, '@')
        const inlineEditor = getInlineEditorByModel(rootComponent.host, model)
        inlineEditor?.slots.inlineRangeSync.once(() => {
          const widgetInstance = rootComponent.std.view.getWidget('affine-linked-doc-widget', rootComponent.model.id)
          widgetInstance?.show?.()
        })
      },
    } satisfies SlashMenuActionItem)
  }
}

/**
 * Polls `root` for the mounted slash-menu widget and registers our items.
 * Runs on every editor mount rather than once globally — see
 * `native-database/slash-menu.ts`'s equivalent comment for why a one-time
 * flag risks silently skipping registration on later pages in the session.
 */
export function registerPageCommandsSlashMenuItems(root: ParentNode) {
  let attempts = 0
  const tryRegister = () => {
    const widget = root.querySelector('affine-slash-menu-widget') as SlashMenuWidgetLike | null
    if (widget?.config?.items) {
      pushItems(widget)
      return
    }
    attempts += 1
    if (attempts < 40) setTimeout(tryRegister, 100)
  }
  tryRegister()
}
