import { TASK_STATUS_CATEGORIES } from '@/collections/TaskStatuses'
import {
  taskMatchesFilters as taskMatchesTaskFilters,
  type TaskFilters,
  type TaskSortField,
} from '@/lib/task-views/data-layer'
import type { Task, TaskStatus } from '@/payload-types'

// ROADMAP B-4 "Work" — the tasks board/list/table's own filter/sort/group/
// column/density shape, used both for the ad-hoc (unsaved) view state a user
// is currently looking at and for what a saved view (collections/
// SavedViews.ts's `config` json field) persists.
//
// RECONCILED AT MERGE (2026-09-02): this file originally defined its own
// parallel `TaskViewSort`/`TaskViewSortField`/`TaskViewGroupBy`, built in
// isolation from the sibling `roadmap/b4-list-table` branch's shared
// `lib/task-views/data-layer.ts` — which by merge time was already the real,
// working sort/group model wired through `useTaskViewData`, `TaskListView`
// and `TaskTableView` (whose column headers are only clickable for the
// fields `TaskSortField` actually supports — 'status'/'assignee'/'project'
// were never real sortable columns there, just listed in this file's now-
// removed `SORT_FIELDS`). Chose direction (b) from this file's own original
// comment: kept `TaskViewFilters` (a simpler, single-value, URL-friendly
// shape — good for saved views and shareable links) but re-point `sort` and
// `groupBy` at the sibling's real, already-wired types instead of a second,
// competing model. `taskViewFiltersToTaskFilters` below is the one new seam
// needed to bridge `TaskViewFilters`'s single-value/category-based shape
// into `TaskFilters`'s array-based/status-id-based shape at the one place
// that actually queries/filters tasks.

/** Mirrors `TASK_STATUS_CATEGORIES` (collections/TaskStatuses.ts) — the one
 * fixed vocabulary every status-aware filter in this app is supposed to read,
 * per that file's own comment, rather than a free-text status name. */
export type TaskStatusCategory = (typeof TASK_STATUS_CATEGORIES)[number]

export interface TaskViewFilters {
  /** `task.status`'s owning `TaskStatus.category` — one of the 7 fixed values, or null for "any." */
  statusCategory: TaskStatusCategory | null
  /** `task.assignee` id, or null for "any." */
  assigneeId: number | null
  /** `task.agent` id, or null for "any." */
  agentId: number | null
  /** `task.project` id, or null for "any." */
  projectId: number | null
  /** Hides tasks with the (not-yet-schema-real — see migrations/20260902_130000_tasks_archived.ts) archived flag once it exists. Client-side only today since the field isn't queryable yet; defaults true so an archived task actually disappears from view once "Archive" is used. */
  hideArchived: boolean
}

/** Re-exported, not redefined — `lib/task-views/data-layer.ts`'s `TaskSort`/
 * `TaskSortField` is the real sort model `useTaskViewData`/`TaskTableView`
 * already read and write; see the file header for why this file no longer
 * has its own parallel version. */
export type { TaskSort as TaskViewSort, TaskSortField as TaskViewSortField } from '@/lib/task-views/data-layer'

/** Re-exported, not redefined — same reasoning as `TaskViewSort` above, for
 * `lib/task-views/data-layer.ts`'s `TaskGroupBy` (values already matched
 * exactly: 'status' | 'project' | 'assignee' | 'none'). */
export type { TaskGroupBy as TaskViewGroupBy } from '@/lib/task-views/data-layer'

/** Visibility for the optional "agent columns" (components/tasks/columns/
 * task-agent-columns.tsx) — Agent/Runs/Last-run-outcome/Spend/Live. All
 * default visible; a workspace with no agents at all is the main reason to
 * turn one off. */
export interface TaskViewColumns {
  agent: boolean
  runs: boolean
  lastRunOutcome: boolean
  spend: boolean
  live: boolean
}

export type TaskViewDensity = 'comfortable' | 'compact'

export type TaskViewMode = 'board' | 'list' | 'table'

export interface TaskViewConfig {
  view: TaskViewMode
  filters: TaskViewFilters
  sort: TaskViewSort | null
  groupBy: TaskViewGroupBy
  columns: TaskViewColumns
  density: TaskViewDensity
}

export const DEFAULT_TASK_VIEW_FILTERS: TaskViewFilters = {
  statusCategory: null,
  assigneeId: null,
  agentId: null,
  projectId: null,
  hideArchived: true,
}

export const DEFAULT_TASK_VIEW_COLUMNS: TaskViewColumns = {
  agent: true,
  runs: true,
  lastRunOutcome: true,
  spend: true,
  live: true,
}

