/**
 * ROADMAP B-4.1 — the shared data/filter layer Board, List and Table all
 * consume identically. This module owns the *model* (what a filter/sort/
 * group setting means) as plain, framework-agnostic types and pure
 * functions — no React, no Payload client. Two things read it:
 *
 * - `app/(app)/workspace/[workspaceSlug]/tasks/actions.ts`'s `getTasksForView`
 *   server action uses `buildTasksWhere` to turn the same filter model into a
 *   Payload `where` clause for a real cross-column query.
 * - `components/tasks/use-task-view-data.ts` (the client hook) uses
 *   `taskMatchesFilters`/`sortTasks`/`groupTasks` to apply the *same* model
 *   client-side, over the board's already-fetched per-column cache, so a
 *   filter set means the same thing whether it's narrowing an in-memory
 *   board column or a fresh server query for List/Table.
 *
 * Extracted first, per the plan's own risk note: "extract the data layer
 * first, keep the board working on it, then add list and table."
 */
import type { Where } from 'payload'
import type { Task, TaskStatus } from '@/payload-types'

// ---------------------------------------------------------------------------
// Filter model
// ---------------------------------------------------------------------------

/** `'unassigned'` / `'none'` are real, first-class filter values (a task
 * with a null relationship), not the absence of a filter — the absence of a
 * filter is the array being `null`. */
export interface TaskFilters {
  statusIds: number[] | null
  assigneeIds: (number | 'unassigned')[] | null
  agentIds: (number | 'none')[] | null
  projectIds: (number | 'none')[] | null
  /** Case-insensitive title substring match. `''` = no filter. */
  query: string
}

export const EMPTY_FILTERS: TaskFilters = {
  statusIds: null,
  assigneeIds: null,
  agentIds: null,
  projectIds: null,
  query: '',
}

export function isFiltersEmpty(filters: TaskFilters): boolean {
  return (
    !filters.statusIds &&
    !filters.assigneeIds &&
    !filters.agentIds &&
    !filters.projectIds &&
    filters.query.trim() === ''
  )
}

// ---------------------------------------------------------------------------
// Sort model
// ---------------------------------------------------------------------------

export type TaskSortField = 'position' | 'title' | 'updatedAt' | 'lastActivityAt'

export interface TaskSort {
  field: TaskSortField
  direction: 'asc' | 'desc'
}

export const DEFAULT_SORT: TaskSort = { field: 'position', direction: 'asc' }

export const SORT_FIELD_LABELS: Record<TaskSortField, string> = {
  position: 'Manual order',
  title: 'Title',
  updatedAt: 'Last updated',
  lastActivityAt: 'Last activity',
}

// ---------------------------------------------------------------------------
// Group model
// ---------------------------------------------------------------------------

export type TaskGroupBy = 'status' | 'assignee' | 'project' | 'none'

export const GROUP_BY_LABELS: Record<TaskGroupBy, string> = {
  status: 'Status',
  assignee: 'Assignee',
  project: 'Project',
  none: 'No grouping',
}

export interface TaskGroup {
  key: string
  label: string
  tasks: Task[]
  /** Present only when `groupBy === 'status'` — lets a consumer read the
   * status's `color`/`category` for a chip, same as the board column header. */
  status?: TaskStatus
}

// ---------------------------------------------------------------------------
// Field extraction helpers (shared by the client predicate/comparator below
// AND by anything rendering a cell — one source of truth for "what a task's
// assignee/project *is*" regardless of relationship depth).
// ---------------------------------------------------------------------------

function relId(value: number | { id: number } | null | undefined): number | null {
  if (value == null) return null
  return typeof value === 'number' ? value : value.id
}

export function taskStatusId(task: Task): number {
  return typeof task.status === 'number' ? task.status : task.status.id
}

export function taskAssigneeId(task: Task): number | null {
  return relId(task.assignee)
}

export function taskAgentId(task: Task): number | null {
  return relId(task.agent)
}

export function taskProjectId(task: Task): number | null {
  return relId(task.project)
}

export function taskAssigneeLabel(task: Task): string | null {
  return typeof task.assignee === 'object' && task.assignee ? task.assignee.name || task.assignee.email : null
}

export function taskProjectLabel(task: Task): string | null {
  return typeof task.project === 'object' && task.project ? task.project.name || null : null
}

// ---------------------------------------------------------------------------
// Server-side query builder
// ---------------------------------------------------------------------------

