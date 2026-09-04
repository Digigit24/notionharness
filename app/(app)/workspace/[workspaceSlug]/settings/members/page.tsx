import { notFound } from 'next/navigation'
import { Users } from 'lucide-react'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { failureOf } from '@/lib/failures'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'
import { EmptyState } from '@/components/ui/empty-state'
import { MembersView } from '@/components/members/members-view'
import { getMembersScreen } from './actions'

/**
 * Settings → Members.
 *
 * The one screen where a workspace stops being a single-player tool. Everything
 * the permission model can express — four roles, the last-owner rule, an invite
 * that survives the invitee not having an account yet — was reachable only
 * through the database until this page existed.
 *
 * The data is fetched on the SERVER and handed down as the client component's
 * initial state, rather than fetched in an effect after hydration. A members
 * list that arrives one round trip after the page paints is a page that flashes
 * empty for everybody who has ever been invited (D0).
 */
export default async function MembersSettingsPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>
}) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const screen = await getMembersScreen(workspace.id)
  const failure = failureOf(screen)

  return (
    <main className="w-full px-5 py-8">
      <div className="mb-6">
        <Breadcrumbs
          className="mb-2"
          segments={[
            { label: workspace.name, href: `/workspace/${workspace.slug}` },
            { label: 'Settings', href: `/workspace/${workspace.slug}/settings` },
            { label: 'Members' },
          ]}
        />
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Users size={20} />
          Members
        </h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">
          Who is in this workspace and what each of them may do. An owner or an admin can invite people, change a
          role, and remove somebody; the last owner can never be demoted or removed, because nobody else can
          delete or transfer the workspace.
        </p>
      </div>

      {failure ? (
        <EmptyState
          icon={<Users />}
          title="Cannot show the member list"
          description={failure.message}
        />
      ) : (
        <MembersView
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
          workspaceName={workspace.name}
          initialMembers={'members' in screen ? screen.members : []}
          initialInvitations={'invitations' in screen ? screen.invitations : []}
          viewerRole={'viewerRole' in screen ? screen.viewerRole : 'viewer'}
          viewerId={'viewerId' in screen ? screen.viewerId : 0}
        />
      )}
    </main>
  )
}
