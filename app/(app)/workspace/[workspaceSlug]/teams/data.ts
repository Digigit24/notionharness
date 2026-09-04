import { getPayloadClient } from '@/lib/payload'
import { getBrokerPool, listChannelFeed, type ChannelMessage, type Team } from '@/lib/broker'
import { listTeamRoomMessages, type TeamRoomMessage } from '@/lib/teams/reliability'
import type { RoomFeedMessage, TeamSlotView } from '@/components/teams/shared'

/**
 * Server-side reads for the Teams route.
 *
 * Deliberately NOT in `actions.ts`. Every exported async function in a
 * `'use server'` module is a public HTTP endpoint, so putting an unguarded
 * `loadSlots(teamId)` there would publish "give me any channel's roster by id"
 * to the internet. These are ordinary server functions: the page component and
 * the guarded actions call them AFTER their own checks, and nothing reaches
 * them from a browser.
 *
 * They read tables `lib/broker` already owns, through queries `lib/broker`
 * cannot supply, and every one of those gaps is explained where it occurs.
 */

/** A channel is a `teams` row. Migration 0013 added `topic`, `is_private` and
 * `archived_at` to it; `lib/broker`'s `Team` mapper predates them and that file
 * is foundation, so the three extra columns are read here. */
export interface Channel extends Team {
  topic: string | null
  isPrivate: boolean
  archivedAt: string | null
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function toChannel(row: any): Channel {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    name: row.name,
    description: row.description,
    workspaceMode: row.workspace_mode,
    createdBy: row.created_by == null ? null : Number(row.created_by),
    createdAt: new Date(row.created_at).toISOString(),
    topic: row.topic ?? null,
    isPrivate: row.is_private === true,
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function getChannel(id: number): Promise<Channel | null> {
  const { rows } = await getBrokerPool().query(`SELECT * FROM teams WHERE id = $1`, [id])
  return rows[0] ? toChannel(rows[0]) : null
}

/** Whether a person holds a slot in a channel — the membership test a private
 * channel's visibility turns on. */
export async function isChannelMember(teamId: number, userId: number): Promise<boolean> {
  const { rows } = await getBrokerPool().query(
    `SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1`,
    [teamId, userId],
  )
  return rows.length > 0
}

/**
 * The caller's OWN slot in a channel, or null when they are only reading.
 *
 * This is the only way a slot id is ever chosen for a write that acts as a
 * member. Reactions and the read cursor are per-slot, so accepting a slot id
 * from the browser would mean reacting as, and marking read for, anybody in
 * the room. Derived from the session instead — there is nothing to forge.
 */
export async function resolveMySlot(
  teamId: number,
  userId: number,
): Promise<{ id: number; displayName: string } | null> {
  const { rows } = await getBrokerPool().query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM team_members WHERE team_id = $1 AND user_id = $2 ORDER BY id LIMIT 1`,
    [teamId, userId],
  )
  return rows[0] ? { id: Number(rows[0].id), displayName: rows[0].display_name } : null
}

/**
 * Every slot in a channel, with its agent or person resolved.
 *
 * Its own query rather than `listTeamMembers`, because that function's row
 * mapper types `agent_id` as a plain number and migration 0013 made the column
 * nullable — a human slot would come back as "agent 0". `lib/broker/teams.ts`
 * is foundation and is not edited from here.
 *
 * Two bulk lookups for the names, never one per slot (D0).
 */
export async function loadSlots(teamId: number): Promise<TeamSlotView[]> {
  const { rows } = await getBrokerPool().query(
    // Leader first, then stable by creation, so the room always renders in the
    // same order rather than shuffling as rows are touched.
    `SELECT id, team_id, agent_id, user_id, role, display_name, colour, session_id, worktree_id,
            last_read_message_id
       FROM team_members
      WHERE team_id = $1
      ORDER BY (role = 'leader') DESC, id`,
    [teamId],
  )
  if (rows.length === 0) return []

  const agentIds = [...new Set(rows.filter((r) => r.agent_id != null).map((r) => Number(r.agent_id)))]
  const userIds = [...new Set(rows.filter((r) => r.user_id != null).map((r) => Number(r.user_id)))]
  const payload = await getPayloadClient()
  const [agents, users] = await Promise.all([
    agentIds.length === 0
      ? Promise.resolve({ docs: [] as Array<{ id: number; name: string }> })
      : payload.find({
          collection: 'agents',
          where: { id: { in: agentIds } },
          limit: agentIds.length,
          depth: 0,
          overrideAccess: true,
        }),
    userIds.length === 0
      ? Promise.resolve({ docs: [] as Array<{ id: number; name?: string | null; email: string }> })
      : payload.find({
          collection: 'users',
          where: { id: { in: userIds } },
          limit: userIds.length,
          depth: 0,
          overrideAccess: true,
        }),
  ])
  const agentName = new Map<number, string>(agents.docs.map((a) => [a.id, a.name]))
  const userName = new Map<number, string>(users.docs.map((u) => [u.id, u.name || u.email]))

  return rows.map((row) => {
    const agentId = row.agent_id == null ? null : Number(row.agent_id)
    const userId = row.user_id == null ? null : Number(row.user_id)
    return {
      id: Number(row.id),
      teamId: Number(row.team_id),
      agentId,
      userId,
      role: row.role,
      displayName: row.display_name,
      colour: row.colour,
      sessionId: row.session_id == null ? null : Number(row.session_id),
      worktreeId: row.worktree_id == null ? null : Number(row.worktree_id),
      agentName: agentId == null ? null : (agentName.get(agentId) ?? null),
      userName: userId == null ? null : (userName.get(userId) ?? null),
      lastReadMessageId: row.last_read_message_id == null ? null : Number(row.last_read_message_id),
    }
  })
}

/**
 * Joins the two message queries into the one row the feed renders.
 *
 * `listChannelFeed` knows reply counts, reactions and mentions; it does not
 * know which rows the room wrote itself or which directed notes died with
 * their addressee (R6.6's columns, which live in `lib/teams/reliability.ts`).
 * Neither query can answer for the other, so both run and the results are
 * merged BY ID here — one pass over two arrays, never a query per row.
 */
export function mergeReliability(feed: ChannelMessage[], room: TeamRoomMessage[]): RoomFeedMessage[] {
  const extras = new Map(room.map((m) => [m.id, m]))
  return feed.map((message) => {
    const extra = extras.get(message.id)
    return {
      ...message,
      systemKind: extra?.systemKind ?? null,
      undeliverableAt: extra?.undeliverableAt ?? null,
      undeliverableReason: extra?.undeliverableReason ?? message.undeliverableReason,
      addresseeMissing: extra?.addresseeMissing ?? false,
    }
  })
}

/**
 * The first page of a channel, for the server render.
 *
 * Roots only — replies live in their thread pane, which is the whole point of
 * a thread, and a feed that inlined them would be the flat list channels exist
 * to stop being.
 *
 * This returns the NEWEST `limit` roots, which is what opening a channel wants.
 * It briefly did the opposite: `listChannelFeed` only read forward from a
 * cursor, so a busy channel painted its first day rather than its last. Calling
 * it with no `since` now means "the latest page" (and `{ before }` pages
 * backwards from there), so this is correct without a cap high enough to hide
 * the problem.
 */
export async function loadChannelFeed(teamId: number, limit = 200): Promise<RoomFeedMessage[]> {
  const [feed, room] = await Promise.all([
    listChannelFeed(teamId, { limit }),
    listTeamRoomMessages(teamId, { limit: 1000 }),
  ])
  return mergeReliability(feed, room)
}

