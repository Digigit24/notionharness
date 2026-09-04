'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import {
  addTeamMember,
  claimTeamTask,
  claimableTasks,
  createSession,
  createTeam,
  createTeamTask,
  deleteTeam,
  getBrokerPool,
  getTeam,
  getTeamMember,
  getTeamTask,
  listTeamMembers,
  listTeamTasks,
  removeTeamMember,
  reportTeamTaskDone,
  sendTeamMessage,
  setTeamLeader,
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
import { slotColourFor } from '@/components/teams/shared'

/**
 * Server actions for the Teams section (R6.4).
 *
 * Everything here is a thin, guarded wrapper over `lib/broker/teams.ts`, which
 * is the whole data layer. Nothing in this file computes a number the database
 * did not answer: where a figure cannot be asked for honestly it is not shown
 * at all (see the presence note in `components/teams/lanes-view.tsx`).
 *
 * Two guards run on every entry point, because a server action is a public
 * endpoint: you must be logged in, and the team you name must belong to the
 * workspace you claim to be acting in. Without the second, a team id from one
 * workspace addresses another workspace's room.
 */

async function requireUser() {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')
  return user
}

async function requireTeam(teamId: number, workspaceId: number): Promise<Team> {
  const team = await getTeam(teamId)
  if (!team) throw new Error('That team no longer exists.')
  if (team.workspaceId !== workspaceId) throw new Error('That team belongs to another workspace.')
  return team
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

async function requireTask(taskId: number, teamId: number): Promise<TeamTask> {
  const task = await getTeamTask(taskId)
  if (!task) throw new Error('That task no longer exists.')
  if (task.teamId !== teamId) throw new Error('That task belongs to another team.')
  return task
}

// --- The list page ----------------------------------------------------------

export interface TeamSummary extends Team {
  memberCount: number
  /**
   * Messages nobody has opened the room to read yet — what makes a row bold.
   *
   * `team_messages.read_at` is ONE column for the whole install, not a per
   * person cursor, so this really answers "has anybody looked at this room",
   * not "have you". With a second human in the workspace it reads wrong.
   * Fixing it needs a per-user read cursor, i.e. a migration under
   * `lib/broker/migrations/`, which this unit does not own — so the limit is
   * recorded here rather than papered over.
   */
  unreadCount: number
  openTaskCount: number
  lastMessageAt: string | null
}

/**
 * Every room in the workspace plus the four numbers a channel list needs.
 *
 * One round trip, not one per team. The counters are scalar subqueries rather
 * than joins with GROUP BY on purpose: joining `team_members`, `team_messages`
 * and `team_tasks` in one FROM multiplies the rows together and every count
 * comes back inflated. There is no rollup helper for teams in `lib/broker` and
 * `lib/broker/teams.ts` belongs to another unit, so the aggregate lives here —
 * the same shape, and the same D0 reasoning, as the one on the Projects list.
 */
export async function listTeamSummaries(workspaceId: number): Promise<TeamSummary[]> {
  await requireUser()
  const pool = getBrokerPool()
  const { rows } = await pool.query<{
    id: string
    workspace_id: string
    name: string
    description: string | null
    workspace_mode: TeamWorkspaceMode
    created_by: string | null
    created_at: Date
    member_count: string
    unread_count: string
    open_task_count: string
    last_message_at: Date | null
  }>(
    `SELECT t.id, t.workspace_id, t.name, t.description, t.workspace_mode, t.created_by, t.created_at,
            (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS member_count,
            (SELECT COUNT(*) FROM team_messages g WHERE g.team_id = t.id AND g.read_at IS NULL) AS unread_count,
            (SELECT COUNT(*) FROM team_tasks k WHERE k.team_id = t.id AND k.status NOT IN ('done', 'cancelled')) AS open_task_count,
            (SELECT MAX(g.created_at) FROM team_messages g WHERE g.team_id = t.id) AS last_message_at
       FROM teams t
      WHERE t.workspace_id = $1
      ORDER BY t.name`,
    [workspaceId],
  )
  return rows.map((row) => ({
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    name: row.name,
    description: row.description,
    workspaceMode: row.workspace_mode,
    createdBy: row.created_by == null ? null : Number(row.created_by),
    createdAt: new Date(row.created_at).toISOString(),
    memberCount: Number(row.member_count),
    unreadCount: Number(row.unread_count),
    openTaskCount: Number(row.open_task_count),
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
  }))
}

// --- Creating a team and filling its slots ----------------------------------

/**
 * Binds a slot to its own conversation.
 *
 * R6.1's central decision is that a member is a slot bound to an ordinary
 * `chat_sessions` row, so streaming, tool cards, approvals and resume all work
 * inside a team with no second code path. That only holds if the row exists,
 * so it is created here rather than lazily on first message — a slot with no
 * session is a lane that cannot be opened.
 */
async function createSlot(input: {
  team: Team
  agentId: number
  displayName: string
  index: number
  userId: number | null
}): Promise<TeamMember> {
  const session = await createSession({
    workspaceId: input.team.workspaceId,
    agentId: input.agentId,
    title: `${input.team.name} — ${input.displayName}`,
    createdBy: input.userId,
  })
  return addTeamMember({
    teamId: input.team.id,
    agentId: input.agentId,
    displayName: input.displayName,
    // Colour is server state, deliberately. AionUi keeps member colour in
    // localStorage, which is why their team looks different on every machine;
    // stored here the room is the same everywhere and survives a restart.
    colour: slotColourFor(input.index),
    sessionId: session.id,
  })
}

export async function createTeamAction(input: {
  workspaceId: number
  workspaceSlug: string
  name: string
  description?: string
  workspaceMode: TeamWorkspaceMode
  /** Slots in roster order. Two entries may name the SAME agent — that is the
   * point of a slot, and the UI must not collapse them (R6.1). */
  slots: Array<{ agentId: number; displayName: string }>
  /** An index into `slots`, not an agent id, precisely because the same agent
   * can appear twice and "which agent leads" would then be ambiguous. */
  leaderIndex: number | null
}): Promise<{ teamId: number }> {
  const user = await requireUser()
  const name = input.name.trim()
  if (!name) throw new Error('A team needs a name.')

  // Checked before the team row exists, so a bad agent id fails cleanly
  // instead of leaving an empty team behind. `Set` because a roster naming the
  // same agent twice is legitimate and must not cost two lookups.
  for (const agentId of new Set(input.slots.map((s) => s.agentId))) {
    await requireAgent(agentId, input.workspaceId)
  }

  // Sequential, not Promise.all: `createSlot` writes two rows through two
  // broker calls and there is no transaction spanning both from out here
  // (opening one would mean editing `lib/broker/teams.ts`, which this unit
  // does not own). Sequential at least fails at a known point — the team and
  // the slots created so far survive and the roster panel can finish the job —
  // instead of leaving an unpredictable subset behind.
  const team = await createTeam({
    workspaceId: input.workspaceId,
    name,
    description: input.description?.trim() || null,
    workspaceMode: input.workspaceMode,
    createdBy: user.id,
  })

  const created: TeamMember[] = []
  for (const [index, slot] of input.slots.entries()) {
    created.push(
      await createSlot({
        team,
        agentId: slot.agentId,
        displayName: slot.displayName.trim() || `Slot ${index + 1}`,
        index,
        userId: user.id,
      }),
    )
  }

  if (input.leaderIndex != null && created[input.leaderIndex]) {
    await setTeamLeader(team.id, created[input.leaderIndex].id)
  }

  revalidatePath(`/workspace/${input.workspaceSlug}/teams`)
  return { teamId: team.id }
}

export async function addSlotAction(input: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  agentId: number
  displayName: string
}): Promise<TeamMember> {
  const user = await requireUser()
  const team = await requireTeam(input.teamId, input.workspaceId)
  await requireAgent(input.agentId, input.workspaceId)
  const existing = await listTeamMembers(team.id)
  const slot = await createSlot({
    team,
    agentId: input.agentId,
    displayName: input.displayName.trim() || 'New slot',
    // Colour follows roster size, so a second slot for the same agent gets a
    // different colour and the two are told apart at a glance.
    index: existing.length,
    userId: user.id,
  })
  revalidatePath(`/workspace/${input.workspaceSlug}/teams/${team.id}`)
  return slot
}

