'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bot, ShieldCheck, UserRound } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SkeletonList } from '@/components/ui/skeletons'
import { useOptimisticAction } from '@/lib/optimistic'
import { unwrap } from '@/lib/failures'
import { GRANT_ROLES, type GrantRole } from '@/lib/permissions/model'
import { formatTimestamp } from '@/lib/relative-time'
import { grantAccess, listObjectAccess, revokeGrant, updateGrantRole } from './actions'
import type { ObjectAccess, ObjectAccessGrant, ShareObjectType } from './types'

/**
 * Who has access to one project or one agent, and the controls to change it.
 *
 * THE DISABLED-NOT-HIDDEN RULE, which is the reason this component is shaped
 * the way it is. Somebody without the `share` verb still sees the whole panel:
 * the list of who has access, the add form, the role selects, the remove
 * buttons — all present, all disabled, with the refusal sentence
 * (`refusalMessage`, written for the person who hit it) sitting above them. A
 * control that is silently absent teaches people the feature does not exist,
 * and then they ask support for something that has been in front of them all
 * along. A disabled control with a reason teaches them who to ask.
 *
 * WHY IT LOADS ITS OWN DATA. This is a tab, not the landing view, and its data
 * is the one thing on either detail page that changes because of somebody
 * else. Fetching it in the page's server component would put a grants query on
 * the critical path of every Overview load to fill a panel most visits never
 * open; fetching it here costs one round trip when the tab is actually chosen,
 * behind a skeleton that reserves the row shape rather than a spinner over
 * nothing (D0).
 *
 * AGENT SUBJECTS ARE READ HERE, WRITTEN ELSEWHERE. An agent that has been
 * granted access to this project shows in the list and can be demoted or
 * removed from it, but new agent grants are made on the agent's own page
 * (`<AgentReachPanel>`) — one screen that answers "what can this agent reach"
 * beats the same grant being creatable from N project pages with no single
 * place to review the result.
 */
