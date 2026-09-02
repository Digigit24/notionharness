'use client'

import Link from 'next/link'
import { useRef } from 'react'
import { Maximize2 } from 'lucide-react'
import { Thread } from '@/components/hermes'
import { ConnectionStatusBanner } from './connection-status-banner'
import { useThreadData } from './use-thread-data'
import type { Agent } from '@/payload-types'
import type { Run, RunMessageRow } from '@/lib/broker/types'

/**
 * ThreadDrawerTab
 *
 * Mount Thread component in the task drawer's Sessions tab.
 * Uses virtualization for efficient rendering of many runs.
 */
export interface ThreadDrawerTabProps {
  taskId: number
  agents: Agent[]
  loader: (taskId: number) => Promise<Array<{ run: Run; events: RunMessageRow[] }>>
  expandHref?: string
}

export function ThreadDrawerTab({ taskId, agents: _agents, loader, expandHref }: ThreadDrawerTabProps) {
  const observed = true
  const { threads, connectionStatus, retry } = useThreadData(taskId, observed, loader)
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
      <ConnectionStatusBanner status={connectionStatus} onRetry={retry} />
      {/* Most recent thread */}
      {mostRecent && (
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-gray-100 dark:bg-gray-800 px-3 py-2 border-b flex justify-between items-center">
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Latest Run</p>
            {expandHref && (
              <Link
                href={expandHref}
                className="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors p-1"
                title="Expand to full session view"
              >
                <Maximize2 size={14} />
              </Link>
            )}
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
