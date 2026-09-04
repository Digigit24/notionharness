'use client'

import { useEffect } from 'react'
import { PaneFailure } from '@/components/ui/pane-boundary'

// R12-P1.2 — this screen polls live runs, so it fails while a run is failing:
// exactly when the rest of the workspace needs to stay usable to do something
// about it.
export default function ActiveRunsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[active runs error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <PaneFailure headline="Active runs could not load." error={error} onRetry={reset} />
    </div>
  )
}
