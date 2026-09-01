import { AffineMention } from './mention-node'

export function effects() {
  if (!customElements.get('affine-mention')) {
    customElements.define('affine-mention', AffineMention)
  }
}
