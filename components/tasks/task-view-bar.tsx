'use client'

import { useState } from 'react'
import { Loader2, Rows3, Columns3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TASK_STATUS_CATEGORIES } from '@/collections/TaskStatuses'
import type { SavedViewScope } from '@/collections/SavedViews'
import {
  taskViewConfigsEqual,
  type TaskViewConfig,
  type TaskViewSortField,
} from '@/lib/task-views/types'
// ROADMAP B-4 merge reconciliation — `TaskViewSortField` is re-exported from
// `lib/task-views/data-layer.ts`'s real `TaskSortField`, the same model
// `TaskTableView`'s column headers are wired to. 'status'/'assignee'/
// 'project' were never real sortable columns there (unclickable headers,
// see that file's own `SORTABLE_COLUMNS` comment) — offering them here would
// silently do nothing when picked, so they're not listed below.
import type { Agent, Project, SavedView, User } from '@/payload-types'

// ROADMAP B-4 "Work" — "Filter chips, grouping, sorting, column visibility,
// density." + saved-view picker with the "baseline diff" affordance ("if the
// board's live filter state differs from the currently-selected saved
// view's stored config, show an 'unsaved changes' affordance with Save/
// Revert actions"). Purely a controlled view over `config` — every change
// goes through `onChange`, task-board.tsx owns the actual state (and its URL
// sync). Saved-view selection/CRUD callbacks are likewise owned by the
// parent, which is what talks to saved-views-actions.ts.

function formatCategory(category: string): string {
  return category.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
}

const SORT_FIELDS: { value: TaskViewSortField; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'position', label: 'Position' },
  { value: 'updatedAt', label: 'Updated' },
  { value: 'lastActivityAt', label: 'Last activity' },
]

