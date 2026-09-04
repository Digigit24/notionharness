'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { TERMINAL_STATUSES } from '@/lib/broker/types'
import type { Run, RunMessageRow } from '@/lib/broker/types'
import type { RunEvent } from '@/lib/run-events'

export interface RunEventSnapshot {
  run: Run
  events: RunMessageRow[]
}

export type RunEventLoader = (taskId: number) => Promise<RunEventSnapshot[]>

/**
 * ROADMAP B-6 "Finish" (state-craft sweep) — the "offline/disconnected"
 * standard: "a quiet banner when the event stream ... drops, with
 * automatic reconnect and a manual retry. Never silent." Before this,
 * `source.onerror` below did nothing observable — the browser's own
 * `EventSource` retried silently and callers had no way to know a
 * connection had dropped at all. `'reconnecting'` means at least one of
 * this hook's open SSE connections is currently in its own error/retry
 * state; `'connected'` means every connection this hook has opened is
 * currently open (or none have been opened yet — nothing to be
 * disconnected from).
 */
/**
 * Four states, not two. The previous two-state version showed the same amber
 * "reconnecting" banner for every non-open condition, including the brief gap
 * a normal reconnect always has — so the banner flapped on healthy streams
 * and looked identical whether recovery was one retry away or never coming.
 *
 * - `connected`   nothing to say (also used when nothing live is subscribed)
 * - `connecting`  a drop just happened; stays SILENT for the grace period,
 *                 because most reconnects finish inside it
 * - `reconnecting` still retrying, worth telling the reader about
 * - `offline`     gave up after MAX_RECONNECT_ATTEMPTS; sources are closed,
 *                 so this is terminal until the reader hits Retry
 */
export type RunStreamConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'offline'

/** A drop shorter than this never reaches the screen. */
const RECONNECT_GRACE_MS = 2000
/** After this many consecutive failures a stream is declared offline and
 * closed, rather than retried forever against a server that isn't answering. */
const MAX_RECONNECT_ATTEMPTS = 5