export async function removeSlotAction(input: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  slotId: number
}): Promise<void> {
  await requireUser()
  await requireTeam(input.teamId, input.workspaceId)
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
}

export async function setLeaderAction(input: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  slotId: number | null
}): Promise<void> {
  await requireUser()
  await requireTeam(input.teamId, input.workspaceId)
  if (input.slotId != null) await requireSlot(input.slotId, input.teamId)
  await setTeamLeader(input.teamId, input.slotId)
  revalidatePath(`/workspace/${input.workspaceSlug}/teams/${input.teamId}`)
}

export async function deleteTeamAction(input: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
}): Promise<void> {
  await requireUser()
  await requireTeam(input.teamId, input.workspaceId)
  await deleteTeam(input.teamId)
  revalidatePath(`/workspace/${input.workspaceSlug}/teams`)
}

// --- The channel ------------------------------------------------------------

export async function postTeamMessageAction(input: {
  workspaceId: number
  teamId: number
  body: string
  kind: TeamMessageKind
  toSlotId: number | null
}): Promise<TeamRoomMessage> {
  await requireUser()
  await requireTeam(input.teamId, input.workspaceId)
  // Also the dead-letter guard at this end: a slot removed while the compose
  // box was open is refused here rather than accepted into a mailbox that will
  // never be opened.
  if (input.toSlotId != null) await requireSlot(input.toSlotId, input.teamId)
  const body = input.body.trim()
  if (!body) throw new Error('Write something first.')
  // `fromSlotId: null` is how the human speaks — the column is nullable and no
  // slot represents the person.
  //
  // R6.6 closed most of the ambiguity that used to sit here. A departed
  // member's messages KEEP their `from_slot_id` now (migration 0012 dropped the
  // ON DELETE SET NULL), and rows the room writes itself carry a `system_kind`,
  // so "the human said it" is finally its own case: NULL sender, no system
  // kind. What survives is history — rows already NULLed by deletions that
  // happened before that migration, whose sender id was destroyed and cannot
  // be recovered.
  const message = await sendTeamMessage({
    teamId: input.teamId,
    fromSlotId: null,
    toSlotId: input.toSlotId,
    kind: input.kind,
    body,
  })
  // No revalidatePath: the channel appends the returned row locally.
  // Re-rendering the whole room to show a message we already hold is exactly
  // the round trip on a UI action D0 forbids.
  return {
    ...message,
    systemKind: null,
    undeliverableAt: null,
    undeliverableReason: null,
    // The recipient was re-read against this team one statement ago.
    addresseeMissing: false,
  }
}

