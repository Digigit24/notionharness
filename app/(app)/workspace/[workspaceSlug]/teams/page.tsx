import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Users } from 'lucide-react'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'
import { EmptyState } from '@/components/ui/empty-state'
import { formatRelativeTime } from '@/lib/relative-time'
import { CreateTeamForm } from '@/components/teams/create-team-form'
import { listTeamSummaries } from './actions'

/**
 * Teams — the channel list (R6.4).
 *
 * A chat client's channel list, not a dashboard of cards: one row per room,
 * unread in bold rather than as a badge, and the numbers that actually
 * distinguish one row from another (who is in it, what is open, when it last
 * said anything). Everything on the row comes from one aggregate query in
 * `listTeamSummaries`.
 */
export default async function TeamsPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const payload = await getPayloadClient()
  const [teams, agents] = await Promise.all([
    listTeamSummaries(workspace.id),
    // The create form needs the agent list up front. Fetched here rather than
    // behind a click so opening the form costs nothing — the list is small and
    // is already the shape every other create surface in this app uses.
    payload.find({
      collection: 'agents',
      where: { workspace: { equals: workspace.id }, enabled: { equals: true } },
      sort: 'name',
      limit: 100,
      depth: 0,
      overrideAccess: true,
    }),
  ])

  const agentOptions = agents.docs.map((a) => ({ id: a.id, name: a.name }))

  return (
    <main className="w-full px-5 py-8">
      <div className="mb-6">
        <Breadcrumbs
          className="mb-2"
          segments={[{ label: workspace.name, href: `/workspace/${workspace.slug}` }, { label: 'Teams' }]}
        />
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Teams</h1>
            <p className="mt-1 text-sm text-black/50 dark:text-white/50">
              Rooms where several agents work on one objective. A member is a slot, so the same agent can hold two
              jobs at once.
            </p>
          </div>
          <CreateTeamForm workspaceId={workspace.id} workspaceSlug={workspace.slug} agents={agentOptions} />
        </div>
      </div>

      {teams.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title="No teams yet"
          description="A team is a room: name it, add agents as slots, and pick which one leads."
        />
      ) : (
        <ul className="divide-y divide-black/5 rounded-xl border border-black/10 dark:divide-white/5 dark:border-white/10">
          {teams.map((team) => {
            const unread = team.unreadCount > 0
            return (
              <li key={team.id}>
                <Link
                  href={`/workspace/${workspace.slug}/teams/${team.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-black/[.03] dark:hover:bg-white/[.04]"
                >
                  <span
                    aria-hidden
                    className="text-black/30 dark:text-white/30"
                    // A channel list marks a room, not a document. The hash is
                    // the cheapest way to say "this is a room you talk in".
                  >
                    #
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={unread ? 'font-semibold' : 'font-medium'}>{team.name}</span>
                    {team.description && (
                      <span className="ml-2 truncate text-sm text-black/45 dark:text-white/45">
                        {team.description}
                      </span>
                    )}
                    <span className="mt-0.5 block text-xs text-black/45 dark:text-white/45">
                      {team.memberCount} {team.memberCount === 1 ? 'slot' : 'slots'} · {team.openTaskCount} open{' '}
                      {team.openTaskCount === 1 ? 'task' : 'tasks'} ·{' '}
                      {team.workspaceMode === 'shared' ? 'shared worktree' : 'worktree per member'}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-black/40 dark:text-white/40">
                    {/* Unread as weight, not as a pill: a count in bold reads
                        as "there is something here" without adding a second
                        colour to every row. */}
                    {unread && <span className="block font-semibold text-black dark:text-white">{team.unreadCount} unread</span>}
                    {team.lastMessageAt ? formatRelativeTime(team.lastMessageAt) : 'no messages yet'}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
