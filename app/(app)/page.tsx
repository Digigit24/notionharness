import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getPayloadClient } from '@/lib/payload'
import { CreateWorkspaceForm } from '@/components/workspace/create-workspace-form'

export default async function Home() {
  const payload = await getPayloadClient()
  const workspaces = await payload.find({ collection: 'workspaces', limit: 100, sort: 'name', overrideAccess: true })

  if (workspaces.docs.length === 1) {
    redirect(`/workspace/${workspaces.docs[0].slug}`)
  }

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-8 bg-[#f7f7f5] px-6 py-16 dark:bg-[#191919]">
      <div className="text-center">
        <h1 className="text-3xl font-semibold">NotionForge</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">A fast, self-hosted, Notion-like workspace.</p>
      </div>

      {workspaces.docs.length > 0 && (
        <div className="flex w-full max-w-sm flex-col gap-1.5">
          {workspaces.docs.map((w) => (
            <Link
              key={w.id}
              href={`/workspace/${w.slug}`}
              className="flex items-center gap-2 rounded-lg border border-black/10 bg-white px-4 py-3 text-sm font-medium hover:border-black/20 dark:border-white/10 dark:bg-[#202020] dark:hover:border-white/20"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded bg-black/10 text-xs dark:bg-white/10">
                {w.icon || w.name.slice(0, 1).toUpperCase()}
              </span>
              {w.name}
            </Link>
          ))}
        </div>
      )}

      <CreateWorkspaceForm />
    </div>
  )
}
