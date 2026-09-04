'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import {
  claimTeamTask,
  claimableTasks,
  createSession,
  createTeam,
  createTeamTask,
  deleteTeam,
  getBrokerPool,
  getChannelMessage,
  getTeamMember,
  getTeamTask,
  listChannelFeed,
  listChannelUnread,
  listTeamTasks,
  listThread,
  markChannelRead,
  parseMentions,
  postChannelMessage,
  removeTeamMember,
  reportTeamTaskDone,
  setTeamLeader,
  toggleReaction,
  updateTeamTaskStatus,
  type Team,
  type TeamMember,
  type TeamMessageKind,
  type TeamTask,
  type TeamTaskStatus,
  type TeamWorkspaceMode,
} from '@/lib/broker'
import { requestRunCancel } from '@/lib/dispatcher/worker'
import {
  clearTeamStopRequest,
  listTeamDeadLetters,
  listTeamRoomMessages,
  listTeamRunsInFlight,
  readTeamStopState,
  recordTeamStopRequest,
  sweepTeamSlots,
  type TeamRoomMessage,
  type TeamSlotHealth,
  type TeamStopState,
} from '@/lib/teams/reliability'
import { slotColourFor, type RoomFeedMessage, type TeamSlotView } from '@/components/teams/shared'
import {
  getChannel,
  isChannelMember,
  loadSlots,
  mergeReliability,
  resolveMySlot,
  toChannel,
  type Channel,
} from './data'

/**
 * Server actions for the Teams section (R6.4 / R6.5 channels).
 *
 * Everything here is a thin, guarded wrapper over `lib/broker/teams.ts` and
 * `lib/broker/channels.ts`, which are the whole data layer. Nothing in this
 * file computes a number the database did not answer: where a figure cannot be
 * asked for honestly it is not shown at all (see the presence note in
 * `components/teams/lanes-view.tsx`).
 *
 * THREE guards run on every entry point, because a server action is a public
 * endpoint and every id on the wire is hostile:
 *
 *   1. you must be logged in;
 *   2. you must be able to open the WORKSPACE you claim to be acting in — this
 *      used to be missing, and without it the `workspaceId` argument was
 *      simply believed, so naming a workspace you cannot open plus a team
 *      inside it passed the team check trivially;
 *   3. the team you name must belong to that workspace, and a PRIVATE channel
 *      must have you in its roster.
 *
 * And a fourth on anything that acts AS a member: the slot is never taken from
 * the client. `resolveMySlot` derives it from (team, logged-in user), so a
 * reaction or a read cursor cannot be attributed to somebody else's slot by
 * editing a number in a request.
 */

async function requireUser() {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')
  return user
}

/**
 * The workspace, re-checked against the caller.
 *
 * The page layout does this too, but a server action is reachable without ever
 * rendering that layout, so repeating it here is the difference between a
 * check and a decoration. One indexed `findByID`; the same owner-or-member
 * rule as `app/(app)/workspace/[workspaceSlug]/layout.tsx`.
 */
async function requireWorkspace(workspaceId: number, userId: number): Promise<void> {
  const payload = await getPayloadClient()
  const workspace = await payload.findByID({
    collection: 'workspaces',
    id: workspaceId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })
  if (!workspace) throw new Error('That workspace no longer exists.')
  const ownerId = typeof workspace.owner === 'number' ? workspace.owner : workspace.owner?.id
  const memberIds = (workspace.members ?? []).map((m) => (typeof m === 'number' ? m : m.id))
  if (ownerId !== userId && !memberIds.includes(userId)) throw new Error('That workspace is not yours.')
}

/**
 * The channel, scoped to the workspace AND to the caller's right to see it.
 *
 * A private channel is invisible to a non-member: the error is the same as for
 * a channel in another workspace, so probing ids cannot distinguish "not
 * yours" from "does not exist".
 */
async function requireChannel(teamId: number, workspaceId: number, userId: number): Promise<Channel> {
  const team = await getChannel(teamId)
  if (!team) throw new Error('That channel no longer exists.')
  if (team.workspaceId !== workspaceId) throw new Error('That channel belongs to another workspace.')
  if (team.isPrivate && !(await isChannelMember(teamId, userId))) {
    throw new Error('That channel no longer exists.')
  }
  return team
}

/** Convenience for the many actions that need both guards in order. */
async function requireAccess(workspaceId: number, teamId: number) {
  const user = await requireUser()
  await requireWorkspace(workspaceId, user.id)
  const team = await requireChannel(teamId, workspaceId, user.id)
  return { user, team }
}

/** A slot id is only meaningful inside its team; re-check rather than trusting
 * the client to have sent a slot from the room it is looking at. */
async function requireSlot(slotId: number, teamId: number): Promise<TeamMember> {
  const slot = await getTeamMember(slotId)
  if (!slot) throw new Error('That team slot no longer exists.')
  if (slot.teamId !== teamId) throw new Error('That slot belongs to another team.')
  return slot
}

