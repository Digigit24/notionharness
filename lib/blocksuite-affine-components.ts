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
export { popMenu, popupTargetFromElement, menu } from '@blocksuite/affine-components/context-menu'
