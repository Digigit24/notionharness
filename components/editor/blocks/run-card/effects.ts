import { RunCardBlockComponent } from './run-card-block'

export function effects() {
  if (!customElements.get('affine-run-card')) {
    customElements.define('affine-run-card', RunCardBlockComponent)
  }
}
