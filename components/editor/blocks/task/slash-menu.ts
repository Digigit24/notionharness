// Same DOM-query mechanism as `native-database/slash-menu.ts` (see that
// file's comment for why: no clean extension point for the slash menu in
// this BlockSuite version).

import type { TemplateResult } from 'lit'
import { createQuickTask } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import { taskIcon } from '../../slash-commands/slash-icons'

const ITEM_NAME = 'Task'

interface SlashMenuActionContext {
  rootComponent: {
    host: {
      closest(selector: string): Element | null
    }
    doc: {
      getParent(target: unknown): { children: unknown[] } | null
      addBlock(flavour: string, props?: Record<string, unknown>, parent?: unknown, parentIndex?: number): string
    }
  }
  model: unknown
}

interface SlashMenuActionItem {
  name: string
  description?: string
  alias?: string[]
  icon?: TemplateResult
  action: (ctx: SlashMenuActionContext) => void | Promise<void>
}

interface SlashMenuWidgetLike extends HTMLElement {
  config: { items: unknown[] }
}

function alreadyPresent(widget: SlashMenuWidgetLike): boolean {
  return widget.config.items.some(
    (item) => typeof item === 'object' && item !== null && (item as { name?: unknown }).name === ITEM_NAME,
  )
}

/**
 * ROADMAP B3.4/B3.5 — "/task ... creates a new real task row (via the
 * existing `createTask` action) AND inserts this block referencing it, in
 * one action." `createQuickTask` (`tasks/actions.ts`) does the row-create
 * half (resolving a default status + the current user server-side); this
 * item's `action` then inserts the `affine:embed-task` block referencing
 * the id it returns — same two-step-in-one-action shape the native-database
 * "Database" slash item uses for its own optimistic create.
 */
function pushItem(widget: SlashMenuWidgetLike) {
  if (alreadyPresent(widget)) return

  const item: SlashMenuActionItem = {
    name: ITEM_NAME,
    description: 'Track work with a real task — assignee, status, linked to the tasks board',
    alias: ['todo', 'to-do'],
    icon: taskIcon,
    action: async ({ rootComponent, model }) => {
      const parentModel = rootComponent.doc.getParent(model)
      if (!parentModel) return

      // Same `data-workspace-id`/`data-workspace-slug` lookups
      // `native-database-block.ts` and `agent-thread/page-context.ts` use —
      // set on the editor's container in `BlockSuiteEditor.tsx`. Read
      // directly here (rather than importing those typed helpers) since
      // this context's `host` is a hand-rolled structural type, not the
      // real `EditorHost` those helpers are typed against — same reasoning
      // native-database/slash-menu.ts's own `SlashMenuActionContext`
      // avoids importing `@blocksuite/block-std` types outside `lib/
      // blocksuite-*.ts` wrappers.
      const workspaceIdStr = rootComponent.host.closest('[data-workspace-id]')?.getAttribute('data-workspace-id') ?? null
      const workspaceSlug = rootComponent.host.closest('[data-workspace-slug]')?.getAttribute('data-workspace-slug') ?? null
      const workspaceId = workspaceIdStr ? Number(workspaceIdStr) : NaN
      if (!Number.isFinite(workspaceId) || !workspaceSlug) {
        console.error('[task-slash-menu] Could not resolve a workspace — aborting task creation.')
        return
      }

      let taskId: number
      try {
        const task = await createQuickTask({ workspaceId, workspaceSlug, title: '' })
        taskId = task.id
      } catch (err) {
        console.error('[task-slash-menu] Failed to create task.', err)
        return
      }

      const index = parentModel.children.indexOf(model) + 1
      rootComponent.doc.addBlock('affine:embed-task', { taskId }, parentModel, index)
    },
  }
  widget.config.items.push(item)
}

/**
 * Polls `root` for the mounted slash-menu widget and registers our item.
 * Runs on every editor mount rather than once globally — see
 * `native-database/slash-menu.ts`'s equivalent comment for why a one-time
 * flag risks silently skipping registration on later pages in the session.
 */
export function registerTaskSlashMenuItem(root: ParentNode) {
  let attempts = 0
  const tryRegister = () => {
    const widget = root.querySelector('affine-slash-menu-widget') as SlashMenuWidgetLike | null
    if (widget?.config?.items) {
      pushItem(widget)
      return
    }
    attempts += 1
    if (attempts < 40) setTimeout(tryRegister, 100)
  }
  tryRegister()
}
