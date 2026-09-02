import { BlockViewExtension, FlavourExtension, type ExtensionType } from '@/lib/blocksuite-block-std'
import { literal } from 'lit/static-html.js'

export const TaskBlockSpec: ExtensionType[] = [
  FlavourExtension('affine:embed-task'),
  BlockViewExtension('affine:embed-task', literal`affine-task-block`),
]
