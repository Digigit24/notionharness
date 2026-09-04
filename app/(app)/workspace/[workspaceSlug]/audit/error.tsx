'use client'

import { useEffect } from 'react'
import { PaneFailure } from '@/components/ui/pane-boundary'

// R12-P1.2 — the audit log is the screen you go to when something else has
// already gone wrong, so it is the worst possible one to answer with a blank
// workspace. Its own failure now stays inside its own pane.
export default function AuditError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[audit error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <PaneFailure headline="The audit log could not load." error={error} onRetry={reset} />
    </div>
  )
}