/**
 * A slot binds an agent AND creates a `chat_sessions` row for it, so an agent
 * id arriving from the client is a write into the workspace, not a label. It
 * has to be re-checked: a server action is a public endpoint, and without this
 * an agent from another workspace can be bound into this team's roster and
 * given a conversation in this workspace.
 */
async function requireAgent(agentId: number, workspaceId: number): Promise<void> {
  const payload = await getPayloadClient()
  const agent = await payload.findByID({
    collection: 'agents',
    id: agentId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })
  if (!agent) throw new Error('That agent no longer exists.')
  const owner = typeof agent.workspace === 'object' && agent.workspace ? agent.workspace.id : agent.workspace
  if (Number(owner) !== workspaceId) throw new Error('That agent belongs to another workspace.')
}

/**
 * Same reasoning as `requireAgent`, for the human half of a roster: a user id
 * off the wire must be somebody who can already open this workspace, or adding
 * a member would be a way to hand a stranger a seat in a private channel.
 *
 * Takes the whole set rather than one id at a time. Creating a channel names
 * several people at once, and checking them one by one would re-read the SAME
 * workspace document once per person — a query loop over a list, which is the
 * shape D0 rules out. One read, then a set membership test per id.
 */
async function requireWorkspaceUsers(userIds: number[], workspaceId: number): Promise<void> {
  if (userIds.length === 0) return
  const payload = await getPayloadClient()
  const workspace = await payload.findByID({
    collection: 'workspaces',
    id: workspaceId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })
  if (!workspace) throw new Error('That workspace no longer exists.')
  const ownerId = typeof workspace.owner === 'number' ? workspace.owner : workspace.owner?.id
  const allowed = new Set<number>((workspace.members ?? []).map((m) => (typeof m === 'number' ? m : m.id)))
  if (typeof ownerId === 'number') allowed.add(ownerId)
  for (const userId of userIds) {
    if (!allowed.has(userId)) throw new Error('That person is not in this workspace.')
  }
}

async function requireTask(taskId: number, teamId: number): Promise<TeamTask> {
  const task = await getTeamTask(taskId)
  if (!task) throw new Error('That task no longer exists.')
  if (task.teamId !== teamId) throw new Error('That task belongs to another team.')
  return task
}

// --- The channel list -------------------------------------------------------

export interface ChannelSummary extends Channel {
  memberCount: number
  /**
   * Unread FOR YOU, at last.
   *
   * The old number here counted rows with `team_messages.read_at IS NULL`,
   * which is one flag for the whole installation: it answered "has anybody
   * opened this room", not "have you", and read wrong the moment a second
   * person existed. Migration 0013 added `team_members.last_read_message_id`,
   * so `listChannelUnread` answers the real question per member — and this is
   * null, not 0, when you have no slot in the channel, because "nothing new"
   * and "no cursor to compare against" are different facts.
   */
  unreadCount: number | null
  mentionCount: number
  openTaskCount: number
  lastMessageAt: string | null
  /** True when the caller holds a slot here. Drives "Join" vs "Open". */
  joined: boolean
}

/**
 * Every channel the caller may see, plus the numbers a channel list needs.
 *
 * Two round trips total, not one per channel: one aggregate over `teams`, then
 * one `listChannelUnread` over every slot the caller holds in this workspace.
 * The counters inside the first are scalar subqueries rather than joins with
 * GROUP BY on purpose — joining `team_members`, `team_messages` and
 * `team_tasks` in one FROM multiplies the rows together and every count comes
 * back inflated.
 */
export async function listChannelSummaries(workspaceId: number): Promise<ChannelSummary[]> {
  const user = await requireUser()
  await requireWorkspace(workspaceId, user.id)
  const pool = getBrokerPool()
  const { rows } = await pool.query(
    `SELECT t.*,
            (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS member_count,
            (SELECT COUNT(*) FROM team_tasks k WHERE k.team_id = t.id AND k.status NOT IN ('done', 'cancelled')) AS open_task_count,
            (SELECT MAX(g.created_at) FROM team_messages g WHERE g.team_id = t.id) AS last_message_at,
            (SELECT m.id FROM team_members m WHERE m.team_id = t.id AND m.user_id = $2 ORDER BY m.id LIMIT 1) AS my_slot_id
       FROM teams t
      WHERE t.workspace_id = $1
        AND t.archived_at IS NULL
        -- A private channel is not listed to a non-member. Enforced in SQL
        -- rather than filtered in JS so the row never leaves the database.
        AND (t.is_private = false
             OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = $2))
      ORDER BY t.name`,
    [workspaceId, user.id],
  )

  const mySlotIds = rows.map((r) => (r.my_slot_id == null ? null : Number(r.my_slot_id))).filter((v): v is number => v != null)
  const unread = await listChannelUnread(mySlotIds)
  const unreadByTeam = new Map(unread.map((u) => [u.teamId, u]))

  return rows.map((row) => {
    const channel = toChannel(row)
    const mine = unreadByTeam.get(channel.id)
    return {
      ...channel,
      memberCount: Number(row.member_count),
      unreadCount: mine ? mine.unreadCount : null,
      mentionCount: mine ? mine.mentionCount : 0,
      openTaskCount: Number(row.open_task_count),
      lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
      joined: row.my_slot_id != null,
    }
  })
}

