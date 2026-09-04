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
import { workspaceRoleAllows, type WorkspaceRole } from '@/lib/permissions'

/**
 * Every workspace this person belongs to, with their role in each.
 *
 * ONE query on the layout that renders on every page in the product, which is
 * why this is not `lib/permissions`'s `loadAccess`: that answers about a single
 * workspace and costs two queries (membership plus per-object grants), and this
 * layout needs the whole list anyway for the workspace switcher. Asking once
 * and reading both answers out of the result is the difference between one
 * round trip and three on the hottest path in the app (D0).
 *
 * The grants half of `loadAccess` is genuinely not needed here: the gate below
 * is `read` on the WORKSPACE, and `can()` resolves that to
 * `workspaceRoleAllows(role, verb)` with no grant lookup at all — a per-object
 * grant can raise access to a project, never to the workspace shell.
 */
async function membershipsOf(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  userId: number,
): Promise<{ ids: number[]; roleByWorkspace: Map<number, WorkspaceRole> }> {
  const members = await payload.find({
    collection: 'workspace-members',
    where: { user: { equals: userId } },
    limit: 500,
    depth: 0,
    overrideAccess: true,
  })
  const roleByWorkspace = new Map<number, WorkspaceRole>()
  for (const doc of members.docs) {
    const id = typeof doc.workspace === 'object' && doc.workspace ? doc.workspace.id : doc.workspace
    if (typeof id === 'number') roleByWorkspace.set(id, doc.role as WorkspaceRole)
  }
  return { ids: [...roleByWorkspace.keys()], roleByWorkspace }
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
  // PHASE 0 — the check now reads `workspace-members`, the table the whole
  // permission layer reads, instead of the legacy `workspaces.owner`/
  // `workspaces.members` pair.
  //
  // Membership lives in two representations, and `lib/invitations.ts` keeps
  // them in step by writing both on every add and remove — its own commit
  // message names this line as the reason it must. That works and is not being
  // undone; what it cannot do is make the duplication safe, because any future
  // writer that forgets the second write produces a person who holds a role,
  // appears in the members screen, and gets a 404 here. Observed live during
  // this session, not hypothesised: two rows existed in `workspace_members`
  // (roles `viewer` and `admin` in workspace 1) with no counterpart in the
  // legacy array, and this line would have refused both. Reading the
  // authoritative table removes the whole class.
  //
  // Strictly wider, never narrower — measured against this database: every
  // legacy `owner`/`members` pair has a `workspace_members` row, so nobody who
  // could open a workspace before loses it here. It is also the first version
  // of this check that can tell roles apart at all; `read` is deliberately the
  // verb, so a `viewer` still gets the shell.
  if (!currentUser) notFound()
  const { ids: memberWorkspaceIds, roleByWorkspace } = await membershipsOf(payload, currentUser.id)
  const role = roleByWorkspace.get(workspace.id)
  if (!role || !workspaceRoleAllows(role, 'read')) notFound()

  const [workspaces, pages, ambientStatus, unreadNotificationCount, channels] = await Promise.all([
    payload.find({
      collection: 'workspaces',
      // The workspace switcher's list, out of the same query the check above
      // already made — a switcher that offers a workspace the layout then 404s
      // is worse than one that omits it, and this costs nothing extra.
      where: { id: { in: memberWorkspaceIds } },
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
