'use client'

import { useEffect } from 'react'
import { PaneFailure } from '@/components/ui/pane-boundary'

// R12-P1.2 — covers the roster and each agent's detail page below it. Agents
// carry runtime profiles and handshakes, so a runtime that has been uninstalled
// underneath a saved agent surfaces here; its message names the runtime, which
// is the one thing worth reading.
export default function AgentsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[agents error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <PaneFailure headline="The agent list could not load." error={error} onRetry={reset} />
    </div>
  )
}
