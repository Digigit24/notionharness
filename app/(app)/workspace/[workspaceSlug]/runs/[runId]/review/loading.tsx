// R12-P2.1 — a loading state shaped like the screen it stands in for.
//
// One run's review: the same two-pane shape.
//
// Four of thirty-five routes had one of these; the rest showed the PREVIOUS
// screen until the server component resolved, which reads as a freeze rather
// than as loading. The shape matters more than the animation: a skeleton that
// does not match what replaces it is a second layout shift with a shimmer on
// it.

import { SkeletonCode, SkeletonRail } from '@/components/ui/skeletons'

export default function RunReviewLoading() {
  return (
    <main className="flex h-full w-full gap-4 px-5 py-6">
      <div className="w-64 shrink-0">
        <SkeletonRail rows={8} />
      </div>
      <div className="min-w-0 flex-1">
        <SkeletonCode lines={20} />
      </div>
    </main>
  )
}
