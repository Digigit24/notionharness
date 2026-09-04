import Link from 'next/link'
import { CheckSquare, Table2 } from 'lucide-react'

import type { PageOrigin } from '@/lib/page-origin'

/**
 * R7.4 (A5.1 / A5.3) — a page created *for* something says so.
 *
 * Row-paired pages and task documents are deliberately kept out of the sidebar
 * tree, which is correct — they would bury it. But that left them with no
 * context on screen at all: opening a row page told you nothing about which
 * table the row belongs to, and the only way back was the browser button.
 *
 * A server component, because the origin is resolved server-side and this
 * renders it. No state, no interactivity, nothing to hydrate.
 */
export function PageOriginHeader({ workspaceSlug, origin }: { workspaceSlug: string; origin: PageOrigin }) {
  if (!origin) return null

  if (origin.kind === 'record') {
    return (
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-black/50 dark:text-white/50">
        <Table2 size={12} className="shrink-0" />
        <span>Row in</span>
        {/* Linked when the table can be located, plain text when it cannot —
            an inert link that looks clickable is worse than no link. */}
        {origin.tablePageId ? (
          <Link
            href={`/workspace/${workspaceSlug}/p/${origin.tablePageId}`}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {origin.databaseName}
          </Link>
        ) : (
          <span className="font-medium">{origin.databaseName}</span>
        )}
        <span aria-hidden="true">·</span>
        <span className="truncate">{origin.title}</span>
      </div>
    )
  }

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-black/50 dark:text-white/50">
      <CheckSquare size={12} className="shrink-0" />
      <span>Document for</span>
      <Link
        href={`/workspace/${workspaceSlug}/tasks/${origin.taskId}`}
        className="font-medium text-primary underline-offset-2 hover:underline"
      >
        {origin.taskTitle}
      </Link>
      {origin.projectId && origin.projectName && (
        <>
          <span aria-hidden="true">·</span>
          <Link
            href={`/workspace/${workspaceSlug}/projects/${origin.projectId}`}
            className="underline-offset-2 hover:underline"
          >
            {origin.projectName}
          </Link>
        </>
      )}
    </div>
  )
}
