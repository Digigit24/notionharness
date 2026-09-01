import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { getPayloadClient } from '@/lib/payload'
import { TeableFullPageView } from '@/components/editor/TeableFullPageView'

export default async function TeableFullPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; teableDatabaseId: string }>
}) {
  const { workspaceSlug, teableDatabaseId } = await params
  const payload = await getPayloadClient()

  const workspaceResult = await payload.find({
    collection: 'workspaces',
    where: { slug: { equals: workspaceSlug } },
    limit: 1,
    overrideAccess: true,
  })
  const workspace = workspaceResult.docs[0]
  if (!workspace) notFound()

  const id = Number(teableDatabaseId)
  if (!Number.isFinite(id)) notFound()

  const connection = await payload
    .findByID({ collection: 'teable-databases', id, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  const connectionWorkspaceId = connection ? (typeof connection.workspace === 'number' ? connection.workspace : connection.workspace.id) : null
  if (!connection || connectionWorkspaceId !== workspace.id) notFound()

  return (
    <div className="flex h-full flex-1 flex-col overflow-y-auto">
      <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-1 border-b border-black/5 bg-white/90 px-4 backdrop-blur dark:border-white/10 dark:bg-[#191919]/90">
        <Link href={`/workspace/${workspace.slug}`} className="shrink-0 truncate text-sm text-black/50 hover:text-black/80 dark:text-white/50 dark:hover:text-white/80">
          {workspace.name}
        </Link>
        <ChevronRight size={13} className="shrink-0 text-black/30 dark:text-white/30" />
        <span className="truncate text-sm text-black/80 dark:text-white/80">{connection.name}</span>
      </header>
      <div className="mx-auto w-full max-w-5xl flex-1 px-8 pb-24 pt-8">
        <TeableFullPageView teableDatabaseId={id} />
      </div>
    </div>
  )
}
