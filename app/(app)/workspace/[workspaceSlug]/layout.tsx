import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getSession } from '@/lib/session'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getSidebarPages, getWorkspaceBySlug } from '@/lib/pages-cache'
import { getSidebarChannels } from '@/components/sidebar/channels-data'
import { getUnreadNotificationCount } from '@/app/(app)/notifications/actions'
import { getAmbientStatus } from '@/app/(app)/workspace/[workspaceSlug]/actions'
import { Sidebar } from '@/components/sidebar/sidebar'
import { KeyboardProvider } from '@/components/keyboard/keyboard-provider'
import { HermesNotConfiguredBanner } from '@/components/thread/hermes-not-configured-banner'
import { HERMES_BASE_URL } from '@/lib/runtimes/hermes/api-proxy'
import { can, loadAccess } from '@/lib/permissions'

/** Every workspace this person is a member of, from `workspace-members`.
 * Duplicated in `app/(app)/page.tsx` rather than shared: both are two lines
 * over one indexed table, and a `lib/` module for it would be a third place to
 * look for an answer these two already state plainly. */
async function memberWorkspaceIds(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  userId: number,
): Promise<number[]> {
  const members = await payload.find({
    collection: 'workspace-members',
    where: { user: { equals: userId } },
    limit: 500,
    depth: 0,
    overrideAccess: true,
  })
  return members.docs
    .map((doc) => (typeof doc.workspace === 'object' && doc.workspace ? doc.workspace.id : doc.workspace))
    .filter((id): id is number => typeof id === 'number')
}

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ workspaceSlug: string }>
}) {
  const { workspaceSlug } = await params
  const payload = await getPayloadClient()

  const [workspace, session, currentUser] = await Promise.all([
    getWorkspaceBySlug(workspaceSlug),
    getSession(),
    // Command bar's "Create task" act-mode step needs the Payload user id
    // (Tasks.createdBy has no req.user to fall back on — see collections/
    // Tasks.ts's class comment) — resolved once here rather than inside
    // the command bar itself, which has no server-side context of its own.
    getCurrentPayloadUser(),
  ])
  if (!workspace) notFound()

  // Ownership/membership check — this used to be entirely absent, so any
  // signed-in account could open any other account's workspace just by
  // knowing (or guessing) its slug. `notFound()` rather than a 403 page,
  // matching this same function's existing not-found handling for a
  // nonexistent slug: neither case should confirm to an unauthorized caller
  // that the slug does or doesn't exist.
  //
  // PHASE 0 — the check now reads `workspace-members` through `lib/permissions`
  // instead of the legacy `workspaces.owner`/`workspaces.members` pair, because
  // the two had silently diverged: this database has one row in the legacy
  // `members` array and eight in `workspace_members`, so everybody invited
  // through the new members screen was being sent to a 404 by this line while
  // every other surface treated them as a member. One source of truth, and it
  // is the one the invitation flow writes to.
  //
  // Strictly wider, never narrower: the backfill was verified against this
  // database — every legacy `owner`/`members` pair has a `workspace_members`
  // row — so nobody who could open a workspace before loses it here.
  if (!currentUser) notFound()
  const access = await loadAccess(currentUser.id, workspace.id)
  if (!can(access, 'read', 'workspace')) notFound()

  const [workspaces, pages, ambientStatus, unreadNotificationCount, channels] = await Promise.all([
    payload.find({
      collection: 'workspaces',
      // The workspace switcher's list, from the same table the check above
      // uses — a switcher that offers a workspace the layout then 404s is
      // worse than one that omits it.
      where: { id: { in: await memberWorkspaceIds(payload, currentUser.id) } },
      limit: 100,
      sort: 'name',
      overrideAccess: true,
    }),
    getSidebarPages(workspace.id),
    getAmbientStatus(workspace.id),
    getUnreadNotificationCount(),
    // The Channels tab's rows and unread badges. Joins the existing Promise.all
    // rather than adding a fifth sequential await, and it is three queries
    // internally rather than one per channel — the sidebar renders on every
    // page in the product, so an N+1 here would be the most-repeated one there
    // is (D0). A failure degrades the tab to a "Browse channels" link instead
    // of taking the whole shell down with it.
    getSidebarChannels(workspace.id, currentUser.id).catch(() => null),
  ])

  return (
    <KeyboardProvider workspaceId={workspace.id} workspaceSlug={workspace.slug}>
      <div className="flex h-screen w-full overflow-hidden bg-white dark:bg-[#191919]">
        <Sidebar
          workspace={workspace}
          workspaces={workspaces.docs}
          pages={pages}
          userEmail={session?.user.email ?? ''}
          currentUserId={currentUser?.id ?? null}
          unreadNotificationCount={unreadNotificationCount}
          ambientStatus={ambientStatus}
          channels={channels}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {!HERMES_BASE_URL && <HermesNotConfiguredBanner />}
          {children}
        </div>
      </div>
    </KeyboardProvider>
  )
}
