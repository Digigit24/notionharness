// Same DOM-query mechanism as `teable-database/slash-menu.ts` (see that
// file's comment for why: no clean extension point for the slash menu in
// this BlockSuite version). This module ALSO removes BlockSuite's own
// stock "Table View"/"Kanban View" items (`affine:database`-backed, purely
// local Yjs data, not connected to anything) — now that a genuinely
// Teable-connected alternative with the same native look exists, offering
// the disconnected stock ones just re-creates the original confusion.

import type { TemplateResult } from 'lit'
import { databaseIcon, tableIcon } from '../../slash-commands/slash-icons'

// User-facing name deliberately avoids "Teable" — the backing engine is an
// implementation detail (Notion never exposes its own backing store's name
// either). Code-level identifiers (flavour, file names) keep it for clarity.
const ITEM_NAME = 'Database'
const REMOVE_NAMES = new Set(['Table View', 'Kanban View'])

// ROADMAP B3.4/B3.5 — "PayloadDataSource already exists; expose it in the
// slash menu so 'insert a view of this project's tasks' is two keystrokes."
// A second, distinct item (not just an alias on `ITEM_NAME`, which creates a
// blank `user-database`): typing `/table` inserts this same block flavour
// already pre-configured with `sourceType: 'payload', payloadCollection:
// 'tasks'` (now allowlisted in `app/api/payload-datasource/_lib.ts`) — no
// picker, matching the "Database" item's own no-upfront-choice precedent.
const TABLE_ITEM_NAME = 'Tasks table'

interface SlashMenuActionContext {
  rootComponent: {
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
  action: (ctx: SlashMenuActionContext) => void
}

interface SlashMenuWidgetLike extends HTMLElement {
  config: { items: unknown[] }
}

function pushItem(widget: SlashMenuWidgetLike) {
  const names = new Set(
    widget.config.items
      .map((item) => (typeof item === 'object' && item !== null ? (item as { name?: unknown }).name : undefined))
      .filter((name): name is string => typeof name === 'string'),
  )

  if (!names.has(ITEM_NAME)) {
    const item: SlashMenuActionItem = {
      name: ITEM_NAME,
      description: 'Add a database with table and board views',
      icon: databaseIcon,
      action: ({ rootComponent, model }) => {
        const parentModel = rootComponent.doc.getParent(model)
        if (!parentModel) return
        const index = parentModel.children.indexOf(model) + 1
        // NOTION-PARITY 7 — inserted already committed to a fresh
        // `user-database` source (`userDatabaseId: null` signals "not
        // created yet" to `native-database-block.ts`'s `connectedCallback`,
        // which immediately starts an optimistic creation) — no upfront
        // picker, matching Notion's actual `/table` behavior. "Use an
        // existing source" is now a secondary action reachable from the
        // block's own "Change data source" menu once it exists, not a
        // blocking choice here. Flavour string stays
        // `affine:embed-teable-native` — see schema.ts's comment.
        rootComponent.doc.addBlock(
          'affine:embed-teable-native',
          { sourceType: 'user-database', userDatabaseId: null },
          parentModel,
          index,
        )
      },
    }
    widget.config.items.push(item)
  }

  if (!names.has(TABLE_ITEM_NAME)) {
    const item: SlashMenuActionItem = {
      name: TABLE_ITEM_NAME,
      description: "Insert a live view of this workspace's tasks",
      icon: tableIcon,
      alias: ['table', 'tasks table'],
      action: ({ rootComponent, model }) => {
        const parentModel = rootComponent.doc.getParent(model)
        if (!parentModel) return
        const index = parentModel.children.indexOf(model) + 1
        rootComponent.doc.addBlock(
          'affine:embed-teable-native',
          { sourceType: 'payload', payloadCollection: 'tasks' },
          parentModel,
          index,
        )
      },
    }
    widget.config.items.push(item)
  }

  widget.config.items = widget.config.items.filter(
    (item) => !(typeof item === 'object' && item !== null && REMOVE_NAMES.has((item as { name?: string }).name ?? '')),
  )
}

/**
 * Polls `root` for the mounted slash-menu widget and registers/prunes our
 * items. Runs on every editor mount rather than once globally — see
 * `teable-database/slash-menu.ts`'s equivalent comment for why a one-time
 * flag risks silently skipping registration on later pages in the session.
 */
export function registerNativeDatabaseSlashMenuItem(root: ParentNode) {
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
