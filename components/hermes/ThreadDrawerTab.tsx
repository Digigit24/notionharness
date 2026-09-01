'use client'

import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Thread } from '@/components/hermes'
import { useThreadData } from './use-thread-data'
import type { Agent } from '@/payload-types'

/**
 * ThreadDrawerTab
 *
 * Mount Thread component in the task drawer's Sessions tab.
 * Uses virtualization for efficient rendering of many runs.
 */
export interface ThreadDrawerTabProps {
  taskId: number
  agents: Agent[]
  loader: (taskId: number) => Promise<Array<{ run: any; events: any[] }>>
}

export function ThreadDrawerTab({ taskId, agents, loader }: ThreadDrawerTabProps) {
  const observed = true
  const threads = useThreadData(taskId, observed, loader)
  const parentRef = useRef<HTMLDivElement>(null)

  if (threads.length === 0) {
    return <p className="text-sm text-black/40 dark:text-white/40">No agent runs yet.</p>
  }

  // Stack threads vertically, each in its own container
  // For now, show the most recent thread prominently, others collapsed/expandable
  const mostRecent = threads[threads.length - 1]
  const older = threads.slice(0, -1)

  return (
    <div ref={parentRef} className="flex flex-col gap-4 max-h-[70vh] overflow-auto pb-4">
      {/* Most recent thread */}
      {mostRecent && (
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-gray-100 dark:bg-gray-800 px-3 py-2 border-b">
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Latest Run</p>
          </div>
          <div className="h-[500px] bg-white dark:bg-gray-900">
            <Thread thread={mostRecent} showUsage showRunId={false} />
          </div>
        </div>
      )}

      {/* Older runs collapsed */}
      {older.length > 0 && (
        <details className="border rounded-lg">
          <summary className="bg-gray-100 dark:bg-gray-800 px-3 py-2 cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700">
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
              {older.length} previous run{older.length !== 1 ? 's' : ''}
            </p>
          </summary>
          <div className="flex flex-col gap-3 p-3">
            {older.map((thread, idx) => (
              <div key={idx} className="border rounded overflow-hidden">
                <div className="bg-gray-50 dark:bg-gray-800/50 px-2 py-1">
                  <p className="text-[11px] text-gray-600 dark:text-gray-400">
                    Run {thread.runId}
                  </p>
                </div>
                <div className="h-[300px] bg-white dark:bg-gray-900">
                  <Thread thread={thread} showUsage={false} showRunId={false} />
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
