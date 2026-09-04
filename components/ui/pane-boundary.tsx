'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { reportFailure } from '@/lib/failures'

/**
 * R12-P1.2 — the one way this app draws "this piece broke".
 *
 * Two exports, because a failure reaches the screen by two different routes
 * and has no business looking like two different products depending on which
 * one it took. A route segment's `error.tsx` is handed its error by Next and
 * renders `PaneFailure` directly; a pane that is NOT a route segment — a
 * thread column, a docked editor — has nothing above it but the segment
 * boundary, which would take the whole screen down with it, so it gets
 * `PaneBoundary` and fails alone.
 *
 * Both print `error.message` verbatim, following the standard the workspace
 * segment boundary set: a Payload, broker or daemon message is the most useful
 * text that can be on the page, and replacing it with "something went wrong"
 * throws away the only sentence that tells anyone what to do next.
 */
export function PaneFailure({
  headline,
  error,
  onRetry,
  compact = false,
  className,
}: {
  /** One sentence naming the surface that broke, in that surface's own words —
   * "The channel list could not load." tells you where you are, "Something
   * broke on this page." does not, and with a dozen of these the difference is
   * the whole point of splitting them up. */
  headline: string
  /** Widened past `Error` because React's App Router adds `digest` and a
   * boundary may also catch a non-Error throw. */
  error: { message?: string; digest?: string }
  onRetry: () => void
  /** Inline form, for a pane sitting beside working UI rather than replacing a
   * whole screen. */
  compact?: boolean
  className?: string
}) {
  const message = error.message || 'An unexpected error occurred.'

  if (compact) {
    return (
      <div
        role="alert"
        className={cn(
          'm-3 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-3 text-left',
          className,
        )}
      >
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <p className="text-xs font-medium text-foreground">{headline}</p>
          <p className="break-words text-xs text-muted-foreground">{message}</p>
          {error.digest && <p className="text-[11px] text-muted-foreground/70">Reference: {error.digest}</p>}
          <Button type="button" size="xs" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div role="alert" className={cn('flex max-w-md flex-col items-center gap-3 text-center', className)}>
      <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle size={18} />
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-heading text-sm font-medium text-foreground">{headline}</p>
        <p className="max-w-sm break-words text-sm text-muted-foreground">{message}</p>
        {error.digest && <p className="text-xs text-muted-foreground/70">Reference: {error.digest}</p>}
      </div>
      <Button type="button" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}

interface PaneBoundaryProps {
  /** Names the pane in both the fallback headline and the log line. */
  label: string
  children: ReactNode
  /** For a parent that needs to react — close the pane, drop a cached row —
   * rather than just show the failure. */
  onError?: (error: Error, info: ErrorInfo) => void
  className?: string
}

interface PaneBoundaryState {
  error: Error | null
}

/**
 * A class, and it has to be: React has never shipped a hook equivalent of
 * `componentDidCatch`, so an error boundary is the one place in this codebase
 * where a class component is the correct answer rather than a leftover.
 *
 * Renders children untouched — a fragment, not a wrapper element — so dropping
 * this around part of a flex column does not change the layout of the pane it
 * is protecting.
 */
export class PaneBoundary extends Component<PaneBoundaryProps, PaneBoundaryState> {
  state: PaneBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): PaneBoundaryState {
    // A throw does not have to be an `Error`, and `PaneFailure` needs a
    // message to print either way.
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportFailure(error, 'pane boundary caught a render failure', {
      pane: this.props.label,
      componentStack: info.componentStack,
    })
    this.props.onError?.(error, info)
  }

  private readonly retry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return <>{this.props.children}</>

    return (
      <PaneFailure
        compact
        headline={`${this.props.label} stopped working.`}
        error={error}
        onRetry={this.retry}
        className={this.props.className}
      />
    )
  }
}
