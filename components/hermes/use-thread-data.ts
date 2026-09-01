'use client'

import { useMemo } from 'react'
import { adaptRunEventsToThread } from '@/lib/hermes/runEvent-adapter'
import type { ChatThread, RunEventEnvelope } from '@/lib/hermes/runEvent-adapter'
import { useRunEventStream } from '@/components/runs/use-run-event-stream'
import type { RunMessageRow, Run } from '@/lib/broker/types'

/**
 * Hook: load and adapt run events to ChatThread
 * Reuses useRunEventStream hook (P5.7) for polling/batching/virtualization
 * Wraps result in RunEvent adapter
 */
export function useThreadData(
  taskId: number,
  observed: boolean,
  loader: (taskId: number) => Promise<Array<{ run: Run; events: RunMessageRow[] }>>,
): ChatThread[] {
  const snapshots = useRunEventStream(taskId, observed, async (id) => {
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

  return threads
}
