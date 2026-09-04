// Channels: threads, mentions, per-member unread, and reactions.
//
// Built ON `team_messages`, not beside it. A thread is a message with a root;
// the main feed is roots only. That is Slack's own model, and it means every
// existing reader, index and tool keeps working — a separate `threads` table
// would double the shapes any consumer has to understand and force a union in
// every query that wants "the conversation".
//
// Its own module rather than more of `teams.ts` because that file is already
// the mailbox-and-board layer and this is the room layer. They share tables
// deliberately; they do not share concerns.
import { getBrokerPool } from './db'
import type { TeamMessageKind } from './teams'

/** Who a message points at. Ids, never names, so a rename cannot orphan one. */
export type MentionTarget =
  | { type: 'slot'; id: number }
  | { type: 'agent'; id: number }
  | { type: 'user'; id: number }
  | { type: 'team'; id: number }

export interface ChannelReaction {
  emoji: string
  count: number
  /** Who reacted, so the UI can show "you" state without a second query. */
  actorSlotIds: number[]
}

export interface ChannelMessage {
  id: number
  teamId: number
  fromSlotId: number | null
  /** Null means broadcast — which in a channel is most messages. See the
   * migration's note on why a future DM must be a channel of two rather than a
   * second meaning for this column. */
  toSlotId: number | null
  kind: TeamMessageKind
  body: string
  taskId: number | null
  createdAt: string
  /** Null for a root; the root's id for a reply. */
  threadRootId: number | null
  mentions: MentionTarget[]
  /** Replies under this root. Always 0 for a reply itself. */
  replyCount: number
  /** Newest reply's timestamp, for "4 replies · last reply 14:02". */
  lastReplyAt: string | null
  reactions: ChannelReaction[]
  /** Set when this message could not be delivered (R6.6 dead letters). */
  undeliverableReason: string | null
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toChannelMessage(row: any): ChannelMessage {
  return {
    id: Number(row.id),
    teamId: Number(row.team_id),
    fromSlotId: row.from_slot_id == null ? null : Number(row.from_slot_id),
    toSlotId: row.to_slot_id == null ? null : Number(row.to_slot_id),
    kind: row.kind,
    body: row.body,
    taskId: row.task_id == null ? null : Number(row.task_id),
    createdAt: new Date(row.created_at).toISOString(),
    threadRootId: row.thread_root_id == null ? null : Number(row.thread_root_id),
    mentions: Array.isArray(row.mentions) ? (row.mentions as MentionTarget[]) : [],
    replyCount: Number(row.reply_count ?? 0),
    lastReplyAt: row.last_reply_at ? new Date(row.last_reply_at).toISOString() : null,
    reactions: Array.isArray(row.reactions)
      ? (row.reactions as Array<{ emoji: string; count: number; actor_slot_ids: number[] }>).map((r) => ({
          emoji: r.emoji,
          count: Number(r.count),
          actorSlotIds: Array.isArray(r.actor_slot_ids) ? r.actor_slot_ids.map(Number) : [],
        }))
      : [],
    undeliverableReason: row.undeliverable_reason ?? null,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * One query for a feed page, reply counts and reactions included.
 *
 * The obvious shape — fetch messages, then each one's reply count, then each
 * one's reactions — is two N+1s stacked on the surface a person stares at all
 * day and which repaints on every poll. Lateral subqueries collapse it to a
 * single round trip.
 */
const MESSAGE_SELECT = `
  SELECT m.*,
         COALESCE(r.reply_count, 0) AS reply_count,
         r.last_reply_at,
         COALESCE(x.reactions, '[]'::json) AS reactions
    FROM team_messages m
    LEFT JOIN LATERAL (
      SELECT count(*) AS reply_count, max(created_at) AS last_reply_at
        FROM team_messages child
       WHERE child.thread_root_id = m.id
    ) r ON true
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('emoji', e.emoji, 'count', e.count, 'actor_slot_ids', e.actor_slot_ids)
                      ORDER BY e.count DESC, e.emoji) AS reactions
        FROM (
          SELECT emoji, count(*) AS count, array_agg(actor_slot_id) AS actor_slot_ids
            FROM team_message_reactions
           WHERE message_id = m.id
           GROUP BY emoji
        ) e
    ) x ON true
`

/** The channel feed: roots only, oldest first. */
export async function listChannelFeed(
  teamId: number,
  options: { limit?: number; since?: number } = {},
): Promise<ChannelMessage[]> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `${MESSAGE_SELECT}
      WHERE m.team_id = $1 AND m.thread_root_id IS NULL AND m.id > $2
      ORDER BY m.id
      LIMIT $3`,
    [teamId, options.since ?? 0, Math.min(options.limit ?? 200, 500)],
  )
  return rows.map(toChannelMessage)
}

/** One thread: its root followed by its replies, in order. */
export async function listThread(rootId: number): Promise<ChannelMessage[]> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `${MESSAGE_SELECT} WHERE m.id = $1 OR m.thread_root_id = $1 ORDER BY m.id`,
    [rootId],
  )
  return rows.map(toChannelMessage)
}

export async function getChannelMessage(id: number): Promise<ChannelMessage | null> {
  const pool = getBrokerPool()
  const { rows } = await pool.query(`${MESSAGE_SELECT} WHERE m.id = $1`, [id])
  return rows[0] ? toChannelMessage(rows[0]) : null
}

/**
 * Posts into a channel, optionally as a reply.
 *
 * A reply to a reply is re-pointed at the ROOT rather than nesting deeper.
 * Slack made that choice and it is right: arbitrary nesting turns a
 * conversation into a tree nobody can read in a feed, and it would force every
 * renderer downstream to handle unbounded depth for a case that adds nothing.
 */
