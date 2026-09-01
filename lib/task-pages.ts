import type { Payload } from 'payload'
import { relId } from '@/lib/activity'

/**
 * Resolves a task's linked document (ROADMAP 6.1 — "the task's document"),
 * creating and linking one the first time it's needed rather than on every
 * task's creation (lead-confirmed decision: a task an agent never touches
 * should never get a page nobody opens). Safe to call repeatedly — a task
 * that already has a `page` just returns its id.
 */
export async function ensureTaskPage(payload: Payload, taskId: number): Promise<number> {
  const task = await payload.findByID({ collection: 'tasks', id: taskId, overrideAccess: true, depth: 0 })
  const existingPageId = relId(task.page)
  if (existingPageId) return existingPageId

  const workspaceId = relId(task.workspace)
  if (!workspaceId) {
    throw new Error(`Task ${taskId} has no workspace; cannot create its document.`)
  }

  const page = await payload.create({
    collection: 'pages',
    data: { title: task.title || 'Untitled', workspace: workspaceId },
    overrideAccess: true,
  })
  await payload.update({ collection: 'tasks', id: taskId, data: { page: page.id }, overrideAccess: true })
  return page.id
}
