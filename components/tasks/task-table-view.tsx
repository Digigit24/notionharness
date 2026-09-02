'use client'

// ROADMAP B-4 — TanStack Table (headless) + TanStack Virtual, consuming the
// same shared, filtered/sorted task list every other view reads
// (`useTaskViewData().tableTasks`). Column pinning and resizing are real
// TanStack Table state (`columnPinning`/`columnSizing`), not CSS tricks.
// Sort is intentionally NOT a second, table-local sort model — clicking a
// sortable column header writes into the same shared `TaskSort` the filter
// bar's "Sort by" control uses, so "sorted by X" means the same thing here
// as it does in List (the plan's explicit requirement that a filter/sort
// set mean the same thing across all three views).
import { useMemo, useRef, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnPinningState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Pin, PinOff } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { statusColorClasses } from '@/lib/status-colors'
import type { TaskSort, TaskSortField } from '@/lib/task-views/data-layer'
import { AgentPresence, RunMetrics, type TaskRunMetrics } from './run-metrics'
import type { Task, TaskStatus } from '@/payload-types'

const ROW_HEIGHT = 40

// Maps a table column to the shared sort model's field, when that column
// has one — columns with no corresponding sort field (status/assignee/
// project) render a plain, unclickable header instead of pretending to sort.
const SORTABLE_COLUMNS: Partial<Record<string, TaskSortField>> = {
  title: 'title',
  position: 'position',
  updatedAt: 'updatedAt',
}

