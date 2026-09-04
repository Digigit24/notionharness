// R12-P2.1 — a loading state shaped like the screen it stands in for.
//
// Ask: a composer with an answer area above it.
//
// Four of thirty-five routes had one of these; the rest showed the PREVIOUS
// screen until the server component resolved, which reads as a freeze rather
// than as loading. The shape matters more than the animation: a skeleton that
// does not match what replaces it is a second layout shift with a shimmer on
// it.

import { Skeleton } from '@/components/ui/skeleton'
import { SkeletonList } from '@/components/ui/skeletons'

export default function AskLoading() {
  return (
    <main className="mx-auto flex h-full w-full max-w-3xl flex-col px-5 py-6">
      <SkeletonList rows={3} className="flex-1" />
      <Skeleton className="mt-3 h-16 w-full rounded-xl" />
    </main>
  )
}
