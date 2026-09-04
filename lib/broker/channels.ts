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
import { bestEffort } from '@/lib/failures'
import type { TeamMessageKind } from './teams'

/**
 * R12-P3.3 — the push half of the channel going real-time.
 *
 * One shared `pg_notify` channel for every room in the install, not one per
 * team: `LISTEN` is cheap on ONE connection (`lib/broker/notify.ts` already
 * carries the approval-decision channel this way) but a channel PER TEAM
 * would mean a fresh `LISTEN name` for every room anyone ever opens, which
 * never gets unregistered when the room closes. The payload carries the team
 * id so the one SSE route subscribed to this channel can ignore every
 * notification that is not its own room — a filter in the route, not a
 * connection per room.
 *
 * Best-effort and fire-and-forget: this is the PUSH path, and the room's own
 * fallback poll (`team-room.tsx`) is what makes correctness never depend on a
 * `NOTIFY` arriving. A dropped wake-up costs at most one poll interval, which
 * is the same failure mode `subscribeToNotifications` already documents for
 * the approval channel.
 */
export const CHANNEL_EVENTS_CHANNEL = 'channel_events'

export async function notifyChannelEvent(teamId: number): Promise<void> {
  await bestEffort(
    getBrokerPool().query(`SELECT pg_notify('${CHANNEL_EVENTS_CHANNEL}', $1)`, [JSON.stringify({ teamId })]),
    'a missed room wake-up is covered by the fallback poll',
    { teamId },
  )
}

/**
 * R12-P3.2 — a person typing, and NOTHING written to disk for it.
 *
 * A separate channel from `CHANNEL_EVENTS_CHANNEL` on purpose: that one means
 * "go re-fetch the room", and every subscriber pays a query for it. This one
 * carries the whole fact in its payload — team, slot, timestamp — so the SSE
 * route can forward it verbatim with no database round trip at all. Folding
 * typing into the same channel would mean every keystroke in a busy room
 * triggered a `pollTeamRoomAction` call on every other open tab, which is
 * exactly the load a "no rows written" feature exists to avoid.
 *
 * Composer-side throttling (`message-composer.tsx`, one call per two seconds
 * while there is uncommitted text) is what keeps this cheap; nothing here
 * enforces a rate, because `pg_notify` has no row to rate-limit against.
 */
export const CHANNEL_TYPING_CHANNEL = 'channel_typing'

