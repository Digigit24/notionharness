import { Skeleton } from '@/components/ui/skeleton'

// ROADMAP B-6 "Finish" (state-craft sweep) — matches InboxList's real row
// shape (a kind badge, headline + subline, trailing timestamp) rather than
// a generic spinner, per the plan's loading-state standard.
export default function InboxLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-8">
        <div className="flex flex-col gap-1">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="flex flex-col gap-1">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-3 rounded-md border border-transparent px-3 py-2">
              <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
              <Skeleton className="h-3 w-16 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
