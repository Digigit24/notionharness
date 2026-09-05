'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { descendantIds } from '@/lib/tree'
import { applyDocSync } from '@/lib/blocksuite-doc'
import { enqueueRun, getRun, listPendingSuggestionRunsForPage, listRunEvents, listRunsForPage } from '@/lib/broker'
import type { Run, RunMessageRow } from '@/lib/broker/types'
import { acceptRunSuggestions, rejectRunSuggestions } from '@/lib/agent-suggestions'
import { raise } from '@/lib/failures'
import { requireAccess, type Verb } from '@/lib/permissions'
import type { Page, TaskStatus } from '@/payload-types'

/**
 * PHASE 0 — the page mutations in this file had NO check of any kind.
 *
 * `enqueuePageRun`, `getPageRunSnapshots` and the three suggestion actions were
 * already guarded (by `assertPageAccess`, below). Everything else was not:
 * `createPage`, `renamePage`, `setPageIcon`, `setPageCover`, `toggleFavorite`,
 * `toggleFullWidth`, `toggleLocked`, `archivePage`, `restorePage`,
 * `deletePageForever`, `duplicatePage`, `movePage`, `getRunSnapshot` and — the
 * worst of them — `syncPageDoc`, which takes a page id and a Yjs update and
 * applies it. A server action is a public POST endpoint with a generated URL,
 * so that was "rewrite the contents of any page in the install".
 *
 * These two helpers say it once. `requirePage` resolves the workspace FROM THE
 * PAGE, never from a `workspaceId` the caller also supplied — several of these
 * actions take both, and trusting the second would let a caller pair a
 * workspace they belong to with a page they do not.
 */
async function requirePage(pageId: number, verb: Verb): Promise<{ userId: number; workspaceId: number }> {
  const user = await getCurrentPayloadUser()
  if (!user) raise('unauthenticated', 'You are not signed in.')
  const payload = await getPayloadClient()
  const page = await payload
    .findByID({ collection: 'pages', id: pageId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  // One sentence for "no such page" and for "not yours", so this cannot be used
  // to enumerate which page ids exist in other workspaces.
  if (!page) raise('not_found', 'That page no longer exists.')
  const workspaceId = typeof page.workspace === 'number' ? page.workspace : page.workspace?.id
  if (typeof workspaceId !== 'number') raise('not_found', 'That page no longer exists.')
  await requireAccess({ userId: user.id, workspaceId, verb, objectType: 'workspace' })
  return { userId: user.id, workspaceId }
}

async function requireWorkspace(workspaceId: number, verb: Verb): Promise<number> {
  const user = await getCurrentPayloadUser()
  if (!user) raise('unauthenticated', 'You are not signed in.')
  await requireAccess({ userId: user.id, workspaceId, verb, objectType: 'workspace' })
  return user.id
}

function parentIdOf(page: Page): number | null {
  if (!page.parentPage) return null
  return typeof page.parentPage === 'number' ? page.parentPage : page.parentPage.id
}

function slugify(name: string) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'workspace'
  )
}

// ROADMAP P2.2 — a sensible starting set, not the full 7-category vocabulary:
// the other categories (inReview/blocked/cancelled) are real, supported
// values a workspace can use once 2.5's status-management UI exists to add
// them — seeding all 7 by default would be more scaffolding than most teams
// start with actually needing.
const DEFAULT_TASK_STATUSES: Array<{ name: string; category: TaskStatus['category'] }> = [
  { name: 'Backlog', category: 'backlog' },
  { name: 'To Do', category: 'todo' },
  { name: 'In Progress', category: 'inProgress' },
  { name: 'Done', category: 'done' },
]

async function seedDefaultTaskStatuses(payload: Awaited<ReturnType<typeof getPayloadClient>>, workspaceId: number) {
  await Promise.all(
    DEFAULT_TASK_STATUSES.map((status, index) =>
      payload.create({
        collection: 'task-statuses',
        data: { workspace: workspaceId, name: status.name, category: status.category, position: (index + 1) * 10 },
        overrideAccess: true,
      }),
    ),
  )
}

