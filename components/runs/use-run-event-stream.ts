'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
export type RunStreamConnectionStatus = 'connected' | 'reconnecting'

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
  const loadRef = useRef(load)
  loadRef.current = load
  // Bumped by `retry()` to force the effect below to tear down and rebuild
  // every SSE connection from scratch — a real, user-triggered reconnect
  // rather than waiting on the browser's own backoff timer.
  const [retryToken, setRetryToken] = useState(0)
  const retry = useCallback(() => setRetryToken((t) => t + 1), [])

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
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const syncConnectionStatus = () => {
      if (!active) return
      setConnectionStatus(erroredRunIds.size > 0 ? 'reconnecting' : 'connected')
    }

    const flush = () => {
      flushTimer = null
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

    const scheduleFlush = () => {
      if (!flushTimer) flushTimer = setTimeout(flush, 50)
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
        if (frame.event.type === 'done') closeSource(runId)
      }
      source.onerror = () => {
        // Network drop or a transient server error: EventSource's built-in
        // reconnect (with Last-Event-ID) handles resuming — this hook still
        // needs to surface that a reconnect is in progress rather than stay
        // silent about it (ROADMAP B-6 "offline/disconnected" standard). A
        // run that's already terminal gets closed by the `done` handler
        // above instead of ever reaching here.
        if (!erroredRunIds.has(runId)) {
          erroredRunIds.add(runId)
          syncConnectionStatus()
        }
      }
    }

    const applyList = (list: RunEventSnapshot[]) => {
      if (!active || list.length === 0) return
      // Side effects (tracking run metadata, opening SSE connections) happen
      // once here, not inside the `setSnapshots` updater below — React can
      // invoke a functional updater more than once for the same commit.
      for (const { run, events } of list) {
        runMeta.set(run.id, run)
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
      if (flushTimer) clearTimeout(flushTimer)
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

  return { snapshots, connectionStatus, retry }
}
