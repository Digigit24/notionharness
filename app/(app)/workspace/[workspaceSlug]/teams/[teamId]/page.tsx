import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { claimableTasks, getTeam, listTeamMembers, listTeamMessages, listTeamTasks } from '@/lib/broker'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'
import { TeamRoom } from '@/components/teams/team-room'
import type { TeamSlotView } from '@/components/teams/shared'

/**
 * A team room (R6.4).
 *
 * Everything the three views need is fetched once, here, in parallel, and
 * handed down as typed rows. The room is not allowed to fetch on mount: the
 * channel must be readable on first paint, not after a client round trip.
 *
 * The message window is the last 200 rows. `listTeamMessages` reads forward
 * from a cursor and caps at 1000, so the natural "give me the tail" query does
 * not exist in the broker; 200 from the start of the room is what it can
 * honestly answer without a query this unit is not allowed to add. For rooms
 * past 200 messages that means the channel shows the BEGINNING of the feed,
 * which is wrong for a chat client — recorded as a known gap rather than
 * hidden, and fixed properly by a `listTeamMessages({ before })` in
 * `lib/broker/teams.ts`.
 */
export default async function TeamRoomPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; teamId: string }>
}) {
  const { workspaceSlug, teamId } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const id = Number(teamId)
  if (!Number.isSafeInteger(id)) notFound()
  const team = await getTeam(id)
  // A team id from another workspace must 404 rather than render: the URL is
  // guessable and the room carries the whole conversation.
  if (!team || team.workspaceId !== workspace.id) notFound()

  const [members, messages, tasks, claimable, payload] = await Promise.all([
    listTeamMembers(team.id),
    listTeamMessages(team.id, { limit: 200 }),
    listTeamTasks(team.id),
    claimableTasks(team.id),
    getPayloadClient(),
  ])

  // One query for every agent named by a slot, plus the enabled agents the
  // roster can add — not one lookup per slot. The two sets overlap heavily so
  // they are asked for together and split apart here.
  const agentsResult = await payload.find({
    collection: 'agents',
    where: { workspace: { equals: workspace.id } },
    sort: 'name',
    limit: 200,
    depth: 0,
    overrideAccess: true,
  })
  const agentById = new Map(agentsResult.docs.map((a) => [a.id, a]))

  const slots: TeamSlotView[] = members.map((m) => ({
    ...m,
    agentName: agentById.get(m.agentId)?.name ?? null,
  }))

  return (
    <main className="flex h-full w-full flex-col px-5 py-6">
      <Breadcrumbs
        className="mb-2"
        segments={[
          { label: workspace.name, href: `/workspace/${workspace.slug}` },
          { label: 'Teams', href: `/workspace/${workspace.slug}/teams` },
          { label: team.name },
        ]}
      />
      <TeamRoom
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        team={team}
        slots={slots}
        initialMessages={messages}
        initialTasks={tasks}
        initialClaimableIds={claimable.map((t) => t.id)}
        agents={agentsResult.docs
          .filter((a) => a.enabled !== false)
          .map((a) => ({ id: a.id, name: a.name }))}
      />
    </main>
  )
}
