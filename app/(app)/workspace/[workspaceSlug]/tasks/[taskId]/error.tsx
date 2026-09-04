'use client'

import { useEffect } from 'react'
import { PaneFailure } from '@/components/ui/pane-boundary'

// R12-P1.2 — a task detail view loads statuses, projects, assignees and the
// task's own run history. One task with a dangling reference should cost you
// that task, not the board it is on.
export default function TaskError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[task error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <PaneFailure headline="This task could not be opened." error={error} onRetry={reset} />
    </div>
  )
}