async function nextPosition(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  workspaceId: number,
  parentPageId: number | null,
) {
  const result = await payload.find({
    collection: 'pages',
    where: {
      workspace: { equals: workspaceId },
      parentPage: parentPageId === null ? { exists: false } : { equals: parentPageId },
    },
    sort: '-position',
    limit: 1,
    overrideAccess: true,
  })
  return (result.docs[0]?.position ?? 0) + 10
}

export async function createWorkspace(name: string) {
  const payload = await getPayloadClient()
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in to create a workspace.')

  let slug = slugify(name)
  const clash = await payload.find({
    collection: 'workspaces',
    where: { slug: { equals: slug } },
    limit: 1,
    overrideAccess: true,
  })
  if (clash.docs.length > 0) slug = `${slug}-${Date.now().toString(36)}`

  const workspace = await payload.create({
    collection: 'workspaces',
    data: { name, slug, owner: user.id },
    overrideAccess: true,
  })

  await seedDefaultTaskStatuses(payload, workspace.id)

  revalidatePath('/')
  redirect(`/workspace/${workspace.slug}`)
}

export async function createPage({
  workspaceId,
  workspaceSlug,
  parentPageId,
}: {
  workspaceId: number
  workspaceSlug: string
  parentPageId?: number | null
}) {
  await requireWorkspace(workspaceId, 'write')
  const payload = await getPayloadClient()
  const [position, user] = await Promise.all([
    nextPosition(payload, workspaceId, parentPageId ?? null),
    getCurrentPayloadUser(),
  ])

  const page = await payload.create({
    collection: 'pages',
    data: {
      title: 'Untitled',
      workspace: workspaceId,
      parentPage: parentPageId ?? undefined,
      position,
    },
    overrideAccess: true,
    // ROADMAP P2.6 — Pages has no `createdBy` field (unlike Tasks); the
    // afterChange activity hook reads the actor from this hook-only context
    // instead (see `collections/Pages.ts`).
    context: { actorId: user?.id },
  })

  revalidatePath(`/workspace/${workspaceSlug}`)
  redirect(`/workspace/${workspaceSlug}/p/${page.id}`)
}

export async function renamePage(pageId: number, workspaceSlug: string, title: string) {
  await requirePage(pageId, 'write')
  const payload = await getPayloadClient()
  const user = await getCurrentPayloadUser()
  await payload.update({
    collection: 'pages',
    id: pageId,
    data: { title: title || 'Untitled' },
    overrideAccess: true,
    context: { actorId: user?.id },
  })
  revalidatePath(`/workspace/${workspaceSlug}`)
}

export async function setPageIcon(pageId: number, workspaceSlug: string, icon: string | null) {
  await requirePage(pageId, 'write')
  const payload = await getPayloadClient()
  await payload.update({ collection: 'pages', id: pageId, data: { icon }, overrideAccess: true })
  // See `toggleFullWidth`'s comment — 'layout' so the currently-open
  // `/p/[pageId]` route (a fresh load, or another tab) picks this up too,
  // not just the workspace index. `PageCanvas` reflects the change instantly
  // via its own local state; this is the correctness fallback, and without
  // it the write persisted but nothing outside the tab that made it ever saw
  // so.
  revalidatePath(`/workspace/${workspaceSlug}`, 'layout')
}

export async function setPageCover(pageId: number, workspaceSlug: string, coverImage: string | null) {
  await requirePage(pageId, 'write')
  const payload = await getPayloadClient()
  await payload.update({ collection: 'pages', id: pageId, data: { coverImage }, overrideAccess: true })
  // See `toggleFullWidth`'s comment.
  revalidatePath(`/workspace/${workspaceSlug}`, 'layout')
}

