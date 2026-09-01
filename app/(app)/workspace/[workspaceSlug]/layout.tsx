import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getSession } from '@/lib/session'
import { getWorkspaceBySlug, getWorkspacePages } from '@/lib/pages-cache'
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

  const [workspace, session, workspaces] = await Promise.all([
    getWorkspaceBySlug(workspaceSlug),
    getSession(),
    payload.find({ collection: 'workspaces', limit: 100, sort: 'name', overrideAccess: true }),
  ])
  if (!workspace) notFound()

  const pages = await getWorkspacePages(workspace.id)

  return (
    <div className="flex h-screen w-full overflow-hidden bg-white dark:bg-[#191919]">
      <Sidebar
        workspace={workspace}
        workspaces={workspaces.docs}
        pages={pages}
        userEmail={session?.user.email ?? ''}
      />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
