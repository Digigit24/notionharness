'use client'

import { useEffect } from 'react'
import { PaneFailure } from '@/components/ui/pane-boundary'

// R12-P1.2 — one boundary for every settings section (providers, runtimes,
// model, safety, skills, plugins, MCP, health, personality). They are the
// screens most likely to fail for an environmental reason — an unreachable
// daemon, a provider key that no longer authenticates — and those failures are
// exactly the ones whose own message is the answer. Per-section files would be
// nine copies of this one; Next's boundaries already cover the subtree.
export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[settings error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <PaneFailure headline="This settings section could not load." error={error} onRetry={reset} />
    </div>
  )
}
