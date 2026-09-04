import { Skeleton } from '@/components/ui/skeleton'

// Matches ArtifactsInbox's real shape — heading, a filter row, then cards
// with an icon, a title line, a preview line and a trailing control — rather
// than a spinner, per the loading-state standard the other sections follow
// (see inbox/loading.tsx). The skeleton exists mostly because opening the
// panel is a navigation on this same route: without it, clicking a card
// blanks the list it was in.
export default function ArtifactsLoading() {
  return (
    <div className="w-full px-5 py-8">
      <div className="mb-6 flex flex-col gap-1">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="mb-4 flex gap-2">
        <Skeleton className="h-8 w-36 rounded-lg" />
        <Skeleton className="h-8 w-44 rounded-lg" />
        <Skeleton className="h-8 w-52 rounded-lg" />
      </div>
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-start gap-3 rounded-lg border border-black/10 px-3 py-3 dark:border-white/10">
            <Skeleton className="mt-1 size-4 shrink-0" />
            <Skeleton className="size-8 shrink-0 rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-1/4" />
            </div>
            <Skeleton className="h-8 w-36 shrink-0 rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  )
}