export async function toggleFavorite(pageId: number, workspaceSlug: string, value: boolean) {
  await requirePage(pageId, 'write')
  const payload = await getPayloadClient()
  await payload.update({ collection: 'pages', id: pageId, data: { isFavorite: value }, overrideAccess: true })
  // See `toggleFullWidth`'s comment.
  revalidatePath(`/workspace/${workspaceSlug}`, 'layout')
}

export async function toggleFullWidth(pageId: number, workspaceSlug: string, value: boolean) {
  await requirePage(pageId, 'write')
  const payload = await getPayloadClient()
  await payload.update({ collection: 'pages', id: pageId, data: { isFullWidth: value }, overrideAccess: true })
  // `'layout'` (not the default `'page'`) so this invalidates the currently-open
  // `/p/[pageId]` route too, not just the workspace index — a bare
  // `revalidatePath('/workspace/${workspaceSlug}')` only revalidates that exact
  // path, leaving whatever page the user is actually viewing stale.
  revalidatePath(`/workspace/${workspaceSlug}`, 'layout')
}

export async function toggleLocked(pageId: number, workspaceSlug: string, value: boolean) {
  await requirePage(pageId, 'write')
  const payload = await getPayloadClient()
  await payload.update({ collection: 'pages', id: pageId, data: { isLocked: value }, overrideAccess: true })
  // See toggleFullWidth's comment — 'layout' so a fresh load/other tab of the
  // currently-open `/p/[pageId]` route picks this up too, not just the
  // workspace index. The active tab itself reflects the toggle instantly via
  // PageCanvas's local `locked` state; this is the correctness fallback.
  revalidatePath(`/workspace/${workspaceSlug}`, 'layout')
}

// Debounced autosave target for the BlockSuite editor — no revalidatePath here,
// this fires on every keystroke (500ms after typing stops) and must stay silent.
// Wrapped in an object (not a bare string) because Payload's `json` field
// tries to JSON.parse a raw string value, which a base64 Yjs update isn't.
export async function syncPageDoc(pageId: number, update: string) {
  // Fires on every keystroke, so this adds two indexed reads to the debounced
  // autosave path. Measured against the alternative it is not close: the
  // alternative was that a page id and a Yjs update were the only things needed
  // to rewrite any document in the install.
  await requirePage(pageId, 'write')
  const payload = await getPayloadClient()
  await applyDocSync(payload, pageId, update)
}

/** Queue work anchored to a page rather than a task (P6.2 block-anchored
 * threads). The prompt is persisted on the raw-pg run row so the dispatcher
 * can deliver it without depending on a Payload request or a second write.
 * `agentId` is caller-supplied (the "ask agent" trigger resolves which
 * agent, via a picker when a workspace has more than one) but always
 * re-validated server-side against the page's own workspace below — never
 * trusted blindly, same standard as the accountable-user resolution.
 */
