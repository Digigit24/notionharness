// R12-P2.1 — a loading state shaped like the screen it stands in for.
//
// One agent: header, tabs, then the settings form's own field rows.
//
// Four of thirty-five routes had one of these; the rest showed the PREVIOUS
// screen until the server component resolved, which reads as a freeze rather
// than as loading. The shape matters more than the animation: a skeleton that
// does not match what replaces it is a second layout shift with a shimmer on
// it.

import { Skeleton } from '@/components/ui/skeleton'
import { SkeletonPageHeader } from '@/components/ui/skeletons'

export default function AgentLoading() {
  return (
    <main className="w-full px-5 py-6">
      <SkeletonPageHeader className="mb-5" />
      <div className="mb-4 flex gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-7 w-28 rounded-md" />
        ))}
      </div>
      <div className="flex max-w-2xl flex-col gap-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
        ))}
      </div>
    </main>
  )
}