export function TaskTableView({
  tasks,
  statuses,
  runMetrics,
  activeTaskIds,
  sort,
  onSortChange,
  onOpenTask,
  loading,
}: {
  tasks: Task[]
  statuses: TaskStatus[]
  runMetrics: Record<number, TaskRunMetrics>
  activeTaskIds: Set<number>
  sort: TaskSort
  onSortChange: (sort: TaskSort) => void
  onOpenTask: (taskId: number) => void
  loading: boolean
}) {
  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses])

  const columnDefs = useMemo<ColumnDef<Task>[]>(
    () => [
      {
        id: 'title',
        accessorFn: (task) => task.title || 'Untitled',
        header: 'Title',
        size: 320,
        minSize: 160,
        cell: (info) => <span className="truncate font-medium">{info.getValue<string>()}</span>,
      },
      {
        id: 'status',
        accessorFn: (task) => statusById.get(typeof task.status === 'number' ? task.status : task.status.id)?.name ?? '',
        header: 'Status',
        size: 140,
        cell: (info) => {
          const status = statusById.get(typeof info.row.original.status === 'number' ? info.row.original.status : info.row.original.status.id)
          if (!status) return null
          return <span className={`truncate rounded px-1.5 py-0.5 text-xs font-medium ${statusColorClasses(status.color)}`}>{status.name}</span>
        },
      },
      {
        id: 'assignee',
        accessorFn: (task) => (typeof task.assignee === 'object' ? task.assignee?.name || task.assignee?.email || '' : ''),
        header: 'Assignee',
        size: 160,
      },
      {
        id: 'project',
        accessorFn: (task) => (typeof task.project === 'object' ? task.project?.name || '' : ''),
        header: 'Project',
        size: 160,
      },
      {
        id: 'position',
        accessorFn: (task) => task.position ?? 0,
        header: 'Position',
        size: 100,
      },
      {
        id: 'updatedAt',
        accessorFn: (task) => (task.updatedAt ? new Date(task.updatedAt).toLocaleString() : ''),
        header: 'Updated',
        size: 160,
      },
      {
        id: 'run',
        header: 'Run',
        size: 220,
        enableResizing: false,
        cell: (info) => (
          <span className="flex items-center gap-2">
            <AgentPresence active={activeTaskIds.has(info.row.original.id)} />
            <RunMetrics metrics={runMetrics[info.row.original.id]} />
          </span>
        ),
      },
    ],
    [activeTaskIds, runMetrics, statusById],
  )

  // Real, user-toggleable TanStack Table state — "title" starts pinned
  // (matching every other view's convention of title always being visible)
  // but the pin button in each header actually calls `column.pin(...)`,
  // which flows through here. Sizing (`columnResizeMode: 'onChange'`) is
  // left table-internal/uncontrolled — a per-viewer layout preference, not
  // part of the shared filter/sort/group model the other views read.
  const [columnPinning, setColumnPinning] = useState<ColumnPinningState>({ left: ['title'], right: [] })

  const table = useReactTable({
    data: tasks,
    columns: columnDefs,
    state: { columnPinning },
    onColumnPinningChange: setColumnPinning,
    columnResizeMode: 'onChange',
    enableColumnResizing: true,
    getCoreRowModel: getCoreRowModel(),
  })

  const parentRef = useRef<HTMLDivElement | null>(null)
  const rows = table.getRowModel().rows
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0
  const paddingBottom = virtualItems.length > 0 ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0

  if (loading && rows.length === 0) {
    // ROADMAP B-6 "Finish" (state-craft sweep) — a skeleton matching the
    // real table row shape, not a bare "Loading…" string.
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
        <Skeleton className="h-8 w-full" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }
  if (!loading && rows.length === 0) {
    return (
      <EmptyState
        className="flex-1 border-none"
        title="No tasks match the current filters."
        description="Try widening your filters, or create a task to get started."
      />
    )
  }

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto p-4">
      <Table style={{ width: table.getTotalSize(), tableLayout: 'fixed' }}>
        <TableHeader className="sticky top-0 z-10 bg-white dark:bg-[#191919]">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id} className="hover:bg-transparent">
              {headerGroup.headers.map((header) => {
                const isPinned = header.column.getIsPinned()
                const sortField = SORTABLE_COLUMNS[header.column.id]
                return (
                  <TableHead
                    key={header.id}
                    className={`relative select-none whitespace-nowrap ${isPinned ? 'sticky left-0 z-20 bg-white dark:bg-[#191919]' : ''}`}
                    style={{ width: header.getSize(), left: isPinned ? header.getStart('left') : undefined }}
                  >
                    <div className="flex items-center gap-1 pr-3">
                      {sortField ? (
                        <button
                          type="button"
                          onClick={() => onSortChange({ field: sortField, direction: sort.field === sortField && sort.direction === 'asc' ? 'desc' : 'asc' })}
                          className="flex items-center gap-1 hover:text-foreground"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sort.field === sortField ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}
                        </button>
                      ) : (
                        <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                      )}
                      {header.column.id !== 'run' && (
                        <button
                          type="button"
                          onClick={() => header.column.pin(isPinned ? false : 'left')}
                          title={isPinned ? 'Unpin column' : 'Pin column'}
                          aria-label={isPinned ? 'Unpin column' : 'Pin column'}
                          className="ml-auto text-black/30 hover:text-black/70 dark:text-white/30 dark:hover:text-white/70"
                        >
                          {isPinned ? <PinOff size={11} /> : <Pin size={11} />}
                        </button>
                      )}
                    </div>
                    {header.column.getCanResize() && (
                      <div
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        className="absolute right-0 top-0 h-full w-1 cursor-col-resize touch-none select-none bg-black/10 opacity-0 hover:opacity-100 dark:bg-white/20"
                      />
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {paddingTop > 0 && (
            <tr aria-hidden="true"><td colSpan={columnDefs.length} style={{ height: paddingTop }} /></tr>
          )}
          {virtualItems.map((item) => {
            const row = rows[item.index]
            return (
              <TableRow key={row.id} onClick={() => onOpenTask(row.original.id)} className="cursor-pointer" style={{ height: ROW_HEIGHT }}>
                {row.getVisibleCells().map((cell) => {
                  const isPinned = cell.column.getIsPinned()
                  return (
                    <TableCell
                      key={cell.id}
                      className={`truncate ${isPinned ? 'sticky left-0 z-[5] bg-white dark:bg-[#191919]' : ''}`}
                      style={{ width: cell.column.getSize(), left: isPinned ? cell.column.getStart('left') : undefined }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  )
                })}
              </TableRow>
            )
          })}
          {paddingBottom > 0 && (
            <tr aria-hidden="true"><td colSpan={columnDefs.length} style={{ height: paddingBottom }} /></tr>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