// --- Creating a channel and filling its slots -------------------------------

/**
 * Binds an AGENT slot to its own conversation.
 *
 * R6.1's central decision is that a member is a slot bound to an ordinary
 * `chat_sessions` row, so streaming, tool cards, approvals and resume all work
 * inside a team with no second code path. That only holds if the row exists,
 * so it is created here rather than lazily on first message — a slot with no
 * session is a lane that cannot be opened.
 *
 * A HUMAN slot deliberately gets no session: a person has no runtime to
 * stream, and creating an empty agent conversation for them would put a dead
 * thread in Work for every member of every channel.
 */
async function insertSlot(input: {
  team: Team
  agentId: number | null
  userId: number | null
  displayName: string
  index: number
  createdBy: number
}): Promise<void> {
  let sessionId: number | null = null
  if (input.agentId != null) {
    const session = await createSession({
      workspaceId: input.team.workspaceId,
      agentId: input.agentId,
      title: `${input.team.name} — ${input.displayName}`,
      createdBy: input.createdBy,
    })
    sessionId = session.id
  }
  // Direct SQL rather than `addTeamMember`, which has no `user_id` parameter
  // and would violate migration 0013's `agent_id XOR user_id` CHECK for a
  // person. `lib/broker/teams.ts` is foundation and is not edited from here.
  await getBrokerPool().query(
    `INSERT INTO team_members (team_id, agent_id, user_id, role, display_name, colour, session_id)
     VALUES ($1, $2, $3, 'member', $4, $5, $6)`,
    [
      input.team.id,
      input.agentId,
      input.userId,
      input.displayName,
      // Colour is server state, deliberately. AionUi keeps member colour in
      // localStorage, which is why their team looks different on every machine;
      // stored here the room is the same everywhere and survives a restart.
      slotColourFor(input.index),
      sessionId,
    ],
  )
}

