// Same DOM-query mechanism as `teable-database/slash-menu.ts` (see that
// file's comment for why: no clean extension point for the slash menu in
// this BlockSuite version). This module ALSO removes BlockSuite's own
// stock "Table View"/"Kanban View" items (`affine:database`-backed, purely
// local Yjs data, not connected to anything) — now that a genuinely
// Teable-connected alternative with the same native look exists, offering
// the disconnected stock ones just re-creates the original confusion.

// User-facing name deliberately avoids "Teable" — the backing engine is an
// implementation detail (Notion never exposes its own backing store's name
// either). Code-level identifiers (flavour, file names) keep it for clarity.
const ITEM_NAME = 'Database'
const REMOVE_NAMES = new Set(['Table View', 'Kanban View'])

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
  action: (ctx: SlashMenuActionContext) => void
}

interface SlashMenuWidgetLike extends HTMLElement {
  config: { items: unknown[] }
}

function pushItem(widget: SlashMenuWidgetLike) {
  const alreadyPresent = widget.config.items.some(
    (item) => typeof item === 'object' && item !== null && (item as { name?: string }).name === ITEM_NAME,
  )
  if (!alreadyPresent) {
    const item: SlashMenuActionItem = {
      name: ITEM_NAME,
      description: 'Add a database with table and board views',
      action: ({ rootComponent, model }) => {
        const parentModel = rootComponent.doc.getParent(model)
        if (!parentModel) return
        const index = parentModel.children.indexOf(model) + 1
        // Flavour string stays `affine:embed-teable-native` — see schema.ts's comment.
        rootComponent.doc.addBlock('affine:embed-teable-native', {}, parentModel, index)
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