export async function enqueuePageRun(prompt: string, pageId: number, agentId: number): Promise<{ runId: number }> {
  const text = typeof prompt === 'string' ? prompt.trim() : ''
  if (!text || text.length > 20_000) throw new Error('A prompt between 1 and 20,000 characters is required.')
  if (!Number.isSafeInteger(pageId) || pageId < 1) throw new Error('A valid page id is required.')
  if (!Number.isSafeInteger(agentId) || agentId < 1) throw new Error('A valid agent id is required.')

  const [user, payload] = await Promise.all([getCurrentPayloadUser(), getPayloadClient()])
  if (!user) throw new Error('You must be logged in to enqueue a page run.')
  const page = await payload.findByID({ collection: 'pages', id: pageId, depth: 0, overrideAccess: true, disableErrors: true }).catch(() => null)
  if (!page) throw new Error('Page not found.')
  const workspaceId = typeof page.workspace === 'number' ? page.workspace : page.workspace?.id
  if (typeof workspaceId !== 'number') throw new Error('Page has no workspace.')
  const workspace = await payload.findByID({ collection: 'workspaces', id: workspaceId, depth: 0, overrideAccess: true, disableErrors: true }).catch(() => null)
  if (!workspace) throw new Error('Workspace not found.')
  const ownerId = typeof workspace.owner === 'number' ? workspace.owner : workspace.owner?.id
  const memberIds = Array.isArray(workspace.members)
    ? workspace.members.map((member) => typeof member === 'number' ? member : member.id)
    : []
  if (ownerId !== user.id && !memberIds.includes(user.id)) throw new Error('You do not have access to this page.')

  const agent = await payload.findByID({ collection: 'agents', id: agentId, depth: 0, overrideAccess: true, disableErrors: true }).catch(() => null)
  if (!agent || agent.enabled === false) throw new Error('Agent not found or disabled.')
  const agentWorkspaceId = typeof agent.workspace === 'number' ? agent.workspace : agent.workspace?.id
  if (agentWorkspaceId !== workspaceId) throw new Error('That agent does not belong to this page\'s workspace.')

  const run = await enqueueRun({
    taskId: null,
    agentId,
    pageId,
    prompt: text,
    originatorUser: user.id,
    accountableUser: user.id,
  })
  return { runId: run.id }
}

/**
 * ROADMAP 6.2 — a single-run equivalent of `getTaskRuns`/`getRunMessages`
 * (tasks/actions.ts) for the block-anchored thread popover, which has no
 * task to scope by. One round trip instead of two separate polls.
 */
export async function getRunSnapshot(runId: number): Promise<{ run: Run; events: RunMessageRow[] } | null> {
  const run = await getRun(runId)
  if (!run) return null
  // A run's events are its full transcript — the prompt, the tool calls, the
  // output. This is the block-anchored thread popover's loader, so every run it
  // legitimately asks about has a page; a run without one is refused rather
  // than waved through, because there is nothing here to check it against.
  if (!run.pageId) return null
  await requirePage(run.pageId, 'read')
  const events = await listRunEvents(runId)
  return { run, events }
}

/**
 * ROADMAP B-3 "Surface" — the `getTaskRuns`-shaped loader for the docked page
 * panel (`components/editor/agent-thread/page-docked-panel.tsx`), which uses
 * the same `useThreadData(id, observed, loader)` hook the task chromes
 * (`ThreadDrawerTab`/`ThreadLaneView`/`ThreadFullPage`) already use, just
 * scoped by `pageId` instead of `taskId` — `listRunsForPage` already existed
 * in `lib/broker/runs.ts` for the suggestions-bar read path, this is its
 * first use for a full conversation history rather than a pending-only
 * filter. Access-checked the same way every other page-scoped action here is
 * (`assertPageAccess`) since a page's run history can reveal prompts a
 * non-member must not see.
 */
export async function getPageRunSnapshots(pageId: number): Promise<{ run: Run; events: RunMessageRow[] }[]> {
  if (!Number.isSafeInteger(pageId) || pageId < 1) throw new Error('A valid page id is required.')
  const [user, payload] = await Promise.all([getCurrentPayloadUser(), getPayloadClient()])
  if (!user) throw new Error('You must be logged in.')
  await assertPageAccess(payload, pageId, user.id, 'read')
  const runs = await listRunsForPage(pageId)
  return Promise.all(runs.map(async (run) => ({ run, events: await listRunEvents(run.id) })))
}

async function subtreeIds(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  workspaceId: number,
  rootId: number,
) {
  const all = await payload.find({
    collection: 'pages',
    where: { workspace: { equals: workspaceId } },
    limit: 5000,
    overrideAccess: true,
  })
  return descendantIds(all.docs, rootId)
}

