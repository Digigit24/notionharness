import { Skeleton } from '@/components/ui/skeleton'

// ROADMAP B-6 "Finish" (state-craft sweep) — matches the default Board
// view's real shape (a header bar, then columns of card-shaped rows)
// rather than a bare spinner, per the plan's loading-state standard. Task
// data is fetched server-side before <TaskBoard> mounts, so this is what a
// visitor actually sees while that fetch is in flight.
export default function TasksLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-black/5 px-6 py-3 dark:border-white/10">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-7 w-40" />
      </div>
      <div className="flex flex-1 gap-3 overflow-x-auto p-4">
        {[0, 1, 2, 3].map((col) => (
          <div key={col} className="flex w-72 shrink-0 flex-col gap-1.5 rounded-lg border border-black/10 bg-black/[.015] p-2 dark:border-white/10 dark:bg-white/[.02]">
            <Skeleton className="mb-1 h-5 w-20" />
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-16 w-full rounded-md" />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
