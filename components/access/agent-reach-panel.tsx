'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { SkeletonTable } from '@/components/ui/skeletons'
import { unwrap } from '@/lib/failures'
import { useOptimisticAction } from '@/lib/optimistic'
import { GRANT_ROLES, type GrantRole } from '@/lib/permissions/model'
import { grantAccess, listAgentReach, revokeGrant } from './actions'
import type { AgentReach, AgentReachRow } from './types'

/**
 * What this agent may reach, with the intersection rule stated on the screen.
 *
 * THE RULE THIS PANEL EXISTS TO MAKE VISIBLE. An agent's effective permissions
 * are the INTERSECTION of its own grants and the accountable user's — never
 * the union, never the agent's alone. A screen that showed only the agent's
 * column would imply an agent granted `admin` is an admin, when the same agent
 * running for a viewer is a viewer. So every row shows three things: what the
 * agent has, what YOU have, and what the agent would actually get running on
 * your behalf. The third column is computed by the server from
 * `weakerGrantRole`, the same function enforcement uses, rather than
 * re-derived here where it could drift.
 *
 * THE MIGRATION AFFORDANCE, SAID OUT LOUD. `lib/permissions` treats an agent
 * with NO grants anywhere as `editor`, so workspaces that predate the grants
 * table keep working. That is a real regime with real reach, and an empty
 * table that silently meant "everything" would be the worst thing a
 * permissions screen could show. Until the first grant exists the table is
 * covered by a banner saying which regime the agent is in, and making the
 * first grant is framed as the deliberate act that ends it — because it is:
 * the moment one row exists, every object without one becomes a refusal.
 */
export function AgentReachPanel({
  workspaceId,
  workspaceSlug,
  agentId,
}: {
  workspaceId: number
  workspaceSlug: string
  agentId: number
}) {
  const [view, setView] = useState<AgentReach | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const optimistic = useOptimisticAction()

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      setView(unwrap(await listAgentReach({ workspaceId, agentId })))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not read what this agent can reach.')
    }
  }, [workspaceId, agentId])

  useEffect(() => {
    void load()
  }, [load])

  if (loadError) {
    return (
      <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        {loadError}
      </p>
    )
  }
  if (!view) return <SkeletonTable rows={5} columns={4} />

  async function setRole(row: AgentReachRow, next: GrantRole | null) {
    if (!view) return
    const previous = row.agentRole
    const wasFirstGrant = !view.hasAnyGrant && next !== null
    await optimistic.run({
      apply: () =>
        setView((current) =>
          current
            ? {
                ...current,
                // The banner has to flip on the FIRST grant, in the same paint
                // as the row does — the two are one fact, and showing the
                // agent as granted while still claiming it inherits everything
                // would be a contradiction on screen.
                hasAnyGrant: current.hasAnyGrant || next !== null,
                rows: current.rows.map((entry) =>
                  entry.objectType === row.objectType && entry.objectId === row.objectId
                    ? {
                        ...entry,
                        agentRole: next,
                        effectiveForViewer: next && entry.viewerRole ? weaker(next, entry.viewerRole) : null,
                      }
                    : entry,
                ),
              }
            : current,
        ),
      // A failed first grant must not leave the banner saying the regime
      // changed, so this reloads rather than patching one row back.
      rollback: () => void load(),
      work: () =>
        next === null
          ? revokeGrant({ workspaceId, workspaceSlug, grantId: row.grantId as number })
          : grantAccess({
              workspaceId,
              workspaceSlug,
              objectType: row.objectType,
              objectId: row.objectId,
              subjectAgentId: agentId,
              role: next,
            }),
      failureTitle:
        next === null
          ? `Could not take ${row.objectName} away from this agent`
          : `Could not give this agent ${row.objectName}`,
      onSettled: (value) => {
        const grantId = (value as { grantId?: number }).grantId ?? null
        setView((current) =>
          current
            ? {
                ...current,
                rows: current.rows.map((entry) =>
                  entry.objectType === row.objectType && entry.objectId === row.objectId
                    ? { ...entry, grantId: next === null ? null : grantId }
                    : entry,
                ),
              }
            : current,
        )
        // The first grant changes what EVERY other row means, so re-read once
        // rather than trusting the optimistic flip for the rest of the session.
        if (wasFirstGrant) void load()
      },
    })
    void previous
  }

  const projects = view.rows.filter((row) => row.objectType === 'project')
  const channels = view.rows.filter((row) => row.objectType === 'channel')

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h3 className="text-sm font-semibold">What {view.agentName} can reach</h3>
        <p className="mt-0.5 max-w-prose text-xs text-black/50 dark:text-white/50">
          An agent&apos;s effective permissions are the <strong>intersection</strong> of its own grants and the
          permissions of the person accountable for the run — never the union, never the agent&apos;s alone. An
          agent granted <Badge variant="outline">admin</Badge> acting for a viewer gets{' '}
          <Badge variant="outline">viewer</Badge>. The last column is what this agent would actually get running
          on your behalf.
        </p>
      </header>

      {!view.hasAnyGrant && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[.07] px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            This agent has no explicit access, so it inherits the workspace default: it is treated as{' '}
            <Badge variant="outline">editor</Badge> on everything in this workspace. That is a migration
            affordance for agents created before per-object access existed — not a decision anyone made about
            this agent. <strong>Giving it its first grant below ends that</strong>: from then on it reaches only
            what is listed here, and everything else becomes a refusal.
          </span>
        </div>
      )}

      <ReachTable title="Projects" rows={projects} disabledPending={optimistic.pending} onChange={setRole} inherits={!view.hasAnyGrant} />
      <ReachTable title="Channels" rows={channels} disabledPending={optimistic.pending} onChange={setRole} inherits={!view.hasAnyGrant} />
    </section>
  )
}

