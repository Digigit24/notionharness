'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import type { Task } from '@/payload-types'

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
}: {
  workspaceId: number
  workspaceSlug: string
  statusId: number
  title: string
  createdById: number
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
    },
    overrideAccess: true,
  })
  revalidatePath(`/workspace/${workspaceSlug}/tasks`)
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
  const position = await nextColumnPosition(payload, workspaceId, statusId)
  const task = await payload.update({
    collection: 'tasks',
    id: taskId,
    data: { status: statusId, position },
    overrideAccess: true,
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
  data: Partial<Pick<Task, 'title' | 'status' | 'assignee' | 'project'>>
}): Promise<Task> {
  const payload = await getPayloadClient()
  const task = await payload.update({
    collection: 'tasks',
    id: taskId,
    data,
    overrideAccess: true,
  })
  revalidatePath(`/workspace/${workspaceSlug}/tasks`)
  return task
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
