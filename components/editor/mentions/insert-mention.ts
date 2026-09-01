import type { AffineInlineEditor } from '@/lib/blocksuite-affine-components'
import type { MentionAttribute } from './schema'

// A literal single space, mirroring REFERENCE_NODE — the delta needs some
// non-empty `insert` text for the zero-width-joiner inline-range trick to work.
export const MENTION_NODE = ' '

export function insertMentionNode({
  inlineEditor,
  mention,
}: {
  inlineEditor: AffineInlineEditor
  mention: MentionAttribute
}) {
  if (!inlineEditor) return
  const inlineRange = inlineEditor.getInlineRange()
  if (!inlineRange) return
  inlineEditor.insertText(inlineRange, MENTION_NODE, { mention })
  inlineEditor.setInlineRange({ index: inlineRange.index + 1, length: 0 })
}
