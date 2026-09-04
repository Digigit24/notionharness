import type { Payload } from 'payload'
import { loadDocForWrite } from '@/lib/blocksuite-doc'
import { getRun, setSuggestionStatus } from '@/lib/broker'

/**
 * ROADMAP B3.1 (Batch B-2 "Moat") — suggestions mode, shipped at whole-run
 * granularity. This is the plan's own pre-authorized coarser fallback, not
 * the target per-block design, and here's why it was the right call rather
 * than a shortcut:
 *
 * The target ("an agent's edits arrive as suggestions you accept or reject
 * per block") needs a place to durably record each block's pending/accepted/
 * rejected state. That place would have to be a Yjs block prop — anything
 * else (an in-memory map, a Payload row per block) can't survive a reload or
 * merge correctly with `applyDocSync`'s CRDT-union semantics. Two ways to get
 * a prop onto a block, both dead ends within this repo's boundaries:
 *
 *   1. Add a prop to the subtree handle's existing schema (`affine:list`,
 *      ListBlockSchema in `@blocksuite/affine-model`). Confirmed by reading
 *      that package plus `@blocksuite/store`'s sync-controller.ts: a block
 *      model's props are whatever `_parseYBlock` finds under `prop:`-prefixed
 *      keys in the Yjs map, seeded from the schema's own `props()` defaults;
 *      `model.keys` (which the model's Proxy `set` trap checks before writing
 *      to `yBlock`) only ever contains schema-declared keys. Setting an
 *      undeclared key via `doc.updateBlock` — which is exactly what a
 *      `suggestionStatus` prop would require — silently sets a plain JS
 *      property on the in-memory model object and never reaches `yBlock` at
 *      all: it would vanish on the very next reload, no error, no signal.
 *      `ListBlockSchema` itself is upstream `@blocksuite/affine-model` code,
 *      not something this repo can edit.
 *   2. Register a brand-new container block flavour for the subtree (the
 *      `RunCardBlockSchema` pattern), with its own `suggestionStatus` prop.
 *      That's real BlockSuite schema/spec/component work, and — critically —
 *      it would also need its own `BlockComponent` that renders arbitrary
 *      nested children the way `affine:note`'s does, since the subtree holds
 *      whatever mix of heading/paragraph/list/code blocks the run appended.
 *      That's the kind of BlockSuite-internals rewrite AGENTS.md's
 *      `lib/blocksuite-*.ts` wrapper boundary exists to keep out of app code,
 *      and exactly the class of risk the plan itself calls out: "be willing
 *      to ship a coarser version... if the fine-grained version fights the
 *      CRDT."
 *
 * So suggestion state lives where `pageSubtreeBlockId` already lives: a
 * column on the run's own row in the raw-pg `runs` table (D5), never a
 * BlockSuite schema change. "Accept" cannot go finer than "the whole
 * subtree" for the same reason — there is no durable, reload-safe way to
 * mark an individual block within it as accepted independently of its
 * siblings without one of the two dead ends above.
 */

/**
 * "Accept" for the whole-run fallback: clear the pending marker only. The
 * run's blocks stay exactly where `appendBlockToSubtree` put them — nested
 * under their labeled "Agent run #N" toggle section, which already serves as
 * a visible provenance marker. No Yjs mutation happens here at all, so
 * nothing that was already attached to those blocks (their content, their
 * position under the labeled subtree, the `page_write` RunEvent history) is
 * touched or lost — there is no per-block provenance prop today for this to
 * clobber (see the module docstring: agent-page-writes.ts's appended blocks
 * carry no custom Yjs props, only stock content), so a later provenance
 * workstream reading this module should look at the subtree's own label text
 * plus the run's `page_write` events, not a per-block prop.
 */
export async function acceptRunSuggestions(runId: number): Promise<void> {
  const run = await getRun(runId)
  if (!run) throw new Error(`Run ${runId} not found.`)
  if (!run.pageId || !run.pageSubtreeBlockId) throw new Error(`Run ${runId} has no page subtree to accept.`)
  await setSuggestionStatus(runId, 'accepted')
}

/**
 * "Reject" for the whole-run fallback: delete the run's entire subtree (the
 * toggle block plus every block the run appended under it, and — same as a
 * human deleting that block by hand — anything a human may have nested
 * inside it since) in one CRDT op via `doc.deleteBlock`, then mark rejected.
 * `doc.deleteBlock`/`doc.getBlock` are plain, always-supported `Doc` methods
 * (the same primitives BlockSuite's own UI uses for a manual block delete),
 * not `agent-page-writes.ts`'s narrower "append only" primitive — this
 * module serves the human review action, not the agent write path, so it's a
 * separate module rather than widening that one's "must not become an
 * arbitrary page mutation API" invariant.
 *
 * Marks rejected even if the subtree block was already gone (e.g. a human
 * deleted it manually before ever using this action) — the pending marker
 * must not linger either way.
 */
