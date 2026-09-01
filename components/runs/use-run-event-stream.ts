'use client'

import { useEffect, useRef, useState } from 'react'
import type { Run, RunMessageRow } from '@/lib/broker/types'

export interface RunEventSnapshot {
  run: Run
  events: RunMessageRow[]
}

export type RunEventLoader = (taskId: number) => Promise<RunEventSnapshot[]>

/** Merge by the daemon-assigned sequence number, never arrival time/order. */
export function mergeRunEvents(current: RunMessageRow[], incoming: RunMessageRow[]): RunMessageRow[] {
  const bySeq = new Map(current.map((row) => [row.seq, row]))
  for (const row of incoming) bySeq.set(row.seq, row)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/** Polls only while mounted/observed, and coalesces updates into ~50ms flushes. */
export function useRunEventStream(taskId: number, observed: boolean, load: RunEventLoader) {
  const [snapshots, setSnapshots] = useState<RunEventSnapshot[]>([])
  const pending = useRef<RunEventSnapshot[] | null>(null)
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    if (!observed) return
    let active = true
    const flush = () => {
      flushTimer.current = null
      const next = pending.current
      pending.current = null
      if (!next || !active) return
      setSnapshots((current) => {
        const prior = new Map(current.map((item) => [item.run.id, item]))
        for (const item of next) {
          const old = prior.get(item.run.id)
          prior.set(item.run.id, { run: item.run, events: mergeRunEvents(old?.events ?? [], item.events) })
        }
        return [...prior.values()].sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))
      })
    }
    const refresh = async () => {
      try {
        const next = await loadRef.current(taskId)
        if (!active) return
        pending.current = next
        if (!flushTimer.current) flushTimer.current = setTimeout(flush, 50)
      } catch {
        // A later poll retries; the drawer remains usable while a daemon is offline.
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => {
      active = false
      clearInterval(timer)
      if (flushTimer.current) clearTimeout(flushTimer.current)
      flushTimer.current = null
      pending.current = null
    }
  }, [taskId, observed])

  return snapshots
}
