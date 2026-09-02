import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'

export type BreadcrumbSegment = {
  label: string
  /** Omit on the last segment — it's the current page and renders as plain text, not a link. */
  href?: string
}

/**
 * ROADMAP B-0 (Frame) — the Entity level of the three-tier
 * Workspace / Section / Entity navigation model. Renders a `segments`
 * array as real, individually-navigable `next/link`s (every segment
 * except the last, which is the current page and has no `href`).
 *
 * This component is deliberately dumb: it takes the segments it's given
 * and renders them. Building the segment array for a given page (e.g.
 * Workspace > Projects > "My Project" > "Some Task") is the caller's
 * job — wiring it into every detail page across the app is a separate,
 * larger task than this component itself.
 */
export function Breadcrumbs({ segments, className }: { segments: BreadcrumbSegment[]; className?: string }) {
  if (segments.length === 0) return null

  return (
    <nav aria-label="Breadcrumb" className={cn('flex items-center text-sm text-black/50 dark:text-white/50', className)}>
      <ol className="flex min-w-0 items-center">
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1
          return (
            <li key={`${segment.label}-${index}`} className="flex min-w-0 items-center">
              {index > 0 && (
                <ChevronRight size={14} className="mx-1 shrink-0 text-black/30 dark:text-white/30" aria-hidden="true" />
              )}
              {isLast || !segment.href ? (
                <span
                  className={cn('truncate', isLast && 'font-medium text-black dark:text-white')}
                  aria-current={isLast ? 'page' : undefined}
                >
                  {segment.label}
                </span>
              ) : (
                <Link
                  href={segment.href}
                  className="truncate hover:text-black hover:underline dark:hover:text-white"
                >
                  {segment.label}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
