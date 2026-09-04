import { Skeleton } from '@/components/ui/skeleton'
import { SkeletonList, SkeletonPageHeader } from '@/components/ui/skeletons'

/**
 * The members screen's own shape while its two queries land.
 *
 * The settings rail lives in `settings/layout.tsx` and stays on screen, so this
 * covers only the panel — the navigation must not blink. The invite box is a
 * bordered block above a list of people, so that is what is reserved: a generic
 * card stack here would be a second layout shift with a shimmer on it.
 */
export default function MembersLoading() {
  return (
    <div className="w-full px-5 py-8">
      <SkeletonPageHeader className="mb-6" />
      <div className="flex max-w-3xl flex-col gap-6">
        <div className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 dark:border-white/10">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-full" />
          <div className="mt-1 flex gap-2">
            <Skeleton className="h-8 w-64 rounded-md" />
            <Skeleton className="h-8 w-40 rounded-md" />
            <Skeleton className="h-8 w-36 rounded-md" />
          </div>
        </div>
        <div>
          <Skeleton className="mb-2 h-4 w-40" />
          <SkeletonList rows={4} className="rounded-lg border border-black/10 p-3 dark:border-white/10" />
        </div>
      </div>
    </div>
  )
}