export async function notifyTyping(teamId: number, slotId: number): Promise<void> {
  await bestEffort(
    getBrokerPool().query(`SELECT pg_notify('${CHANNEL_TYPING_CHANNEL}', $1)`, [
      JSON.stringify({ teamId, slotId, at: Date.now() }),
    ]),
    'a missed typing signal is cosmetic — the indicator simply never appears for that keystroke',
    { teamId, slotId },
  )
}

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
  /** The run that produced this message, when an agent wrote it. Lets a reply
   * link to the EXACT run behind it rather than approximating from the slot's
   * session, which might be a later turn entirely. */
  runId: number | null
  /**
   * R14-P0.4 — Media collection ids, and NOTHING else.
   *
   * Same "store the id, not a duplicate blob" pattern every other pointer on
   * this table already follows (`taskId`, `runId`): the file's bytes, name,
   * size and image variants live in Payload's `media` collection exactly
   * once, and resolving an id to those is `components/thread/Attachment.tsx`'s
   * `ChannelAttachment` wrapper's job, not this module's — `lib/broker` has no
   * business knowing what a Media doc looks like.
   */
  attachments: number[]
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
    runId: row.run_id == null ? null : Number(row.run_id),
    attachments: Array.isArray(row.attachments) ? row.attachments.map(Number) : [],
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
  options: { limit?: number; since?: number; before?: number } = {},
): Promise<ChannelMessage[]> {
  const pool = getBrokerPool()
  const limit = Math.min(options.limit ?? 200, 500)

  // `before` reads BACKWARDS from a point, which is what opening a channel
  // actually wants: the most recent messages, not the oldest.
  //
  // Without it the feed was `id > since` only, so a channel with more than one
  // page of history painted from the BEGINNING of the conversation — you
  // opened a busy room and were shown its first day. Slack scrolls back from
  // now; so does this. The rows come back newest-first from the database and
  // are reversed here so callers always receive oldest-first, which is the one
  // order a feed can render without thinking about it.
  if (options.before !== undefined) {
    const { rows } = await pool.query(
      `${MESSAGE_SELECT}
        WHERE m.team_id = $1 AND m.thread_root_id IS NULL AND m.id < $2
        ORDER BY m.id DESC
        LIMIT $3`,
      [teamId, options.before, limit],
    )
    return rows.map(toChannelMessage).reverse()
  }

  // No cursor at all means "the latest page", for the same reason.
  if (options.since === undefined) {
    const { rows } = await pool.query(
      `${MESSAGE_SELECT}
        WHERE m.team_id = $1 AND m.thread_root_id IS NULL
        ORDER BY m.id DESC
        LIMIT $2`,
      [teamId, limit],
    )
    return rows.map(toChannelMessage).reverse()
  }

  // An explicit `since` is the poll: everything new, forwards.
  const { rows } = await pool.query(
    `${MESSAGE_SELECT}
      WHERE m.team_id = $1 AND m.thread_root_id IS NULL AND m.id > $2
      ORDER BY m.id
      LIMIT $3`,
    [teamId, options.since, limit],
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
  /** Set by the dispatcher when an agent's run produced this message. */
  runId?: number | null
  /** Media collection ids. See `ChannelMessage.attachments`'s own comment for
   * why this is ids only. */
  attachments?: number[]
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
    `INSERT INTO team_messages (team_id, from_slot_id, to_slot_id, kind, body, task_id, thread_root_id, mentions, run_id, attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb) RETURNING id`,
    [
      input.teamId,
      input.fromSlotId,
      input.toSlotId ?? null,
      input.kind ?? 'status',
      input.body,
      input.taskId ?? null,
      rootId,
      JSON.stringify(input.mentions ?? []),
      input.runId ?? null,
      JSON.stringify(input.attachments ?? []),
    ],
  )
  const created = await getChannelMessage(Number(rows[0].id))
  if (!created) throw new Error('The message vanished immediately after being written.')
  // Fired after the row is fully committed and re-read, so a viewer woken by
  // this can never poll and find nothing there yet.
  void notifyChannelEvent(input.teamId)
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
  /** Optional ONLY for callers that predate this — every current call site
   * passes it, and passing it is what turns a reaction into a live update for
   * everyone else looking at the room instead of something they notice on
   * their next poll. */
  teamId?: number
}): Promise<{ added: boolean }> {
  const pool = getBrokerPool()
  const inserted = await pool.query(
    `INSERT INTO team_message_reactions (message_id, actor_slot_id, emoji)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
    [input.messageId, input.actorSlotId, input.emoji],
  )
  if (input.teamId != null) void notifyChannelEvent(input.teamId)
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
 * Resolves to SLOT ids deliberately: a slot is what tools and tasks take, and
 * the same agent may hold two slots, so resolving to an agent would reintroduce
 * the ambiguity slots exist to remove. The body text stays canonical — this is
 * an index, not a rewrite.
 *
 * SCANS AND CONSUMES, left to right, longest name first. The obvious
 * implementation — test `body.includes('@' + name)` for each roster entry —
 * is wrong in a way that sorting alone does not fix, because nothing is ever
 * consumed: "@Coder 2" contains the substring "@Coder", so BOTH slots get
 * mentioned and the prefix-named member gets a mention badge for a message
 * that never named them. That is not hypothetical here — the create dialog
 * auto-names a second slot for one agent "Coder 2", so this product generates
 * the collision itself.
 *
 * Matching at a position and skipping past it is the only shape that cannot
 * double-count. `components/teams/shared.ts`'s `splitMentions` renders with the
 * same rule, so what is highlighted and what is indexed agree.
 */
export function parseMentions(
  body: string,
  roster: Array<{ id: number; displayName: string }>,
): MentionTarget[] {
  // Longest first, so "@Coder 2" is matched as itself rather than as "@Coder"
  // followed by a stray "2".
  const ordered = [...roster]
    .filter((member) => member.displayName.trim().length > 0)
    .sort((a, b) => b.displayName.length - a.displayName.length)
  if (ordered.length === 0) return []

  const lower = body.toLowerCase()
  const found = new Map<number, MentionTarget>()

  let index = lower.indexOf('@')
  while (index !== -1) {
    let consumed = 0
    for (const member of ordered) {
      const name = member.displayName.toLowerCase()
      if (lower.startsWith(name, index + 1)) {
        found.set(member.id, { type: 'slot', id: member.id })
        consumed = name.length
        break
      }
    }
    // Past the whole match on a hit, past the '@' on a miss. Either way the
    // scan always advances, so a name containing '@' cannot loop.
    index = lower.indexOf('@', index + 1 + consumed)
  }

  return [...found.values()]
}

/**
 * The run started to answer a channel message, if there is one.
 *
 * Lets a thread link to the WORK rather than only the summary. A channel reply
 * is an answer; the tool calls, terminal output and diffs behind it live in the
 * run's own session, and without this there is no way across — the thread says
 * what happened and the evidence sits in a place you cannot reach from it.
 *
 * Newest first, because a message answered more than once (a deliberate
 * re-ask) should link to the most recent attempt.
 */
export async function getRunForChannelMessage(
  messageId: number,
): Promise<{ runId: number; sessionId: number | null; status: string } | null> {
  const pool = getBrokerPool()
  const { rows } = await pool.query<{ id: string; session_id: string | null; status: string }>(
    `SELECT id, session_id, status FROM runs WHERE channel_message_id = $1 ORDER BY id DESC LIMIT 1`,
    [messageId],
  )
  const row = rows[0]
  if (!row) return null
  return {
    runId: Number(row.id),
    sessionId: row.session_id == null ? null : Number(row.session_id),
    status: row.status,
  }
}

/** What a channel message's run is doing, including anything it is blocked on. */
export interface ChannelMessageRun {
  runId: number
  sessionId: number | null
  status: string
}

export async function getRunsForChannelMessages(
  messageIds: number[],
): Promise<Map<number, ChannelMessageRun>> {
  const found = new Map<number, ChannelMessageRun>()
  if (messageIds.length === 0) return found
  const pool = getBrokerPool()
  const { rows } = await pool.query<{
    channel_message_id: string
    id: string
    session_id: string | null
    status: string
  }>(
    `SELECT DISTINCT ON (r.channel_message_id)
            r.channel_message_id, r.id, r.session_id, r.status
       FROM runs r
      WHERE r.channel_message_id = ANY($1::bigint[])
      ORDER BY r.channel_message_id, r.id DESC`,
    [messageIds],
  )
  for (const row of rows) {
    found.set(Number(row.channel_message_id), {
      runId: Number(row.id),
      sessionId: row.session_id == null ? null : Number(row.session_id),
      status: row.status,
    })
  }
  return found
}

/**
 * A permission request that is blocking a run started FROM this channel.
 *
 * Why this exists as its own query rather than riding on
 * `getRunsForChannelMessages`: that map is fetched once per message id and
 * never re-fetched, because whether a message started a run is decided at
 * insert time and can never change. An approval is the opposite — it appears
 * in the MIDDLE of a run, minutes after the message was posted, and it
 * disappears again when somebody decides. It has to be read on the same
 * cadence as the rest of the room.
 *
 * It costs no round trip: the room already polls, and this runs inside that
 * poll's existing `Promise.all` alongside the feed and the task reads. Its
 * result set is bounded by "pending approvals in one channel", which is
 * approximately never more than a handful.
 *
 * `messageId` is the thread ROOT, not the triggering message, because that is
 * the row the channel feed actually renders — the feed is roots only. The
 * trigger id is carried separately for the thread pane.
 */
export interface ChannelApproval {
  /** The feed row this belongs under: the trigger's thread root. */
  rootMessageId: number
  /** The message that named the agent, for the thread pane. */
  triggerMessageId: number
  runId: number
  sessionId: number | null
  /** The slot whose agent is blocked, so the strip can name it. */
  slotId: number | null
  /** ACP request id — what `/api/approvals` is POSTed with. */
  externalId: string
  title: string
  detail: string | null
  options: Array<{ optionId: string; kind: string; label?: string }>
  /** Only this person may decide. Everyone else sees the block and is told
   * who is holding it, which is more useful than hiding it from them. */
  requestedUserId: number
  createdAt: string
}

export async function listPendingChannelApprovals(teamId: number): Promise<ChannelApproval[]> {
  const pool = getBrokerPool()
  const { rows } = await pool.query<{
    root_id: string
    trigger_id: string
    run_id: string
    session_id: string | null
    from_slot_id: string | null
    external_id: string
    title: string | null
    detail: string | null
    options: unknown
    requested_user_id: number
    created_at: Date | string
  }>(
    `SELECT COALESCE(m.thread_root_id, m.id) AS root_id,
            m.id                             AS trigger_id,
            r.id                             AS run_id,
            r.session_id,
            tm.id                            AS from_slot_id,
            a.external_id,
            a.title,
            a.detail,
            a.options,
            a.requested_user_id,
            a.created_at
       FROM approvals a
       JOIN runs r          ON r.id = a.run_id
       JOIN team_messages m ON m.id = r.channel_message_id
       LEFT JOIN team_members tm ON tm.session_id = r.session_id AND tm.team_id = m.team_id
      WHERE a.status = 'pending' AND m.team_id = $1
      ORDER BY a.id`,
    [teamId],
  )
  return rows.map((row) => ({
    rootMessageId: Number(row.root_id),
    triggerMessageId: Number(row.trigger_id),
    runId: Number(row.run_id),
    sessionId: row.session_id == null ? null : Number(row.session_id),
    slotId: row.from_slot_id == null ? null : Number(row.from_slot_id),
    externalId: row.external_id,
    title: row.title ?? 'Permission requested',
    detail: row.detail ?? null,
    options: Array.isArray(row.options)
      ? (row.options as Array<{ optionId: string; kind: string; label?: string }>)
      : [],
    requestedUserId: Number(row.requested_user_id),
    createdAt: new Date(row.created_at).toISOString(),
  }))
}

export interface UserMention {
  messageId: number
  teamId: number
  channelName: string
  body: string
  createdAt: string
  fromSlotId: number | null
  fromDisplayName: string | null
  threadRootId: number | null
  /** True while it sits above the reader's own high-water mark. */
  unread: boolean
}

/**
 * Every message mentioning this person, across every channel they are in.
 *
 * The surface that fixes the wrong entry point: nobody opens a product asking
 * which rooms exist, they ask what needs them. One query over the GIN index on
 * `mentions`, joined to the reader's own slots — no new table, no second
 * notifications system.
 *
 * Bounded, and ordered newest-first, because "what needs me" is a recent
 * question and an unbounded list on a landing surface is exactly what D0
 * forbids.
 */
export async function listUserMentions(
  userId: number,
  options: { workspaceId?: number; limit?: number; unreadOnly?: boolean } = {},
): Promise<UserMention[]> {
  const pool = getBrokerPool()
  const params: unknown[] = [userId]
  let scope = ''
  if (options.workspaceId != null) {
    params.push(options.workspaceId)
    scope = ` AND t.workspace_id = $${params.length}`
  }
  params.push(Math.min(options.limit ?? 50, 200))

  const { rows } = await pool.query<{
    id: string
    team_id: string
    channel_name: string
    body: string
    created_at: Date
    from_slot_id: string | null
    from_display_name: string | null
    thread_root_id: string | null
    unread: boolean
  }>(
    `SELECT m.id,
            m.team_id,
            t.name AS channel_name,
            m.body,
            m.created_at,
            m.from_slot_id,
            sender.display_name AS from_display_name,
            m.thread_root_id,
            (m.id > COALESCE(mine.last_read_message_id, 0)) AS unread
       FROM team_members mine
       JOIN teams t ON t.id = mine.team_id AND t.archived_at IS NULL
       JOIN team_messages m
         ON m.team_id = mine.team_id
        AND m.mentions @> jsonb_build_array(jsonb_build_object('type', 'slot', 'id', mine.id))
       LEFT JOIN team_members sender ON sender.id = m.from_slot_id
      WHERE mine.user_id = $1${scope}
        -- A mention of yourself is not a thing that needs you.
        AND m.from_slot_id IS DISTINCT FROM mine.id
        ${options.unreadOnly ? 'AND m.id > COALESCE(mine.last_read_message_id, 0)' : ''}
      ORDER BY m.id DESC
      LIMIT $${params.length}`,
    params,
  )

  return rows.map((row) => ({
    messageId: Number(row.id),
    teamId: Number(row.team_id),
    channelName: row.channel_name,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
    fromSlotId: row.from_slot_id == null ? null : Number(row.from_slot_id),
    fromDisplayName: row.from_display_name,
    threadRootId: row.thread_root_id == null ? null : Number(row.thread_root_id),
    unread: row.unread,
  }))
}
