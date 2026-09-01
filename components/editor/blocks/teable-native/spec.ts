import { BlockViewExtension, FlavourExtension, type ExtensionType } from '@blocksuite/block-std'
import { literal } from 'lit/static-html.js'

export const TeableNativeBlockSpec: ExtensionType[] = [
  FlavourExtension('affine:embed-teable-native'),
  BlockViewExtension('affine:embed-teable-native', literal`affine-teable-native`),
]
