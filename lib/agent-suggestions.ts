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