/** Postgres' unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505'

function isDuplicateChannelName(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  const constraint = (error as { constraint?: string } | null)?.constraint
  return code === UNIQUE_VIOLATION && (constraint == null || constraint.includes('teams_workspace_name'))
}

export type ChannelMemberDraft =
  | { kind: 'agent'; agentId: number; displayName: string }
  | { kind: 'user'; userId: number; displayName: string }

export async function createChannelAction(input: {
  workspaceId: number
  workspaceSlug: string
  name: string
  topic?: string
  isPrivate: boolean
  workspaceMode: TeamWorkspaceMode
  /** Slots in roster order. Two entries may name the SAME agent — that is the
   * point of a slot, and neither this action nor the UI collapses them (R6.1). */
  members: ChannelMemberDraft[]
  /** An index into `members`, not an agent id, precisely because the same agent
   * can appear twice and "which agent leads" would then be ambiguous. */
  leaderIndex: number | null
}): Promise<{ teamId: number }> {
  const user = await requireUser()
  await requireWorkspace(input.workspaceId, user.id)
  const name = input.name.trim().replace(/^#+/, '').trim()
  if (!name) throw new Error('A channel needs a name.')

  // Checked before the team row exists, so a bad id fails cleanly instead of
  // leaving an empty channel behind. `Set` because a roster naming the same
  // agent twice is legitimate and must not cost two lookups.
  for (const agentId of new Set(input.members.flatMap((m) => (m.kind === 'agent' ? [m.agentId] : [])))) {
    await requireAgent(agentId, input.workspaceId)
  }
  await requireWorkspaceUsers(
    [...new Set(input.members.flatMap((m) => (m.kind === 'user' ? [m.userId] : [])))],
    input.workspaceId,
  )

  // Named before it is created, so the common case answers without waiting for
  // a constraint violation. The catch below is still required: two people
  // creating "#design" at the same moment is exactly what the unique index is
  // for, and a pre-check cannot close that window.
  const { rows: clash } = await getBrokerPool().query(
    `SELECT 1 FROM teams WHERE workspace_id = $1 AND lower(name) = lower($2) AND archived_at IS NULL LIMIT 1`,
    [input.workspaceId, name],
  )
  if (clash.length > 0) throw new Error(`#${name} already exists — pick another name.`)

  // Sequential, not Promise.all: creating a slot writes two rows through two
  // calls and there is no transaction spanning both from out here (opening one
  // would mean editing `lib/broker/teams.ts`, which this unit does not own).
  // Sequential at least fails at a known point — the channel and the slots
  // created so far survive and the roster panel can finish the job — instead
  // of leaving an unpredictable subset behind.
  let team: Team
  try {
    team = await createTeam({
      workspaceId: input.workspaceId,
      name,
      description: null,
      workspaceMode: input.workspaceMode,
      createdBy: user.id,
    })
  } catch (error) {
    if (isDuplicateChannelName(error)) throw new Error(`#${name} already exists — pick another name.`)
    throw error
  }

  // `createTeam` predates 0013 and does not know about these two columns.
  await getBrokerPool().query(`UPDATE teams SET topic = $2, is_private = $3 WHERE id = $1`, [
    team.id,
    input.topic?.trim() || null,
    input.isPrivate,
  ])

  // The creator is always a member, and is added FIRST so index 0 is theirs.
  // A private channel whose creator is not in it would be invisible to the
  // person who just made it, and reactions and unread both need a slot.
  const members: ChannelMemberDraft[] = input.members.some((m) => m.kind === 'user' && m.userId === user.id)
    ? input.members
    : [{ kind: 'user', userId: user.id, displayName: user.name || user.email }, ...input.members]
  const leaderOffset = members.length - input.members.length

  for (const [index, member] of members.entries()) {
    await insertSlot({
      team,
      agentId: member.kind === 'agent' ? member.agentId : null,
      userId: member.kind === 'user' ? member.userId : null,
      displayName: member.displayName.trim() || `Slot ${index + 1}`,
      index,
      createdBy: user.id,
    })
  }

  if (input.leaderIndex != null) {
    const slots = await loadSlots(team.id)
    const leader = slots[input.leaderIndex + leaderOffset]
    if (leader) await setTeamLeader(team.id, leader.id)
  }

  revalidatePath(`/workspace/${input.workspaceSlug}/teams`)
  return { teamId: team.id }
}

export async function addSlotAction(input: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  agentId: number | null
  userId: number | null
  displayName: string
}): Promise<TeamSlotView[]> {
  const { user, team } = await requireAccess(input.workspaceId, input.teamId)
  // The CHECK constraint says exactly one; saying so here gives a sentence
  // instead of a constraint name.
  if ((input.agentId == null) === (input.userId == null)) {
    throw new Error('A slot is backed by an agent or by a person — one of the two.')
  }
  if (input.agentId != null) await requireAgent(input.agentId, input.workspaceId)
  if (input.userId != null) await requireWorkspaceUsers([input.userId], input.workspaceId)

  const existing = await loadSlots(team.id)
  await insertSlot({
    team,
    agentId: input.agentId,
    userId: input.userId,
    displayName: input.displayName.trim() || 'New slot',
    // Colour follows roster size, so a second slot for the same agent gets a
    // different colour and the two are told apart at a glance.
    index: existing.length,
    createdBy: user.id,
  })
  revalidatePath(`/workspace/${input.workspaceSlug}/teams/${team.id}`)
  return loadSlots(team.id)
}

/** Joining is adding yourself, and it is the only add that does not need you
 * to already be in the room — so a public channel can be entered from the
 * channel list. A private one is unreachable here because `requireChannel`
 * has already refused it. */
export async function joinChannelAction(input: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
}): Promise<TeamSlotView[]> {
  const { user, team } = await requireAccess(input.workspaceId, input.teamId)
  const mine = await resolveMySlot(team.id, user.id)
  if (!mine) {
    const existing = await loadSlots(team.id)
    await insertSlot({
      team,
      agentId: null,
      userId: user.id,
      displayName: user.name || user.email,
      index: existing.length,
      createdBy: user.id,
    })
  }
  revalidatePath(`/workspace/${input.workspaceSlug}/teams/${team.id}`)
  return loadSlots(team.id)
}

export async function removeSlotAction(input: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  slotId: number
}): Promise<TeamSlotView[]> {
  await requireAccess(input.workspaceId, input.teamId)
  await requireSlot(input.slotId, input.teamId)
  // Hand back whatever the departing slot was holding BEFORE deleting it.
  //
  // `team_tasks.owner_slot_id` is ON DELETE SET NULL, so removing a slot
  // leaves its unfinished tasks unowned but still in `claimed`/`in_progress`.
  // That state is a dead end: `claimableTasks` only ever offers `open` or
  // `blocked` rows, and `claimTeamTask`'s guarded UPDATE carries the same
  // condition — so no member could ever pick the task up again, and the human
  // "Claim for…" control on the board would offer a claim that always loses.
  // Releasing to `open` is the only status that puts the work back in play.
  await getBrokerPool().query(
    `UPDATE team_tasks
        SET status = 'open', updated_at = now()
      WHERE team_id = $1
        AND owner_slot_id = $2
        AND status IN ('claimed', 'in_progress')`,
    [input.teamId, input.slotId],
  )
  // The slot's `chat_sessions` row is deliberately left alone: its transcript
  // is history, and `team_messages.from_slot_id` is ON DELETE SET NULL, so
  // deleting the conversation as well would erase what was said with no way to
  // read it back.
  await removeTeamMember(input.slotId)
  revalidatePath(`/workspace/${input.workspaceSlug}/teams/${input.teamId}`)
  return loadSlots(input.teamId)
}

