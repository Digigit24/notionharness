'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '@/hooks/use-toast'
import { ClientFailure, isFailureEnvelope, type WithFailure } from '@/lib/failures'

/**
 * R12-P2.3 — paint first, reconcile after, roll back on failure.
 *
 * THE PATTERN THIS REPLACES. Twenty-four call sites in this app do some
 * variation of `await someAction(...)` followed by `router.refresh()`: a full
 * server round trip, then a re-render of the whole route, to show a state that
 * was already known at the moment of the click. D0's rule is that anything the
 * server has to confirm is confirmed AFTER the paint, never before it.
 *
 * WHY NOT `useOptimistic`. React's own hook is built for a value derived from
 * a server-owned list inside a transition, and it discards the optimistic
 * value the moment the transition ends — which is correct for a form that
 * re-reads its data, and wrong for the mutations here, which own their state
 * locally and never re-read. Using it would mean the row flashing back to its
 * old value between the action resolving and the refresh landing. That flash
 * is the exact artefact this is meant to remove.
 *
 * WHAT THIS DOES INSTEAD. Apply the intended state immediately, run the
 * action, and on failure put back the value captured before the change and
 * say why. `applyReactionToggle` in `components/teams/shared.ts` has worked
 * this way since the channel shipped; this is that shape, generalised.
 */
export interface OptimisticRunner<T> {
  /**
   * @param apply     Paint the intended state now. Runs synchronously.
   * @param rollback  Put it back. Given whatever `apply` returned, so a caller
   *                  can capture the previous value at apply time rather than
   *                  guessing it later.
   * @param work      The server call. Return `WithFailure<T>` from a guarded
   *                  action and its message is surfaced verbatim.
   */
  run: (args: {
    apply: () => void
    rollback: () => void
    work: () => Promise<WithFailure<T>>
    /** Shown when the server refuses. The failure's own message becomes the
     * description, so this is the headline, not the explanation. */
    failureTitle: string
    /** Runs with the server's value once it lands — for reconciling a
     * temporary id with a real one. Never runs on failure. */
    onSettled?: (value: T) => void
  }) => Promise<boolean>
  /** True while at least one call is in flight. For disabling a control that
   * must not be pressed twice — NOT for greying out the thing that already
   * painted. */
  pending: boolean
}

export function useOptimisticAction<T = unknown>(): OptimisticRunner<T> {
  const [inFlight, setInFlight] = useState(0)
  // Rolling back a component that has since unmounted would be writing to
  // state nobody is reading. Harmless, but it also means a failed mutation on
  // a closed pane can skip the toast's rollback work entirely.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback<OptimisticRunner<T>['run']>(async ({ apply, rollback, work, failureTitle, onSettled }) => {
    apply()
    setInFlight((n) => n + 1)
    try {
      const result = await work()
      if (isFailureEnvelope(result)) throw new ClientFailure(result.__failure)
      onSettled?.(result as T)
      return true
    } catch (error) {
      if (mounted.current) rollback()
      toast({
        title: failureTitle,
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
      return false
    } finally {
      setInFlight((n) => Math.max(0, n - 1))
    }
  }, [])

  return { run, pending: inFlight > 0 }
}
