import Link from 'next/link'
import { notFound } from 'next/navigation'
import { FileText } from 'lucide-react'
import { getPayloadClient } from '@/lib/payload'
import { NewPageButton } from '@/components/canvas/new-page-button'

export default async function WorkspaceHome({
  params,
}: {
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

  const topLevel = (
    await payload.find({
      collection: 'pages',
      where: {
        workspace: { equals: workspace.id },
        parentPage: { exists: false },
        isArchived: { equals: false },
      },
      sort: 'position',
      limit: 200,
      overrideAccess: true,
    })
  ).docs

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <h1 className="text-2xl font-semibold">{workspace.name}</h1>
      {topLevel.length === 0 ? (
        <>
          <p className="max-w-sm text-sm text-black/50 dark:text-white/50">
            This workspace doesn&apos;t have any pages yet. Create your first one to get started.
          </p>
          <NewPageButton workspaceId={workspace.id} workspaceSlug={workspace.slug} />
        </>
      ) : (
        <div className="flex w-full max-w-sm flex-col gap-1 text-left">
          <p className="mb-1 text-sm text-black/50 dark:text-white/50">Pick a page from the sidebar, or:</p>
          {topLevel.slice(0, 5).map((p) => (
            <Link
              key={p.id}
              href={`/workspace/${workspace.slug}/p/${p.id}`}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-black/[.04] dark:hover:bg-white/[.06]"
            >
              <span>{p.icon || <FileText size={14} />}</span>
              {p.title || 'Untitled'}
            </Link>
          ))}
          <NewPageButton workspaceId={workspace.id} workspaceSlug={workspace.slug} label="+ New page" />
        </div>
      )}
    </div>
  )
}
