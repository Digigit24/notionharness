'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import type { Task } from '@/payload-types'
import { enqueueRun, listActiveRunsForWorkspace, listRunsForTask, listRunEvents } from '@/lib/broker'

async function nextColumnPosition(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  workspaceId: number,
  statusId: number,
) {
  const result = await payload.find({
    collection: 'tasks',
    where: { workspace: { equals: workspaceId }, status: { equals: statusId } },
    sort: '-position',
    limit: 1,
    overrideAccess: true,
  })
  return (result.docs[0]?.position ?? 0) + 10
}

export async function createTask({
  workspaceId,
  workspaceSlug,
  statusId,
  title,
  createdById,
  projectId,
}: {
  workspaceId: number
  workspaceSlug: string
  statusId: number
  title: string
  createdById: number
  /** ROADMAP B-1 — project detail page's "New task" primary action pre-fills
   * this instead of leaving the task unscoped. Optional so every other
   * caller (the plain Tasks board) is unaffected. */
  projectId?: number
}): Promise<Task> {
  const payload = await getPayloadClient()
  const position = await nextColumnPosition(payload, workspaceId, statusId)
  const task = await payload.create({
    collection: 'tasks',
    data: {
      title: title || 'Untitled',
      workspace: workspaceId,
      status: statusId,
      createdBy: createdById,
      position,
      ...(projectId ? { project: projectId } : {}),
    },
    overrideAccess: true,
  })
  revalidatePath(`/workspace/${workspaceSlug}/tasks`)
  if (projectId) revalidatePath(`/workspace/${workspaceSlug}/projects/${projectId}`)
  return task
}

// Drag-and-drop only moves a card between columns (status change), matching
// this codebase's one existing dnd-kit precedent (`components/database/
// kanban-board.tsx`) which is also column-level-only — dnd-kit/core alone
// (no `@dnd-kit/sortable`, not a dependency here) doesn't give a drop target
// more precise than "which column," so a dropped card is appended to the end
// of its new column rather than inserted at a specific index. Fine-grained
// intra-column reordering is a scoped follow-up if it turns out to matter.
export async function moveTaskToStatus({
  taskId,
  workspaceId,
  workspaceSlug,
  statusId,
}: {
  taskId: number
  workspaceId: number
  workspaceSlug: string
  statusId: number
}): Promise<Task> {
  const payload = await getPayloadClient()
  const [position, user] = await Promise.all([
    nextColumnPosition(payload, workspaceId, statusId),
    getCurrentPayloadUser(),
  ])
  const task = await payload.update({
    collection: 'tasks',
    id: taskId,
    data: { status: statusId, position },
    overrideAccess: true,
    // ROADMAP P2.6 — read by Tasks.ts's afterChange hook to attribute the
    // status_changed activity row to whoever dragged the card.
    context: { actorId: user?.id },
  })
  revalidatePath(`/workspace/${workspaceSlug}/tasks`)
  return task
}

export async function updateTaskFields({
  taskId,
  workspaceSlug,
  data,
}: {
  taskId: number
  workspaceSlug: string
  data: Partial<Pick<Task, 'title' | 'status' | 'assignee' | 'agent' | 'project'>>
}): Promise<Task> {
  const payload = await getPayloadClient()
  const user = await getCurrentPayloadUser()
  const before = await payload.findByID({ collection: 'tasks', id: taskId, depth: 0, overrideAccess: true })
  const task = await payload.update({
    collection: 'tasks',
    id: taskId,
    data,
    overrideAccess: true,
    context: { actorId: user?.id },
  })
  const beforeAgent = typeof before.agent === 'number' ? before.agent : before.agent?.id ?? null
  const afterAgent = typeof task.agent === 'number' ? task.agent : task.agent?.id ?? null
  if (afterAgent !== null && afterAgent !== beforeAgent && user?.id) {
    await enqueueRun({ taskId, agentId: afterAgent, originatorUser: user.id, accountableUser: user.id })
  }
  revalidatePath(`/workspace/${workspaceSlug}/tasks`)
  return task
}

export async function getTaskRuns(taskId: number) {
  return listRunsForTask(taskId)
}

export async function getActiveRunsForWorkspace(workspaceId: number) {
  return listActiveRunsForWorkspace(workspaceId)
}

export async function getRunMessages(runId: number) {
  return listRunEvents(runId)
}

export async function loadMoreTasks({
  workspaceId,
  statusId,
  offset,
  limit,
}: {
  workspaceId: number
  statusId: number
  offset: number
  limit: number
}): Promise<Task[]> {
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'tasks',
    where: { workspace: { equals: workspaceId }, status: { equals: statusId } },
    sort: 'position',
    limit,
    page: Math.floor(offset / limit) + 1,
    overrideAccess: true,
  })
  return result.docs
}

// Read-only — the task detail drawer's Activity tab. Not exported from the
// top-level `app/(app)/actions.ts` since it's scoped to this surface only.
export async function getTaskActivity(taskId: number) {
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'activity',
    where: { entityType: { equals: 'task' }, entityId: { equals: String(taskId) } },
    sort: '-createdAt',
    limit: 100,
    overrideAccess: true,
  })
  return result.docs
}
