'use client'

import { useMemo } from 'react'
import { adaptRunEventsToThread } from '@/lib/hermes/runEvent-adapter'
import type { ChatThread } from '@/lib/hermes/runEvent-adapter'
import { useRunEventStream, type RunStreamConnectionStatus } from '@/components/runs/use-run-event-stream'
import type { RunMessageRow, Run } from '@/lib/broker/types'
import type { RunEventEnvelope } from '@/lib/run-events'

export interface ThreadDataResult {
  threads: ChatThread[]
  /** ROADMAP B-6 "Finish" (state-craft sweep) — see use-run-event-stream.ts's
   * own doc comment. Every `<Thread>` chrome (drawer/full-page/lane/docked
   * panel) shares this one hook, so surfacing it here reaches all of them
   * from a single change. */
  connectionStatus: RunStreamConnectionStatus
  retry: () => void
}

/**
 * Hook: load and adapt run events to ChatThread
 * Reuses useRunEventStream hook (P5.7) for polling/batching/virtualization
 * Wraps result in RunEvent adapter
 */
export function useThreadData(
  taskId: number,
  observed: boolean,
  loader: (taskId: number) => Promise<Array<{ run: Run; events: RunMessageRow[] }>>,
): ThreadDataResult {
  const { snapshots, connectionStatus, retry } = useRunEventStream(taskId, observed, async (id) => {
    const data = await loader(id)
    return data
  })

  const threads = useMemo(() => {
    return snapshots.map(({ run, events }) => {
      const envelopes: RunEventEnvelope[] = events.map((row) => ({
        runId: String(run.id),
        seq: row.seq,
        event: row.event,
      }))
      return adaptRunEventsToThread(envelopes)
    })
  }, [snapshots])

  return { threads, connectionStatus, retry }
}
