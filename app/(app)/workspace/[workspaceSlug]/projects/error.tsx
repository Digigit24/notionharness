'use client'

import { useEffect } from 'react'
import { PaneFailure } from '@/components/ui/pane-boundary'

// R12-P1.2 — the list joins projects to their task counts and members, so it
// fails for reasons a single project never would. Kept off the workspace
// boundary so a broken join does not cost you the sidebar as well.
export default function ProjectsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[projects error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <PaneFailure headline="The project list could not load." error={error} onRetry={reset} />
    </div>
  )
}