function ReachTable({
  title,
  rows,
  inherits,
  disabledPending,
  onChange,
}: {
  title: string
  rows: AgentReachRow[]
  /** True while the agent is still in the no-grants-anywhere regime, so the
   * effective column can say "editor (inherited)" instead of a bare dash that
   * would read as "no access". */
  inherits: boolean
  disabledPending: boolean
  onChange: (row: AgentReachRow, next: GrantRole | null) => void | Promise<void>
}) {
  return (
    <div>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">
        {title}
      </h4>
      <div className="overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
        <div className="grid grid-cols-[minmax(0,1fr)_7rem_5rem_9rem] gap-2 border-b border-black/10 bg-black/[.02] px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-black/40 dark:border-white/10 dark:bg-white/[.02] dark:text-white/40">
          <span>{title.slice(0, -1)}</span>
          <span>Agent&apos;s grant</span>
          <span>Yours</span>
          <span>Effective for you</span>
        </div>
        {rows.length === 0 && (
          <p className="px-3 py-3 text-xs text-black/45 dark:text-white/45">
            This workspace has no {title.toLowerCase()}.
          </p>
        )}
        {rows.map((row) => (
          <div
            key={`${row.objectType}:${row.objectId}`}
            className="grid grid-cols-[minmax(0,1fr)_7rem_5rem_9rem] items-center gap-2 border-b border-black/[.06] px-3 py-2 last:border-b-0 dark:border-white/[.06]"
          >
            <span className="truncate text-sm">{row.objectName}</span>
            <select
              aria-label={`This agent's role on ${row.objectName}`}
              value={row.agentRole ?? ''}
              disabled={!row.canShare || disabledPending}
              title={row.shareRefusal ?? undefined}
              onChange={(event) => void onChange(row, (event.target.value || null) as GrantRole | null)}
              className="rounded border border-black/15 px-1.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-white/[.04]"
            >
              <option value="">none</option>
              {GRANT_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <span className="text-xs text-black/55 dark:text-white/55">{row.viewerRole ?? 'none'}</span>
            <span className="flex items-center gap-1 text-xs">
              <ArrowRight className="size-3 shrink-0 text-black/25 dark:text-white/25" aria-hidden />
              {row.effectiveForViewer ? (
                <Badge variant="secondary">{row.effectiveForViewer}</Badge>
              ) : row.agentRole === null && inherits ? (
                // Not a dash: while the migration affordance applies, an
                // ungranted object genuinely IS reachable, and a dash here
                // would be the panel lying about the agent's real reach.
                <span className="text-black/45 dark:text-white/45">editor (inherited)</span>
              ) : (
                <span className="text-black/45 dark:text-white/45">no access</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

const RANK: Record<GrantRole, number> = { viewer: 1, editor: 2, admin: 3 }

/** `weakerGrantRole`'s rule, for the one optimistic paint that happens before
 * the server answers. The server's value replaces it on reconcile. */
function weaker(a: GrantRole, b: GrantRole): GrantRole {
  return RANK[a] <= RANK[b] ? a : b
}
