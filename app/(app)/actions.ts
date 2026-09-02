'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { descendantIds } from '@/lib/tree'
import { applyDocSync } from '@/lib/blocksuite-doc'
import { enqueueRun, getRun, listRunEvents } from '@/lib/broker'
import type { Run, RunMessageRow } from '@/lib/broker/types'
import type { Page, TaskStatus } from '@/payload-types'

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
  const payload = await getPayloadClient()
  await payload.update({ collection: 'pages', id: pageId, data: { icon }, overrideAccess: true })
  revalidatePath(`/workspace/${workspaceSlug}`)
}

export async function setPageCover(pageId: number, workspaceSlug: string, coverImage: string | null) {
  const payload = await getPayloadClient()
  await payload.update({ collection: 'pages', id: pageId, data: { coverImage }, overrideAccess: true })
  revalidatePath(`/workspace/${workspaceSlug}`)
}

export async function toggleFavorite(pageId: number, workspaceSlug: string, value: boolean) {
  const payload = await getPayloadClient()
  await payload.update({ collection: 'pages', id: pageId, data: { isFavorite: value }, overrideAccess: true })
  revalidatePath(`/workspace/${workspaceSlug}`)
}

export async function toggleFullWidth(pageId: number, workspaceSlug: string, value: boolean) {
  const payload = await getPayloadClient()
  await payload.update({ collection: 'pages', id: pageId, data: { isFullWidth: value }, overrideAccess: true })
  // `'layout'` (not the default `'page'`) so this invalidates the currently-open
  // `/p/[pageId]` route too, not just the workspace index — a bare
  // `revalidatePath('/workspace/${workspaceSlug}')` only revalidates that exact
  // path, leaving whatever page the user is actually viewing stale.
  revalidatePath(`/workspace/${workspaceSlug}`, 'layout')
}

export async function toggleLocked(pageId: number, workspaceSlug: string, value: boolean) {
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
  const payload = await getPayloadClient()
  await applyDocSync(payload, pageId, update)
}

/** Queue work anchored to a page rather than a task (P6.2 block-anchored
 * threads). The prompt is persisted on the raw-pg run row so the dispatcher
 * can deliver it without depending on a Payload request or a second write.
 * Agent selection is intentionally separate: a later assignment step can set
 * agent_id before dispatch; this action never trusts a caller-supplied user.
 */
export async function enqueuePageRun(prompt: string, pageId: number): Promise<{ runId: number }> {
  const text = typeof prompt === 'string' ? prompt.trim() : ''
  if (!text || text.length > 20_000) throw new Error('A prompt between 1 and 20,000 characters is required.')
  if (!Number.isSafeInteger(pageId) || pageId < 1) throw new Error('A valid page id is required.')

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

  const run = await enqueueRun({
    taskId: null,
    agentId: null,
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
  const events = await listRunEvents(runId)
  return { run, events }
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
  const payload = await getPayloadClient()
  const ids = await subtreeIds(payload, workspaceId, pageId)
  await Promise.all(
    [...ids, pageId].map((id) => payload.delete({ collection: 'pages', id, overrideAccess: true })),
  )
  revalidatePath(`/workspace/${workspaceSlug}`)
}

export async function duplicatePage(pageId: number, workspaceSlug: string) {
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
