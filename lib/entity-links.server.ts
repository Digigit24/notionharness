// ROADMAP P2.6/P5.5/P6.5 - server-only "activity entity -> deep link" resolver.
//
// Split out from lib/entity-links.ts in P6.5 because the file's new Q2
// helpers (planHrefForTask, workHrefForRun, etc.) needed to be safe for
// `components/sidebar/mode-switcher.tsx` to import (it's a 'use client'
// component), and the static top-of-file `getRun` import here drags the
// raw `pg` client into webpack's client-bundle graph if everything lives
// in one file. The `.server.ts` suffix is Next's convention that forces
// this file out of any client bundle, even if someone later mistakenly
// tries to import it from a client component.
//
// Imported only by Server Components / Server Actions:
//   - app/(app)/notifications/actions.ts
//   - app/(app)/workspace/[workspaceSlug]/inbox/page.tsx
//
// The pure Q2 helpers + mode-default constants used by the sidebar's
// ModeSwitcher live in the client-safe sibling file lib/entity-links.ts.

import { getPayloadClient } from '@/lib/payload'
import { getRun } from '@/lib/broker/runs'
import type { Activity } from '@/payload-types'

type PayloadClient = Awaited<ReturnType<typeof getPayloadClient>>

// Defaults per docs/p6-5-plan-work-review-design.md:
//   - task    -> the task itself (highlighted in the tasks list)
//   - page    -> the page itself
//   - run     -> the run's review panel
//   - project -> the project detail route (ROADMAP B-1; previously null —
//                no detail route existed to land on)
//
// A few extra lookups per notification (task/page/run -> its workspace,
// for the slug in the URL) is an accepted cost for a "fetch when the
// panel opens, no real-time push" pass with a 30-item cap.
export async function hrefForEntity(
  payload: PayloadClient,
  entityType: Activity['entityType'],
  entityId: string,
): Promise<string | null> {
  const id = Number(entityId)
  if (!Number.isFinite(id)) return null

  if (entityType === 'task') {
    const task = await payload.findByID({ collection: 'tasks', id, overrideAccess: true, disableErrors: true }).catch(() => null)
    if (!task) return null
    const workspaceId = typeof task.workspace === 'number' ? task.workspace : task.workspace.id
    const workspace = await payload
      .findByID({ collection: 'workspaces', id: workspaceId, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    return workspace ? `/workspace/${workspace.slug}/tasks?task=${task.id}` : null
  }

  if (entityType === 'page') {
    const page = await payload.findByID({ collection: 'pages', id, overrideAccess: true, disableErrors: true }).catch(() => null)
    if (!page) return null
    const workspaceId = typeof page.workspace === 'number' ? page.workspace : page.workspace.id
    const workspace = await payload
      .findByID({ collection: 'workspaces', id: workspaceId, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    return workspace ? `/workspace/${workspace.slug}/p/${page.id}` : null
  }

  if (entityType === 'project') {
    const project = await payload.findByID({ collection: 'projects', id, overrideAccess: true, disableErrors: true }).catch(() => null)
    if (!project) return null
    const workspaceId = typeof project.workspace === 'number' ? project.workspace : project.workspace.id
    const workspace = await payload
      .findByID({ collection: 'workspaces', id: workspaceId, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    return workspace ? `/workspace/${workspace.slug}/projects/${project.id}` : null
  }

  if (entityType === 'run') {
    // Runs live in the broker (raw `pg`), not in Payload. Walk via the owning
    // task to recover the workspace - broker `runs` rows carry `task_id` and
    // `page_id` but not a workspace FK of their own.
    const run = await getRun(id).catch(() => null)
    if (!run?.taskId) return null
    const task = await payload
      .findByID({ collection: 'tasks', id: run.taskId, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    if (!task) return null
    const workspaceId = typeof task.workspace === 'number' ? task.workspace : task.workspace.id
    const workspace = await payload
      .findByID({ collection: 'workspaces', id: workspaceId, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    return workspace ? `/workspace/${workspace.slug}/runs/${run.id}/review` : null
  }

  return null
}
