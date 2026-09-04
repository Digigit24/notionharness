import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * R12-P2.2 — the shapes, composed once.
 *
 * A skeleton's job is to reserve the exact box its content will occupy. Get
 * that wrong and it is not a loading state, it is a second layout shift with
 * an animation on it — which is why these are composed here from the real
 * screens rather than improvised per route. Every one of them is a server
 * component: they hold no state and must never cost hydration.
 *
 * Sizes here are taken from the components they stand in for, so when one of
 * those changes shape this file is the single place to correct.
 */

/** A table: header row plus body rows, all columns equal width. */
export function SkeletonTable({
  rows = 8,
  columns = 4,
  className,
}: {
  rows?: number
  columns?: number
  className?: string
}) {
  return (
    <div className={cn('w-full overflow-hidden rounded-lg border border-black/10 dark:border-white/10', className)}>
      <div className="flex gap-3 border-b border-black/10 bg-black/[.02] px-3 py-2 dark:border-white/10 dark:bg-white/[.02]">
        {Array.from({ length: columns }, (_, i) => (
          <Skeleton key={i} className="h-3.5 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-3 border-b border-black/[.06] px-3 py-2.5 last:border-b-0 dark:border-white/[.06]">
          {Array.from({ length: columns }, (_, c) => (
            // The first column carries the title in every table in this app,
            // so it is wider — a row of identical bars reads as a grid, not
            // as the table it is standing in for.
            <Skeleton key={c} className={cn('h-3.5', c === 0 ? 'flex-[2]' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** A vertical list of rows with an avatar-ish leading box. */
export function SkeletonList({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-start gap-2.5">
          <Skeleton className="size-7 shrink-0 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-40" />
            {/* Varying widths, deterministically: a column of identical bars
                reads as a barcode. Derived from the index rather than from
                Math.random so the server and the client agree. */}
            <Skeleton className={cn('h-3', ['w-full', 'w-4/5', 'w-2/3', 'w-11/12'][i % 4])} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Cards in a responsive grid — projects, agents, artifacts. */
export function SkeletonCards({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/10">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
          <div className="mt-1 flex gap-2">
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-5 w-12 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Source code: a gutter of line numbers and lines of varying length. */
export function SkeletonCode({ lines = 18, className }: { lines?: number; className?: string }) {
  const widths = ['w-1/3', 'w-2/3', 'w-1/2', 'w-4/5', 'w-3/5', 'w-11/12', 'w-2/5', 'w-3/4']
  return (
    <div className={cn('overflow-hidden rounded-lg border border-black/10 dark:border-white/10', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-[3px]">
          <Skeleton className="h-3 w-6 shrink-0" />
          <Skeleton className={cn('h-3', widths[i % widths.length])} />
        </div>
      ))}
    </div>
  )
}

/** A chat feed: grouped bursts, so it looks like a conversation rather than
 * a list — the grouping is what makes a channel recognisable at a glance. */
export function SkeletonFeed({ groups = 4, className }: { groups?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-4 px-2', className)}>
      {Array.from({ length: groups }, (_, g) => (
        <div key={g} className="flex gap-2.5">
          <Skeleton className="size-7 shrink-0 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-11/12" />
            {g % 2 === 0 && <Skeleton className="h-3 w-3/5" />}
          </div>
        </div>
      ))}
    </div>
  )
}

/** A left rail of navigation or roster rows. */
export function SkeletonRail({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-7 w-full rounded-md" />
      ))}
    </div>
  )
}

/** The page header every detail screen opens with: breadcrumb, title, blurb. */
export function SkeletonPageHeader({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Skeleton className="h-3 w-48" />
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-3.5 w-96 max-w-full" />
    </div>
  )
}
