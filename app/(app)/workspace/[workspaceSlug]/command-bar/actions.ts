'use server'

// B0: Frame — server actions backing the ⌘K command bar's navigate mode
// (cross-entity search) and act mode's pickers (which task/user/agent/
// status to act on). The actual mutations act mode performs are NOT
// reimplemented here — `createTask` and `updateTaskFields` from the tasks
// route's own `actions.ts` are imported and called directly from the
// command bar client component, per AGENTS.md's "use the real existing
// server action" rule. This file only adds what didn't already exist:
// cross-entity search, and read-only picker lists.
//
// B-3 "Surface" (B1.3): `searchCommandBar` below now runs real Postgres
// full-text search (`lib/search.ts`) instead of B0's `like`-based
// placeholder. See that file's top-of-file comment for the full-text
// approach (live `to_tsvector`, no migration) and its reasoning.

import type { Where } from 'payload'
import { getPayloadClient } from '@/lib/payload'
import {
  searchAgentIds,
  searchComments,
  searchPageIds,
  searchProjectIds,
  searchRunTranscripts,
  searchSkills,
  searchTaskIds,
  type CommentSearchResult,
  type RankedId,
  type RunTranscriptSearchResult,
  type SkillSearchResult,
} from '@/lib/search'
import type { NavigateProviderKey } from '@/components/command-bar/types'
import { createTask, updateTaskFields } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import type { Agent, Page, Project, Task, TaskStatus, User } from '@/payload-types'

// Plan's own guidance: "cap each group (e.g. 8)". Was 5 under the old
// `like`-query placeholder; bumped now that ranked full-text results are
// worth showing a few more of.
const RESULTS_PER_CATEGORY = 8

export type RunResult = RunTranscriptSearchResult

export interface CommandBarSearchResult {
  pages: Page[]
  tasks: Task[]
  projects: Project[]
  agents: Agent[]
  comments: CommentSearchResult[]
  runs: RunResult[]
  skills: SkillSearchResult[]
}

const EMPTY_RESULT: CommandBarSearchResult = {
  pages: [],
  tasks: [],
  projects: [],
  agents: [],
  comments: [],
  runs: [],
  skills: [],
}

/** Reorders Payload-hydrated docs to match a ranked-id list's order (the
 * `ts_rank` order the SQL query already computed) — `payload.find({ where:
 * { id: { in: [...] } } })` does not itself preserve `in`-list order. */
function orderByRank<T extends { id: number }>(docs: T[], ranked: RankedId[]): T[] {
  const byId = new Map(docs.map((d) => [d.id, d]))
  return ranked.map((r) => byId.get(r.id)).filter((d): d is T => d !== undefined)
}

/**
 * SEAM (B1.3, filled in): each category below is real Postgres full-text
 * search (`lib/search.ts`), not the B0 `like`-query placeholder. `types`
 * is additive — omitted (or `undefined`), every non-`skills` category runs;
 * passed (from the command bar's filter chips), only the named categories
 * run, which is also how `skills` (excluded from the default hot path —
 * see `lib/search.ts`'s `searchSkills` comment) ever gets queried at all.
 */
export async function searchCommandBar({
  workspaceId,
  query,
  types,
}: {
  workspaceId: number
  query: string
  types?: NavigateProviderKey['key'][]
}): Promise<CommandBarSearchResult> {
  const q = query.trim()
  if (!q) return EMPTY_RESULT

  const wants = (key: NavigateProviderKey['key']) => (types ? types.includes(key) : key !== 'skills')

  const [pageIds, taskIds, projectIds, agentIds, comments, runs, skills] = await Promise.all([
    wants('pages') ? searchPageIds(workspaceId, q, RESULTS_PER_CATEGORY) : Promise.resolve<RankedId[]>([]),
    wants('tasks') ? searchTaskIds(workspaceId, q, RESULTS_PER_CATEGORY) : Promise.resolve<RankedId[]>([]),
    wants('projects') ? searchProjectIds(workspaceId, q, RESULTS_PER_CATEGORY) : Promise.resolve<RankedId[]>([]),
    wants('agents') ? searchAgentIds(workspaceId, q, RESULTS_PER_CATEGORY) : Promise.resolve<RankedId[]>([]),
    wants('comments') ? searchComments(workspaceId, q, RESULTS_PER_CATEGORY) : Promise.resolve<CommentSearchResult[]>([]),
    wants('runs') ? searchRunTranscripts(workspaceId, q, RESULTS_PER_CATEGORY) : Promise.resolve<RunTranscriptSearchResult[]>([]),
    wants('skills') ? searchSkills(q, RESULTS_PER_CATEGORY) : Promise.resolve<SkillSearchResult[]>([]),
  ])

  const payload = await getPayloadClient()
  const [pageDocs, taskDocs, projectDocs, agentDocs] = await Promise.all([
    pageIds.length
      ? payload
          .find({ collection: 'pages', where: { id: { in: pageIds.map((r) => r.id) } }, limit: pageIds.length, depth: 0, overrideAccess: true })
          .then((r) => r.docs)
      : Promise.resolve<Page[]>([]),
    taskIds.length
      ? payload
          .find({ collection: 'tasks', where: { id: { in: taskIds.map((r) => r.id) } }, limit: taskIds.length, depth: 0, overrideAccess: true })
          .then((r) => r.docs)
      : Promise.resolve<Task[]>([]),
    projectIds.length
      ? payload
          .find({ collection: 'projects', where: { id: { in: projectIds.map((r) => r.id) } }, limit: projectIds.length, depth: 0, overrideAccess: true })
          .then((r) => r.docs)
      : Promise.resolve<Project[]>([]),
    agentIds.length
      ? payload
          .find({ collection: 'agents', where: { id: { in: agentIds.map((r) => r.id) } }, limit: agentIds.length, depth: 0, overrideAccess: true })
          .then((r) => r.docs)
      : Promise.resolve<Agent[]>([]),
  ])

  return {
    pages: orderByRank(pageDocs, pageIds),
    tasks: orderByRank(taskDocs, taskIds),
    projects: orderByRank(projectDocs, projectIds),
    agents: orderByRank(agentDocs, agentIds),
    comments,
    runs,
    skills,
  }
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
