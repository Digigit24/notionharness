'use client'

import { Thread } from '@/components/hermes'
import { ConnectionStatusBanner } from './connection-status-banner'
import { useThreadData } from './use-thread-data'
import type { Agent } from '@/payload-types'
import type { Run, RunMessageRow } from '@/lib/broker/types'

/**
 * ThreadLaneView
 *
 * Mount Thread component in a lane within a team/multi-agent view.
 * Shows the most recent run's thread in a constrained height for side-by-side layout.
 */
export interface ThreadLaneViewProps {
  taskId: number
  taskTitle?: string
  agents: Agent[]
  loader: (taskId: number) => Promise<Array<{ run: Run; events: RunMessageRow[] }>>
  height?: string
}

export function ThreadLaneView({
  taskId,
  taskTitle,
  agents: _agents,
  loader,
  height = 'h-[500px]',
}: ThreadLaneViewProps) {
  const observed = true
  const { threads, connectionStatus, retry } = useThreadData(taskId, observed, loader)
  const mostRecent = threads[threads.length - 1]

  return (
    <div className={`flex flex-col border rounded-lg overflow-hidden bg-white dark:bg-gray-900 ${height}`}>
      {/* Header */}
      <div className="border-b border-gray-200 dark:border-gray-700 px-4 py-3 bg-gray-50 dark:bg-gray-800">
        <h3 className="font-semibold text-sm">{taskTitle ?? `Task #${taskId}`}</h3>
        <p className="text-xs text-gray-500 mt-1">
          {threads.length} run{threads.length !== 1 ? 's' : ''}
          {mostRecent?.done ? ` · ${mostRecent.done.status}` : ' · Running'}
        </p>
      </div>

      <ConnectionStatusBanner status={connectionStatus} onRetry={retry} />

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {mostRecent ? (
          <Thread thread={mostRecent} autoScroll={true} showUsage={false} showRunId={false} />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-gray-500">
            No runs yet
          </div>
        )}
      </div>
    </div>
  )
}
