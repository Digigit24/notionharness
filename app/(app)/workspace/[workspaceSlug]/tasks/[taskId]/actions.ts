'use server'

// ROADMAP B-1 "Detail" — task-detail-page-scoped server actions. Kept out of
// the sibling `tasks/actions.ts` (board-scoped) the same way the board file
// itself notes for `getTaskActivity`: these are read/write surfaces this
// page alone needs, not the whole board.

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { recordActivity } from '@/lib/activity'
import { ensureTaskPage } from '@/lib/task-pages'
import { enqueueRun, type Run } from '@/lib/broker'
import { createTask } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import type { Comment, Task } from '@/payload-types'

function taskDetailPath(workspaceSlug: string, taskId: number) {
  return `/workspace/${workspaceSlug}/tasks/${taskId}`
}

// ---------------------------------------------------------------------------
// Work tab — comments (the "Enter" verb of the composer).
// ---------------------------------------------------------------------------

export async function listTaskComments(taskId: number): Promise<Comment[]> {
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'comments',
    where: { task: { equals: taskId } },
    sort: 'createdAt',
    limit: 200,
    depth: 1,
    overrideAccess: true,
  })
  return result.docs
}

export async function createTaskComment({
  taskId,
  workspaceSlug,
  body,
}: {
  taskId: number
  workspaceSlug: string
  body: string
}): Promise<Comment> {
  const text = body.trim()
  if (!text) throw new Error('Comment cannot be empty.')
  const payload = await getPayloadClient()
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in to comment.')

  const comment = await payload.create({
    collection: 'comments',
    data: { task: taskId, author: user.id, body: text },
    depth: 1,
    overrideAccess: true,
  })

  try {
    await recordActivity({
      payload,
      entityType: 'task',
      entityId: String(taskId),
      actor: user.id,
      action: 'commented',
      details: { commentId: comment.id },
    })
  } catch (err) {
    console.error('[task-detail] Failed to record comment activity.', err)
  }

  revalidatePath(taskDetailPath(workspaceSlug, taskId))
  return comment
}

// ---------------------------------------------------------------------------
// Work tab — runs (the "⌘↵" verb of the composer). Same enqueue primitive
// the board's agent-assignment flow already uses (see tasks/actions.ts's
// `updateTaskFields`); this just exposes it as an explicit action so the
// composer can start a run without reassigning the task's agent field.
// ---------------------------------------------------------------------------

export async function startTaskRun({
  taskId,
  workspaceSlug,
  agentId,
  prompt,
}: {
  taskId: number
  workspaceSlug: string
  agentId: number
  prompt?: string
}): Promise<Run> {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in to start a run.')

  const run = await enqueueRun({
    taskId,
    agentId,
    originatorUser: user.id,
    accountableUser: user.id,
    prompt: prompt?.trim() ? prompt.trim() : null,
  })

  try {
    const payload = await getPayloadClient()
    await recordActivity({
      payload,
      entityType: 'task',
      entityId: String(taskId),
      actor: user.id,
      action: 'run_started',
      details: { runId: run.id, agentId },
    })
  } catch (err) {
    console.error('[task-detail] Failed to record run-started activity.', err)
  }

  revalidatePath(taskDetailPath(workspaceSlug, taskId))
  return run
}

// ---------------------------------------------------------------------------
// Work tab — the task's document. `ensureTaskPage` (lib/task-pages.ts) is
// the existing lazy create-or-return primitive from ROADMAP 6.1; this just
// wraps it with this page's revalidation.
// ---------------------------------------------------------------------------

export async function ensureTaskDocument(taskId: number, workspaceSlug: string): Promise<number> {
  const payload = await getPayloadClient()
  const pageId = await ensureTaskPage(payload, taskId)
  revalidatePath(taskDetailPath(workspaceSlug, taskId))
  return pageId
}

// ---------------------------------------------------------------------------
// Sub-tasks tab. Tasks has no `parentTask` field (checked `collections/
// Tasks.ts`) — parent/child is modeled through the existing `task-links`
// collection's `parentOf` link type (`collections/TaskLinks.ts`), not a new
// field. Creation reuses the board's own `createTask` action (position,
// activity, auto-follow all already handled there) and adds one link row.
// ---------------------------------------------------------------------------

export async function listSubtasks(taskId: number): Promise<Task[]> {
  const payload = await getPayloadClient()
  const links = await payload.find({
    collection: 'task-links',
    where: { fromTask: { equals: taskId }, linkType: { equals: 'parentOf' } },
    limit: 200,
    depth: 1,
    overrideAccess: true,
  })
  return links.docs
    .map((link) => (typeof link.toTask === 'object' ? link.toTask : null))
    .filter((t): t is Task => t !== null)
}

export async function createSubtask({
  parentTaskId,
  workspaceId,
  workspaceSlug,
  statusId,
  title,
}: {
  parentTaskId: number
  workspaceId: number
  workspaceSlug: string
  statusId: number
  title: string
}): Promise<Task> {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in to create a sub-task.')

  const task = await createTask({
    workspaceId,
    workspaceSlug,
    statusId,
    title,
    createdById: user.id,
  })

  const payload = await getPayloadClient()
  await payload.create({
    collection: 'task-links',
    data: { fromTask: parentTaskId, toTask: task.id, linkType: 'parentOf' },
    overrideAccess: true,
  })

  revalidatePath(taskDetailPath(workspaceSlug, parentTaskId))
  return task
}