export async function setLeaderAction(input: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  slotId: number | null
}): Promise<void> {
  await requireAccess(input.workspaceId, input.teamId)
  if (input.slotId != null) await requireSlot(input.slotId, input.teamId)
  await setTeamLeader(input.teamId, input.slotId)
  revalidatePath(`/workspace/${input.workspaceSlug}/teams/${input.teamId}`)
}

export async function renameChannelAction(input: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  name: string
  topic: string
}): Promise<Channel> {
  await requireAccess(input.workspaceId, input.teamId)
  const name = input.name.trim().replace(/^#+/, '').trim()
  if (!name) throw new Error('A channel needs a name.')
  try {
    await getBrokerPool().query(`UPDATE teams SET name = $2, topic = $3 WHERE id = $1`, [
      input.teamId,
      name,
      input.topic.trim() || null,
    ])
  } catch (error) {
    if (isDuplicateChannelName(error)) throw new Error(`#${name} already exists — pick another name.`)
    throw error
  }
  revalidatePath(`/workspace/${input.workspaceSlug}/teams`)
  const channel = await getChannel(input.teamId)
  if (!channel) throw new Error('That channel no longer exists.')
  return channel
}

export async function deleteTeamAction(input: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
}): Promise<void> {
  await requireAccess(input.workspaceId, input.teamId)
  await deleteTeam(input.teamId)
  revalidatePath(`/workspace/${input.workspaceSlug}/teams`)
}

// --- The channel feed -------------------------------------------------------

export interface PostMessageResult {
  message: RoomFeedMessage
  /** The slot the message was attributed to, so the composer can stop offering
   * "join to react" the moment somebody's first post creates their slot. */
  mySlotId: number | null
}

/**
 * Posts into the channel.
 *
 * Mentions are parsed HERE, on the server, against the roster the server
 * reads — never taken from the request. A client-supplied mention array would
 * be a way to write `{type:'slot', id:<anyone>}` into an indexed column and
 * light up another member's mention badge from outside the room.
 */
export async function postChannelMessageAction(input: {
  workspaceId: number
  teamId: number
  body: string
  kind?: TeamMessageKind
  toSlotId?: number | null
  threadRootId?: number | null
}): Promise<PostMessageResult> {
  const { user, team } = await requireAccess(input.workspaceId, input.teamId)
  const body = input.body.trim()
  if (!body) throw new Error('Write something first.')

  // Also the dead-letter guard at this end: a slot removed while the compose
  // box was open is refused here rather than accepted into a mailbox that will
  // never be opened.
  if (input.toSlotId != null) await requireSlot(input.toSlotId, input.teamId)
  // `postChannelMessage` re-checks that the root belongs to this channel, so a
  // thread id from another room is refused in the data layer as well as here.

  const [mine, roster] = await Promise.all([resolveMySlot(team.id, user.id), loadSlots(team.id)])
  const message = await postChannelMessage({
    teamId: team.id,
    // `fromSlotId: null` is how somebody with no slot speaks — the column is
    // nullable and, since 0012, a NULL sender with no `system_kind` is
    // unambiguously "a person typed this".
    fromSlotId: mine?.id ?? null,
    toSlotId: input.toSlotId ?? null,
    kind: input.kind ?? 'status',
    body,
    threadRootId: input.threadRootId ?? null,
    mentions: parseMentions(body, roster),
  })

  // Posting is reading: you have seen everything up to your own message.
  if (mine) await markChannelRead(mine.id, message.id).catch(() => undefined)

  // No revalidatePath: the channel appends the returned row locally.
  // Re-rendering the whole room to show a message we already hold is exactly
  // the round trip on a UI action D0 forbids.
  return {
    message: { ...message, systemKind: null, undeliverableAt: null, addresseeMissing: false },
    mySlotId: mine?.id ?? null,
  }
}

/**
 * Adds or removes one reaction, as the caller's own slot.
 *
 * `actorSlotId` is deliberately NOT a parameter. `toggleReaction` writes a row
 * naming a slot, and taking that slot from the browser would let anyone react
 * as anyone. The message is also re-read and checked against this channel: the
 * reactions table has a foreign key to `team_messages` but none to a team, so
 * without this a message id from another workspace's room could be reacted to
 * through a channel the caller can legitimately open.
 */
export async function toggleReactionAction(input: {
  workspaceId: number
  teamId: number
  messageId: number
  emoji: string
}): Promise<{ added: boolean; actorSlotId: number }> {
  const { user, team } = await requireAccess(input.workspaceId, input.teamId)
  const mine = await resolveMySlot(team.id, user.id)
  if (!mine) throw new Error('Join this channel before reacting — a reaction is recorded against a member.')
  const emoji = input.emoji.trim()
  // A short whitelist rather than arbitrary text: `emoji` is a TEXT column with
  // no constraint, and the grouping query would happily aggregate a paragraph.
  if (!emoji || [...emoji].length > 4) throw new Error('That is not an emoji.')
  const message = await getChannelMessage(input.messageId)
  if (!message || message.teamId !== team.id) throw new Error('That message is not in this channel.')
  const { added } = await toggleReaction({ messageId: input.messageId, actorSlotId: mine.id, emoji })
  return { added, actorSlotId: mine.id }
}

