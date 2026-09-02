import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { hrefForEntity } from '@/lib/entity-links.server'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'
import { EmptyState } from '@/components/ui/empty-state'
import { AuditFilters } from '@/components/audit/audit-filters'
import { AuditPager } from '@/components/audit/audit-pager'
import { ACTIVITY_ENTITY_TYPES } from '@/collections/Activity'
import type { Where } from 'payload'
import { History } from 'lucide-react'

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
  const [tasksRes, projectsRes, pagesRes] = await Promise.all([
    payload.find({ collection: 'tasks', where: { workspace: { equals: workspace.id } }, limit: ENTITY_SCAN_LIMIT, depth: 0, overrideAccess: true }),
    payload.find({ collection: 'projects', where: { workspace: { equals: workspace.id } }, limit: ENTITY_SCAN_LIMIT, depth: 0, overrideAccess: true }),
    payload.find({ collection: 'pages', where: { workspace: { equals: workspace.id } }, limit: ENTITY_SCAN_LIMIT, depth: 0, overrideAccess: true }),
  ])
  const idsByType: Record<string, string[]> = {
    task: tasksRes.docs.map((d) => String(d.id)),
    project: projectsRes.docs.map((d) => String(d.id)),
    page: pagesRes.docs.map((d) => String(d.id)),
    // 'run' is a declared entity type (collections/Activity.ts) but nothing
    // in this codebase writes activity rows for it yet ("later run") — an
    // empty id list here is correct, not a bug: it means "no run activity
    // exists to scope," not "runs were forgotten."
    run: [],
  }

  const entityScopeOr: Where[] = ACTIVITY_ENTITY_TYPES.filter((t) => !entityType || t === entityType).map((t) => ({
    entityType: { equals: t },
    entityId: { in: idsByType[t] },
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
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
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
                  {new Date(item.createdAt).toLocaleString()}
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
