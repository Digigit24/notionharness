'use server'

// B0: Frame — server actions backing the ⌘K command bar's navigate mode
// (cross-entity substring search) and act mode's pickers (which task/user/
// agent/status to act on). The actual mutations act mode performs are NOT
// reimplemented here — `createTask` and `updateTaskFields` from the tasks
// route's own `actions.ts` are imported and called directly from the
// command bar client component, per AGENTS.md's "use the real existing
// server action" rule. This file only adds what didn't already exist:
// cross-entity search, and read-only picker lists.

import type { Where } from 'payload'
import { getPayloadClient } from '@/lib/payload'
import { listActiveRunsForWorkspace } from '@/lib/broker'
import { createTask, updateTaskFields } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import type { Agent, Page, Project, Task, TaskStatus, User } from '@/payload-types'

const RESULTS_PER_CATEGORY = 5

export interface RunResult {
  id: number
  status: string
  taskId: number | null
  taskTitle: string | null
}

export interface CommandBarSearchResult {
  pages: Page[]
  tasks: Task[]
  agents: Agent[]
  runs: RunResult[]
}

/**
 * SEAM (B1.3): every branch below is "Payload `find` with a `like` `where`
 * clause, capped at `RESULTS_PER_CATEGORY`" — explicitly not the Postgres
 * full-text search B1.3 will build over pages/tasks/projects/agents/
 * skills/run transcripts/comments. When that lands, each of these four
 * lookups (and the runs branch, which can't use Payload `find` at all —
 * `runs` lives in the raw-`pg` broker per AGENTS.md's D5) can be swapped
 * independently without touching this function's signature, the caller in
 * `command-bar.tsx`, or the `NavigateResultItem` shape it renders into.
 */
export async function searchCommandBar({
  workspaceId,
  query,
}: {
  workspaceId: number
  query: string
}): Promise<CommandBarSearchResult> {
  const q = query.trim()
  if (!q) return { pages: [], tasks: [], agents: [], runs: [] }

  const payload = await getPayloadClient()

  const [pages, tasks, agents, runs] = await Promise.all([
    payload
      .find({
        collection: 'pages',
        where: {
          and: [{ workspace: { equals: workspaceId } }, { isArchived: { equals: false } }, { title: { like: q } }],
        },
        sort: '-updatedAt',
        limit: RESULTS_PER_CATEGORY,
        depth: 0,
        overrideAccess: true,
      })
      .then((r) => r.docs),
    searchTasks(payload, workspaceId, q, RESULTS_PER_CATEGORY),
    payload
      .find({
        collection: 'agents',
        where: { and: [{ workspace: { equals: workspaceId } }, { name: { like: q } }] },
        sort: 'name',
        limit: RESULTS_PER_CATEGORY,
        depth: 0,
        overrideAccess: true,
      })
      .then((r) => r.docs),
    searchRuns(payload, workspaceId, q),
  ])

  return { pages, tasks, agents, runs }
}

async function searchTasks(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  workspaceId: number,
  query: string,
  limit: number,
): Promise<Task[]> {
  const where: Where = { and: [{ workspace: { equals: workspaceId } }, { title: { like: query } }] }
  const result = await payload.find({
    collection: 'tasks',
    where,
    sort: '-lastActivityAt',
    limit,
    depth: 0,
    overrideAccess: true,
  })
  return result.docs
}

/**
 * Runs have no title/name field to substring-match against at all — they're
 * raw-`pg` rows (task id, agent id, status; see `lib/broker/types.ts`), not
 * a Payload collection. This is a deliberately narrow first pass: pull this
 * workspace's *active* runs (already a small, bounded set — the same query
 * the active-runs board uses) and match the query against the run's id or
 * its status, rather than inventing a fake text field. A run whose id or
 * status doesn't contain the typed text just won't show up; that's an
 * honest limitation of "runs have no name," not a shortcut this pass took.
 */
async function searchRuns(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  workspaceId: number,
  query: string,
): Promise<RunResult[]> {
  const runs = await listActiveRunsForWorkspace(workspaceId)
  const q = query.toLowerCase()
  const matched = runs
    .filter((r) => String(r.id).includes(q) || r.status.toLowerCase().includes(q))
    .slice(0, RESULTS_PER_CATEGORY)
  if (matched.length === 0) return []

  const taskIds = [...new Set(matched.map((r) => r.taskId).filter((id): id is number => id !== null))]
  const taskTitleById = new Map<number, string>()
  if (taskIds.length > 0) {
    const taskDocs = await payload.find({
      collection: 'tasks',
      where: { id: { in: taskIds } },
      limit: taskIds.length,
      depth: 0,
      overrideAccess: true,
    })
    for (const t of taskDocs.docs) taskTitleById.set(t.id, t.title)
  }

  return matched.map((r) => ({
    id: r.id,
    status: r.status,
    taskId: r.taskId,
    taskTitle: r.taskId !== null ? taskTitleById.get(r.taskId) ?? null : null,
  }))
}

