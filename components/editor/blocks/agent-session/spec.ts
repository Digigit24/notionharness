import { BlockViewExtension, FlavourExtension, type ExtensionType } from '@/lib/blocksuite-block-std'
import { literal } from 'lit/static-html.js'

export const AgentSessionBlockSpec: ExtensionType[] = [
  FlavourExtension('affine:embed-agent-session'),
  BlockViewExtension('affine:embed-agent-session', literal`notionforge-agent-session-block`),
]