export async function archivePage(pageId: number, workspaceId: number, workspaceSlug: string) {
  // Checked against the page, then the caller's own `workspaceId` is used only
  // to walk the subtree — a mismatch between the two finds no descendants
  // rather than archiving another workspace's tree.
  await requirePage(pageId, 'write')
  const payload = await getPayloadClient()
  const ids = await subtreeIds(payload, workspaceId, pageId)
  await Promise.all(
    [pageId, ...ids].map((id) =>
      payload.update({ collection: 'pages', id, data: { isArchived: true }, overrideAccess: true }),
    ),
  )
  revalidatePath(`/workspace/${workspaceSlug}`)
}

export async function restorePage(pageId: number, workspaceId: number, workspaceSlug: string) {
  await requirePage(pageId, 'write')
  const payload = await getPayloadClient()
  const ids = await subtreeIds(payload, workspaceId, pageId)
  await Promise.all(
    [pageId, ...ids].map((id) =>
      payload.update({ collection: 'pages', id, data: { isArchived: false }, overrideAccess: true }),
    ),
  )
  revalidatePath(`/workspace/${workspaceSlug}`)
}

export async function deletePageForever(pageId: number, workspaceId: number, workspaceSlug: string) {
  await requirePage(pageId, 'delete')
  const payload = await getPayloadClient()
  const ids = await subtreeIds(payload, workspaceId, pageId)
  await Promise.all(
    [...ids, pageId].map((id) => payload.delete({ collection: 'pages', id, overrideAccess: true })),
  )
  revalidatePath(`/workspace/${workspaceSlug}`)
}

export async function duplicatePage(pageId: number, workspaceSlug: string) {
  // `write` on the source, which is also the destination: a copy always lands
  // beside its original, in the same workspace.
  await requirePage(pageId, 'write')
  const payload = await getPayloadClient()
  const original = await payload.findByID({ collection: 'pages', id: pageId, overrideAccess: true })
  const workspaceId = typeof original.workspace === 'number' ? original.workspace : original.workspace.id
  const parentPageId = parentIdOf(original)
  const position = await nextPosition(payload, workspaceId, parentPageId)

  const copy = await payload.create({
    collection: 'pages',
    data: {
      title: `${original.title || 'Untitled'} (Copy)`,
      icon: original.icon,
      coverImage: original.coverImage,
      workspace: workspaceId,
      parentPage: parentPageId ?? undefined,
      position,
      docState: original.docState,
      plainTextContent: original.plainTextContent,
    },
    overrideAccess: true,
  })

  revalidatePath(`/workspace/${workspaceSlug}`)
  return copy.id
}

export async function movePage({
  pageId,
  workspaceId,
  workspaceSlug,
  newParentPageId,
  placement,
  referenceId,
}: {
  pageId: number
  workspaceId: number
  workspaceSlug: string
  newParentPageId: number | null
  placement: 'before' | 'after' | 'end'
  referenceId?: number | null
}) {
  // Both ends: the page being moved, and the workspace whose sibling positions
  // this rewrites. They are normally the same workspace, and a caller who names
  // two different ones is refused by whichever they do not belong to.
  await requirePage(pageId, 'write')
  await requireWorkspace(workspaceId, 'write')
  const payload = await getPayloadClient()
  const all = (
    await payload.find({
      collection: 'pages',
      where: { workspace: { equals: workspaceId } },
      limit: 5000,
      overrideAccess: true,
    })
  ).docs

  if (newParentPageId !== null) {
    if (newParentPageId === pageId) return
    if (descendantIds(all, pageId).has(newParentPageId)) return
  }

  const siblings = all
    .filter((p) => p.id !== pageId && parentIdOf(p) === newParentPageId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))

  let insertAt = siblings.length
  if (placement !== 'end' && referenceId != null) {
    const refIndex = siblings.findIndex((p) => p.id === referenceId)
    if (refIndex !== -1) insertAt = placement === 'before' ? refIndex : refIndex + 1
  }

  siblings.splice(insertAt, 0, { id: pageId } as Page)

  await Promise.all(
    siblings.map((p, index) =>
      payload.update({
        collection: 'pages',
        id: p.id,
        data: {
          position: (index + 1) * 10,
          ...(p.id === pageId ? { parentPage: newParentPageId } : {}),
        },
        overrideAccess: true,
      }),
    ),
  )

  revalidatePath(`/workspace/${workspaceSlug}`)
}