export function SharePanel({
  workspaceId,
  workspaceSlug,
  objectType,
  objectId,
  objectLabel,
}: {
  workspaceId: number
  workspaceSlug: string
  objectType: ShareObjectType
  objectId: string
  /** The project's or agent's name, so the copy can be about the real thing. */
  objectLabel: string
}) {
  const [view, setView] = useState<ObjectAccess | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [addUserId, setAddUserId] = useState('')
  const [addRole, setAddRole] = useState<GrantRole>('viewer')
  const optimistic = useOptimisticAction()

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      setView(unwrap(await listObjectAccess({ workspaceId, objectType, objectId })))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not read who has access.')
    }
  }, [workspaceId, objectType, objectId])

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
  if (!view) return <SkeletonList rows={4} />

  const disabled = !view.canShare
  const candidate = view.candidates.find((entry) => String(entry.userId) === addUserId) ?? null

  async function add() {
    if (!candidate) return
    const subjectUserId = candidate.userId
    const role = addRole
    await optimistic.run({
      // Painted with a negative placeholder id so the row is in the list
      // before the server answers; `onSettled` swaps in the real one.
      apply: () =>
        setView((current) =>
          current
            ? {
                ...current,
                grants: [
                  ...current.grants,
                  {
                    id: -Date.now(),
                    role,
                    subjectKind: 'user',
                    subjectId: subjectUserId,
                    subjectName: candidate.name,
                    subjectEmail: candidate.email,
                    grantedByName: null,
                    createdAt: null,
                  },
                ],
                candidates: current.candidates.filter((entry) => entry.userId !== subjectUserId),
              }
            : current,
        ),
      rollback: () =>
        setView((current) =>
          current
            ? {
                ...current,
                grants: current.grants.filter((grant) => grant.subjectId !== subjectUserId || grant.id > 0),
                candidates: [...current.candidates, candidate].sort((a, b) => a.name.localeCompare(b.name)),
              }
            : current,
        ),
      work: () =>
        grantAccess({ workspaceId, workspaceSlug, objectType, objectId, subjectUserId, role }),
      failureTitle: `Could not give ${candidate.name} access`,
      onSettled: (value) =>
        setView((current) =>
          current
            ? {
                ...current,
                grants: current.grants.map((grant) =>
                  grant.id < 0 && grant.subjectId === subjectUserId
                    ? { ...grant, id: (value as { grantId: number }).grantId }
                    : grant,
                ),
              }
            : current,
        ),
    })
    setAddUserId('')
  }

  async function changeRole(grant: ObjectAccessGrant, role: GrantRole) {
    const previous = grant.role
    await optimistic.run({
      apply: () =>
        setView((current) =>
          current
            ? { ...current, grants: current.grants.map((row) => (row.id === grant.id ? { ...row, role } : row)) }
            : current,
        ),
      rollback: () =>
        setView((current) =>
          current
            ? {
                ...current,
                grants: current.grants.map((row) => (row.id === grant.id ? { ...row, role: previous } : row)),
              }
            : current,
        ),
      work: () => updateGrantRole({ workspaceId, workspaceSlug, grantId: grant.id, role }),
      failureTitle: `Could not change ${grant.subjectName}'s role`,
    })
  }

  async function remove(grant: ObjectAccessGrant) {
    await optimistic.run({
      apply: () =>
        setView((current) =>
          current ? { ...current, grants: current.grants.filter((row) => row.id !== grant.id) } : current,
        ),
      rollback: () => void load(),
      work: () => revokeGrant({ workspaceId, workspaceSlug, grantId: grant.id }),
      failureTitle: `Could not remove ${grant.subjectName}`,
    })
  }

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h3 className="text-sm font-semibold">Who has access to {objectLabel}</h3>
        <p className="mt-0.5 max-w-prose text-xs text-black/50 dark:text-white/50">
          A grant only ever ADDS to what workspace membership already gives — it cannot take access away. Everyone
          in this workspace can already reach this {objectType} at the role their membership implies; the list
          below is who has been given more.
        </p>
      </header>

      {disabled && view.shareRefusal && (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[.07] px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{view.shareRefusal} The controls below are shown so you know they exist, and disabled because
          they are not yours to use.</span>
        </p>
      )}

      <div className="flex flex-col divide-y divide-black/[.06] rounded-lg border border-black/10 dark:divide-white/[.06] dark:border-white/10">
        {view.grants.length === 0 && (
          <p className="px-3 py-4 text-xs text-black/45 dark:text-white/45">
            Nobody has been given extra access to this {objectType} yet.
          </p>
        )}
        {view.grants.map((grant) => (
          <div key={grant.id} className="flex items-center gap-3 px-3 py-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-black/[.05] text-black/50 dark:bg-white/[.06] dark:text-white/50">
              {grant.subjectKind === 'agent' ? <Bot className="size-3.5" /> : <UserRound className="size-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{grant.subjectName}</p>
              <p className="truncate text-[11px] text-black/45 dark:text-white/45">
                {grant.subjectEmail ?? 'Agent'}
                {grant.grantedByName ? ` · added by ${grant.grantedByName}` : ''}
                {grant.createdAt ? ` · ${formatTimestamp(grant.createdAt)}` : ''}
              </p>
            </div>
            <select
              aria-label={`Role for ${grant.subjectName}`}
              value={grant.role}
              disabled={disabled || optimistic.pending}
              title={view.shareRefusal ?? undefined}
              onChange={(event) => void changeRole(grant, event.target.value as GrantRole)}
              className="rounded border border-black/15 px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-white/[.04]"
            >
              {GRANT_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || optimistic.pending}
              title={view.shareRefusal ?? undefined}
              onClick={() => void remove(grant)}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-56 flex-1 text-xs">
          Add somebody
          <select
            value={addUserId}
            disabled={disabled}
            title={view.shareRefusal ?? undefined}
            onChange={(event) => setAddUserId(event.target.value)}
            className="mt-1 w-full rounded border border-black/15 px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-white/[.04]"
          >
            <option value="">Choose a workspace member…</option>
            {view.candidates.map((entry) => (
              <option key={entry.userId} value={entry.userId}>
                {entry.name} — {entry.workspaceRole}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          Role
          <select
            value={addRole}
            disabled={disabled}
            title={view.shareRefusal ?? undefined}
            onChange={(event) => setAddRole(event.target.value as GrantRole)}
            className="mt-1 rounded border border-black/15 px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-white/[.04]"
          >
            {GRANT_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          size="sm"
          disabled={disabled || !candidate || optimistic.pending}
          title={view.shareRefusal ?? undefined}
          onClick={() => void add()}
        >
          Add
        </Button>
      </div>

      {/* The one thing a share dialog can quietly get wrong: offering a role
          weaker than what the person already has, and looking like it did
          something. Said before the click, not after. */}
      {candidate && RANK[addRole] <= RANK[candidate.impliedRole] && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          {candidate.name} is a workspace {candidate.workspaceRole}, which already implies{' '}
          <Badge variant="outline">{candidate.impliedRole}</Badge> here. Granting{' '}
          <Badge variant="outline">{addRole}</Badge> would change nothing — grants raise access, they never lower
          it.
        </p>
      )}
    </section>
  )
}

const RANK: Record<GrantRole, number> = { viewer: 1, editor: 2, admin: 3 }
