import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { Sidebar } from '@/components/sidebar/sidebar'

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ workspaceSlug: string }>
}) {
  const { workspaceSlug } = await params
  const payload = await getPayloadClient()

  const workspaceResult = await payload.find({
    collection: 'workspaces',
    where: { slug: { equals: workspaceSlug } },
    limit: 1,
    overrideAccess: true,
  })
  const workspace = workspaceResult.docs[0]
  if (!workspace) notFound()

  const [workspaces, pagesResult] = await Promise.all([
    payload.find({ collection: 'workspaces', limit: 100, sort: 'name', overrideAccess: true }),
    payload.find({
      collection: 'pages',
      where: { workspace: { equals: workspace.id } },
      limit: 5000,
      sort: 'position',
      overrideAccess: true,
    }),
  ])

  return (
    <div className="flex h-screen w-full overflow-hidden bg-white dark:bg-[#191919]">
      <Sidebar workspace={workspace} workspaces={workspaces.docs} pages={pagesResult.docs} />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
