// Sidebar channel data — resolved on the SERVER, handed to the sidebar as one
// prop. There is no 'use client' here and there must never be: this file
// imports the broker (which pulls in `pg`), so a client component importing it
// would drag a database driver into the browser bundle.
//
// It lives beside the sidebar rather than in `lib/broker/**` because it is a
// view query — the exact shape one surface renders — not a domain primitive.
// `lib/broker/channels.ts` owns the primitives and is frozen for this unit.
//
// LATENCY (docs/ROADMAP-SERIES.md D0): THREE queries total, regardless of how
// many channels or slots the workspace has. The obvious implementation —
// listTeams, then listTeamMembers per team, then unread per team — is two
// stacked N+1s on the one component that renders on literally every page in
// the product.
import { listChannelUnread, listTeams, getBrokerPool } from '@/lib/broker'

/** One member slot of a channel, as the sidebar renders it. */
export interface SidebarChannelAgent {
  /** The SLOT id, not the agent id. Slots are what messages, tasks and unread
   * are keyed by; the same agent can hold two slots in one channel. */
  slotId: number
  displayName: string
  colour: string | null
  isLeader: boolean
  /** Null for a human-backed slot (migration 0013 made `agent_id` nullable and
   * added the agent-XOR-user constraint). Only agent-backed slots can link to
   * an agent detail page. */
  agentId: number | null
}

export interface SidebarChannel {
  id: number
  name: string
  members: SidebarChannelAgent[]
  /** Total members, so a capped `members` array can say "+3" honestly. */
  memberCount: number
  /**
   * Unread for THE VIEWER, summed over whatever slots the viewer holds in this
   * channel. Zero when the viewer holds no slot — which is not the same thing
   * as "nothing new happened", and is why `viewerIsMember` is a separate flag
   * rather than something the UI has to infer from a zero.
   */
  unreadCount: number
  /** Unread messages that name one of the viewer's slots. A DISTINCT badge:
   * "someone spoke" and "someone asked you" are different urgencies. */
  mentionCount: number
  viewerIsMember: boolean
}

export interface SidebarChannels {
  channels: SidebarChannel[]
  /** Channels beyond `SIDEBAR_CHANNEL_LIMIT`, so the UI can offer a real
   * "+N more" link instead of silently truncating (D0: no unbounded lists,
   * and no lying about the ones you bounded). */
  hiddenCount: number
}

/** Bounded on purpose. A workspace with 300 channels must not render 300 rows
 * into the layout of every page; the overflow goes to the Teams route, which
 * is a full page built for a long list. */
const SIDEBAR_CHANNEL_LIMIT = 30

/** Members rendered under one expanded channel before "+N more". */
export const SIDEBAR_CHANNEL_MEMBER_LIMIT = 6

interface SlotRow {
  id: string
  team_id: string
  agent_id: string | null
  user_id: number | null
  role: string
  display_name: string
  colour: string | null
}

/**
 * Every channel in one workspace, with its roster and the viewer's unread.
 *
 * SECURITY: `workspaceId` must come from the already-authorised workspace the
 * layout resolved (it checks owner/membership before rendering the shell) —
 * never from a client-supplied id. Every query below is scoped through it:
 * teams by `workspace_id`, slots by those team ids, unread by slots that are
 * both in those teams AND held by `viewerUserId`. There is no path here by
 * which a caller reaches a channel in another workspace.
 *
 * Returns `null` when the broker is unreachable. The sidebar is chrome on
 * every page in the app; a channel list that cannot load must degrade to "no
 * channel list" rather than 500 the whole product. The UI distinguishes null
 * ("could not load") from an empty array ("this workspace has no channels").
 */
export async function getSidebarChannels(
  workspaceId: number,
  viewerUserId: number | null,
): Promise<SidebarChannels | null> {
  try {
    // 1 — the channels themselves.
    //
    // `listTeams` is the sanctioned API and is used deliberately. Its one gap:
    // it has no `archived_at IS NULL` filter, so an archived channel still
    // appears in this list. Filtering it would mean either a second query that
    // re-reads the same rows or editing lib/broker/teams.ts, which this unit
    // must not touch. Flagged rather than papered over — the fix belongs in
    // `listTeams` itself, as an option, so every caller benefits.
    const teams = await listTeams(workspaceId)
    if (teams.length === 0) return { channels: [], hiddenCount: 0 }

    const visible = teams.slice(0, SIDEBAR_CHANNEL_LIMIT)
    const teamIds = visible.map((t) => t.id)

    const pool = getBrokerPool()

    // 2 — every slot of every visible channel, in ONE query.
    //
    // `listTeamMembers` takes a single teamId, so using it here would be one
    // round trip per channel. Same ordering it uses (leader first, then stable
    // by id) so a room's roster reads the same in the sidebar as in the room.
    const { rows: slotRows } = await pool.query<SlotRow>(
      `SELECT id, team_id, agent_id, user_id, role, display_name, colour
         FROM team_members
        WHERE team_id = ANY($1::bigint[])
        ORDER BY (role = 'leader') DESC, id`,
      [teamIds],
    )

    const membersByTeam = new Map<number, SidebarChannelAgent[]>()
    const viewerSlotIds: number[] = []
    for (const row of slotRows) {
      const teamId = Number(row.team_id)
      const slotId = Number(row.id)
      const list = membersByTeam.get(teamId) ?? []
      list.push({
        slotId,
        displayName: row.display_name,
        colour: row.colour,
        isLeader: row.role === 'leader',
        agentId: row.agent_id == null ? null : Number(row.agent_id),
      })
      membersByTeam.set(teamId, list)
      if (viewerUserId != null && row.user_id === viewerUserId) viewerSlotIds.push(slotId)
    }

    // 3 — unread for every one of the viewer's slots, in ONE query.
    //
    // `listChannelUnread` takes an array precisely so this is not an N+1; the
    // viewer's slots are collected above rather than asked for per channel.
    // Skipped entirely when the viewer holds no slot anywhere — there is
    // nothing to ask about, and an empty array short-circuits in the helper
    // anyway.
    const unreadBySlot = viewerSlotIds.length > 0 ? await listChannelUnread(viewerSlotIds) : []
    const unreadByTeam = new Map<number, { unread: number; mentions: number }>()
    for (const row of unreadBySlot) {
      // Summed rather than replaced: one person may hold two slots in the same
      // channel, and both slots' unread is unread to that one person.
      const acc = unreadByTeam.get(row.teamId) ?? { unread: 0, mentions: 0 }
      acc.unread += row.unreadCount
      acc.mentions += row.mentionCount
      unreadByTeam.set(row.teamId, acc)
    }
    const viewerTeamIds = new Set(unreadBySlot.map((r) => r.teamId))

    return {
      channels: visible.map((team) => {
        const members = membersByTeam.get(team.id) ?? []
        const unread = unreadByTeam.get(team.id)
        return {
          id: team.id,
          name: team.name,
          members,
          memberCount: members.length,
          unreadCount: unread?.unread ?? 0,
          mentionCount: unread?.mentions ?? 0,
          viewerIsMember: viewerTeamIds.has(team.id),
        }
      }),
      hiddenCount: teams.length - visible.length,
    }
  } catch {
    return null
  }
}