export function buildTasksWhere(workspaceId: number, filters: TaskFilters): Where {
  const and: Where[] = [{ workspace: { equals: workspaceId } }]

  // `null` = unrestricted (every status); a non-null array (including an
  // explicit `[]`, if a caller ever produces one — e.g. a "deselect every
  // status chip" UI state) restricts to exactly those, `in: []` correctly
  // matching zero rows rather than being silently treated as "no filter."
  if (filters.statusIds !== null) {
    and.push({ status: { in: filters.statusIds } })
  }

  const relationshipClause = (
    field: 'assignee' | 'agent' | 'project',
    values: (number | 'unassigned' | 'none')[] | null,
  ) => {
    if (values === null) return
    if (values.length === 0) {
      // Same "explicit empty = match nothing" case as statusIds above.
      and.push({ [field]: { in: [] } })
      return
    }
    const ids = values.filter((v): v is number => typeof v === 'number')
    const wantsEmpty = values.some((v) => v === 'unassigned' || v === 'none')
    const or: Where[] = []
    if (ids.length > 0) or.push({ [field]: { in: ids } })
    if (wantsEmpty) or.push({ [field]: { exists: false } })
    if (or.length > 0) and.push(or.length === 1 ? or[0] : { or })
  }
  relationshipClause('assignee', filters.assigneeIds)
  relationshipClause('agent', filters.agentIds)
  relationshipClause('project', filters.projectIds)

  const query = filters.query.trim()
  if (query) and.push({ title: { like: query } })

  return { and }
}

/** The client-side twin of `buildTasksWhere` — same semantics, evaluated
 * in-memory over an already-fetched task, e.g. the board's per-column cache. */
export function taskMatchesFilters(task: Task, filters: TaskFilters): boolean {
  if (filters.statusIds && !filters.statusIds.includes(taskStatusId(task))) return false

  const matchesRelation = (
    values: (number | 'unassigned' | 'none')[] | null,
    id: number | null,
  ): boolean => {
    if (values === null) return true
    return values.some((v) => (v === 'unassigned' || v === 'none' ? id === null : v === id))
  }
  if (!matchesRelation(filters.assigneeIds, taskAssigneeId(task))) return false
  if (!matchesRelation(filters.agentIds, taskAgentId(task))) return false
  if (!matchesRelation(filters.projectIds, taskProjectId(task))) return false

  const query = filters.query.trim().toLowerCase()
  if (query && !(task.title || '').toLowerCase().includes(query)) return false

  return true
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortValue(task: Task, field: TaskSortField): string | number {
  switch (field) {
    case 'position':
      return task.position ?? 0
    case 'title':
      return (task.title || '').toLowerCase()
    case 'updatedAt':
      return task.updatedAt ? new Date(task.updatedAt).getTime() : 0
    case 'lastActivityAt':
      return task.lastActivityAt ? new Date(task.lastActivityAt).getTime() : 0
  }
}

export function compareTasks(a: Task, b: Task, sort: TaskSort): number {
  const av = sortValue(a, sort.field)
  const bv = sortValue(b, sort.field)
  const cmp = av < bv ? -1 : av > bv ? 1 : 0
  return sort.direction === 'asc' ? cmp : -cmp
}

export function sortTasks(tasks: Task[], sort: TaskSort): Task[] {
  return [...tasks].sort((a, b) => compareTasks(a, b, sort))
}

/** Payload `sort` string for `buildTasksWhere`'s companion query. */
export function payloadSortString(sort: TaskSort): string {
  return `${sort.direction === 'desc' ? '-' : ''}${sort.field}`
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export function groupTasks(tasks: Task[], groupBy: TaskGroupBy, statuses: TaskStatus[]): TaskGroup[] {
  if (groupBy === 'none') {
    return tasks.length > 0 ? [{ key: 'all', label: 'All tasks', tasks }] : []
  }

  if (groupBy === 'status') {
    const byStatus = new Map<number, Task[]>()
    for (const task of tasks) {
      const id = taskStatusId(task)
      const bucket = byStatus.get(id)
      if (bucket) bucket.push(task)
      else byStatus.set(id, [task])
    }
    // Ordered by the statuses list's own `position` (same convention as the
    // board's columns), only emitting groups that actually have tasks.
    return statuses
      .filter((status) => (byStatus.get(status.id)?.length ?? 0) > 0)
      .map((status) => ({ key: `status-${status.id}`, label: status.name, tasks: byStatus.get(status.id) ?? [], status }))
  }

  const groups = new Map<string, { label: string; tasks: Task[] }>()
  const UNASSIGNED_KEY = groupBy === 'assignee' ? 'unassigned' : 'no-project'
  const unassignedLabel = groupBy === 'assignee' ? 'Unassigned' : 'No project'
  for (const task of tasks) {
    const id = groupBy === 'assignee' ? taskAssigneeId(task) : taskProjectId(task)
    const label = (groupBy === 'assignee' ? taskAssigneeLabel(task) : taskProjectLabel(task)) ?? unassignedLabel
    const key = id === null ? UNASSIGNED_KEY : `${groupBy}-${id}`
    const bucket = groups.get(key)
    if (bucket) bucket.tasks.push(task)
    else groups.set(key, { label, tasks: [task] })
  }
  // Named groups first (stable insertion order = first-appearance in the
  // already-sorted task list), the unassigned/no-project bucket always last.
  const named = [...groups.entries()].filter(([key]) => key !== UNASSIGNED_KEY)
  const rest = groups.get(UNASSIGNED_KEY)
  return [
    ...named.map(([key, group]) => ({ key, label: group.label, tasks: group.tasks })),
    ...(rest ? [{ key: UNASSIGNED_KEY, label: rest.label, tasks: rest.tasks }] : []),
  ]
}
