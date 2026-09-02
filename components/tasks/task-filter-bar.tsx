'use client'

// ROADMAP B-4.1 — filter/sort/group controls for the shared data layer.
// Rendered once by `task-board.tsx` above whichever view is active; every
// control writes straight into `useTaskViewData`'s `filters`/`sort`/
// `groupBy` state, so a change here is instantly visible in Board (which
// filters its per-column cache client-side) and List/Table (which re-query
// via `getTasksForView`) alike — one filter set, one meaning, three views.
import { Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { GROUP_BY_LABELS, SORT_FIELD_LABELS, type TaskFilters, type TaskGroupBy, type TaskSort, type TaskSortField } from '@/lib/task-views/data-layer'
import type { TaskViewKind } from './use-task-view-data'
import type { Agent, Project, TaskStatus, User } from '@/payload-types'

const NONE_VALUE = '__none__'

export function TaskFilterBar({
  view,
  statuses,
  projects,
  assignableUsers,
  agents,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  groupBy,
  onGroupByChange,
}: {
  view: TaskViewKind
  statuses: TaskStatus[]
  projects: Project[]
  assignableUsers: User[]
  agents: Agent[]
  filters: TaskFilters
  onFiltersChange: (filters: TaskFilters) => void
  sort: TaskSort
  onSortChange: (sort: TaskSort) => void
  groupBy: TaskGroupBy
  onGroupByChange: (groupBy: TaskGroupBy) => void
}) {
  function toggleStatus(statusId: number) {
    const current = filters.statusIds ?? statuses.map((s) => s.id)
    const next = current.includes(statusId) ? current.filter((id) => id !== statusId) : [...current, statusId]
    // Selecting every status back out is the same as "no filter" — keep the
    // model's `null` = unrestricted convention rather than an explicit
    // all-included array that would drift out of sync if a status is added.
    onFiltersChange({ ...filters, statusIds: next.length === statuses.length ? null : next })
  }

  const singleAssignee = filters.assigneeIds?.[0] ?? null
  const singleAgent = filters.agentIds?.[0] ?? null
  const singleProject = filters.projectIds?.[0] ?? null

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-black/5 px-6 py-2 dark:border-white/10">
      <div className="relative">
        <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.query}
          onChange={(e) => onFiltersChange({ ...filters, query: e.target.value })}
          placeholder="Search titles…"
          className="h-7 w-44 pl-6 text-xs"
          aria-label="Search task titles"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {statuses.map((status) => {
          const active = !filters.statusIds || filters.statusIds.includes(status.id)
          return (
            <Badge
              key={status.id}
              variant={active ? 'secondary' : 'outline'}
              asChild
              className={`cursor-pointer select-none ${active ? '' : 'opacity-50'}`}
            >
              <button type="button" onClick={() => toggleStatus(status.id)}>
                {status.name}
              </button>
            </Badge>
          )
        })}
      </div>

      <FilterSelect
        label="Assignee"
        value={singleAssignee === 'unassigned' ? 'unassigned' : singleAssignee != null ? String(singleAssignee) : NONE_VALUE}
        onChange={(value) =>
          onFiltersChange({
            ...filters,
            assigneeIds: value === NONE_VALUE ? null : value === 'unassigned' ? ['unassigned'] : [Number(value)],
          })
        }
        options={[
          { value: 'unassigned', label: 'Unassigned' },
          ...assignableUsers.map((u) => ({ value: String(u.id), label: u.name || u.email })),
        ]}
      />
      <FilterSelect
        label="Agent"
        value={singleAgent === 'none' ? 'none' : singleAgent != null ? String(singleAgent) : NONE_VALUE}
        onChange={(value) =>
          onFiltersChange({ ...filters, agentIds: value === NONE_VALUE ? null : value === 'none' ? ['none'] : [Number(value)] })
        }
        options={[{ value: 'none', label: 'No agent' }, ...agents.map((a) => ({ value: String(a.id), label: a.name }))]}
      />
      <FilterSelect
        label="Project"
        value={singleProject === 'none' ? 'none' : singleProject != null ? String(singleProject) : NONE_VALUE}
        onChange={(value) =>
          onFiltersChange({ ...filters, projectIds: value === NONE_VALUE ? null : value === 'none' ? ['none'] : [Number(value)] })
        }
        options={[{ value: 'none', label: 'No project' }, ...projects.map((p) => ({ value: String(p.id), label: p.name || 'Untitled' }))]}
      />

      {view !== 'board' && (
        <div className="ml-auto flex items-center gap-2">
          {view === 'list' && (
            <Select value={groupBy} onValueChange={(v) => onGroupByChange(v as TaskGroupBy)}>
              <SelectTrigger size="sm" className="h-7 text-xs"><SelectValue placeholder="Group by" /></SelectTrigger>
              <SelectContent>
                {(Object.keys(GROUP_BY_LABELS) as TaskGroupBy[]).map((key) => (
                  <SelectItem key={key} value={key}>Group: {GROUP_BY_LABELS[key]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select
            value={sort.field}
            onValueChange={(v) => onSortChange({ ...sort, field: v as TaskSortField })}
          >
            <SelectTrigger size="sm" className="h-7 text-xs"><SelectValue placeholder="Sort by" /></SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_FIELD_LABELS) as TaskSortField[]).map((key) => (
                <SelectItem key={key} value={key}>Sort: {SORT_FIELD_LABELS[key]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={() => onSortChange({ ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' })}
            className="rounded-md border border-border px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted"
            title="Toggle sort direction"
            aria-label="Toggle sort direction"
          >
            {sort.direction === 'asc' ? '↑' : '↓'}
          </button>
        </div>
      )}
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="h-7 text-xs">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE_VALUE}>All {label.toLowerCase()}s</SelectItem>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