/** One thread: its root and every reply, in order. */
export async function loadThreadAction(input: {
  workspaceId: number
  teamId: number
  rootId: number
}): Promise<RoomFeedMessage[]> {
  const { team } = await requireAccess(input.workspaceId, input.teamId)
  const messages = await listThread(input.rootId)
  // `listThread` takes a bare id and knows nothing about teams, so a root from
  // another workspace's channel would otherwise be readable through a channel
  // the caller can open. Refuse the whole thread rather than filtering it: a
  // partially-foreign thread is not a thread.
  if (messages.length === 0 || messages.some((m) => m.teamId !== team.id)) return []
  const room = await listTeamRoomMessages(team.id, { limit: 1000 })
  return mergeReliability(messages, room)
}

/**
 * Moves the caller's read cursor forward.
 *
 * The slot is derived, not supplied — `markChannelRead` takes a bare slot id
 * and would otherwise mark somebody else caught up. `GREATEST` inside it means
 * a late call from a stale tab cannot rewind the mark.
 */
export async function markChannelReadAction(input: {
  workspaceId: number
  teamId: number
  messageId: number
}): Promise<void> {
  const { user, team } = await requireAccess(input.workspaceId, input.teamId)
  const mine = await resolveMySlot(team.id, user.id)
  if (!mine) return
  await markChannelRead(mine.id, input.messageId)
}

// --- The canvas -------------------------------------------------------------

export interface ChannelCanvas {
  pageId: number
  title: string
  docState: unknown
  isLocked: boolean
}

/**
 * The channel's canvas, created on first open.
 *
 * An ordinary `pages` row tagged `linkedSourceType='team'` /
 * `linkedSourceId=<teamId>`, and deliberately NOT a `canvas_page_id` column on
 * `teams`. The tag already buys three things a column would not:
 * `getSidebarPages` excludes any page with a `linkedSourceType`, so canvases
 * never clutter the tree; `PageOriginHeader` already renders "Canvas for
 * #channel" through the branch in `lib/page-origin.ts`; and the editor is
 * `BlockSuiteEditor`, unchanged.
 *
 * Lazy, because most channels never grow a canvas and creating one per channel
 * up front would fill the workspace with empty documents.
 */
