'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'

// ROADMAP B7.3 — plain prev/next pagination over the audit log's URL `page`
// param. Not virtualized: the plan's own reference list view (B-4's
// task-list-view.tsx) virtualizes because a task board can realistically
// hold thousands of rows fetched client-side in one shot; this view is
// server-paginated at PAGE_SIZE=50 per request instead, so there's no large
// in-memory list to virtualize over in the first place.
export function AuditPager({
  page,
  hasNextPage,
  hasPrevPage,
  totalDocs,
}: {
  page: number
  hasNextPage: boolean
  hasPrevPage: boolean
  totalDocs: number
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function goToPage(next: number) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('page', String(next))
    router.push(`${pathname}?${params.toString()}`)
  }

  if (totalDocs === 0) return null

  return (
    <div className="mt-4 flex items-center justify-between text-xs text-black/50 dark:text-white/50">
      <span>{totalDocs} total</span>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={!hasPrevPage} onClick={() => goToPage(page - 1)}>
          Previous
        </Button>
        <span>Page {page}</span>
        <Button type="button" size="sm" variant="outline" disabled={!hasNextPage} onClick={() => goToPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  )
}
