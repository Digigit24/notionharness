'use client'

import { useEffect } from 'react'
import { recordRecentPageVisit } from '@/lib/recent-pages-client'

/**
 * Renders nothing — records the current page into the per-viewer
 * localStorage recent-pages list (see lib/recent-pages-client.ts) on mount.
 * Mounted directly from the page route (a Server Component) so the route
 * doesn't need to know anything about localStorage itself.
 */
export function RecentPageTracker({
  workspaceSlug,
  pageId,
  title,
  icon,
}: {
  workspaceSlug: string
  pageId: number
  title: string
  icon: string | null
}) {
  useEffect(() => {
    recordRecentPageVisit(workspaceSlug, { id: pageId, title: title || 'Untitled', icon })
    // Re-record on id/title/icon change (e.g. a rename while the page is
    // open) but not on every render.
  }, [workspaceSlug, pageId, title, icon])

  return null
}
