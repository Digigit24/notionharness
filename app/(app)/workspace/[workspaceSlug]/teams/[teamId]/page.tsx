import { notFound } from 'next/navigation'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import {
  claimableTasks,
  getRunsForChannelMessages,
  listChannelUnread,
  listPendingChannelApprovals,
  listTeamTasks,
} from '@/lib/broker'
import { listTeamRoomMessages, readTeamStopState, sweepTeamSlots } from '@/lib/teams/reliability'
import { TeamRoom } from '@/components/teams/team-room'
import { getChannel, isChannelMember, loadChannelFeed, loadSlots, resolveMySlot } from '../data'

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
  //
  // `projectsResult` is R14-P0.8's own addition — the "New task" popup's
  // project picker needs the same list `app/(app)/workspace/[workspaceSlug]/
  // projects/page.tsx` already fetches for its own list, so opening that
  // popup costs nothing either.
  const [agentsResult, usersResult, projectsResult] = await Promise.all([
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
    payload.find({
      collection: 'projects',
      where: { workspace: { equals: workspace.id } },
      sort: 'name',
      limit: 500,
      depth: 0,
      overrideAccess: true,
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

  /**
   * The runs behind this page of messages, and the caller's unread counts.
   *
   * Both are resolved HERE rather than after mount, and both are ONE query.
   *
   * `getRunsForChannelMessages` is the plural of `getRunForChannelMessage` and
   * exists precisely so a feed does not ask per row; asking per row is the
   * N+1 D0 rules out and would be 200 round trips on a busy channel. Without
   * it on the server, a reload in the middle of an agent's turn painted a
   * channel with no sign that anything was running.
   *
   * `listChannelUnread` answers unread and mentions separately in one grouped
   * query. The counts have to be read before the room marks itself read, which
   * it does within a second of mounting — so they are read here, at open, and
   * frozen for the same reason the "New" divider is frozen.
   */
  const mine = await resolveMySlot(channel.id, user.id)
  const [runs, unread, approvals] = await Promise.all([
    getRunsForChannelMessages(feed.map((m) => m.id)),
    mine ? listChannelUnread([mine.id]) : Promise.resolve([]),
    // An agent blocked on a permission must be visible on FIRST PAINT, not six
    // seconds later when the first poll lands — a reload in the middle of a
    // block is exactly when somebody is looking for the button.
    listPendingChannelApprovals(channel.id).catch(() => []),
  ])

  return (
    // R14 — height pass. No breadcrumb here: the room's own header states the
    // channel name one line below where this row used to sit, in a bigger,
    // bolder typeface — a breadcrumb repeating it added a full row of chrome
    // that told you nothing the header didn't. Reduced page padding for the
    // same reason: this route's whole reason to exist is the message list
    // below, not the frame around it.
    <main className="flex h-full w-full flex-col px-5 py-4">
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
        initialRuns={Object.fromEntries(runs)}
        initialApprovals={approvals}
        initialUnread={{
          unreadCount: unread[0]?.unreadCount ?? 0,
          mentionCount: unread[0]?.mentionCount ?? 0,
        }}
        agents={agentsResult.docs.map((a) => ({ id: a.id, name: a.name }))}
        users={[...peopleById.values()].sort((a, b) => a.name.localeCompare(b.name))}
        projects={projectsResult.docs.map((p) => ({ id: p.id, name: p.name }))}
      />
    </main>
  )
}
