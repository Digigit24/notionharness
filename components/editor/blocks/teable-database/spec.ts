import { BlockViewExtension, FlavourExtension, type ExtensionType } from '@blocksuite/block-std'
import { literal } from 'lit/static-html.js'

export const TeableDatabaseBlockSpec: ExtensionType[] = [
  FlavourExtension('affine:embed-teable-database'),
  BlockViewExtension('affine:embed-teable-database', literal`affine-teable-database`),
]
