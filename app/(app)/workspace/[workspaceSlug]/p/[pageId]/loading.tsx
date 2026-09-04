// R12-P2.1 — a loading state shaped like the screen it stands in for.
//
// A page: the title block and the first few paragraphs of the canvas. The
// editor itself is the heaviest client bundle in the app, so this is what a
// reader looks at while it arrives.
//
// Four of thirty-five routes had one of these; the rest showed the PREVIOUS
// screen until the server component resolved, which reads as a freeze rather
// than as loading. The shape matters more than the animation: a skeleton that
// does not match what replaces it is a second layout shift with a shimmer on
// it.

import { Skeleton } from '@/components/ui/skeleton'

export default function PageLoading() {
  return (
    <main className="mx-auto w-full max-w-3xl px-8 py-10">
      <Skeleton className="mb-3 h-3 w-40" />
      <Skeleton className="mb-6 h-10 w-2/3" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    </main>
  )
}
