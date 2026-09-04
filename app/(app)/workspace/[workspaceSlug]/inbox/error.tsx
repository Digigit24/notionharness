'use client'

import { useEffect } from 'react'
import { PaneFailure } from '@/components/ui/pane-boundary'

// R12-P1.2 — the inbox aggregates notifications, approvals and mentions from
// several sources at once, which is several independent ways to fail. It is
// also the first screen many people open, so failing here without taking the
// shell with it is the difference between "the inbox is broken" and "the app
// is broken".
export default function InboxError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[inbox error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <PaneFailure headline="The inbox could not load." error={error} onRetry={reset} />
    </div>
  )
}
