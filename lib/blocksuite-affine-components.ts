import { autoPlacement, offset, shift, size } from '@floating-ui/dom'
import {
  popMenu as blocksuitePopMenu,
  popupTargetFromElement,
  createPopup,
  menu,
  type MenuHandler,
  type PopupTarget,
} from '@blocksuite/affine-components/context-menu'

// BlockSuite boundary for rich-text component extensions.
export * from '@blocksuite/affine-components/rich-text'
// Menu/popup primitives used by custom property configs (e.g. the relation
// property's target-database/row pickers) — see NOTION-PARITY 7's incident:
// importing this directly from `@blocksuite/affine-components/context-menu`
// bypassed this wrapper and loaded a second copy of BlockSuite's/Lit's
// module graph, breaking `instanceof`/custom-element registration checks
// app-wide. Every BlockSuite touchpoint must go through `lib/blocksuite-*`.
//
// Named re-export (not `export *`): `context-menu` and `rich-text` both
// export their own `effects` (custom-element registration) — neither is
// actually called through this wrapper (that happens via the top-level
// `@blocksuite/blocks/effects`/`@blocksuite/presets/effects` bundles in
// `BlockSuiteEditor.tsx`, which already cover both), and Next's webpack
// flags the `export *` collision as a build warning even when a later
// explicit export shadows it. Naming only what's actually consumed here
// avoids the collision at the source instead of overriding it after the fact.
export { popupTargetFromElement, createPopup, menu }
export type { MenuHandler, PopupTarget }

// property-popup-polish — root cause of "table property dropdowns get
// cropped by the page boundary instead of scrolling": `popMenu`'s OWN
// default positioning (`@blocksuite/affine-components/dist/context-menu/
// menu-renderer.js`) is `[autoPlacement({allowedPlacements: [4 corners]}),
// offset(4)]`. `autoPlacement` only RANKS which of those four corners has
// the most room — it never pulls an oversized popup back fully on-screen
// (that's `shift`'s job, which the default never includes) and never caps
// the popup's own height to whatever room is actually available (that's
// `size`'s job). So a popup taller than whatever corner "won" the ranking —
// the property-type list with every preset, formula's function-name hint,
// rollup's aggregation list, a long select/relation options list — clips
// past the viewport edge instead of shifting into view or scrolling. This
// wrapper is the one seam every `popMenu` call in this app already goes
// through (see the header comment above), so fixing the default here fixes
// it for every call site at once — the property config popups this task
// targets, and incidentally every other `popMenu` user in this app — rather
// than passing `middleware` at each one individually. A caller that already
// supplies its own `middleware` is left untouched (`props.middleware ?? …`);
// none do today, but the override stays available if one ever needs to.
function defaultPopupMiddleware() {
  return [
    autoPlacement({ allowedPlacements: ['bottom-start', 'bottom-end', 'top-start', 'top-end'] }),
    offset(4),
    shift({ padding: 8, crossAxis: true }),
    size({
      padding: 8,
      apply({ availableHeight, elements }) {
        // `size()` is the only middleware here that actually knows how much
        // room is left once `autoPlacement`+`shift` have settled on a spot —
        // written as an inline style so it naturally wins over the static
        // fallback `max-height` in `ensurePopupStylesInjected` below (no
        // `!important` fight needed: an inline style already outranks a
        // plain stylesheet rule for the same property).
        Object.assign(elements.floating.style, { maxHeight: `${Math.max(160, availableHeight)}px` })
      },
    }),
  ]
}

export function popMenu(target: PopupTarget, props: Parameters<typeof blocksuitePopMenu>[1]): MenuHandler {
  ensurePopupStylesInjected()
  return blocksuitePopMenu(target, {
    ...props,
    middleware: props.middleware ?? defaultPopupMiddleware(),
  })
}

let popupStylesInjected = false

/**
 * `size()` above caps the popup's OWN box once it's positioned, but the
 * scrollable-list half of the bug is CSS, not positioning: `affine-menu`'s
 * own styles (menu-renderer.js's `MenuComponent.styles`) give the host no
 * `max-height` and `.affine-menu-body` (the actual item list, a sibling of
 * the title/search rows) no `overflow`, so without a bound the list just
 * grows past whatever box `size()` sets instead of scrolling inside it —
 * `size()` alone can shrink the container, it can't make the CONTENT
 * respect that shrink. `affine-menu` is a `ShadowlessElement` (BlockSuite's
 * own no-shadow-DOM convention — see this file's header comment on why that
 * makes its styles genuinely page-global already, not component-scoped),
 * registered once for the whole app, so one small global stylesheet reaches
 * every popup built on it — our own property config menus AND BlockSuite's
 * own stock ones (the property-type picker included, since picking a type
 * is a `menu.subMenu` rendered as this exact same element, not a distinct
 * component this app could style locally instead).
 *
 * Only `border-radius`/`box-shadow` need `!important`: those two properties
 * already have a value in `MenuComponent`'s own adopted stylesheet, and this
 * plain `<style>` tag's cascade position relative to that adopted sheet
 * isn't something this app controls. `max-height`/`overflow` have no
 * pre-existing declaration to out-rank, so they don't need it — and leaving
 * `!important` off there is what lets `size()`'s inline `max-height` (a
 * more precise, viewport-aware number) win for `popMenu`-driven menus,
 * while BlockSuite's own `menu.subMenu` (used for the property-type list —
 * positioned by `sub-menu.js`'s own hardcoded, `popMenu`-bypassing
 * `computePosition` call, so `defaultPopupMiddleware` above never runs for
 * it) still gets a real bound to scroll inside from this fallback value.
 *
 * Exported (not just called lazily from `popMenu` above) because the single
 * most-complained-about popup — the property-TYPE picker itself — is
 * rendered by `@blocksuite/data-view`'s `database-header-column.js`, which
 * imports `popMenu` straight from the real `@blocksuite/affine-components/
 * context-menu` package (it's vendored code, not this app's — it has no
 * reason to know this wrapper exists), so it never calls the wrapped
 * `popMenu` above and would never trigger this injection on its own. A
 * database block is the one place in this app that's guaranteed to render
 * before that menu can possibly be opened, so `NativeDatabaseBlockComponent`
 * calls this directly on `connectedCallback` — see that file's own call site
 * for why this couldn't just be a module-level side effect instead (SSR).
 */
export function ensurePopupStylesInjected() {
  if (popupStylesInjected || typeof document === 'undefined') return
  popupStylesInjected = true
  const style = document.createElement('style')
  style.setAttribute('data-blocksuite-popup-polish', '')
  style.textContent = `
    affine-menu {
      max-height: min(80vh, 560px);
      overflow: hidden;
      border-radius: 12px !important;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18), 0 4px 12px rgba(0, 0, 0, 0.10) !important;
    }
    affine-menu .affine-menu-body {
      overflow-y: auto;
      min-height: 0;
      flex: 1 1 auto;
    }
  `
  document.head.appendChild(style)
}