export const DEFAULT_TASK_VIEW_CONFIG: TaskViewConfig = {
  view: 'board',
  filters: DEFAULT_TASK_VIEW_FILTERS,
  sort: null,
  groupBy: 'status',
  columns: DEFAULT_TASK_VIEW_COLUMNS,
  density: 'comfortable',
}

/** Two configs are equal for "does the live board state match the currently
 * selected saved view" purposes — plain structural comparison, cheap enough
 * for a handful of scalar/boolean fields, no deep-equal dependency needed. */
export function taskViewConfigsEqual(a: TaskViewConfig, b: TaskViewConfig): boolean {
  return (
    a.view === b.view &&
    a.groupBy === b.groupBy &&
    a.density === b.density &&
    a.filters.statusCategory === b.filters.statusCategory &&
    a.filters.assigneeId === b.filters.assigneeId &&
    a.filters.agentId === b.filters.agentId &&
    a.filters.projectId === b.filters.projectId &&
    a.filters.hideArchived === b.filters.hideArchived &&
    (a.sort?.field ?? null) === (b.sort?.field ?? null) &&
    (a.sort?.direction ?? null) === (b.sort?.direction ?? null) &&
    a.columns.agent === b.columns.agent &&
    a.columns.runs === b.columns.runs &&
    a.columns.lastRunOutcome === b.columns.lastRunOutcome &&
    a.columns.spend === b.columns.spend &&
    a.columns.live === b.columns.live
  )
}

export function cloneTaskViewConfig(config: TaskViewConfig): TaskViewConfig {
  return {
    view: config.view,
    filters: { ...config.filters },
    sort: config.sort ? { ...config.sort } : null,
    groupBy: config.groupBy,
    columns: { ...config.columns },
    density: config.density,
  }
}

// ---------------------------------------------------------------------------
// URL round-trip — "every view is a URL." Same discrete-`?param=` shape
// `<DetailLayout>` (components/layout/detail-layout.tsx) established for
// `?tab=`, not one opaque JSON blob param, so a shared URL stays readable and
// individually shareable/bookmarkable per field (e.g. linking straight to
// "just the failed ones" is `?statusCategory=blocked`, not a base64 dump).
// ---------------------------------------------------------------------------

const COLUMN_KEYS: (keyof TaskViewColumns)[] = ['agent', 'runs', 'lastRunOutcome', 'spend', 'live']

/** `TaskSortField`'s real, complete value set — 'position' | 'title' |
 * 'updatedAt' | 'lastActivityAt', per `data-layer.ts`. Used to reject a
 * stale/hand-typed `?sortField=` value from an old URL rather than passing
 * something `TaskTableView`/`sortTasks` were never built to handle. */
const VALID_SORT_FIELDS = new Set<TaskSortField>(['position', 'title', 'updatedAt', 'lastActivityAt'])

/**
 * Bridges this file's simpler, URL-friendly `TaskViewFilters` (single value,
 * status *category*) into `data-layer.ts`'s `TaskFilters` (array-valued,
 * status *ids*) — the one shape `buildTasksWhere`/`taskMatchesFilters`/
 * `getTasksForView` actually consume. `statuses` resolves `statusCategory`
 * to every status id sharing it (a workspace can have several statuses per
 * category, per `data-layer.ts`'s own board-column comment) and, per
 * `hideArchived`'s existing real meaning (see `TaskViewFilters.hideArchived`'s
 * doc comment), also *excludes* every 'cancelled'-category status id when
 * `hideArchived` is true and no explicit category filter already narrows to
 * just one category.
 */
export function taskViewFiltersToTaskFilters(filters: TaskViewFilters, statuses: TaskStatus[]): TaskFilters {
  let statusIds: number[] | null = null
  if (filters.statusCategory) {
    statusIds = statuses.filter((s) => s.category === filters.statusCategory).map((s) => s.id)
  } else if (filters.hideArchived) {
    const nonCancelled = statuses.filter((s) => s.category !== 'cancelled')
    if (nonCancelled.length !== statuses.length) statusIds = nonCancelled.map((s) => s.id)
  }
  return {
    statusIds,
    assigneeIds: filters.assigneeId != null ? [filters.assigneeId] : null,
    agentIds: filters.agentId != null ? [filters.agentId] : null,
    projectIds: filters.projectId != null ? [filters.projectId] : null,
    query: '',
  }
}

