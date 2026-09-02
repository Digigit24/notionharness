import { TASK_STATUS_CATEGORIES } from '@/collections/TaskStatuses'

// ROADMAP B-4 "Work" — the tasks board/list/table's own filter/sort/group/
// column/density shape, used both for the ad-hoc (unsaved) view state a user
// is currently looking at and for what a saved view (collections/
// SavedViews.ts's `config` json field) persists.
//
// FOR THE MERGE LEAD: a parallel branch (`roadmap/b4-list-table`) is
// extracting `task-board.tsx`'s fused filter/render logic into a shared
// data/filter layer with its own view-config type, in isolation from this
// branch. This type was deliberately kept as close as possible to the
// CURRENT board's actual field names (`task.assignee`/`task.agent`/
// `task.project`/`task.status`'s `category`, the exact column ids
// `TaskTableView`'s `columnDefs` already uses for sorting) specifically to
// make reconciling the two at merge time straightforward — expect to either
// (a) fold this into the sibling's type as its filters/sort/group/columns
// shape, keeping whichever field names it settled on, or (b) keep this one
// and re-point the sibling's consumers at it. Either is fine; just don't end
// up with two competing "the" view-config types on `main`.

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

/** Same column ids `TaskTableView`'s `columnDefs` (components/tasks/task-board.tsx) already sorts by — kept in exact sync so a saved sort round-trips through the real table without translation. */
export type TaskViewSortField = 'title' | 'status' | 'assignee' | 'project' | 'position' | 'updatedAt'

export interface TaskViewSort {
  field: TaskViewSortField
  direction: 'asc' | 'desc'
}

/** How table/list rows are grouped. 'status' matches the board's own
 * always-on per-status-column grouping; 'none'/'project'/'assignee' only
 * apply to the flat table view. */
export type TaskViewGroupBy = 'status' | 'project' | 'assignee' | 'none'

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
      sortField && sortDir
        ? { field: sortField as TaskViewSortField, direction: sortDir === 'desc' ? 'desc' : 'asc' }
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
