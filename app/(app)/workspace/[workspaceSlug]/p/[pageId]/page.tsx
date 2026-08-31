import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { buildBreadcrumbChain } from '@/lib/tree'
import { PageCanvas } from '@/components/canvas/page-canvas'

export default async function PageView({
  params,
}: {
  params: Promise<{ workspaceSlug: string; pageId: string }>
}) {
  const { workspaceSlug, pageId } = await params
  const payload = await getPayloadClient()

  const workspaceResult = await payload.find({
    collection: 'workspaces',
    where: { slug: { equals: workspaceSlug } },
    limit: 1,
    overrideAccess: true,
  })
  const workspace = workspaceResult.docs[0]
  if (!workspace) notFound()

  const id = Number(pageId)
  if (!Number.isFinite(id)) notFound()

  const page = await payload
    .findByID({ collection: 'pages', id, overrideAccess: true, disableErrors: true })
    .catch(() => null)

  const pageWorkspaceId = page ? (typeof page.workspace === 'number' ? page.workspace : page.workspace.id) : null
  if (!page || pageWorkspaceId !== workspace.id) notFound()

  const allPages = (
    await payload.find({
      collection: 'pages',
      where: { workspace: { equals: workspace.id } },
      limit: 5000,
      overrideAccess: true,
    })
  ).docs

  const chain = buildBreadcrumbChain(allPages, page.id)

  return <PageCanvas workspace={workspace} page={page} breadcrumbChain={chain} />
}