/** Act-mode task picker (Assign / Start run / Change status all begin by picking a task). */
export async function searchTasksForPicker(workspaceId: number, query: string): Promise<Task[]> {
  const payload = await getPayloadClient()
  const q = query.trim()
  const where: Where = q
    ? { and: [{ workspace: { equals: workspaceId } }, { title: { like: q } }] }
    : { workspace: { equals: workspaceId } }
  const result = await payload.find({
    collection: 'tasks',
    where,
    sort: '-lastActivityAt',
    limit: 8,
    depth: 0,
    overrideAccess: true,
  })
  return result.docs
}

/** Act-mode agent picker (Start run) — enabled agents only, mirrors the tasks board's own agent fetch. */
export async function listWorkspaceAgents(workspaceId: number): Promise<Agent[]> {
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'agents',
    where: { and: [{ workspace: { equals: workspaceId } }, { enabled: { equals: true } }] },
    sort: 'name',
    limit: 100,
    depth: 0,
    overrideAccess: true,
  })
  return result.docs
}

/** Act-mode status picker (Change status), ordered the same as the task board's columns. */
export async function listWorkspaceStatuses(workspaceId: number): Promise<TaskStatus[]> {
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'task-statuses',
    where: { workspace: { equals: workspaceId } },
    sort: 'position',
    limit: 100,
    overrideAccess: true,
  })
  return result.docs
}

/** Create-task's optional project field. */
export async function listWorkspaceProjects(workspaceId: number): Promise<Project[]> {
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'projects',
    where: { workspace: { equals: workspaceId } },
    sort: 'name',
    limit: 100,
    overrideAccess: true,
  })
  return result.docs
}

/**
 * Act-mode assign picker. Users aren't workspace-scoped as their own
 * field — membership lives on `Workspace.owner`/`Workspace.members` — so
 * this resolves the same way `tasks/page.tsx` already does for the task
 * board's assignee dropdown (that logic isn't factored into a shared
 * helper anywhere in this codebase today; this mirrors it rather than
 * introducing a new shared module this pass doesn't otherwise need).
 */
export async function listAssignableUsers(workspaceId: number): Promise<User[]> {
  const payload = await getPayloadClient()
  const workspace = await payload.findByID({ collection: 'workspaces', id: workspaceId, overrideAccess: true })
  const memberEntries = [workspace.owner, ...(workspace.members ?? [])]
  const users: User[] = []
  const seenIds = new Set<number>()
  for (const entry of memberEntries) {
    if (entry == null) continue
    const id = typeof entry === 'number' ? entry : entry.id
    if (seenIds.has(id)) continue
    seenIds.add(id)
    if (typeof entry !== 'number') users.push(entry)
  }
  const unresolvedIds = memberEntries
    .map((entry) => (typeof entry === 'number' ? entry : null))
    .filter((id): id is number => id !== null && !users.some((u) => u.id === id))
  if (unresolvedIds.length > 0) {
    const resolved = await payload.find({
      collection: 'users',
      where: { id: { in: unresolvedIds } },
      limit: unresolvedIds.length,
      overrideAccess: true,
    })
    users.push(...resolved.docs)
  }
  return users
}

/**
 * Act-mode "Create task". `createTask` (tasks route's own real action)
 * doesn't accept a project — this composes it with a follow-up
 * `updateTaskFields` call when a project was picked, rather than adding a
 * new field to the shared `createTask` action that other, unrelated
 * surfaces (the task board's own "new task" button) also call. Both calls
 * are the same real backing actions act mode's other three commands use;
 * nothing here is bespoke task-mutation logic.
 */
export async function quickCreateTask({
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
  projectId?: number | null
}): Promise<Task> {
  const task = await createTask({ workspaceId, workspaceSlug, statusId, title, createdById })
  if (!projectId) return task
  return updateTaskFields({ taskId: task.id, workspaceSlug, data: { project: projectId } })
}
