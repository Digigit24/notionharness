'use client'

import { useEffect } from 'react'
import { PaneFailure } from '@/components/ui/pane-boundary'

// R12-P1.2 — Work resolves an agent roster, a project list, live sessions and
// one Hermes config read per profile before it renders anything. A provider
// config that no longer parses fails the whole screen, and the parse error is
// the useful text; scoping it here keeps the rest of the workspace reachable
// while it is fixed.
export default function WorkError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[work error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <PaneFailure headline="Work could not be opened." error={error} onRetry={reset} />
    </div>
  )
}