/** Merge by the daemon-assigned sequence number, never arrival time/order. */
export function mergeRunEvents(current: RunMessageRow[], incoming: RunMessageRow[]): RunMessageRow[] {
  const bySeq = new Map(current.map((row) => [row.seq, row]))
  for (const row of incoming) bySeq.set(row.seq, row)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/** Wire shape of one SSE `data:` frame from `/api/runs/[runId]/events/stream`. */
interface RunEventFrame {
  runId: number
  seq: number
  event: RunEvent
  createdAt: string
}

/**
 * `id` is whatever the caller's `load` resolves against — a single run id
 * (block-anchored-thread.tsx) or a task id that can fan out to several runs
 * (use-thread-data.ts, backing ThreadLaneView/ThreadFullPage/ThreadDrawerTab).
 * Live event content for every run `load` returns streams over one SSE
 * connection per run (ROADMAP P5.7) instead of the old 2s client poll; `load`
 * itself is still called on a much longer interval purely to notice a run
 * that didn't exist yet at mount (a task can gain a second run while its
 * drawer is open) — there is no per-task push channel, only the per-run one
 * this route provides, so discovering *new* runs still means asking.
 */
const RUN_DISCOVERY_INTERVAL_MS = 8000

/** Polls only while mounted/observed, and coalesces updates into ~50ms flushes. */
export function useRunEventStream(taskId: number, observed: boolean, load: RunEventLoader) {
  const [snapshots, setSnapshots] = useState<RunEventSnapshot[]>([])
  const [connectionStatus, setConnectionStatus] = useState<RunStreamConnectionStatus>('connected')
  /** How many consecutive reconnects the worst-off stream has attempted —
   * shown as "(2/5)" so a retry loop reads as progress, not as a stuck UI. */
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load
  // Bumped by `retry()` to force the effect below to tear down and rebuild
  // every SSE connection from scratch — a real, user-triggered reconnect
  // rather than waiting on the browser's own backoff timer.
  const [retryToken, setRetryToken] = useState(0)
  const retry = useCallback(() => setRetryToken((t) => t + 1), [])

  // Snapshots belong to the id that produced them, so they are dropped the
  // moment that id changes or observation stops. Without this the previous
  // thread stayed on screen: clicking "New chat" sets the session to null,
  // the early return below skips every code path that writes snapshots, and
  // the last conversation's messages simply stayed painted under a header
  // reading "New chat". Switching between two existing sessions had a milder
  // version of the same fault — the old transcript showed until the new one
  // finished loading.
  //
  // Keyed on the id rather than done inside the effect, because the effect
  // also re-runs on `retryToken` — and `retry()` is called immediately after
  // every send. Clearing there would blank the transcript for the moment it
  // takes discovery to re-fetch, on every single message.
  const observedKey = observed ? taskId : null
  const lastObservedKey = useRef<number | null>(observedKey)
  if (lastObservedKey.current !== observedKey) {
    lastObservedKey.current = observedKey
    // Setting state during render is the supported way to derive state from
    // changed inputs; React re-renders immediately without committing the
    // stale tree. Guarded on length so switching between two empty threads
    // costs nothing.
    if (snapshots.length > 0) setSnapshots([])
  }

  useEffect(() => {
    if (!observed) return
    let active = true
    setConnectionStatus('connected')

    // Per-run bookkeeping, local to this mount/id — reset whenever `taskId`
    // or `observed` changes since the effect below tears everything down.
    const runMeta = new Map<number, Run>()
    const sources = new Map<number, EventSource>()
    const pending = new Map<number, RunMessageRow[]>()
    // Which runs currently have a connection in an error/retrying state —
    // drives the aggregate `connectionStatus` this hook returns.
    const erroredRunIds = new Set<number>()
    /** Consecutive failed connects per run; reset by a successful `onopen`. */
    const attemptsByRunId = new Map<number, number>()
    /** Runs that exhausted MAX_RECONNECT_ATTEMPTS. */
    const offlineRunIds = new Set<number>()
    /** Fires once the grace period is up, promoting `connecting` to
     * `reconnecting`. Cleared whenever the connection recovers first. */
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    let erroredSince = 0
    // Runs that have finished on purpose. The server closes the stream right
    // after sending `done`, and the browser reports every close — including
    // a deliberate one — as an `onerror`. Without tracking this, a completed
    // run left a phantom entry in `erroredRunIds` that nothing could ever
    // clear (its source is closed, so `onopen` will never fire again), which
    // is why the "Live updates dropped — reconnecting…" banner stayed up
    // permanently even while streaming was demonstrably working.
    const finishedRunIds = new Set<number>()
    let flushHandle: number | null = null

    const syncConnectionStatus = () => {
      if (!active) return

      if (offlineRunIds.size > 0) {
        setConnectionStatus('offline')
        setConnectionAttempt(MAX_RECONNECT_ATTEMPTS)
        return
      }

      if (erroredRunIds.size === 0) {
        if (graceTimer) {
          clearTimeout(graceTimer)
          graceTimer = null
        }
        erroredSince = 0
        setConnectionStatus('connected')
        setConnectionAttempt(0)
        return
      }

      let worst = 0
      for (const runId of erroredRunIds) worst = Math.max(worst, attemptsByRunId.get(runId) ?? 1)
      setConnectionAttempt(worst)

      // Silent until the grace period elapses. The timer exists so the
      // promotion happens on its own even if no further events arrive —
      // without it a drop that never produces another callback would stay
      // invisible forever.
      if (erroredSince === 0) erroredSince = Date.now()
      if (Date.now() - erroredSince < RECONNECT_GRACE_MS) {
        setConnectionStatus('connecting')
        if (!graceTimer) {
          graceTimer = setTimeout(() => {
            graceTimer = null
            syncConnectionStatus()
          }, RECONNECT_GRACE_MS)
        }
        return
      }
      setConnectionStatus('reconnecting')
    }

    const flush = () => {
      flushHandle = null
      if (!active || pending.size === 0) return
      const toApply = new Map(pending)
      pending.clear()
      setSnapshots((current) => {
        const bySnapshotId = new Map(current.map((item) => [item.run.id, item]))
        for (const [runId, rows] of toApply) {
          const run = runMeta.get(runId) ?? bySnapshotId.get(runId)?.run
          if (!run) continue
          const existing = bySnapshotId.get(runId)
          bySnapshotId.set(runId, { run, events: mergeRunEvents(existing?.events ?? [], rows) })
        }
        return [...bySnapshotId.values()].sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))
      })
    }

    // Frame-aligned rather than a fixed 50ms timer: paint every chunk on the
    // very next frame (~16ms at 60Hz, and it lands in the same frame the
    // browser was going to render anyway), which is what makes the reveal
    // read as continuous typing instead of arriving in visible steps. Still
    // coalesced — several chunks arriving inside one frame are applied as a
    // single React commit, so this doesn't trade smoothness for re-renders.
    // Falls back to a short timer where rAF isn't available (SSR guard, and
    // background tabs, where rAF is throttled to near-zero).
    const scheduleFlush = () => {
      if (flushHandle !== null) return
      if (typeof requestAnimationFrame === 'function') {
        flushHandle = requestAnimationFrame(() => {
          flushHandle = null
          flush()
        })
      } else {
        flushHandle = setTimeout(() => {
          flushHandle = null
          flush()
        }, 16) as unknown as number
      }
    }

    const closeSource = (runId: number) => {
      sources.get(runId)?.close()
      sources.delete(runId)
      if (erroredRunIds.delete(runId)) syncConnectionStatus()
    }

    /** Opens one SSE connection for a run this hook hasn't seen before.
     * `?since=` seeds the very first connect; every reconnect after that is
     * the browser's own native EventSource retry, which resends
     * `Last-Event-ID` (set from each frame's `id:` on the server) so the
     * route resumes from the last seq this client actually received — no
     * manual reconnect/backoff logic needed here. */
    const openSource = (runId: number, initialEvents: RunMessageRow[]) => {
      if (sources.has(runId)) return
      const lastSeq = initialEvents.reduce((max, row) => Math.max(max, row.seq), 0)
      const source = new EventSource(`/api/runs/${runId}/events/stream?since=${lastSeq}`)
      sources.set(runId, source)

      source.onopen = () => {
        attemptsByRunId.delete(runId)
        offlineRunIds.delete(runId)
        if (erroredRunIds.delete(runId)) syncConnectionStatus()
      }
      source.onmessage = (ev) => {
        if (!active) return
        let frame: RunEventFrame
        try {
          frame = JSON.parse(ev.data) as RunEventFrame
        } catch {
          return // Malformed frame — the next one recovers.
        }
        const row: RunMessageRow = { seq: frame.seq, event: frame.event, createdAt: frame.createdAt }
        const bucket = pending.get(runId)
        if (bucket) bucket.push(row)
        else pending.set(runId, [row])
        scheduleFlush()
        // The route closes right after sending `done`; close from this end
        // too so the browser doesn't treat that as a network drop and try
        // to auto-reconnect into a run that will never emit anything else.
        if (frame.event.type === 'done') {
          finishedRunIds.add(runId)
          closeSource(runId)
        }
      }
      source.onerror = () => {
        // Network drop or a transient server error: EventSource's built-in
        // reconnect (with Last-Event-ID) handles resuming — this hook still
        // needs to surface that a reconnect is in progress rather than stay
        // silent about it (ROADMAP B-6 "offline/disconnected" standard).
        //
        // A run that finished normally is NOT a dropped connection, even
        // though the browser reports the server's deliberate close through
        // this same handler — and because its source is already closed,
        // `onopen` can never fire to clear it again, so treating it as an
        // error left the reconnecting banner stuck on forever.
        if (finishedRunIds.has(runId)) return
        const attempts = (attemptsByRunId.get(runId) ?? 0) + 1
        attemptsByRunId.set(runId, attempts)
        erroredRunIds.add(runId)
        if (attempts >= MAX_RECONNECT_ATTEMPTS) {
          // Stop the EventSource rather than letting the browser retry into
          // a server that has failed five times running — an endless retry
          // loop costs a request every few seconds and still shows the
          // reader the same amber banner. `retry()` reopens everything.
          offlineRunIds.add(runId)
          sources.get(runId)?.close()
          sources.delete(runId)
        }
        syncConnectionStatus()
      }
    }

    const applyList = (list: RunEventSnapshot[]) => {
      if (!active || list.length === 0) return
      // Side effects (tracking run metadata, opening SSE connections) happen
      // once here, not inside the `setSnapshots` updater below — React can
      // invoke a functional updater more than once for the same commit.
      for (const { run, events } of list) {
        runMeta.set(run.id, run)
        // Only stream runs that can still produce events. A finished run's
        // transcript is already complete in `events` — opening a stream for
        // it just makes the server immediately close an empty connection,
        // which the browser reports as an error, which then showed up as a
        // permanent "Live updates dropped — reconnecting…" banner with
        // nothing actually wrong. It also meant a conversation with a long
        // history opened one pointless SSE connection (and its auth +
        // database work) per past run on every single page load.
        if (TERMINAL_STATUSES.includes(run.status)) {
          finishedRunIds.add(run.id)
          continue
        }
        openSource(run.id, events)
      }
      setSnapshots((current) => {
        const bySnapshotId = new Map(current.map((item) => [item.run.id, item]))
        for (const { run, events } of list) {
          const existing = bySnapshotId.get(run.id)
          bySnapshotId.set(run.id, { run, events: mergeRunEvents(existing?.events ?? [], events) })
        }
        return [...bySnapshotId.values()].sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))
      })
    }

    const discoverRuns = async () => {
      try {
        const list = await loadRef.current(taskId)
        if (!active) return
        applyList(list)
      } catch {
        // The next discovery tick retries; already-open SSE connections for
        // known runs keep flowing regardless.
      }
    }

    void discoverRuns()
    const discoveryTimer = setInterval(() => void discoverRuns(), RUN_DISCOVERY_INTERVAL_MS)

    return () => {
      active = false
      clearInterval(discoveryTimer)
      if (graceTimer) clearTimeout(graceTimer)
      if (flushHandle !== null) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(flushHandle)
        clearTimeout(flushHandle)
      }
      for (const source of sources.values()) source.close()
      sources.clear()
      pending.clear()
    }
    // `retryToken` deliberately participates here: bumping it re-runs this
    // whole effect, whose cleanup above already closes every open
    // EventSource — so a manual retry is a full, real reconnect (a fresh
    // `discoverRuns()` call reopening every source from scratch) rather
    // than waiting on the browser's own backoff timer.
  }, [taskId, observed, retryToken])

  return { snapshots, connectionStatus, connectionAttempt, maxConnectionAttempts: MAX_RECONNECT_ATTEMPTS, retry }
}
