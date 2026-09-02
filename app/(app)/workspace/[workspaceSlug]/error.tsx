'use client'

import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'

// ROADMAP B-6 "Finish" (state-craft sweep) — the workspace segment had NO
// error.tsx anywhere in this app (confirmed via a repo-wide search before
// writing this file: zero error.tsx, zero loading.tsx under app/). Next.js's
// App Router error boundaries are one file per route segment and catch the
// whole subtree below them — this one file now covers every screen mounted
// under /workspace/[workspaceSlug]/* (home, inbox, tasks, agents, projects,
// runs review, active-runs, page canvas) that doesn't already have its own
// more specific error.tsx. Per the plan's own standard: "the real message,
// a retry, and never a blank screen. Provider and daemon errors surface
// verbatim — they are the most useful text on the page." `error.message` is
// shown as-is (not swallowed behind a generic "Something went wrong"),
// since a Payload/broker/daemon failure's own message is exactly the
// diagnostic text an operator needs here.
export default function WorkspaceSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[workspace segment error]', error)
  }, [error])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle size={18} />
        </div>
        <div className="flex flex-col gap-1">
          <p className="font-heading text-sm font-medium text-foreground">Something broke on this page.</p>
          <p className="max-w-sm break-words text-sm text-muted-foreground">
            {error.message || 'An unexpected error occurred.'}
          </p>
          {error.digest && (
            <p className="text-xs text-muted-foreground/70">Reference: {error.digest}</p>
          )}
        </div>
        <Button type="button" size="sm" onClick={() => reset()}>
          Try again
        </Button>
      </div>
    </div>
  )
}
