import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Hash, Lock, MessagesSquare } from 'lucide-react'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'
import { EmptyState } from '@/components/ui/empty-state'
import { formatRelativeTime } from '@/lib/relative-time'
import { ChannelCreateDialog } from '@/components/teams/channel-create-dialog'
import { listChannelSummaries } from './actions'

/**
 * Channels — the list (R6.4 / R6.5).
 *
 * A chat client's channel list, not a dashboard of cards: one row per room,
 * unread in weight rather than as a badge on everything, and a mention count
 * as the one thing loud enough to earn a colour. Everything on the row comes
 * from `listChannelSummaries`, which is two round trips for the whole list
 * rather than one per channel.
 */
export default async function ChannelsPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const payload = await getPayloadClient()
  const [channels, agents, workspaceDoc] = await Promise.all([
    listChannelSummaries(workspace.id),
    // The create dialog needs both rosters up front. Fetched here rather than
    // behind a click so opening the form costs nothing — both lists are small
    // and this is the shape every other create surface in this app uses.
    payload.find({
      collection: 'agents',
      where: { workspace: { equals: workspace.id }, enabled: { equals: true } },
      sort: 'name',
      limit: 200,
      depth: 0,
      overrideAccess: true,
    }),
    payload.findByID({
      collection: 'workspaces',
      id: workspace.id,
      depth: 1,
      overrideAccess: true,
      disableErrors: true,
    }),
  ])

  const peopleById = new Map<number, { id: number; name: string; email: string }>()
  for (const candidate of [workspaceDoc?.owner, ...(workspaceDoc?.members ?? [])]) {
    if (candidate && typeof candidate === 'object') {
      peopleById.set(candidate.id, {
        id: candidate.id,
        name: candidate.name || candidate.email,
        email: candidate.email,
      })
    }
  }

  return (
    <main className="w-full px-5 py-8">
      <div className="mb-6">
        <Breadcrumbs
          className="mb-2"
          segments={[{ label: workspace.name, href: `/workspace/${workspace.slug}` }, { label: 'Channels' }]}
        />
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Channels</h1>
            <p className="mt-1 text-sm text-black/50 dark:text-white/50">
              Rooms where people and agents work on one objective. A member is a slot, so the same agent can hold
              two jobs at once.
            </p>
          </div>
          <ChannelCreateDialog
            workspaceId={workspace.id}
            workspaceSlug={workspace.slug}
            agents={agents.docs.map((a) => ({ id: a.id, name: a.name }))}
            users={[...peopleById.values()].sort((a, b) => a.name.localeCompare(b.name))}
          />
        </div>
      </div>

      {channels.length === 0 ? (
        <EmptyState
          icon={<MessagesSquare />}
          title="No channels yet"
          description="A channel is a room: name it, add people and agents, and start talking. Each one gets a board and a canvas of its own."
        />
      ) : (
        <ul className="divide-y divide-black/5 rounded-xl border border-black/10 dark:divide-white/5 dark:border-white/10">
          {channels.map((channel) => {
            const unread = (channel.unreadCount ?? 0) > 0
            return (
              <li key={channel.id}>
                <Link
                  href={`/workspace/${workspace.slug}/teams/${channel.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-black/[.03] dark:hover:bg-white/[.04]"
                >
                  <span aria-hidden className="shrink-0 text-black/30 dark:text-white/30">
                    {/* A padlock, not a hash, for a private room. The list is
                        the only place the distinction is visible before you
                        open one. */}
                    {channel.isPrivate ? <Lock size={13} /> : <Hash size={15} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={unread ? 'font-semibold' : 'font-medium'}>{channel.name}</span>
                    {channel.topic && (
                      <span className="ml-2 truncate text-sm text-black/45 dark:text-white/45">{channel.topic}</span>
                    )}
                    <span className="mt-0.5 block text-xs text-black/45 dark:text-white/45">
                      {channel.memberCount} {channel.memberCount === 1 ? 'member' : 'members'} ·{' '}
                      {channel.openTaskCount} open {channel.openTaskCount === 1 ? 'task' : 'tasks'}
                      {!channel.joined && ' · you are not a member'}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-right text-xs text-black/40 dark:text-white/40">
                    {/* A mention is the only thing loud enough for a pill:
                        "somebody said something" and "somebody asked YOU" are
                        different urgencies, and giving both a badge would make
                        neither mean anything. */}
                    {channel.mentionCount > 0 && (
                      <span className="rounded-full bg-red-500 px-1.5 py-px text-[11px] font-medium text-white tabular-nums">
                        {channel.mentionCount}
                      </span>
                    )}
                    <span>
                      {unread && (
                        <span className="block font-semibold text-black dark:text-white">
                          {channel.unreadCount} unread
                        </span>
                      )}
                      {channel.lastMessageAt ? formatRelativeTime(channel.lastMessageAt) : 'no messages yet'}
                    </span>
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
