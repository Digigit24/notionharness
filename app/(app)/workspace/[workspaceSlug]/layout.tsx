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
  if (!currentUser) notFound()
  const ownerId = typeof workspace.owner === 'number' ? workspace.owner : workspace.owner?.id
  const memberIds = (workspace.members ?? []).map((m) => (typeof m === 'number' ? m : m.id))
  if (ownerId !== currentUser.id && !memberIds.includes(currentUser.id)) notFound()

  const [workspaces, pages, ambientStatus, unreadNotificationCount, channels] = await Promise.all([
    payload.find({
      collection: 'workspaces',
      where: { or: [{ owner: { equals: currentUser.id } }, { members: { contains: currentUser.id } }] },
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
