'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { descendantIds } from '@/lib/tree'
import { applyDocSync } from '@/lib/blocksuite-doc'
import type { Page } from '@/payload-types'

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
  const position = await nextPosition(payload, workspaceId, parentPageId ?? null)

  const page = await payload.create({
    collection: 'pages',
    data: {
      title: 'Untitled',
      workspace: workspaceId,
      parentPage: parentPageId ?? undefined,
      position,
    },
    overrideAccess: true,
  })

  revalidatePath(`/workspace/${workspaceSlug}`)
  redirect(`/workspace/${workspaceSlug}/p/${page.id}`)
}

export async function renamePage(pageId: number, workspaceSlug: string, title: string) {
  const payload = await getPayloadClient()
  await payload.update({
    collection: 'pages',
    id: pageId,
    data: { title: title || 'Untitled' },
    overrideAccess: true,
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
