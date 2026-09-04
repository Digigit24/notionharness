// R12-P2.1 — a loading state shaped like the screen it stands in for.
//
// Settings. The rail lives in `settings/layout.tsx` and stays on screen, so
// this covers only the panel beside it — which is the whole point of a
// segment loading file: the navigation does not blink.
//
// Four of thirty-five routes had one of these; the rest showed the PREVIOUS
// screen until the server component resolved, which reads as a freeze rather
// than as loading. The shape matters more than the animation: a skeleton that
// does not match what replaces it is a second layout shift with a shimmer on
// it.

import { Skeleton } from '@/components/ui/skeleton'
import { SkeletonPageHeader } from '@/components/ui/skeletons'

export default function SettingsLoading() {
  return (
    <div className="w-full px-5 py-8">
      <SkeletonPageHeader className="mb-6" />
      <div className="flex max-w-2xl flex-col gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 dark:border-white/10">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-8 w-56 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  )
}