export async function rejectRunSuggestions(payload: Payload, runId: number): Promise<void> {
  const run = await getRun(runId)
  if (!run) throw new Error(`Run ${runId} not found.`)
  if (!run.pageId || !run.pageSubtreeBlockId) throw new Error(`Run ${runId} has no page subtree to reject.`)
  const { doc, persist } = await loadDocForWrite(payload, run.pageId)
  const handle = doc.getBlock(run.pageSubtreeBlockId)
  if (handle) {
    doc.deleteBlock(handle.model)
    await persist()
  }
  await setSuggestionStatus(runId, 'rejected')
}


// ---------------------------------------------------------------------------
// R7.4 (Roadmap A A3.5) — per-block proposals.
//
// The whole-run accept/reject above is coarse by design, and the reason is
// recorded in `lib/broker/types.ts`: a per-block suggestion MARK cannot be
// stored durably without either mutating a stock BlockSuite schema this app
// does not own, or registering a new container flavour with its own
// children-rendering component.
//
// That constraint is about marking blocks, not about acting on them. The run's
// subtree already IS the proposal container — a toggle block holding exactly
// the blocks the run appended — so a per-block decision does not need a new
// mark at all:
//
//   * REJECT one block = delete that block. The rest of the proposal stands.
//   * ACCEPT one block = move it out of the proposal and into the page proper,
//     which is precisely what accepting means: it stops being a proposal and
//     becomes part of the document.
//
// Both use the same always-supported `Doc` primitives the whole-run actions
// use. No schema change, no new flavour, and no pretending the marking problem
// was solved.

/** A block inside a run's proposal subtree, for review. */
export interface ProposedBlock {
  id: string
  flavour: string
  /** Plain text, for a review list that must not embed an editor per row. */
  text: string
}

/**
 * The blocks a run has proposed, in document order.
 *
 * Returns an empty list when the subtree is gone, which is the honest answer:
 * a human who deleted it has already rejected the lot.
 */
export async function listProposedBlocks(payload: Payload, runId: number): Promise<ProposedBlock[]> {
  const run = await getRun(runId)
  if (!run?.pageId || !run.pageSubtreeBlockId) return []
  const { doc } = await loadDocForWrite(payload, run.pageId)
  const handle = doc.getBlock(run.pageSubtreeBlockId)
  if (!handle) return []
  const children = (handle.model.children ?? []) as Array<{ id: string; flavour: string; text?: { toString(): string } }>
  return children.map((child) => ({
    id: child.id,
    flavour: child.flavour,
    text: child.text ? child.text.toString() : '',
  }))
}

/**
 * Accepts one proposed block: moves it out of the proposal and into the note,
 * immediately after the proposal container.
 *
 * Placement is deliberate — appending to the end of the note would scatter
 * accepted blocks away from the context they were proposed in, which for a
 * multi-block proposal reviewed one row at a time would shuffle the document.
 */
export async function acceptProposedBlock(payload: Payload, runId: number, blockId: string): Promise<void> {
  const run = await getRun(runId)
  if (!run?.pageId || !run.pageSubtreeBlockId) throw new Error(`Run ${runId} has no proposal to accept from.`)
  const { doc, persist } = await loadDocForWrite(payload, run.pageId)
  const subtree = doc.getBlock(run.pageSubtreeBlockId)
  const block = doc.getBlock(blockId)
  if (!subtree || !block) throw new Error('That proposed block no longer exists.')

  const parent = doc.getParent(subtree.model)
  if (!parent) throw new Error('The proposal is no longer attached to the page.')

  // `moveBlocks` is the same primitive BlockSuite's own drag-and-drop uses.
  // Guarded because it is the one call here that is not on the narrow
  // always-present surface the rest of this module sticks to.
  const mover = (doc as unknown as {
    moveBlocks?: (blocks: unknown[], newParent: unknown, targetSibling?: unknown, before?: boolean) => void
  }).moveBlocks
  if (typeof mover !== 'function') {
    throw new Error('This BlockSuite build cannot move blocks; accept the whole run instead.')
  }
  mover.call(doc, [block.model], parent, subtree.model, false)
  await persist()
}

/**
 * Rejects one proposed block by deleting it, leaving the rest of the proposal
 * intact. The run's own status is untouched: rejecting one block is not
 * rejecting the run, and marking it so would lose the blocks still pending.
 */
export async function rejectProposedBlock(payload: Payload, runId: number, blockId: string): Promise<void> {
  const run = await getRun(runId)
  if (!run?.pageId) throw new Error(`Run ${runId} has no page.`)
  const { doc, persist } = await loadDocForWrite(payload, run.pageId)
  const block = doc.getBlock(blockId)
  // Already gone is success, not an error — the outcome the caller wanted is
  // the outcome that exists.
  if (!block) return
  doc.deleteBlock(block.model)
  await persist()
}
