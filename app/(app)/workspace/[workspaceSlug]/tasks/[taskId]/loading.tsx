// R12-P2.1 — a loading state shaped like the screen it stands in for.
//
// One task: header, tabs, and the document beneath them.
//
// Four of thirty-five routes had one of these; the rest showed the PREVIOUS
// screen until the server component resolved, which reads as a freeze rather
// than as loading. The shape matters more than the animation: a skeleton that
// does not match what replaces it is a second layout shift with a shimmer on
// it.

import { Skeleton } from '@/components/ui/skeleton'
import { SkeletonPageHeader } from '@/components/ui/skeletons'

export default function TaskLoading() {
  return (
    <main className="w-full px-5 py-6">
      <SkeletonPageHeader className="mb-5" />
      <div className="mb-4 flex gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-7 w-24 rounded-md" />
        ))}
      </div>
      <div className="flex max-w-3xl flex-col gap-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-10/12" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </main>
  )
}