/** The inverse of `taskMatchesTaskFilters`'s array-valued check, applied
 * directly over `TaskViewFilters` — used where the board already has a
 * per-column task list in hand and re-running it through the array-valued
 * adapter above per render would be wasted work. Delegates to the real
 * `data-layer.ts` predicate via `taskViewFiltersToTaskFilters` so the two
 * never silently drift apart. */
export function taskMatchesTaskViewFilters(task: Task, filters: TaskViewFilters, statuses: TaskStatus[]): boolean {
  return taskMatchesTaskFilters(task, taskViewFiltersToTaskFilters(filters, statuses))
}

/** Reads whichever `TaskViewConfig` fields are present in `params`, filling
 * in `DEFAULT_TASK_VIEW_CONFIG` for everything absent — so a URL with no
 * view-state params at all (a fresh `/tasks` link) is exactly the default
 * config, and a URL with only `?statusCategory=blocked` still yields a fully
 * valid config for everything else. */
export function taskViewConfigFromSearchParams(params: URLSearchParams): TaskViewConfig {
  const view = params.get('view')
  const statusCategory = params.get('statusCategory')
  const assigneeId = params.get('assignee')
  const agentId = params.get('agent')
  const projectId = params.get('project')
  const hideArchived = params.get('hideArchived')
  const sortField = params.get('sortField')
  const sortDir = params.get('sortDir')
  const groupBy = params.get('groupBy')
  const density = params.get('density')
  const cols = params.get('cols')

  const columns = { ...DEFAULT_TASK_VIEW_COLUMNS }
  if (cols !== null) {
    const visible = new Set(cols.split(',').filter(Boolean))
    for (const key of COLUMN_KEYS) columns[key] = visible.has(key)
  }

  return {
    view: view === 'list' || view === 'table' || view === 'board' ? view : DEFAULT_TASK_VIEW_CONFIG.view,
    filters: {
      statusCategory: (TASK_STATUS_CATEGORIES as readonly string[]).includes(statusCategory ?? '')
        ? (statusCategory as TaskStatusCategory)
        : null,
      assigneeId: assigneeId ? Number(assigneeId) : null,
      agentId: agentId ? Number(agentId) : null,
      projectId: projectId ? Number(projectId) : null,
      hideArchived: hideArchived === null ? DEFAULT_TASK_VIEW_FILTERS.hideArchived : hideArchived === '1',
    },
    sort:
      sortField && sortDir && VALID_SORT_FIELDS.has(sortField as TaskSortField)
        ? { field: sortField as TaskSortField, direction: sortDir === 'desc' ? 'desc' : 'asc' }
        : null,
    groupBy: groupBy === 'project' || groupBy === 'assignee' || groupBy === 'none' ? groupBy : 'status',
    columns,
    density: density === 'compact' ? 'compact' : 'comfortable',
  }
}

/** Inverse of `taskViewConfigFromSearchParams` — only writes params that
 * differ from the default, so a board sitting at its default state keeps a
 * clean URL rather than a wall of redundant query params. Non-view-state
 * params already on the URL (e.g. `?task=` for the notification deep link)
 * are left untouched by the caller, which starts from the current
 * `URLSearchParams` and only overwrites this function's own keys. */
export function applyTaskViewConfigToSearchParams(params: URLSearchParams, config: TaskViewConfig): void {
  const setOrDelete = (key: string, value: string | null) => {
    if (value === null) params.delete(key)
    else params.set(key, value)
  }
  setOrDelete('view', config.view === DEFAULT_TASK_VIEW_CONFIG.view ? null : config.view)
  setOrDelete('statusCategory', config.filters.statusCategory)
  setOrDelete('assignee', config.filters.assigneeId ? String(config.filters.assigneeId) : null)
  setOrDelete('agent', config.filters.agentId ? String(config.filters.agentId) : null)
  setOrDelete('project', config.filters.projectId ? String(config.filters.projectId) : null)
  setOrDelete('hideArchived', config.filters.hideArchived === DEFAULT_TASK_VIEW_FILTERS.hideArchived ? null : config.filters.hideArchived ? '1' : '0')
  setOrDelete('sortField', config.sort?.field ?? null)
  setOrDelete('sortDir', config.sort?.direction ?? null)
  setOrDelete('groupBy', config.groupBy === 'status' ? null : config.groupBy)
  setOrDelete('density', config.density === 'comfortable' ? null : config.density)
  const hiddenCols = COLUMN_KEYS.filter((key) => !config.columns[key])
  setOrDelete('cols', hiddenCols.length === 0 ? null : COLUMN_KEYS.filter((key) => config.columns[key]).join(','))
}
