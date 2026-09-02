import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getSession } from '@/lib/session'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getWorkspaceBySlug, getWorkspacePages } from '@/lib/pages-cache'
import { getUnreadNotificationCount } from '@/app/(app)/notifications/actions'
import { Sidebar } from '@/components/sidebar/sidebar'
import { KeyboardProvider } from '@/components/keyboard/keyboard-provider'

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ workspaceSlug: string }>
}) {
  const { workspaceSlug } = await params
  const payload = await getPayloadClient()

  const [workspace, session, workspaces, unreadNotificationCount, currentUser] = await Promise.all([
    getWorkspaceBySlug(workspaceSlug),
    getSession(),
    payload.find({ collection: 'workspaces', limit: 100, sort: 'name', overrideAccess: true }),
    getUnreadNotificationCount(),
    // Command bar's "Create task" act-mode step needs the Payload user id
    // (Tasks.createdBy has no req.user to fall back on — see collections/
    // Tasks.ts's class comment) — resolved once here rather than inside
    // the command bar itself, which has no server-side context of its own.
    getCurrentPayloadUser(),
  ])
  if (!workspace) notFound()

  const pages = await getWorkspacePages(workspace.id)

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
        />
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </KeyboardProvider>
  )
}
