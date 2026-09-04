'use client'

import { useEffect } from 'react'
import { PaneFailure } from '@/components/ui/pane-boundary'

// R12-P1.2 — the review surface pulls a run, its task, its agent and its diff.
// A run whose worktree has moved out from under it fails here specifically,
// and the message from git or the broker is the whole diagnosis — so it is
// printed verbatim and the queue behind it stays usable.
export default function RunReviewError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[run review error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <PaneFailure headline="This run's review could not be opened." error={error} onRetry={reset} />
    </div>
  )
}
