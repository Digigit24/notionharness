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

/** The kinds of content a run can append — deliberately small for this first
 * slice (ROADMAP calls out "a plan block, then findings, then a summary,
 * then a diff card"; diff-card rendering is its own follow-up block type,
 * same shape as the run-card's `affine:embed-run-card`, not built yet). */
export type AgentBlockSpec =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }

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
  const blockId =
    spec.kind === 'heading'
      ? doc.addBlock('affine:paragraph', { type: toParagraphType(spec.level), text: new Text(spec.text) }, subtree)
      : doc.addBlock('affine:paragraph', { type: 'text', text: new Text(spec.text) }, subtree)
  await persist()
  return blockId
}
