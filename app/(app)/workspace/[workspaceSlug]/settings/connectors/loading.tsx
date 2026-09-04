import { SkeletonList, SkeletonPageHeader } from '@/components/ui/skeletons'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The shape this screen will have, reserved before it has it.
 *
 * The panel's first paint waits on a Composio round trip for the key's
 * presence, which is a network call to somebody else's server — exactly the
 * kind of wait that must show its shape rather than a spinner over nothing
 * (R12-P2.2). The boxes below match the real sections: header, key card, list,
 * activity.
 */
export default function ConnectorsSettingsLoading() {
  return (
    <main className="w-full max-w-3xl px-5 py-8">
      <SkeletonPageHeader className="mb-6" />

      <div className="mb-8 rounded-lg border border-black/10 p-4 dark:border-white/10">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="mt-2 h-3 w-full max-w-md" />
        <Skeleton className="mt-4 h-8 w-72" />
      </div>

      <div className="mb-8">
        <Skeleton className="mb-3 h-3.5 w-48" />
        <SkeletonList rows={4} />
      </div>

      <div className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <Skeleton className="h-3.5 w-28" />
        <SkeletonList rows={3} className="mt-3" />
      </div>
    </main>
  )
}
