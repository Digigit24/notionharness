// R12-P2.1 — a loading state shaped like the screen it stands in for.
//
// The repository browser: breadcrumb, ref picker, directory table.
//
// Four of thirty-five routes had one of these; the rest showed the PREVIOUS
// screen until the server component resolved, which reads as a freeze rather
// than as loading. The shape matters more than the animation: a skeleton that
// does not match what replaces it is a second layout shift with a shimmer on
// it.

import { Skeleton } from '@/components/ui/skeleton'
import { SkeletonTable } from '@/components/ui/skeletons'

export default function FilesLoading() {
  return (
    <main className="w-full px-5 py-6">
      <div className="mb-3 flex items-center gap-2">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="ml-auto h-7 w-32 rounded-md" />
      </div>
      <SkeletonTable rows={12} columns={3} />
    </main>
  )
}
