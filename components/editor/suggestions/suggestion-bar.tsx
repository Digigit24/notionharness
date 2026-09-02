'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { acceptSuggestionRun, listPendingSuggestionsForPage, rejectSuggestionRun } from '@/app/(app)/actions'

const POLL_MS = 4000

type PendingSuggestion = { runId: number; subtreeBlockId: string; createdAt: string }

/**
 * ROADMAP B3.1 (Batch B-2 "Moat") — the "Accept all / Reject all / Review one
 * by one" floating bar from the plan's own description, shipped at the
 * whole-run granularity `lib/agent-suggestions.ts` documents. Each pending
 * run gets its own row with its own Accept/Reject pair — that IS "review one
 * by one" at this design's granularity (a run's whole subtree, not a single
 * block); the header-level Accept all/Reject all buttons apply the same
 * action to every pending run on the page at once.
 *
 * Polls independently of `BlockSuiteEditor.tsx`'s own pending-subtree poll
 * (which drives the CSS treatment on the blocks themselves) — same
 * "decoupled, each polls what it needs" pattern already used by
 * `affine-run-card`'s status polling elsewhere in this editor.
 */
export function SuggestionBar({ pageId }: { pageId: number }) {
  const [suggestions, setSuggestions] = useState<PendingSuggestion[]>([])
  const [busy, setBusy] = useState<'all-accept' | 'all-reject' | number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await listPendingSuggestionsForPage(pageId)
      setSuggestions(next)
    } catch {
      // A later poll retries; a transient failure here must never break editing.
    }
  }, [pageId])

  useEffect(() => {
    let cancelled = false
    void refresh()
    const timer = setInterval(() => {
      if (!cancelled) void refresh()
    }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refresh])

  async function handleAccept(runId: number) {
    setBusy(runId)
    setError(null)
    try {
      await acceptSuggestionRun(runId)
      setSuggestions((prev) => prev.filter((s) => s.runId !== runId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept run.')
    } finally {
      setBusy(null)
    }
  }

  async function handleReject(runId: number) {
    setBusy(runId)
    setError(null)
    try {
      await rejectSuggestionRun(runId)
      setSuggestions((prev) => prev.filter((s) => s.runId !== runId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject run.')
    } finally {
      setBusy(null)
    }
  }

  async function handleAcceptAll() {
    setBusy('all-accept')
    setError(null)
    try {
      await Promise.all(suggestions.map((s) => acceptSuggestionRun(s.runId)))
      setSuggestions([])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept all runs.')
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  async function handleRejectAll() {
    setBusy('all-reject')
    setError(null)
    try {
      await Promise.all(suggestions.map((s) => rejectSuggestionRun(s.runId)))
      setSuggestions([])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject all runs.')
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  if (suggestions.length === 0) return null

  return (
    <div className="sticky bottom-4 z-20 mx-auto w-full max-w-2xl px-4">
      <Card className="gap-2 border-primary/30 bg-popover/95 py-3 shadow-lg backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4">
          <span className="text-sm font-medium">
            {suggestions.length} pending suggestion{suggestions.length === 1 ? '' : 's'} from agent runs
          </span>
          {suggestions.length > 1 && (
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void handleRejectAll()}>
                Reject all
              </Button>
              <Button size="sm" disabled={busy !== null} onClick={() => void handleAcceptAll()}>
                Accept all
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1 px-4">
          {suggestions.map((s) => (
            <div key={s.runId} className="flex items-center justify-between gap-2 rounded-md py-1 text-sm">
              <span className="text-muted-foreground">Agent run #{s.runId}</span>
              <div className="flex items-center gap-1">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Reject run #${s.runId}`}
                  disabled={busy !== null}
                  onClick={() => void handleReject(s.runId)}
                >
                  <X size={14} />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Accept run #${s.runId}`}
                  disabled={busy !== null}
                  onClick={() => void handleAccept(s.runId)}
                >
                  <Check size={14} />
                </Button>
              </div>
            </div>
          ))}
        </div>

        {error && <p className="px-4 text-xs text-destructive">{error}</p>}
      </Card>
    </div>
  )
}
