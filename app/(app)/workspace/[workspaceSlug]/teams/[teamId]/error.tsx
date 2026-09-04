'use client'

import { useEffect } from 'react'
import { PaneFailure } from '@/components/ui/pane-boundary'

// R12-P1.2 — a room fans out to the broker, a slot sweep and the pending
// approvals in one await; any one of them can fail on a channel while every
// other channel is fine. Scoped here so that stays true on screen: the failure
// names this channel and the list is one click away, rather than the whole
// workspace going to the segment boundary.
export default function ChannelError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[channel error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <PaneFailure headline="This channel could not be opened." error={error} onRetry={reset} />
    </div>
  )
}
