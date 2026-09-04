'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { getProjectRuns, type ProjectRunRow } from '@/app/(app)/workspace/[workspaceSlug]/projects/[projectId]/actions'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import type { Agent } from '@/payload-types'
import type { RunStatus } from '@/lib/broker'
import { PlayCircle } from 'lucide-react'
import { formatTimestamp } from '@/lib/relative-time'

const STATUS_BADGE_VARIANT: Record<RunStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  completed: 'default',
  failed: 'destructive',
  cancelled: 'outline',
  queued: 'secondary',
  dispatched: 'secondary',
  running: 'secondary',
  waiting_directory: 'secondary',
}

function durationLabel(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '—'
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  const minutes = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 60000))
  return minutes < 1 ? '<1m' : `${minutes}m`
}

// ROADMAP B-1 (project detail, Runs tab) — "every run across this project's
// tasks, filterable by agent... cost rollup shown at the top." Runs are D5
// raw-pg rows with no project column of their own; `listRunsForProject`
// (lib/broker/runs.ts) joins through the Payload-owned `tasks` table, the
// same pattern `listActiveRunsForWorkspace` already established.
export function ProjectRunsTab({
  projectId,
  workspaceSlug,
  agents,
  initialRuns,
}: {
  projectId: number
  workspaceSlug: string
  agents: Agent[]
  initialRuns: ProjectRunRow[]
}) {
  const [agentFilter, setAgentFilter] = useState<'all' | number>('all')
  const [rows, setRows] = useState<ProjectRunRow[]>(initialRuns)
  const [loading, setLoading] = useState(false)
  const isFirstRender = useRef(true)

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    let active = true
    setLoading(true)
    getProjectRuns({ projectId, agentId: agentFilter === 'all' ? null : agentFilter })
      .then((next) => {
        if (active) setRows(next)
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [projectId, agentFilter])

  const totalCostTicks = rows.reduce((sum, row) => sum + row.usage.totalCostTicks, 0)

  if (initialRuns.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<PlayCircle />}
          title="No runs yet"
          description="Assign an agent to a task in this project to start one."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <span className="font-medium">${(totalCostTicks / 100).toFixed(2)}</span>{' '}
          <span className="text-black/50 dark:text-white/50">
            total cost across {rows.length} run{rows.length === 1 ? '' : 's'}
          </span>
        </div>
        <select
          value={agentFilter === 'all' ? '' : agentFilter}
          onChange={(e) => setAgentFilter(e.target.value ? Number(e.target.value) : 'all')}
          className="rounded-md border border-black/10 bg-transparent px-2.5 py-1.5 text-sm dark:border-white/10"
        >
          <option value="">All agents</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </div>

      <div className={loading ? 'opacity-50' : undefined}>
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-black/40 dark:text-white/40">No runs for this agent.</p>
        ) : (
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="text-xs text-black/40 dark:text-white/40">
                <th className="border-b border-black/10 px-2 py-2 font-medium dark:border-white/10">Run</th>
                <th className="border-b border-black/10 px-2 py-2 font-medium dark:border-white/10">Status</th>
                <th className="border-b border-black/10 px-2 py-2 font-medium dark:border-white/10">Duration</th>
                <th className="border-b border-black/10 px-2 py-2 font-medium dark:border-white/10">Cost</th>
                <th className="border-b border-black/10 px-2 py-2 font-medium dark:border-white/10">Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ run, usage }) => (
                <tr key={run.id} className="hover:bg-black/[.03] dark:hover:bg-white/[.04]">
                  <td className="border-b border-black/5 px-2 py-2 dark:border-white/10">
                    {/* A run started from a conversation goes back to that
                        conversation, because that is where its context is —
                        the prompt, the reply, the whole thread. The review
                        screen is the right destination only for a run that
                        has no conversation to return to. */}
                    <Link
                      href={
                        run.sessionId
                          ? `/workspace/${workspaceSlug}/work?session=${run.sessionId}`
                          : `/workspace/${workspaceSlug}/runs/${run.id}/review`
                      }
                      className="font-medium hover:underline"
                    >
                      Run #{run.id}
                    </Link>
                    {run.sessionId && (
                      <span className="ml-1.5 text-[10px] text-black/35 dark:text-white/35">in Work</span>
                    )}
                  </td>
                  <td className="border-b border-black/5 px-2 py-2 dark:border-white/10">
                    <Badge variant={STATUS_BADGE_VARIANT[run.status]}>{run.status}</Badge>
                  </td>
                  <td className="border-b border-black/5 px-2 py-2 dark:border-white/10">{durationLabel(run.startedAt, run.completedAt)}</td>
                  <td className="border-b border-black/5 px-2 py-2 dark:border-white/10">${(usage.totalCostTicks / 100).toFixed(2)}</td>
                  <td className="border-b border-black/5 px-2 py-2 text-black/50 dark:border-white/10 dark:text-white/50">
                    {run.startedAt ? formatTimestamp(run.startedAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
