import type { AffineInlineEditor } from '@blocksuite/affine-components/rich-text'
import type { MentionAttribute } from './schema'

// A literal single space, mirroring REFERENCE_NODE — the delta needs some
// non-empty `insert` text for the zero-width-joiner inline-range trick to work.
export const MENTION_NODE = ' '

export function insertMentionNode({
  inlineEditor,
  user,
}: {
  inlineEditor: AffineInlineEditor
  user: MentionAttribute
}) {
  if (!inlineEditor) return
  const inlineRange = inlineEditor.getInlineRange()
  if (!inlineRange) return
  inlineEditor.insertText(inlineRange, MENTION_NODE, { mention: user })
  inlineEditor.setInlineRange({ index: inlineRange.index + 1, length: 0 })
}
