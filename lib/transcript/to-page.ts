import type { Payload } from 'payload'
import { loadDocForWrite, getNote, seedEmptyDoc } from '@/lib/blocksuite-doc'
import { Text } from '@/lib/blocksuite-store'
import type { ChatContent } from '@/lib/hermes/runEvent-adapter'

/**
 * Turns one assistant reply into blocks on a page.
 *
 * The point of the whole page-plus-agent fusion is that a good answer should
 * not be trapped in a chat log. This is the other half of the in-page agent
 * block: a conversation can become a document, and a document can hold a
 * conversation.
 *
 * Fidelity matters here more than convenience. A reply is rarely just prose —
 * it is prose plus the command that was run, its output, and the diff it
 * produced — and flattening all of that into one paragraph loses exactly the
 * part worth keeping. So each content type maps to the closest real block:
 * text becomes paragraphs (one per blank-line-separated chunk, so structure
 * survives), thinking is dropped (it is working, not output), and tool calls,
 * terminal output and diffs become fenced code blocks with a heading naming
 * what they were.
 */

/** Terminal output and diffs can be enormous; a page is not a log viewer. */
const MAX_BLOCK_CHARS = 8_000

function truncate(text: string): string {
  return text.length > MAX_BLOCK_CHARS
    ? `${text.slice(0, MAX_BLOCK_CHARS)}\n… truncated (${text.length - MAX_BLOCK_CHARS} more characters)`
    : text
}

interface PlannedBlock {
  flavour: 'affine:paragraph' | 'affine:code'
  props: Record<string, unknown>
}

/**
 * The blocks one assistant message becomes, in order.
 *
 * Exported separately from the writer so it can be reasoned about (and
 * tested) without a database.
 */
export function planBlocksForContent(content: ChatContent[]): PlannedBlock[] {
  const planned: PlannedBlock[] = []
  const heading = (text: string) =>
    planned.push({ flavour: 'affine:paragraph', props: { type: 'h3', text: new Text(text) } })
  const code = (text: string, language: string | null) =>
    planned.push({ flavour: 'affine:code', props: { text: new Text(truncate(text)), language } })

  for (const item of content) {
    switch (item.type) {
      case 'text': {
        // Preserve the model's own paragraph breaks rather than collapsing
        // the whole reply into a single block.
        for (const chunk of item.text.split(/\n{2,}/)) {
          const trimmed = chunk.trim()
          if (trimmed) {
            planned.push({ flavour: 'affine:paragraph', props: { type: 'text', text: new Text(trimmed) } })
          }
        }
        break
      }
      case 'thinking':
        // Reasoning is how the answer was reached, not the answer. Keeping it
        // would bury the useful part.
        break
      case 'tool_call': {
        heading(item.toolName || 'tool call')
        // `toolOutput` is deliberately `unknown` on the adapter's contract —
        // a tool can return anything. A string renders as-is; anything else
        // becomes JSON rather than "[object Object]".
        const raw = item.toolOutput
        const output = typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw, null, 2)
        if (output.trim()) code(output, typeof raw === 'string' ? null : 'json')
        break
      }
      case 'terminal': {
        heading('terminal')
        if (item.text) code(item.text, 'bash')
        break
      }
      case 'file_change': {
        heading(item.path ? `diff · ${item.path}` : 'diff')
        if (item.diff) code(item.diff, 'diff')
        break
      }
      case 'permission':
        // A settled approval is an event in a conversation, not content in a
        // document.
        break
      default:
        break
    }
  }
  return planned
}

/**
 * Appends an assistant reply to a page's document.
 *
 * Blocks go at the end of the note, not into a collapsed subtree: the point
 * is a readable document, and a reply the user deliberately promoted should
 * not arrive pre-folded.
 */
export async function appendMessageToPage(
  payload: Payload,
  pageId: number,
  content: ChatContent[],
): Promise<number> {
  const planned = planBlocksForContent(content)
  if (planned.length === 0) return 0

  const { doc, title, persist } = await loadDocForWrite(payload, pageId)
  // A page created moments ago has an empty document — no page block, no
  // note — because the note is normally seeded by the editor on first open.
  // Appending to a page nobody has opened yet is exactly the case here, so
  // seed it rather than failing (observed live: "Page 39 has no note to
  // append to", leaving an empty page behind).
  let note = getNote(doc)
  if (!note) {
    seedEmptyDoc(doc, title)
    note = getNote(doc)
  }
  if (!note) throw new Error(`Page ${pageId} has no note to append to.`)

  for (const block of planned) {
    doc.addBlock(block.flavour as never, block.props as never, note.id as string)
  }
  await persist()
  return planned.length
}
