import { BlockViewExtension, FlavourExtension, type ExtensionType } from '@/lib/blocksuite-block-std'
import { literal } from 'lit/static-html.js'

export const RunCardBlockSpec: ExtensionType[] = [
  FlavourExtension('affine:embed-run-card'),
  BlockViewExtension('affine:embed-run-card', literal`affine-run-card`),
]
