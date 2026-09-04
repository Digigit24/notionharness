'use client'

import { useEffect } from 'react'
import { PaneFailure } from '@/components/ui/pane-boundary'

// R12-P1.2 — the queue reads every run awaiting a human across the workspace.
// A single unreadable run used to take down the shell; now it takes down the
// queue, and the run's own review surface (which has its own boundary) can
// still be opened directly.
export default function ReviewQueueError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[review queue error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <PaneFailure headline="The review queue could not load." error={error} onRetry={reset} />
    </div>
  )
}
