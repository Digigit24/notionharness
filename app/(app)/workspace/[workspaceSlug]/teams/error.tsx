'use client'

import { useEffect } from 'react'
import { PaneFailure } from '@/components/ui/pane-boundary'

// R12-P1.2 — Channels is the busiest read in the app (every room's unread,
// mention count and last message in two round trips), and until this file
// existed one bad row took the whole workspace shell down with it. The list
// failing now leaves the sidebar, the switcher and every other section
// navigable. The child segment has its own boundary, so a broken room does not
// blank the list you opened it from either.
export default function ChannelsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[channels error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <PaneFailure headline="The channel list could not load." error={error} onRetry={reset} />
    </div>
  )
}
