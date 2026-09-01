import { TeableNativeBlockComponent } from './teable-native-block'

export function effects() {
  if (!customElements.get('affine-teable-native')) {
    customElements.define('affine-teable-native', TeableNativeBlockComponent)
  }
}