export function TaskViewBar({
  config,
  onChange,
  assignableUsers,
  agents,
  projects,
  savedViews,
  selectedSavedViewId,
  baselineConfig,
  busy,
  canSaveProjectScope,
  onSelectSavedView,
  onSaveNewView,
  onUpdateView,
  onRevertView,
  onDeleteView,
}: {
  config: TaskViewConfig
  onChange: (next: TaskViewConfig) => void
  assignableUsers: User[]
  agents: Agent[]
  projects: Project[]
  savedViews: SavedView[]
  selectedSavedViewId: number | null
  /** The selected saved view's own stored config, or null when nothing is selected (ad-hoc state). */
  baselineConfig: TaskViewConfig | null
  busy: boolean
  /** Whether this board is scoped to one project (so a 'project'-scope saved view is meaningful). */
  canSaveProjectScope: boolean
  onSelectSavedView: (id: number | null) => void
  onSaveNewView: (name: string, scope: SavedViewScope) => void
  onUpdateView: () => void
  onRevertView: () => void
  onDeleteView: () => void
}) {
  const [namingNewView, setNamingNewView] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftScope, setDraftScope] = useState<SavedViewScope>('workspace')

  const isDirty = selectedSavedViewId != null && baselineConfig != null && !taskViewConfigsEqual(config, baselineConfig)

  function patch(partial: Partial<TaskViewConfig>) {
    onChange({ ...config, ...partial })
  }
  function patchFilters(partial: Partial<TaskViewConfig['filters']>) {
    onChange({ ...config, filters: { ...config.filters, ...partial } })
  }

  function submitNewViewName() {
    const name = draftName.trim()
    setDraftName('')
    setNamingNewView(false)
    if (name) onSaveNewView(name, draftScope)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-black/5 px-6 py-2 dark:border-white/10">
      {/* Saved view picker */}
      <Select
        value={selectedSavedViewId != null ? String(selectedSavedViewId) : 'adhoc'}
        onValueChange={(value) => onSelectSavedView(value === 'adhoc' ? null : Number(value))}
      >
        <SelectTrigger size="sm" className="h-7 min-w-32">
          <SelectValue placeholder="Ad-hoc view" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="adhoc">Ad-hoc (unsaved)</SelectItem>
          {savedViews.map((view) => (
            <SelectItem key={view.id} value={String(view.id)}>
              {view.name} · {view.scope}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isDirty && (
        <>
          <Badge variant="outline" className="h-6">Unsaved changes</Badge>
          <Button type="button" size="sm" variant="secondary" className="h-7" onClick={onUpdateView} disabled={busy}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onRevertView} disabled={busy}>
            Revert
          </Button>
        </>
      )}

      {selectedSavedViewId == null && !namingNewView && (
        <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => setNamingNewView(true)}>
          Save as view…
        </Button>
      )}
      {namingNewView && (
        <>
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitNewViewName()
              if (e.key === 'Escape') {
                setDraftName('')
                setNamingNewView(false)
              }
            }}
            placeholder="View name"
            className="h-7 w-36 rounded border border-black/10 bg-white px-2 text-xs outline-none dark:border-white/10 dark:bg-[#2a2a2a]"
          />
          <Select value={draftScope} onValueChange={(value) => setDraftScope(value as SavedViewScope)}>
            <SelectTrigger size="sm" className="h-7"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="workspace">Workspace</SelectItem>
              <SelectItem value="mine">Just me</SelectItem>
              {canSaveProjectScope && <SelectItem value="project">This project</SelectItem>}
            </SelectContent>
          </Select>
          <Button type="button" size="sm" className="h-7" onClick={submitNewViewName}>Save</Button>
        </>
      )}
      {selectedSavedViewId != null && (
        <Button type="button" size="sm" variant="ghost" className="h-7 text-red-600 dark:text-red-400" onClick={onDeleteView} disabled={busy}>
          Delete view
        </Button>
      )}
      {busy && <Loader2 size={14} className="animate-spin text-black/40 dark:text-white/40" />}

      <span className="mx-1 h-4 w-px bg-black/10 dark:bg-white/10" aria-hidden="true" />

      {/* Filter chips */}
      <Select value={config.filters.statusCategory ?? 'any'} onValueChange={(value) => patchFilters({ statusCategory: value === 'any' ? null : (value as TaskViewConfig['filters']['statusCategory']) })}>
        <SelectTrigger size="sm" className="h-7"><SelectValue placeholder="Status" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="any">Any status</SelectItem>
          {TASK_STATUS_CATEGORIES.map((category) => (
            <SelectItem key={category} value={category}>{formatCategory(category)}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={config.filters.assigneeId != null ? String(config.filters.assigneeId) : 'any'} onValueChange={(value) => patchFilters({ assigneeId: value === 'any' ? null : Number(value) })}>
        <SelectTrigger size="sm" className="h-7"><SelectValue placeholder="Assignee" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="any">Anyone</SelectItem>
          {assignableUsers.map((u) => <SelectItem key={u.id} value={String(u.id)}>{u.name || u.email}</SelectItem>)}
        </SelectContent>
      </Select>

      <Select value={config.filters.agentId != null ? String(config.filters.agentId) : 'any'} onValueChange={(value) => patchFilters({ agentId: value === 'any' ? null : Number(value) })}>
        <SelectTrigger size="sm" className="h-7"><SelectValue placeholder="Agent" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="any">Any agent</SelectItem>
          {agents.map((agent) => <SelectItem key={agent.id} value={String(agent.id)}>{agent.name}</SelectItem>)}
        </SelectContent>
      </Select>

      <Select value={config.filters.projectId != null ? String(config.filters.projectId) : 'any'} onValueChange={(value) => patchFilters({ projectId: value === 'any' ? null : Number(value) })}>
        <SelectTrigger size="sm" className="h-7"><SelectValue placeholder="Project" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="any">Any project</SelectItem>
          {projects.map((project) => <SelectItem key={project.id} value={String(project.id)}>{project.name}</SelectItem>)}
        </SelectContent>
      </Select>

      <label className="flex h-7 items-center gap-1.5 rounded-lg border border-border px-2 text-xs text-black/60 dark:text-white/60">
        <input type="checkbox" checked={config.filters.hideArchived} onChange={(e) => patchFilters({ hideArchived: e.target.checked })} className="size-3.5" />
        Hide archived
      </label>

      <span className="mx-1 h-4 w-px bg-black/10 dark:bg-white/10" aria-hidden="true" />

      {/* Sort */}
      <Select value={config.sort?.field ?? 'none'} onValueChange={(value) => patch({ sort: value === 'none' ? null : { field: value as TaskViewSortField, direction: config.sort?.direction ?? 'asc' } })}>
        <SelectTrigger size="sm" className="h-7"><SelectValue placeholder="Sort" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Unsorted</SelectItem>
          {SORT_FIELDS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
        </SelectContent>
      </Select>
      {config.sort && (
        <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => patch({ sort: { field: config.sort!.field, direction: config.sort!.direction === 'asc' ? 'desc' : 'asc' } })}>
          {config.sort.direction === 'asc' ? '↑' : '↓'}
        </Button>
      )}

      {/* Group by */}
      <Select value={config.groupBy} onValueChange={(value) => patch({ groupBy: value as TaskViewConfig['groupBy'] })}>
        <SelectTrigger size="sm" className="h-7"><SelectValue placeholder="Group by" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="status">Group: Status</SelectItem>
          <SelectItem value="project">Group: Project</SelectItem>
          <SelectItem value="assignee">Group: Assignee</SelectItem>
          <SelectItem value="none">Group: None</SelectItem>
        </SelectContent>
      </Select>

      {/* Density */}
      <Button type="button" size="sm" variant="outline" className="h-7" title="Toggle row density" onClick={() => patch({ density: config.density === 'comfortable' ? 'compact' : 'comfortable' })}>
        {config.density === 'compact' ? <Rows3 size={12} /> : <Columns3 size={12} />}
        {config.density === 'compact' ? 'Compact' : 'Comfortable'}
      </Button>

      {/* Column visibility */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="outline" className="h-7">Columns</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Agent columns</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {(['agent', 'runs', 'lastRunOutcome', 'spend', 'live'] as const).map((key) => (
            <DropdownMenuCheckboxItem
              key={key}
              checked={config.columns[key]}
              onCheckedChange={(checked) => patch({ columns: { ...config.columns, [key]: checked } })}
            >
              {key === 'lastRunOutcome' ? 'Last run outcome' : key[0].toUpperCase() + key.slice(1)}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