/**
 * The suggestion actions' access check, now delegated to `lib/permissions`.
 *
 * PHASE 0 — this used to read `workspace.owner` and `workspace.members`
 * directly, which is the ad-hoc boolean `lib/permissions/model.ts` was written
 * to replace: it could not tell a viewer from an editor, so somebody added to a
 * workspace read-only could accept or reject an agent's edits to its documents.
 * `workspace-members` is now authoritative and the backfill is complete —
 * verified against this database, every legacy `owner`/`members` pair has a row
 * — so this is strictly stronger than what it replaces rather than a different
 * set of people.
 *
 * The `payload` parameter is kept so the four callers need no edit; it is
 * unused now that the lookup lives behind `requirePage`.
 */
async function assertPageAccess(
  _payload: Awaited<ReturnType<typeof getPayloadClient>>,
  pageId: number,
  _userId: number,
  verb: Verb = 'write',
) {
  await requirePage(pageId, verb)
}

/** ROADMAP B3.1 (Batch B-2, suggestions mode) — read side of the
 * pending-suggestions bar: every run with a still-pending page subtree on
 * this page, polled from `components/editor/BlockSuiteEditor.tsx` (for the
 * pending-block visual treatment) and `suggestion-bar.tsx` (for the bar
 * itself) independently, same "decoupled, each polls what it needs" pattern
 * `affine-run-card`'s own polling already uses elsewhere in this editor. */
export async function listPendingSuggestionsForPage(
  pageId: number,
): Promise<{ runId: number; subtreeBlockId: string; createdAt: string }[]> {
  if (!Number.isSafeInteger(pageId) || pageId < 1) throw new Error('A valid page id is required.')
  const [user, payload] = await Promise.all([getCurrentPayloadUser(), getPayloadClient()])
  if (!user) throw new Error('You must be logged in.')
  await assertPageAccess(payload, pageId, user.id, 'read')
  const runs = await listPendingSuggestionRunsForPage(pageId)
  return runs
    .filter((run): run is Run & { pageSubtreeBlockId: string } => run.pageSubtreeBlockId !== null)
    .map((run) => ({ runId: run.id, subtreeBlockId: run.pageSubtreeBlockId, createdAt: run.createdAt }))
}

/** ROADMAP B3.1 (Batch B-2, suggestions mode) — the "Accept all" action on a
 * page's pending-suggestions bar (`components/editor/suggestions/suggestion-bar.tsx`).
 * Whole-run granularity: see `lib/agent-suggestions.ts` for why. */
export async function acceptSuggestionRun(runId: number): Promise<void> {
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('A valid run id is required.')
  const [user, payload] = await Promise.all([getCurrentPayloadUser(), getPayloadClient()])
  if (!user) throw new Error('You must be logged in.')
  const run = await getRun(runId)
  if (!run || !run.pageId) throw new Error('Run not found or has no page.')
  await assertPageAccess(payload, run.pageId, user.id)
  await acceptRunSuggestions(runId)
}

/** "Reject all" — deletes the run's whole page subtree. See `lib/agent-suggestions.ts`. */
export async function rejectSuggestionRun(runId: number): Promise<void> {
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('A valid run id is required.')
  const [user, payload] = await Promise.all([getCurrentPayloadUser(), getPayloadClient()])
  if (!user) throw new Error('You must be logged in.')
  const run = await getRun(runId)
  if (!run || !run.pageId) throw new Error('Run not found or has no page.')
  await assertPageAccess(payload, run.pageId, user.id)
  await rejectRunSuggestions(payload, runId)
}
