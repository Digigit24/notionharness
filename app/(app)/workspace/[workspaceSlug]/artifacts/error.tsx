'use client'

import { useEffect } from 'react'
import { PaneFailure } from '@/components/ui/pane-boundary'

// R12-P1.2 — artifacts resolve back to the sessions and agents that produced
// them, so a deleted session can break the list while everything else is
// healthy. There is already an artifacts/loading.tsx for the same reason: this
// route navigates to itself when a card is opened.
export default function ArtifactsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[artifacts error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <PaneFailure headline="The artifact inbox could not load." error={error} onRetry={reset} />
    </div>
  )
}
