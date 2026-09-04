// R12-P2.1 — a loading state shaped like the screen it stands in for.
//
// A task's session transcript.
//
// Four of thirty-five routes had one of these; the rest showed the PREVIOUS
// screen until the server component resolved, which reads as a freeze rather
// than as loading. The shape matters more than the animation: a skeleton that
// does not match what replaces it is a second layout shift with a shimmer on
// it.

import { SkeletonList } from '@/components/ui/skeletons'

export default function TaskSessionLoading() {
  return (
    <main className="w-full px-5 py-6">
      <SkeletonList rows={6} />
    </main>
  )
}