export async function ensureChannelCanvasAction(input: {
  workspaceId: number
  teamId: number
}): Promise<ChannelCanvas> {
  const { team } = await requireAccess(input.workspaceId, input.teamId)
  const payload = await getPayloadClient()

  const existing = await payload.find({
    collection: 'pages',
    where: {
      and: [
        { workspace: { equals: input.workspaceId } },
        { linkedSourceType: { equals: 'team' } },
        { linkedSourceId: { equals: String(team.id) } },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })

  const page =
    existing.docs[0] ??
    (await payload
      .create({
        collection: 'pages',
        data: {
          title: `Canvas for #${team.name}`,
          workspace: input.workspaceId,
          linkedSourceType: 'team',
          linkedSourceId: String(team.id),
        },
        overrideAccess: true,
      })
      .catch((error: unknown) => {
        // Reported as itself instead of being swallowed into an empty pane.
        //
        // `linkedSourceType` is a Payload `select` AND a postgres enum, so
        // 'team' had to be added in two places: the options in
        // `collections/Pages.ts` and `enum_pages_linked_source_type` (see
        // `migrations/20260904_page_linked_source_team.sql`). Both are in
        // place; if this ever fails with an invalid-enum-value error, that
        // migration has not been applied to the database being talked to.
        throw new Error(
          `The channel canvas could not be created: ${error instanceof Error ? error.message : String(error)}`,
        )
      }))

  return {
    pageId: page.id,
    title: page.title,
    docState: page.docState,
    isLocked: !!page.isLocked,
  }
}

// --- Polling ----------------------------------------------------------------

export interface TeamRoomDelta {
  /** Everything, replies included, for the Lanes view's mailbox buckets. */
  messages: TeamRoomMessage[]
  /**
   * A window of channel ROOTS, refreshed rather than appended.
   *
   * A reaction or a reply does not create a new root, so a strictly
   * append-only cursor would never show either one arriving. The client sends
   * the id just below its oldest cached root instead, so this returns that
   * bounded window with current reaction and reply counts, and any new rows
   * after it, in the same query.
   */
  feed: RoomFeedMessage[]
  /** Present only when the client says a thread pane is open. */
  thread: RoomFeedMessage[] | null
  tasks: TeamTask[]
  claimableIds: number[]
  /** R6.6 — one entry per slot, so the roster and the lanes can show which
   * members are actually alive instead of all looking identical. */
  health: TeamSlotHealth[]
  stop: TeamStopState
  /** Slots this poll's sweep declared lost, so the room can say it out loud at
   * the moment it happens rather than leaving it to be noticed. */
  lostSlotIds: number[]
  releasedTaskIds: number[]
}

/**
 * What changed in the room since the client's cursors.
 *
 * This is a cursor poll and it is not what we want. The right answer is an SSE
 * channel per room, the way `app/api/runs/[id]/events/stream` pushes run
 * events through `lib/broker/live-bus.ts` (Postgres LISTEN/NOTIFY) — but
 * nothing publishes a `team_message` event yet, so there is nothing to
 * subscribe to. The replacement is a `publishTeamMessage` alongside
 * `publishRunEvent`, fired from `postChannelMessage` and from the team MCP
 * surface, and a stream route this component subscribes to instead of ticking.
 *
 * Until then it is kept cheap and BOUNDED: the feed window is whatever the
 * client asks to refresh (a few dozen roots), the mailbox read is a range scan
 * on `(team_id, id)` that returns zero rows while the room is idle, and the
 * whole thing is gated on `document.visibilityState` by the caller.
 */
export async function pollTeamRoomAction(input: {
  workspaceId: number
  teamId: number
  sinceMessageId: number
  /** Refresh roots with an id greater than this. The client sends the id just
   * below its oldest cached root, so the window it gets back is the window it
   * is actually showing. */
  feedSince: number
  threadRootId?: number | null
}): Promise<TeamRoomDelta> {
  const { team } = await requireAccess(input.workspaceId, input.teamId)

  // R6.6 — the sweep runs FIRST and is awaited, not fired alongside the reads.
  // If it hands a task back to the board, the very same poll must return the
  // released task and the announcement it wrote; running them in parallel
  // would show the room a board one tick out of date with the message
  // explaining it, which is the specific kind of disagreement that makes
  // people distrust the feed.
  //
  // This is also, today, the ONLY thing that runs the sweep — see the closing
  // note in `lib/teams/reliability.ts`. A room nobody has open detects nothing.
  const sweep = await sweepTeamSlots(team.id)

  const [messages, feedRoots, tasks, claimable, stop, threadRows] = await Promise.all([
    listTeamRoomMessages(team.id, { since: input.sinceMessageId, limit: 200 }),
    listChannelFeed(team.id, { since: input.feedSince, limit: 200 }),
    listTeamTasks(team.id),
    claimableTasks(team.id),
    readTeamStopState(team.id),
    input.threadRootId ? listThread(input.threadRootId) : Promise.resolve(null),
  ])

  // The reliability columns for the window, read once from the same rows the
  // Lanes view already needed. `since` is the older of the two cursors so a
  // refreshed root can still find its own extras.
  const reliabilityWindow =
    input.feedSince < input.sinceMessageId
      ? await listTeamRoomMessages(team.id, { since: input.feedSince, limit: 400 })
      : messages

  return {
    messages,
    feed: mergeReliability(feedRoots, reliabilityWindow),
    thread:
      threadRows && threadRows.length > 0 && threadRows.every((m) => m.teamId === team.id)
        ? mergeReliability(threadRows, reliabilityWindow)
        : threadRows
          ? []
          : null,
    tasks,
    claimableIds: claimable.map((t) => t.id),
    health: sweep.health,
    stop,
    lostSlotIds: sweep.lostSlotIds,
    releasedTaskIds: sweep.releasedTaskIds,
  }
}

// --- Stopping the room ------------------------------------------------------

export interface RoomStopResult {
  /** Runs that accepted the stop. */
  stopped: number[]
  /** Runs that had already settled between the read and the request — reported
   * rather than counted, so the UI never claims to have stopped something that
   * had already finished. */
  alreadySettled: number[]
}

/**
 * Stops every member turn in the room, cooperatively.
 *
 * Reuses the one cancellation mechanism this app has: `requestRunCancel`,
 * which writes `runs.cancel_requested_at` (migration 0010) and, when the turn
 * happens to be executing in this very process, calls the runtime's own
 * `session/cancel` so it lands in milliseconds instead of at the next poll.
 * There is deliberately no team-level cancel flag — a second path would have
 * to be learned by the worker, and it would fail exactly the way the
 * pre-0010 in-process Map failed: unread by whichever process is holding the
 * turn.
 *
 * Cooperative, and the difference matters: everything already streamed is
 * kept, the run settles as `cancelled` through the normal path, and tasks stay
 * assigned. A member that then goes silent for good is the sweep's problem,
 * not this action's.
 */
export async function stopTeamRoomAction(input: {
  workspaceId: number
  teamId: number
}): Promise<RoomStopResult> {
  const { user, team } = await requireAccess(input.workspaceId, input.teamId)

  // Scoped by team, and the ids come from the database rather than the client.
  // A run id off the wire would be a way to stop any run in the installation.
  const inFlight = await listTeamRunsInFlight(team.id)

  // In parallel: these are independent runs, and stopping five members one
  // after another would let the last one keep working while the first is
  // already dead — the whole point of a ROOM-wide stop is that it is one event.
  const results = await Promise.all(
    inFlight.map(async (run) => ({ run, ...(await requestRunCancel(run.runId).catch(() => ({ cancelled: false }))) })),
  )
  const stopped = results.filter((r) => r.cancelled).map((r) => r.run.runId)
  const alreadySettled = results.filter((r) => !r.cancelled).map((r) => r.run.runId)

  await recordTeamStopRequest({ teamId: team.id, requestedBy: user.id, runIds: stopped })
  return { stopped, alreadySettled }
}

/** Clears the stop mark. A person decides the room is running again — nothing
 * infers it, because "a new run appeared" is also what a stray retry looks
 * like, and silently un-stopping a room somebody paused is worse than a banner
 * that outstays its welcome. */
export async function clearTeamStopAction(input: { workspaceId: number; teamId: number }): Promise<void> {
  await requireAccess(input.workspaceId, input.teamId)
  await clearTeamStopRequest(input.teamId)
}

/** Undeliverable mail, newest first — the dead-letter queue R6.6 asks for,
 * read on demand rather than shipped with every poll because it changes only
 * when somebody removes a slot. */
export async function listTeamDeadLettersAction(input: {
  workspaceId: number
  teamId: number
}): Promise<TeamRoomMessage[]> {
  await requireAccess(input.workspaceId, input.teamId)
  return listTeamDeadLetters(input.teamId)
}

// --- The board --------------------------------------------------------------

export async function createTeamTaskAction(input: {
  workspaceId: number
  teamId: number
  subject: string
  description?: string
  ownerSlotId: number | null
  blockedBy: number[]
}): Promise<TeamTask> {
  await requireAccess(input.workspaceId, input.teamId)
  const subject = input.subject.trim()
  if (!subject) throw new Error('A task needs a subject.')
  if (input.ownerSlotId != null) await requireSlot(input.ownerSlotId, input.teamId)
  // Every blocker is re-checked against this team. `team_task_deps` has a
  // foreign key to `team_tasks` but not to a team, so without this a task
  // could be blocked by another team's task and the claimability query would
  // hold it hostage to work this room cannot even see.
  for (const blocker of input.blockedBy) await requireTask(blocker, input.teamId)
  return createTeamTask({
    teamId: input.teamId,
    subject,
    description: input.description?.trim() || null,
    ownerSlotId: input.ownerSlotId,
    blockedBy: input.blockedBy,
  })
}

export async function claimTeamTaskAction(input: {
  workspaceId: number
  teamId: number
  taskId: number
  slotId: number
}): Promise<TeamTask> {
  await requireAccess(input.workspaceId, input.teamId)
  await requireTask(input.taskId, input.teamId)
  await requireSlot(input.slotId, input.teamId)
  const task = await claimTeamTask(input.taskId, input.slotId)
  // Null means the guarded UPDATE matched nothing — somebody else claimed it
  // first, or its dependencies came back. Say so plainly rather than silently
  // leaving the stale row on screen.
  if (!task) throw new Error('Somebody claimed that task first — refresh the board.')
  return task
}

export async function setTeamTaskStatusAction(input: {
  workspaceId: number
  teamId: number
  taskId: number
  status: TeamTaskStatus
}): Promise<TeamTask> {
  await requireAccess(input.workspaceId, input.teamId)
  await requireTask(input.taskId, input.teamId)
  await updateTeamTaskStatus(input.taskId, input.status)
  const task = await getTeamTask(input.taskId)
  if (!task) throw new Error('That task no longer exists.')
  return task
}

export interface ReportDoneActionResult {
  task: TeamTask
  /** What the board released as a consequence, so the UI can say what this
   * unblocked at the moment it happens rather than on the next poll. */
  releasedIds: number[]
  tasks: TeamTask[]
}

export async function reportTeamTaskDoneAction(input: {
  workspaceId: number
  teamId: number
  taskId: number
  slotId: number | null
  summary: string
}): Promise<ReportDoneActionResult> {
  await requireAccess(input.workspaceId, input.teamId)
  await requireTask(input.taskId, input.teamId)
  if (input.slotId != null) await requireSlot(input.slotId, input.teamId)
  const summary = input.summary.trim()
  if (!summary) throw new Error('Say what the task produced.')
  const result = await reportTeamTaskDone({ taskId: input.taskId, slotId: input.slotId, summary })
  if (!result.task) throw new Error('That task no longer exists.')
  // Re-read the whole board rather than patching one row locally: settling a
  // task also flips every dependent that is now unblocked, in the same
  // transaction, so a local patch would leave the other columns lying.
  const tasks = await listTeamTasks(input.teamId)
  return { task: result.task, releasedIds: result.released.map((t) => t.id), tasks }
}
