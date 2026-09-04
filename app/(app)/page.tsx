import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { CreateWorkspaceForm } from '@/components/workspace/create-workspace-form'

export default async function Home() {
  const payload = await getPayloadClient()
  const user = await getCurrentPayloadUser()
  // Scoped to workspaces this user actually owns or belongs to — this used
  // to fetch every workspace in the database unconditionally (`overrideAccess:
  // true`, no `where`), which combined with the workspace layout never
  // checking membership either meant any signed-in account could browse into
  // any other account's workspace by slug. Real fix, not a superficial one:
  // this query is the one place both the auto-redirect-if-only-one-workspace
  // shortcut below and the full picker draw their list from.
  //
  // PHASE 0 — now read from `workspace-members` rather than the legacy
  // `workspaces.owner`/`workspaces.members` pair, for the reason
  // `app/(app)/workspace/[workspaceSlug]/layout.tsx` states at its own check:
  // the two tables had diverged, and this picker was the surface where that
  // showed up as "you have no workspaces" for somebody who plainly did.
  const memberWorkspaceIds =
    user != null
      ? (
          await payload.find({
            collection: 'workspace-members',
            where: { user: { equals: user.id } },
            limit: 500,
            depth: 0,
            overrideAccess: true,
          })
        ).docs
          .map((doc) => (typeof doc.workspace === 'object' && doc.workspace ? doc.workspace.id : doc.workspace))
          .filter((id): id is number => typeof id === 'number')
      : []

  const workspaces =
    memberWorkspaceIds.length > 0
      ? await payload.find({
          collection: 'workspaces',
          where: { id: { in: memberWorkspaceIds } },
          limit: 100,
          sort: 'name',
          overrideAccess: true,
        })
      : { docs: [] }

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
