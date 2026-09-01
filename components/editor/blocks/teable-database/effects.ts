import { TeableDatabaseBlockComponent } from './teable-database-block'

// Mirrors how `@blocksuite/blocks/effects` registers its own custom elements
// (e.g. `customElements.define('affine-divider', DividerBlockComponent)`).
export function effects() {
  if (!customElements.get('affine-teable-database')) {
    customElements.define('affine-teable-database', TeableDatabaseBlockComponent)
  }
}