export interface TeamRoomDelta {
  messages: TeamRoomMessage[]
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
 * What changed in the room since `sinceMessageId`.
 *
 * This is a cursor poll and it is not what we want. The right answer is an SSE
 * channel per room, the way `app/api/runs/[id]/events/stream` pushes run
 * events — but nothing publishes team message events yet (R6.2's MCP surface
 * is what would write them), so there is nothing to subscribe to. A poll over
 * an existing push would violate D0; a poll where no push exists is the honest
 * option, and it is kept cheap: the message query is a range scan on the
 * (team_id, id) index that returns zero rows while the room is idle.
 */
export async function pollTeamRoomAction(input: {
  workspaceId: number
  teamId: number
  sinceMessageId: number
}): Promise<TeamRoomDelta> {
  await requireUser()
  await requireTeam(input.teamId, input.workspaceId)

  // R6.6 — the sweep runs FIRST and is awaited, not fired alongside the reads.
  // If it hands a task back to the board, the very same poll must return the
  // released task and the announcement it wrote; running them in parallel
  // would show the room a board one tick out of date with the message
  // explaining it, which is the specific kind of disagreement that makes
  // people distrust the feed.
  //
  // This is also, today, the ONLY thing that runs the sweep — see the closing
  // note in `lib/teams/reliability.ts`. A room nobody has open detects nothing.
  const sweep = await sweepTeamSlots(input.teamId)

  const [messages, tasks, claimable, stop] = await Promise.all([
    listTeamRoomMessages(input.teamId, { since: input.sinceMessageId, limit: 200 }),
    listTeamTasks(input.teamId),
    claimableTasks(input.teamId),
    readTeamStopState(input.teamId),
  ])
  return {
    messages,
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
  const user = await requireUser()
  await requireTeam(input.teamId, input.workspaceId)

  // Scoped by team, and the ids come from the database rather than the client.
  // A run id off the wire would be a way to stop any run in the installation.
  const inFlight = await listTeamRunsInFlight(input.teamId)

  // In parallel: these are independent runs, and stopping five members one
  // after another would let the last one keep working while the first is
  // already dead — the whole point of a ROOM-wide stop is that it is one event.
  const results = await Promise.all(
    inFlight.map(async (run) => ({ run, ...(await requestRunCancel(run.runId).catch(() => ({ cancelled: false }))) })),
  )
  const stopped = results.filter((r) => r.cancelled).map((r) => r.run.runId)
  const alreadySettled = results.filter((r) => !r.cancelled).map((r) => r.run.runId)

  await recordTeamStopRequest({ teamId: input.teamId, requestedBy: user.id, runIds: stopped })
  return { stopped, alreadySettled }
}

/** Clears the stop mark. A person decides the room is running again — nothing
 * infers it, because "a new run appeared" is also what a stray retry looks
 * like, and silently un-stopping a room somebody paused is worse than a banner
 * that outstays its welcome. */
export async function clearTeamStopAction(input: { workspaceId: number; teamId: number }): Promise<void> {
  await requireUser()
  await requireTeam(input.teamId, input.workspaceId)
  await clearTeamStopRequest(input.teamId)
}

/** Undeliverable mail, newest first — the dead-letter queue R6.6 asks for,
 * read on demand rather than shipped with every poll because it changes only
 * when somebody removes a slot. */
export async function listTeamDeadLettersAction(input: {
  workspaceId: number
  teamId: number
}): Promise<TeamRoomMessage[]> {
  await requireUser()
  await requireTeam(input.teamId, input.workspaceId)
  return listTeamDeadLetters(input.teamId)
}

export async function markRoomReadAction(input: {
  workspaceId: number
  teamId: number
  messageIds: number[]
}): Promise<void> {
  await requireUser()
  await requireTeam(input.teamId, input.workspaceId)
  if (input.messageIds.length === 0) return
  // Scoped by team_id, not just by id. `markTeamMessagesRead` takes a bare id
  // list, so passing the client's array straight through would let a logged-in
  // caller clear the unread flags on any room in the install — including rooms
  // in workspaces they cannot open — by naming a team they CAN see and ids
  // they cannot. The workspace guard above only proves the team is theirs; it
  // says nothing about the ids.
  await getBrokerPool().query(
    `UPDATE team_messages SET read_at = now()
      WHERE team_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL`,
    [input.teamId, input.messageIds],
  )
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
  await requireUser()
  await requireTeam(input.teamId, input.workspaceId)
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
  await requireUser()
  await requireTeam(input.teamId, input.workspaceId)
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
  await requireUser()
  await requireTeam(input.teamId, input.workspaceId)
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
  await requireUser()
  await requireTeam(input.teamId, input.workspaceId)
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