export async function postChannelMessage(input: {
  teamId: number
  fromSlotId: number | null
  toSlotId?: number | null
  kind?: TeamMessageKind
  body: string
  taskId?: number | null
  threadRootId?: number | null
  mentions?: MentionTarget[]
}): Promise<ChannelMessage> {
  const pool = getBrokerPool()
  let rootId = input.threadRootId ?? null

  if (rootId != null) {
    const { rows } = await pool.query<{ thread_root_id: string | null; team_id: string }>(
      `SELECT thread_root_id, team_id FROM team_messages WHERE id = $1`,
      [rootId],
    )
    const parent = rows[0]
    if (!parent) throw new Error('That thread no longer exists.')
    // A cross-channel reply is not a feature; it would leak one room's
    // conversation into another's feed.
    if (Number(parent.team_id) !== input.teamId) throw new Error('That thread belongs to a different channel.')
    if (parent.thread_root_id != null) rootId = Number(parent.thread_root_id)
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO team_messages (team_id, from_slot_id, to_slot_id, kind, body, task_id, thread_root_id, mentions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id`,
    [
      input.teamId,
      input.fromSlotId,
      input.toSlotId ?? null,
      input.kind ?? 'status',
      input.body,
      input.taskId ?? null,
      rootId,
      JSON.stringify(input.mentions ?? []),
    ],
  )
  const created = await getChannelMessage(Number(rows[0].id))
  if (!created) throw new Error('The message vanished immediately after being written.')
  return created
}

/**
 * Marks a member caught up.
 *
 * A high-water mark that only ever moves FORWARD — `GREATEST`, so a slow tab
 * posting an out-of-order call cannot resurrect messages already read. Per
 * member, because `team_messages.read_at` is a single timestamp on the message
 * and cannot express "Alice read it, Bob did not": correct for a one-recipient
 * mailbox, wrong for a room.
 */
export async function markChannelRead(slotId: number, messageId: number): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(
    `UPDATE team_members
        SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), $2), updated_at = now()
      WHERE id = $1`,
    [slotId, messageId],
  )
}

export interface ChannelUnread {
  teamId: number
  slotId: number
  unreadCount: number
  /** Unread messages naming this slot. A separate badge because "someone said
   * something" and "someone asked YOU" are different urgencies. */
  mentionCount: number
}

/**
 * Unread for every channel a set of slots belongs to, in ONE query.
 *
 * The sidebar shows every channel at once, so a per-channel count would be an
 * N+1 on the most frequently rendered surface in the product (D0).
 */
export async function listChannelUnread(slotIds: number[]): Promise<ChannelUnread[]> {
  if (slotIds.length === 0) return []
  const pool = getBrokerPool()
  const { rows } = await pool.query<{ team_id: string; slot_id: string; unread: string; mentions: string }>(
    `SELECT tm.team_id,
            tm.id AS slot_id,
            count(msg.id) AS unread,
            count(msg.id) FILTER (
              WHERE msg.mentions @> jsonb_build_array(jsonb_build_object('type', 'slot', 'id', tm.id))
            ) AS mentions
       FROM team_members tm
       LEFT JOIN team_messages msg
         ON msg.team_id = tm.team_id
        AND msg.id > COALESCE(tm.last_read_message_id, 0)
        -- Your own messages are never unread to you.
        AND msg.from_slot_id IS DISTINCT FROM tm.id
      WHERE tm.id = ANY($1::bigint[])
      GROUP BY tm.team_id, tm.id`,
    [slotIds],
  )
  return rows.map((row) => ({
    teamId: Number(row.team_id),
    slotId: Number(row.slot_id),
    unreadCount: Number(row.unread),
    mentionCount: Number(row.mentions),
  }))
}

/**
 * Toggles one reaction.
 *
 * The unique index IS the toggle: an INSERT that conflicts means it was
 * already there, so the same call removes it. No read-modify-write, so two
 * people reacting in the same instant cannot lose each other's reaction —
 * which is exactly what a JSONB column on the message would have allowed, and
 * this project has already been bitten by that shape once on task claims.
 */
export async function toggleReaction(input: {
  messageId: number
  actorSlotId: number
  emoji: string
}): Promise<{ added: boolean }> {
  const pool = getBrokerPool()
  const inserted = await pool.query(
    `INSERT INTO team_message_reactions (message_id, actor_slot_id, emoji)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
    [input.messageId, input.actorSlotId, input.emoji],
  )
  if (inserted.rows.length > 0) return { added: true }
  await pool.query(
    `DELETE FROM team_message_reactions WHERE message_id = $1 AND actor_slot_id = $2 AND emoji = $3`,
    [input.messageId, input.actorSlotId, input.emoji],
  )
  return { added: false }
}

/**
 * Parses `@name` out of a body against a roster.
 *
 * Deliberately resolves to SLOT ids: a slot is the thing tools and tasks take,
 * and the same agent may hold two slots, so resolving to an agent would
 * reintroduce the ambiguity slots exist to remove. The body text stays
 * canonical — this is an index, not a rewrite.
 */
export function parseMentions(
  body: string,
  roster: Array<{ id: number; displayName: string }>,
): MentionTarget[] {
  const found = new Map<number, MentionTarget>()
  // Longest names first, so "@Test Agent Deep" is not eaten by "@Test".
  const ordered = [...roster].sort((a, b) => b.displayName.length - a.displayName.length)
  for (const member of ordered) {
    const needle = `@${member.displayName}`.toLowerCase()
    if (body.toLowerCase().includes(needle)) found.set(member.id, { type: 'slot', id: member.id })
  }
  return [...found.values()]
}
