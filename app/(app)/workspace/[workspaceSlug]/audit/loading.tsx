// R12-P2.1 — a loading state shaped like the screen it stands in for.
//
// The audit log: a long table.
//
// Four of thirty-five routes had one of these; the rest showed the PREVIOUS
// screen until the server component resolved, which reads as a freeze rather
// than as loading. The shape matters more than the animation: a skeleton that
// does not match what replaces it is a second layout shift with a shimmer on
// it.

import { SkeletonPageHeader, SkeletonTable } from '@/components/ui/skeletons'

export default function AuditLoading() {
  return (
    <main className="w-full px-5 py-6">
      <SkeletonPageHeader className="mb-6" />
      <SkeletonTable rows={12} columns={5} />
    </main>
  )
}
