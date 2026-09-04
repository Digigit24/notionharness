// R12-P2.1 — a loading state shaped like the screen it stands in for.
//
// Work: the session rail beside a transcript.
//
// Four of thirty-five routes had one of these; the rest showed the PREVIOUS
// screen until the server component resolved, which reads as a freeze rather
// than as loading. The shape matters more than the animation: a skeleton that
// does not match what replaces it is a second layout shift with a shimmer on
// it.

import { Skeleton } from '@/components/ui/skeleton'
import { SkeletonList, SkeletonRail } from '@/components/ui/skeletons'

export default function WorkLoading() {
  return (
    <main className="flex h-full w-full gap-4 px-5 py-6">
      <div className="w-64 shrink-0">
        <Skeleton className="mb-2 h-7 w-full rounded-md" />
        <SkeletonRail rows={8} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <SkeletonList rows={5} className="flex-1" />
        <Skeleton className="mt-3 h-16 w-full rounded-xl" />
      </div>
    </main>
  )
}
