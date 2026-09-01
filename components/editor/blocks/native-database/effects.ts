import { NativeDatabaseBlockComponent } from './native-database-block'

export function effects() {
  if (!customElements.get('affine-native-database')) {
    customElements.define('affine-native-database', NativeDatabaseBlockComponent)
  }
}
