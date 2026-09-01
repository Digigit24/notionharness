import { BlockViewExtension, FlavourExtension, type ExtensionType } from '@/lib/blocksuite-block-std'
import { literal } from 'lit/static-html.js'

// The flavour string stays `affine:embed-teable-native` (persisted in
// existing docs — see schema.ts's comment); only the view's own custom
// element tag changes, since that's a runtime-only mapping, never persisted.
export const NativeDatabaseBlockSpec: ExtensionType[] = [
  FlavourExtension('affine:embed-teable-native'),
  BlockViewExtension('affine:embed-teable-native', literal`affine-native-database`),
]
