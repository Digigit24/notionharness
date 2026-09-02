'use server'

import type { Where } from 'payload'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import type { SavedView } from '@/payload-types'
import type { SavedViewScope } from '@/collections/SavedViews'
import { DEFAULT_TASK_VIEW_CONFIG, type TaskViewConfig } from '@/lib/task-views/types'

// ROADMAP B-4 "Work" — CRUD for saved task views (collections/SavedViews.ts).
// Scoping is enforced server-side, never trusted from the client, same rule
// AGENTS.md already states for approvals ("Approval identity must always
// come from the authenticated session; never trust a client-supplied user
// id or header") — a 'mine' view is only ever readable/writable by its
// owner, resolved here via `getCurrentPayloadUser()`, not a client-passed id.
//
// NOTE — this collection is written but not yet migrated (see
// collections/SavedViews.ts's header comment). Every function below will
// throw a real Postgres "relation \"saved_views\" does not exist" error
// until a human runs `migrations/20260902_120000_saved_views.ts`. That's the
// intended, honest failure mode for this batch, not a bug to route around.

/** Lists every saved view visible to the current request for this board:
 * every workspace-scoped view, every project-scoped view for `projectId`
 * (if given — the plain workspace-wide Tasks page has none), and every
 * 'mine' view owned by the logged-in user. */
export async function listSavedViews({
  workspaceId,
  projectId = null,
}: {
  workspaceId: number
  projectId?: number | null
}): Promise<SavedView[]> {
  const [payload, user] = await Promise.all([getPayloadClient(), getCurrentPayloadUser()])

  const orConditions: Where[] = [{ scope: { equals: 'workspace' } }]
  if (projectId != null) {
    orConditions.push({ and: [{ scope: { equals: 'project' } }, { project: { equals: projectId } }] })
  }
  if (user) {
    orConditions.push({ and: [{ scope: { equals: 'mine' } }, { owner: { equals: user.id } }] })
  }

  const result = await payload.find({
    collection: 'saved-views',
    where: { and: [{ workspace: { equals: workspaceId } }, { or: orConditions }] },
    sort: 'name',
    limit: 200,
    depth: 0,
    overrideAccess: true,
  })
  return result.docs
}

export async function createSavedView({
  workspaceId,
  projectId,
  name,
  scope,
  config,
}: {
  workspaceId: number
  /** Required when `scope === 'project'`. */
  projectId?: number | null
  name: string
  scope: SavedViewScope
  config: TaskViewConfig
}): Promise<SavedView> {
  const [payload, user] = await Promise.all([getPayloadClient(), getCurrentPayloadUser()])
  if (!user) throw new Error('You must be logged in to save a view.')
  if (scope === 'project' && !projectId) throw new Error("A project-scoped view needs a project.")

  return payload.create({
    collection: 'saved-views',
    data: {
      name: name.trim() || 'Untitled view',
      scope,
      workspace: workspaceId,
      project: scope === 'project' ? projectId : null,
      owner: scope === 'mine' ? user.id : null,
      createdBy: user.id,
      config,
    },
    overrideAccess: true,
  })
}

async function assertCanWrite(view: SavedView, userId: number): Promise<void> {
  if (view.scope === 'mine') {
    const ownerId = typeof view.owner === 'object' ? view.owner?.id : view.owner
    if (ownerId !== userId) throw new Error('This view is private to another user.')
  }
}

export async function updateSavedView({
  id,
  name,
  config,
}: {
  id: number
  name?: string
  config?: TaskViewConfig
}): Promise<SavedView> {
  const [payload, user] = await Promise.all([getPayloadClient(), getCurrentPayloadUser()])
  if (!user) throw new Error('You must be logged in to update a view.')

  const existing = await payload.findByID({ collection: 'saved-views', id, depth: 0, overrideAccess: true })
  await assertCanWrite(existing, user.id)

  return payload.update({
    collection: 'saved-views',
    id,
    data: {
      ...(name !== undefined ? { name: name.trim() || existing.name } : {}),
      ...(config !== undefined ? { config } : {}),
    },
    overrideAccess: true,
  })
}

export async function deleteSavedView(id: number): Promise<void> {
  const [payload, user] = await Promise.all([getPayloadClient(), getCurrentPayloadUser()])
  if (!user) throw new Error('You must be logged in to delete a view.')

  const existing = await payload.findByID({ collection: 'saved-views', id, depth: 0, overrideAccess: true })
  await assertCanWrite(existing, user.id)

  await payload.delete({ collection: 'saved-views', id, overrideAccess: true })
}

/** Reads a saved view's `config` back as a `TaskViewConfig`, defaulting
 * anything the stored blob is missing (e.g. an older saved view predating a
 * newly added config field) to `DEFAULT_TASK_VIEW_CONFIG`'s value — the
 * `config` json field is opaque to Payload, so this is the one place that
 * gives it real shape. */
export function savedViewConfig(view: SavedView): TaskViewConfig {
  const raw = (view.config ?? {}) as Partial<TaskViewConfig>
  return {
    view: raw.view ?? DEFAULT_TASK_VIEW_CONFIG.view,
    filters: { ...DEFAULT_TASK_VIEW_CONFIG.filters, ...raw.filters },
    sort: raw.sort ?? DEFAULT_TASK_VIEW_CONFIG.sort,
    groupBy: raw.groupBy ?? DEFAULT_TASK_VIEW_CONFIG.groupBy,
    columns: { ...DEFAULT_TASK_VIEW_CONFIG.columns, ...raw.columns },
    density: raw.density ?? DEFAULT_TASK_VIEW_CONFIG.density,
  }
}
