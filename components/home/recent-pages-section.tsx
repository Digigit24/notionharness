'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { FileText } from 'lucide-react'
import { getRecentPageVisits, type RecentPageEntry } from '@/lib/recent-pages-client'
import { formatRelativeTime } from '@/lib/relative-time'
import { EmptyState } from '@/components/ui/empty-state'
import { NewPageButton } from '@/components/canvas/new-page-button'

/**
 * Client-only: recent pages live in localStorage (see
 * lib/recent-pages-client.ts for why), so this can't be a Server Component
 * section like the rest of the home surface. Renders nothing until mount to
 * avoid a hydration mismatch against the server-rendered shell.
 */
export function RecentPagesSection({
  workspaceSlug,
  workspaceId,
}: {
  workspaceSlug: string
  workspaceId: number
}) {
  const [entries, setEntries] = useState<RecentPageEntry[] | null>(null)

  useEffect(() => {
    setEntries(getRecentPageVisits(workspaceSlug))
  }, [workspaceSlug])

  if (entries === null) {
    return <div className="h-16 animate-pulse rounded-md bg-black/[.03] dark:bg-white/[.04]" />
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No recently visited pages yet"
        description="Pages you open will show up here so you can jump back in."
        className="py-6"
      >
        {/* EmptyState's `action` prop only supports a plain href/onClick, not
            a Server Action button — NewPageButton wraps createPage() itself,
            so it's rendered as a child instead of through `action`. */}
        <NewPageButton workspaceId={workspaceId} workspaceSlug={workspaceSlug} />
      </EmptyState>
    )
  }

  return (
    <ul className="flex flex-col gap-1">
      {entries.map((entry) => (
        <li key={entry.id}>
          <Link
            href={`/workspace/${workspaceSlug}/p/${entry.id}`}
            className="flex items-center justify-between gap-3 rounded-md px-3 py-2 hover:bg-black/[.04] dark:hover:bg-white/[.06]"
          >
            <span className="flex min-w-0 items-center gap-2 text-sm">
              <span className="shrink-0">{entry.icon || <FileText size={14} />}</span>
              <span className="truncate">{entry.title || 'Untitled'}</span>
            </span>
            <span className="shrink-0 text-xs text-black/30 dark:text-white/30">
              {formatRelativeTime(entry.visitedAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
