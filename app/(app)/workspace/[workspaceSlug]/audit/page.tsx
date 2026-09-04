import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { hrefForEntity } from '@/lib/entity-links.server'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'
import { EmptyState } from '@/components/ui/empty-state'
import { AuditFilters } from '@/components/audit/audit-filters'
import { AuditPager } from '@/components/audit/audit-pager'
import { formatTimestamp } from '@/lib/relative-time'
import { ACTIVITY_ENTITY_TYPES } from '@/collections/Activity'
import type { Where } from 'payload'
import { History } from 'lucide-react'

/**
 * Channel ids in this workspace, for scoping channel audit rows.
 *
 * A direct broker query because channels are `teams` in raw Postgres and have
 * no Payload collection to `find`. Bounded by the same limit as every other
 * scan on this page, and archived channels are included deliberately: their
 * history is exactly what an audit log is for.
 */
async function listChannelIdsForWorkspace(workspaceId: number): Promise<string[]> {
  const { getBrokerPool } = await import('@/lib/broker/db')
  const { rows } = await getBrokerPool().query<{ id: string }>(
    `SELECT id FROM teams WHERE workspace_id = $1 ORDER BY id LIMIT ${ENTITY_SCAN_LIMIT}`,
    [workspaceId],
  )
  return rows.map((row) => String(row.id))
}

const PAGE_SIZE = 50
// Bounds the one-time "collect every workspace entity id to scope Activity
// by" reads below. A workspace with more tasks/projects/pages than this
// will silently miss the overflow from the audit log — an accepted,
// documented limit (same shape as this codebase's other "bounded, not
// exhaustive" reads, e.g. lib/entity-links.server.ts's own 30-item cap
// comment) rather than a real pagination layer over entity-id collection.
const ENTITY_SCAN_LIMIT = 5000
// How many recent, workspace-scoped activity rows to sample when building
// the verb filter's option list. Not every verb ever used is guaranteed to
// appear if the workspace has more than this many rows total — the dropdown
// reflects "what actually happened recently," not a canonical enum (this
// collection's `action` field is free-text, there is no fixed verb list to
// query exhaustively — see collections/Activity.ts).
const VERB_SAMPLE_LIMIT = 300

