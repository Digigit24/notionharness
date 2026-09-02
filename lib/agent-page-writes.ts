import type { Payload } from 'payload'
import { Text } from '@/lib/blocksuite-store'
import { getNote, loadDocForWrite, seedEmptyDoc } from '@/lib/blocksuite-doc'

/**
 * ROADMAP 6.1 — "the run holds a scoped write handle to a block subtree,
 * appends through the same Yjs path a human edit takes, and never touches
 * blocks outside its subtree." This module is that handle: every export
 * here only ever calls `doc.addBlock(..., parentId)` under a subtree id the
 * caller already owns — never `updateBlock`/`deleteBlock`, and never a
 * parent id outside that subtree — so there is no code path by which an
 * agent write can reach content it wasn't scoped to.
 */

/** A block a caller can append further children under. Opaque outside this module. */
export type RunSubtreeHandle = string

/** The kinds of content a run can append. ROADMAP calls out "a plan block,
 * then findings, then a summary, then a diff card" — heading/paragraph/list/
 * code cover the first three. A diff card is deliberately not here: there is
 * no diff-rendering block flavour anywhere in the codebase to reuse (unlike
 * the run-card's `affine:embed-run-card`, see components/editor/blocks/run-card/schema.ts),
 * and registering a brand-new BlockSuite block schema (schema + custom
 * element + spec + collection registration in lib/blocksuite-doc.ts and the
 * client editor) is a much bigger editor-extension task than this write
 * primitive should take on — left as a follow-up. */
export type AgentBlockSpec =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; type: 'bulleted' | 'numbered' | 'todo'; text: string; checked?: boolean }
  | { kind: 'code'; text: string; language?: string | null }

function toParagraphType(level: 1 | 2 | 3): 'h1' | 'h2' | 'h3' {
  return level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3'
}

/**
 * Creates a new collapsed toggle-list block under a page's note to serve as
 * a run's write handle, labeled for the human reading the page (e.g. "Agent
 * run #42 — <task title>"). Returns its block id; callers persist this
 * alongside the run record (e.g. a new `runs.pageSubtreeBlockId` column) so
 * later appends for the same run target the same handle.
 */
export async function createRunSubtree(payload: Payload, pageId: number, label: string): Promise<RunSubtreeHandle> {
  const { doc, title, persist } = await loadDocForWrite(payload, pageId)
  let note = getNote(doc)
  if (!note) {
    // A page created via `ensureTaskPage` (or any other direct
    // `payload.create`) has no BlockSuite doc structure at all until
    // someone opens it in the browser editor — seed the same
    // page/surface/note/paragraph shape the client creates on first mount,
    // so there's a note to attach the run's subtree under.
    seedEmptyDoc(doc, title)
    note = getNote(doc)
  }
  if (!note) {
    throw new Error(`Page ${pageId} has no note block to attach a run subtree to.`)
  }
  const subtreeId = doc.addBlock('affine:list', { type: 'toggle', text: new Text(label) }, note.id as string)
  await persist()
  return subtreeId
}

/**
 * Appends one block as the last child of a run's subtree handle. Throws if
 * the handle doesn't resolve to a block that still exists in the page (e.g.
 * the human deleted it) — callers should treat that as "the human doesn't
 * want this run's output anymore" and stop appending, not recreate it
 * silently.
 */
export async function appendBlockToSubtree(
  payload: Payload,
  pageId: number,
  subtree: RunSubtreeHandle,
  spec: AgentBlockSpec,
): Promise<string> {
  const { doc, persist } = await loadDocForWrite(payload, pageId)
  const handleBlock = doc.getBlock(subtree)
  if (!handleBlock) {
    throw new Error(`Run subtree ${subtree} no longer exists on page ${pageId}.`)
  }
  // Shapes below are cross-checked against `docToMarkdown`'s `serializeChildren`
  // switch and `markdownToDoc`'s line parser in lib/blocksuite-doc.ts, so a
  // block appended here round-trips through both: `affine:list` reads `type`
  // ('bulleted' | 'numbered' | 'todo') + `text` + `checked` (todo only, export
  // ignores `order` and recomputes numbering from sibling position); `affine:code`
  // reads `text` + `language` (nullable).
  let blockId: string
  switch (spec.kind) {
    case 'heading':
      blockId = doc.addBlock('affine:paragraph', { type: toParagraphType(spec.level), text: new Text(spec.text) }, subtree)
      break
    case 'paragraph':
      blockId = doc.addBlock('affine:paragraph', { type: 'text', text: new Text(spec.text) }, subtree)
      break
    case 'list':
      blockId = doc.addBlock(
        'affine:list',
        { type: spec.type, text: new Text(spec.text), checked: spec.type === 'todo' ? !!spec.checked : false },
        subtree,
      )
      break
    case 'code':
      blockId = doc.addBlock('affine:code', { text: new Text(spec.text), language: spec.language ?? null }, subtree)
      break
  }
  await persist()
  return blockId
}
