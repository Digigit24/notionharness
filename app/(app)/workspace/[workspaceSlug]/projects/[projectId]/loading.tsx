// R12-P2.1 — a loading state shaped like the screen it stands in for.
//
// A project: header, the tab strip, and a table in the default tab.
//
// Four of thirty-five routes had one of these; the rest showed the PREVIOUS
// screen until the server component resolved, which reads as a freeze rather
// than as loading. The shape matters more than the animation: a skeleton that
// does not match what replaces it is a second layout shift with a shimmer on
// it.

import { Skeleton } from '@/components/ui/skeleton'
import { SkeletonPageHeader, SkeletonTable } from '@/components/ui/skeletons'

export default function ProjectLoading() {
  return (
    <main className="w-full px-5 py-6">
      <SkeletonPageHeader className="mb-5" />
      <div className="mb-4 flex gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-7 w-24 rounded-md" />
        ))}
      </div>
      <SkeletonTable rows={8} columns={4} />
    </main>
  )
}
