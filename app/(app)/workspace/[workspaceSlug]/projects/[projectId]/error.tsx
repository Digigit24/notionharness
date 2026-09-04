'use client'

import { useEffect } from 'react'
import { PaneFailure } from '@/components/ui/pane-boundary'

// R12-P1.2 — a project page loads its board columns, task rows and assignable
// users together. One project with a bad column ordering or a dangling
// assignee should not make Projects itself unreachable, which is what happened
// while the workspace boundary was the only one.
export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[project error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <PaneFailure headline="This project could not be opened." error={error} onRetry={reset} />
    </div>
  )
}
