// R12-P2.1 — a loading state shaped like the screen it stands in for.
//
// The review surface: a file tree beside a diff. Both have a known shape
// before the diff is read, which is exactly the case a skeleton is for — this
// screen previously painted nothing at all until the whole diff had loaded.
//
// Four of thirty-five routes had one of these; the rest showed the PREVIOUS
// screen until the server component resolved, which reads as a freeze rather
// than as loading. The shape matters more than the animation: a skeleton that
// does not match what replaces it is a second layout shift with a shimmer on
// it.

import { SkeletonCode, SkeletonRail } from '@/components/ui/skeletons'

export default function ReviewLoading() {
  return (
    <main className="flex h-full w-full gap-4 px-5 py-6">
      <div className="w-64 shrink-0">
        <SkeletonRail rows={10} />
      </div>
      <div className="min-w-0 flex-1">
        <SkeletonCode lines={22} />
      </div>
    </main>
  )
}
