// R12-P2.1 — a loading state shaped like the screen it stands in for.
//
// A channel: breadcrumb, view tabs, the feed, the composer, and the roster
// rail collapsed to its 36px lane — which is how it renders by default, so
// the skeleton must not reserve the full 15rem panel.
//
// Four of thirty-five routes had one of these; the rest showed the PREVIOUS
// screen until the server component resolved, which reads as a freeze rather
// than as loading. The shape matters more than the animation: a skeleton that
// does not match what replaces it is a second layout shift with a shimmer on
// it.

import { Skeleton } from '@/components/ui/skeleton'
import { SkeletonFeed } from '@/components/ui/skeletons'

export default function ChannelLoading() {
  return (
    <main className="flex h-full w-full flex-col px-5 py-6">
      <Skeleton className="mb-2 h-3 w-64" />
      <div className="mb-3 flex items-center gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="ml-auto h-7 w-48 rounded-lg" />
      </div>
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-black/10 dark:border-white/10">
          <div className="min-h-0 flex-1 overflow-hidden py-3">
            <SkeletonFeed groups={6} />
          </div>
          <div className="shrink-0 border-t border-black/10 p-3 dark:border-white/10">
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        </div>
        <div className="flex w-9 shrink-0 flex-col items-center gap-1.5 pt-0.5">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="size-6 rounded" />
          ))}
        </div>
      </div>
    </main>
  )
}
