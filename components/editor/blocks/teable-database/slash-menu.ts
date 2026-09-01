// BlockSuite 0.19's slash menu has no DI/extension registration point for
// adding items (confirmed by reading `@blocksuite/blocks`'s source): the only
// hook is `AffineSlashMenuWidget.DEFAULT_CONFIG`, a static class field that
// isn't part of the package's public `exports` map, so it can't be imported
// directly without reaching into blocked internal paths. Since the widget
// component itself renders as a plain (non-shadow) custom element, we find a
// live instance via the DOM instead and mutate its shared `config.items`
// array in place — the same object every widget instance reads from.

const ITEM_NAME = 'Teable Database'

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
  if (alreadyPresent) return

  const item: SlashMenuActionItem = {
    name: ITEM_NAME,
    description: 'Embed a Teable table',
    action: ({ rootComponent, model }) => {
      const parentModel = rootComponent.doc.getParent(model)
      if (!parentModel) return
      const index = parentModel.children.indexOf(model) + 1
      rootComponent.doc.addBlock('affine:embed-teable-database', {}, parentModel, index)
    },
  }
  widget.config.items.push(item)
}

/**
 * Polls `root` for the mounted slash-menu widget and registers our item.
 * Runs on every editor mount (not just once globally) — `pushItem`'s own
 * `alreadyPresent` check already makes this idempotent when `config` really
 * is the shared, static object every widget instance reads from, but each
 * BlockSuite editor instance's slash-menu widget is a fresh element, and
 * nothing here guarantees `config` is actually shared rather than a
 * per-instance copy. Skipping registration after the first successful page
 * (a `registered` module flag previously did this) would silently leave the
 * item missing on every later page in the same session if it isn't shared.
 */
export function registerTeableSlashMenuItem(root: ParentNode) {
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
