import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug, getWorkspacePages } from '@/lib/pages-cache'
import { buildBreadcrumbChain } from '@/lib/tree'
import { getPageProvenance } from '@/lib/provenance'
import { getPageOrigin } from '@/lib/page-origin'
import { PageCanvas } from '@/components/canvas/page-canvas'
import { RecentPageTracker } from '@/components/home/recent-page-tracker'

export default async function PageView({
  params,
}: {
  params: Promise<{ workspaceSlug: string; pageId: string }>
}) {
  const { workspaceSlug, pageId } = await params
  const payload = await getPayloadClient()
  const id = Number(pageId)
  if (!Number.isFinite(id)) notFound()

  // Workspace lookup and page lookup don't depend on each other — only the
  // validation below needs both, so fetch them in parallel rather than
  // sequentially awaiting each one.
  const [workspace, page] = await Promise.all([
    getWorkspaceBySlug(workspaceSlug),
    payload.findByID({ collection: 'pages', id, overrideAccess: true, disableErrors: true }).catch(() => null),
  ])
  if (!workspace) notFound()

  const pageWorkspaceId = page ? (typeof page.workspace === 'number' ? page.workspace : page.workspace.id) : null
  if (!page || pageWorkspaceId !== workspace.id) notFound()

  // Same `getWorkspacePages` call (and argument) as `WorkspaceLayout` makes for
  // this same request — `React.cache()` means this reuses that result instead
  // of firing a second query. `getPageProvenance` (ROADMAP B-2) is independent
  // of it, so both run in the same Promise.all rather than sequentially.
  const [allPages, provenance, origin] = await Promise.all([
    getWorkspacePages(workspace.id),
    getPageProvenance(payload, page.id),
    // R7.4 — page-level origin, a different question from block-level
    // provenance above. Independent of both, so it joins the same Promise.all
    // rather than adding a third sequential await (D0).
    getPageOrigin(payload, page).catch(() => null),
  ])

  const chain = buildBreadcrumbChain(allPages, page.id)

  return (
    <>
      <RecentPageTracker workspaceSlug={workspace.slug} pageId={page.id} title={page.title} icon={page.icon ?? null} />
      <PageCanvas workspace={workspace} page={page} breadcrumbChain={chain} provenance={provenance} origin={origin} />
    </>
  )
}
