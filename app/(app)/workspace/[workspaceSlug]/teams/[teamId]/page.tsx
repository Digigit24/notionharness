import { notFound } from 'next/navigation'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { claimableTasks, listTeamTasks } from '@/lib/broker'
import { listTeamRoomMessages, readTeamStopState, sweepTeamSlots } from '@/lib/teams/reliability'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'
import { TeamRoom } from '@/components/teams/team-room'
import { getChannel, isChannelMember, loadChannelFeed, loadSlots } from '../data'

/**
 * A channel (R6.4 / R6.5).
 *
 * Everything the three views need is fetched once, here, in parallel, and
 * handed down as typed rows. The room is not allowed to fetch on mount: the
 * channel must be readable on first paint, not after a client round trip.
 *
 * TWO reads of the same messages, deliberately. `loadChannelFeed` returns
 * channel ROOTS with their reply counts, reactions and mentions — the feed.
 * `listTeamRoomMessages` returns everything including replies — what the Lanes
 * view buckets per member. Neither is derivable from the other without either
 * an N+1 or a lie, and both are single indexed range scans.
 */
export default async function ChannelPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; teamId: string }>
}) {
  const { workspaceSlug, teamId } = await params
  const [workspace, user] = await Promise.all([getWorkspaceBySlug(workspaceSlug), getCurrentPayloadUser()])
  if (!workspace || !user) notFound()

  const id = Number(teamId)
  if (!Number.isSafeInteger(id)) notFound()
  const channel = await getChannel(id)
  // A channel id from another workspace must 404 rather than render: the URL
  // is guessable and the room carries the whole conversation.
  if (!channel || channel.workspaceId !== workspace.id || channel.archivedAt) notFound()
  // And a PRIVATE channel 404s for a non-member, with the same response as a
  // channel that does not exist — so probing ids cannot tell the two apart.
  if (channel.isPrivate && !(await isChannelMember(channel.id, user.id))) notFound()

  // R6.6 — the sweep runs before the reads and is awaited, so a room opened
  // after every member died shows the tasks already back on the board rather
  // than a stale assignment that corrects itself six seconds later. It is one
  // query plus writes only when something actually changed, and it is the only
  // thing in the app that runs it (see `lib/teams/reliability.ts`'s closing
  // note on the dispatcher tick being its proper home).
  const sweep = await sweepTeamSlots(channel.id)

  const [slots, feed, messages, tasks, claimable, stop, payload] = await Promise.all([
    loadSlots(channel.id),
    loadChannelFeed(channel.id),
    listTeamRoomMessages(channel.id, { limit: 200 }),
    listTeamTasks(channel.id),
    claimableTasks(channel.id),
    readTeamStopState(channel.id),
    getPayloadClient(),
  ])

  // The agents and the people the roster can add. Fetched here rather than
  // behind a click so opening the picker costs nothing, and as two bounded
  // queries rather than one per row.
  const [agentsResult, usersResult] = await Promise.all([
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

  // The workspace's people are its owner plus its members. Deduplicated by id
  // because the owner is very often also in `members`.
  const peopleById = new Map<number, { id: number; name: string; email: string }>()
  for (const candidate of [usersResult?.owner, ...(usersResult?.members ?? [])]) {
    if (candidate && typeof candidate === 'object') {
      peopleById.set(candidate.id, {
        id: candidate.id,
        name: candidate.name || candidate.email,
        email: candidate.email,
      })
    }
  }

  return (
    <main className="flex h-full w-full flex-col px-5 py-6">
      <Breadcrumbs
        className="mb-2"
        segments={[
          { label: workspace.name, href: `/workspace/${workspace.slug}` },
          { label: 'Channels', href: `/workspace/${workspace.slug}/teams` },
          { label: `#${channel.name}` },
        ]}
      />
      <TeamRoom
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        channel={channel}
        currentUserId={user.id}
        slots={slots}
        initialFeed={feed}
        initialMessages={messages}
        initialTasks={tasks}
        initialClaimableIds={claimable.map((t) => t.id)}
        initialHealth={sweep.health}
        initialStop={stop}
        agents={agentsResult.docs.map((a) => ({ id: a.id, name: a.name }))}
        users={[...peopleById.values()].sort((a, b) => a.name.localeCompare(b.name))}
      />
    </main>
  )
}