// ROADMAP B7.3 (Batch B-6 "Finish") — "One polymorphic activity table
// already backs every timeline [task/project/page Activity tabs, per
// lib/activity.ts]. Give it a workspace-level view with filters by actor,
// verb and entity." Lives under /workspace/[workspaceSlug]/audit rather than
// under the global /settings/* precedent B-5 introduced: that precedent is
// explicitly per-user/cross-workspace (see app/(app)/settings/notifications/page.tsx's
// own header comment), while this view is inherently workspace-scoped (it
// has to resolve which tasks/projects/pages belong to the current
// workspace to filter Activity by them at all, since Activity itself has no
// workspace column). Linked from the workspace Settings page
// (app/(app)/workspace/[workspaceSlug]/settings/page.tsx) and from the
// sidebar's Section nav (components/sidebar/sidebar.tsx's SECTION_LINKS).
export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>
  searchParams: Promise<{ actor?: string; verb?: string; entityType?: string; page?: string }>
}) {
  const { workspaceSlug } = await params
  const { actor, verb, entityType, page: pageParam } = await searchParams
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const payload = await getPayloadClient()
  const pageNum = Math.max(1, Number(pageParam) || 1)

  // Activity has no `workspace` column of its own (D-level polymorphic
  // design, see collections/Activity.ts) — recover workspace scoping by
  // first collecting which task/project/page ids belong to this workspace,
  // same "join through the owning Payload collection" shape this codebase
  // already uses for broker `runs` reads (lib/broker/runs.ts).
  const [tasksRes, projectsRes, pagesRes, agentsRes, connectorsRes, channelIds] = await Promise.all([
    payload.find({ collection: 'tasks', where: { workspace: { equals: workspace.id } }, limit: ENTITY_SCAN_LIMIT, depth: 0, overrideAccess: true }),
    payload.find({ collection: 'projects', where: { workspace: { equals: workspace.id } }, limit: ENTITY_SCAN_LIMIT, depth: 0, overrideAccess: true }),
    payload.find({ collection: 'pages', where: { workspace: { equals: workspace.id } }, limit: ENTITY_SCAN_LIMIT, depth: 0, overrideAccess: true }),
    payload.find({ collection: 'agents', where: { workspace: { equals: workspace.id } }, limit: ENTITY_SCAN_LIMIT, depth: 0, overrideAccess: true }),
    payload.find({ collection: 'connectors', where: { workspace: { equals: workspace.id } }, limit: ENTITY_SCAN_LIMIT, depth: 0, overrideAccess: true }),
    // Channels live in the raw-pg broker, not in Payload, so this one is a
    // direct query rather than a `find`. Same scope, same limit.
    listChannelIdsForWorkspace(workspace.id),
  ])
  /**
   * TYPED EXHAUSTIVELY ON PURPOSE, and this is the whole fix.
   *
   * The comment below records a cross-tenant leak that was confirmed live: a
   * type present in `ACTIVITY_ENTITY_TYPES` but missing a key here produces
   * `entityId: { in: undefined }`, which Payload reads as NO CONSTRAINT, and
   * the audit log then shows another workspace's rows. It happened once with
   * `workspace` and it happened again the moment `connector`, `agent` and
   * `channel` were added for access control — the same bug, three more times,
   * because a `Record<string, string[]>` cannot notice a missing key.
   *
   * `Record<ActivityEntityType, string[]>` can. Adding a value to
   * `ACTIVITY_ENTITY_TYPES` without an entry here is now a compile error rather
   * than a silent tenancy hole. The `?? []` at the use site is the second belt:
   * if this is ever widened again, the failure mode becomes "shows nothing"
   * instead of "shows everyone's".
   */
  const idsByType: Record<(typeof ACTIVITY_ENTITY_TYPES)[number], string[]> = {
    task: tasksRes.docs.map((d) => String(d.id)),
    project: projectsRes.docs.map((d) => String(d.id)),
    page: pagesRes.docs.map((d) => String(d.id)),
    // 'run' is a declared entity type (collections/Activity.ts) but nothing
    // in this codebase writes activity rows for it yet ("later run") — an
    // empty id list here is correct, not a bug: it means "no run activity
    // exists to scope," not "runs were forgotten."
    run: [],
    // People management (invite sent/accepted/revoked, role changed, member
    // removed) files its rows against the workspace itself, so the scope is
    // this one id. This entry is NOT optional: every type in
    // ACTIVITY_ENTITY_TYPES must have one, because a missing key makes the
    // clause below `entityId: { in: undefined }`, which Payload treats as no
    // constraint at all — confirmed live, it returned a `workspace` row
    // belonging to a different workspace. That is a cross-tenant leak in the
    // audit log, not a cosmetic gap.
    workspace: [String(workspace.id)],
    // Access control and connectors, added with the enum values they need.
    // An `agent` or `channel` grant is filed against the object it is about,
    // not against the workspace, because "who was given access to THIS agent"
    // is the question an audit log exists to answer and anchoring it to the
    // workspace makes a per-object timeline impossible to reconstruct.
    agent: agentsRes.docs.map((d) => String(d.id)),
    connector: connectorsRes.docs.map((d) => String(d.id)),
    channel: channelIds,
  }

  const entityScopeOr: Where[] = ACTIVITY_ENTITY_TYPES.filter((t) => !entityType || t === entityType).map((t) => ({
    entityType: { equals: t },
    // `?? []` rather than `idsByType[t]`: an absent key must scope to NOTHING.
    // See the block comment on `idsByType` — the alternative is the leak.
    entityId: { in: idsByType[t] ?? [] },
  }))

  const conditions: Where[] = [{ or: entityScopeOr }]
  if (actor) conditions.push({ actor: { equals: Number(actor) } })
  if (verb) conditions.push({ action: { equals: verb } })
  const where: Where = { and: conditions }

  const [result, verbSample] = await Promise.all([
    payload.find({
      collection: 'activity',
      where,
      sort: '-createdAt',
      page: pageNum,
      limit: PAGE_SIZE,
      depth: 1,
      overrideAccess: true,
    }),
    payload.find({
      collection: 'activity',
      where: { or: entityScopeOr },
      sort: '-createdAt',
      limit: VERB_SAMPLE_LIMIT,
      depth: 0,
      overrideAccess: true,
    }),
  ])

  const verbOptions = [...new Set(verbSample.docs.map((d) => d.action).filter(Boolean))].sort()

  // Actor options: every workspace member/owner who *could* have acted, not
  // only those who actually have — cheap (already resolvable from data this
  // page already needs) and honest (no "distinct actor" query pretending to
  // be exhaustive over system/automation-generated rows, which have no actor
  // at all per Activity.ts's own field doc).
  const memberEntries = [workspace.owner, ...(workspace.members ?? [])]
  const actorOptions: { id: number; label: string }[] = []
  const seenActorIds = new Set<number>()
  for (const entry of memberEntries) {
    if (entry == null || typeof entry === 'number') continue
    if (seenActorIds.has(entry.id)) continue
    seenActorIds.add(entry.id)
    actorOptions.push({ id: entry.id, label: entry.name || entry.email })
  }

  const rows = await Promise.all(
    result.docs.map(async (item) => {
      const actorDoc = typeof item.actor === 'object' ? item.actor : null
      const href = await hrefForEntity(payload, item.entityType, item.entityId).catch(() => null)
      const details = item.payload && typeof item.payload === 'object' ? (item.payload as Record<string, unknown>) : null
      return { item, actorDoc, href, details }
    }),
  )

  return (
    <main className="w-full px-5 py-8">
      <div className="mb-6">
        <Breadcrumbs
          className="mb-2"
          segments={[
            { label: workspace.name, href: `/workspace/${workspace.slug}` },
            { label: 'Audit log' },
          ]}
        />
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <History size={20} />
          Audit log
        </h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">
          Every recorded activity across this workspace&apos;s tasks, projects, and pages — the same table behind
          each entity&apos;s own Activity tab, viewed workspace-wide.
        </p>
      </div>

      <AuditFilters
        actor={actor ?? ''}
        verb={verb ?? ''}
        entityType={entityType ?? ''}
        actorOptions={actorOptions}
        verbOptions={verbOptions}
        entityTypeOptions={[...ACTIVITY_ENTITY_TYPES]}
      />

      {rows.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={<History />}
            title="No matching activity"
            description={
              actor || verb || entityType
                ? 'Nothing recorded matches these filters. Try clearing one.'
                : 'Nothing has been recorded in this workspace yet.'
            }
          />
        </div>
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-black/5 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
          {rows.map(({ item, actorDoc, href, details }) => (
            <li key={item.id} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{actorDoc?.name || actorDoc?.email || 'System'}</span>{' '}
                  <span className="text-black/60 dark:text-white/60">{item.action}</span>{' '}
                  <span className="rounded bg-black/[.06] px-1.5 py-0.5 text-[11px] text-black/50 dark:bg-white/10 dark:text-white/50">
                    {item.entityType} #{item.entityId}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-black/30 dark:text-white/30">
                  {/* `toLocaleString()` formats with the RUNTIME's locale, so
                      the server rendered US order and the browser rendered
                      the user's — the exact hydration mismatch
                      `formatTimestamp` exists to prevent (see its docstring).
                      Every other timestamp in this app already uses it. */}
                  {formatTimestamp(item.createdAt)}
                  {href && (
                    <a href={href} className="font-medium text-black/50 underline underline-offset-2 dark:text-white/50">
                      Open →
                    </a>
                  )}
                </span>
              </div>
              {details && Object.keys(details).length > 0 && (
                <pre className="mt-1 overflow-x-auto rounded bg-black/[.03] px-2 py-1 text-xs text-black/50 dark:bg-white/[.05] dark:text-white/50">
                  {JSON.stringify(details, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}

      <AuditPager page={result.page ?? pageNum} hasNextPage={result.hasNextPage} hasPrevPage={result.hasPrevPage} totalDocs={result.totalDocs} />
    </main>
  )
}
