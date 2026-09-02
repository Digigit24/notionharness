'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatRelativeTime } from '@/lib/relative-time'
import type { PageProvenanceMap } from '@/lib/provenance'

export type ProvenanceTimeFilter = 'all' | 'week'

interface AgentContribution {
  agentId: number
  agentName: string
  blockCount: number
  lastCommittedAt: string
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/**
 * ROADMAP B-2 — the page-level "written by" strip, plus the time filter
 * control (kept in the same component since both read/control the same
 * provenance state, and the plan places them in the same page-header area).
 *
 * **Honest degradation, not the plan's literal "humans and agents":** this
 * strip only ever lists *agents*, never humans. Investigated first, per this
 * batch's own instruction — `collections/Pages.ts` has no `createdBy` field,
 * and no per-block human authorship is tracked anywhere in this codebase
 * (BlockSuite's own Yjs updates carry no stable per-edit user identity
 * today; see `lib/provenance.ts`'s file-level comment for the full
 * investigation). Rendering a human avatar here would mean guessing who
 * touched the page, which this batch's standard explicitly rules out.
 * Renders nothing at all if no run has ever written to this page, rather
 * than an empty "Written by" shell.
 */
export function PageProvenanceStrip({
  provenance,
  workspaceSlug,
  timeFilter,
  onTimeFilterChange,
}: {
  provenance: PageProvenanceMap
  workspaceSlug: string
  timeFilter: ProvenanceTimeFilter
  onTimeFilterChange: (value: ProvenanceTimeFilter) => void
}) {
  const contributors = useMemo<AgentContribution[]>(() => {
    const byAgent = new Map<number, AgentContribution>()
    for (const entry of Object.values(provenance)) {
      if (entry.agentId === null) continue // Defensive: every real entry today does carry an agentId (`runs.agent_id`), but nothing guarantees that forever.
      const existing = byAgent.get(entry.agentId)
      if (!existing) {
        byAgent.set(entry.agentId, {
          agentId: entry.agentId,
          agentName: entry.agentName ?? `Agent #${entry.agentId}`,
          blockCount: 1,
          lastCommittedAt: entry.committedAt,
        })
        continue
      }
      existing.blockCount += 1
      if (Date.parse(entry.committedAt) > Date.parse(existing.lastCommittedAt)) {
        existing.lastCommittedAt = entry.committedAt
      }
    }
    return Array.from(byAgent.values()).sort((a, b) => Date.parse(b.lastCommittedAt) - Date.parse(a.lastCommittedAt))
  }, [provenance])

  if (contributors.length === 0) return null

  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Written by</span>
        <div className="flex -space-x-2">
          {contributors.map((contributor) => (
            <Tooltip key={contributor.agentId}>
              <TooltipTrigger asChild>
                <Link
                  href={`/workspace/${workspaceSlug}/agents/${contributor.agentId}`}
                  className="rounded-full ring-2 ring-background transition-transform hover:z-10 hover:-translate-y-0.5"
                >
                  <Avatar className="size-7">
                    <AvatarFallback className="text-[10px]">{initialsOf(contributor.agentName)}</AvatarFallback>
                  </Avatar>
                </Link>
              </TooltipTrigger>
              <TooltipContent>
                {contributor.agentName} · {contributor.blockCount} block{contributor.blockCount === 1 ? '' : 's'} · last{' '}
                {formatRelativeTime(contributor.lastCommittedAt)}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>

      <Select value={timeFilter} onValueChange={(value) => onTimeFilterChange(value as ProvenanceTimeFilter)}>
        <SelectTrigger size="sm" className="h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All time</SelectItem>
          <SelectItem value="week">This week</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
