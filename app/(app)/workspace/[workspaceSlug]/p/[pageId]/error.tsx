'use client'

import { useEffect } from 'react'
import { PaneFailure } from '@/components/ui/pane-boundary'

// R12-P1.2 — this catches the SERVER side of a page: the row, its stored doc
// state and the provenance map. A crash inside the editor once it has mounted
// is caught closer in, by the PaneBoundary around BlockSuiteEditor in
// page-canvas.tsx, which keeps the title and header alive. Splitting the two is
// the point — a document that will not load and an editor that fell over are
// different problems and read as different sentences.
export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[page error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <PaneFailure headline="This page could not be opened." error={error} onRetry={reset} />
    </div>
  )
}
