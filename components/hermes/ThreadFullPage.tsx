'use client'

import { useState } from 'react'
import { Thread } from '@/components/hermes'
import { ConnectionStatusBanner } from './connection-status-banner'
import { useThreadData } from './use-thread-data'
import type { Agent } from '@/payload-types'
import type { Run, RunMessageRow } from '@/lib/broker/types'

/**
 * ThreadFullPage
 *
 * Mount Thread component as a full-page view with a session list sidebar.
 * Select a run from the sidebar to view its thread in the main area.
 */
export interface ThreadFullPageProps {
  taskId: number
  taskTitle?: string
  agents: Agent[]
  loader: (taskId: number) => Promise<Array<{ run: Run; events: RunMessageRow[] }>>
}

export function ThreadFullPage({ taskId, taskTitle, agents: _agents, loader }: ThreadFullPageProps) {
  const observed = true
  const { threads, connectionStatus, retry } = useThreadData(taskId, observed, loader)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)

  const selected = threads.find((t) => t.runId === selectedRunId) ?? threads[threads.length - 1]

  if (threads.length === 0) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-lg text-gray-500">No agent runs yet for this task.</p>
      </div>
    )
  }

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950">
      {/* Left sidebar: Session list */}
      <div className="w-64 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col">
        <div className="border-b border-gray-200 dark:border-gray-700 p-4">
          <h2 className="font-semibold text-sm truncate">{taskTitle ?? `Task #${taskId}`}</h2>
          <p className="text-xs text-gray-500 mt-1">{threads.length} run{threads.length !== 1 ? 's' : ''}</p>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto">
          <ul className="divide-y divide-gray-200 dark:divide-gray-700">
            {[...threads].reverse().map((thread) => (
              <li key={thread.runId}>
                <button
                  onClick={() => setSelectedRunId(thread.runId)}
                  className={`w-full text-left px-4 py-3 text-sm transition-colors ${
                    thread.runId === selectedRunId
                      ? 'bg-blue-50 dark:bg-blue-900/20 border-l-2 border-blue-500'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  <div className="font-medium text-sm truncate">Run {thread.runId}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {thread.messages.length} message{thread.messages.length !== 1 ? 's' : ''}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    {thread.done
                      ? `Done: ${thread.done.status}`
                      : 'Running...'}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Right main area: Thread view */}
      <div className="flex-1 flex flex-col bg-white dark:bg-gray-900">
        <div className="border-b border-gray-200 dark:border-gray-700 px-6 py-4">
          <h1 className="text-lg font-semibold">Run {selected?.runId}</h1>
        </div>
        <ConnectionStatusBanner status={connectionStatus} onRetry={retry} />
        <div className="flex-1 overflow-hidden">
          {selected && <Thread thread={selected} showUsage={true} showRunId={false} />}
        </div>
      </div>
    </div>
  )
}
