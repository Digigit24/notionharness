// R6.2 — the team tools themselves, kept out of the route.
//
// The route's job is authentication and MCP plumbing; this file's job is
// "what may this slot actually do, and to which rows". They are separated
// because the authorisation rules here are the interesting part and they must
// be readable on their own — and because `scripts/` or a future server action
// can exercise them without going through HTTP.
//
// **Two things the broker layer deliberately does not do, which therefore have
// to happen here.**
//
//  1. `lib/broker/teams.ts` is team-agnostic below the surface: `claimTeamTask`,
//     `updateTeamTaskStatus` and `reportTeamTaskDone` take a bare task id and
//     never ask which team it belongs to. Task ids are a single global
//     sequence, so an agent that guesses an id could otherwise settle another
//     team's task. Every tool below re-reads the task and checks its `teamId`
//     against the caller's before touching it. That is one extra SELECT on the
//     write path, and it is not negotiable: the alternative is a cross-team
//     write with no audit trail.
//  2. It has no notion of a caller. Roles live in `team_members.role`, so the
//     permission rules the roadmap asks for (R6.2: "a member can read the
//     board but not close tasks, and a leader can be the only slot permitted
//     to assign") are enforced here, server-side, on the resolved slot — never
//     on anything the caller sent us.
//
// **R6.6 added a third thing this layer has to do: make every call safe to
// repeat.** An agent retries — on a transport error after the write committed,
// on a timeout it cannot distinguish from a failure, and because a model
// decided to. Before this, a retried `team_report_done` was refused with an
// error the first call never produced, and a retried `team_claim_task` was
// told somebody else had taken it when "somebody else" was itself. Every
// mutating tool below is now wrapped in `runTeamToolOnce`, keyed by slot, tool
// and task exactly as R6.6 asks, and a retry replays the first call's answer
// verbatim instead of running a second effect. The wrapper is OUTSIDE the
// permission checks on purpose: a refused call deletes its own reservation, so
// being told "only the leader may assign" never poisons a later, legitimate
// attempt.
import {
  claimTeamTask,
  createTeamTask,
  getTeamMember,
  getTeamTask,
  listTeamTasks,
  markTeamMessagesRead,
  readTeamInbox,
  reportTeamTaskDone,
  sendTeamMessage,
  updateTeamTaskStatus,
  type TeamMessageKind,
  type TeamRole,
  type TeamTask,
  type TeamTaskStatus,
} from '@/lib/broker/teams'
import { runTeamToolOnce, touchAndReadTeamSlot } from './reliability'

/** How long an identical call counts as a retry rather than a repeat, for the
 * two tools where an identical repeat is legitimate.
 *
 * A member can move a task to `in_progress`, be blocked, and move it back; it
 * can send the same one-line status twice in an afternoon. Neither is a
 * mistake, so those two are deduplicated within a window instead of forever.
 * Every irreversible call — creating a task, claiming one, reporting one done
 * — passes no window and is deduplicated permanently. */
const STATUS_REPEAT_WINDOW_MS = 60_000
const MESSAGE_REPEAT_WINDOW_MS = 10 * 60_000

/** The authenticated identity behind one MCP request: a slot, not an agent.
 * The same agent can hold two slots in one team with different jobs, so every
 * decision below keys on `slotId`. */
export interface TeamCaller {
  teamId: number
  slotId: number
  role: TeamRole
  displayName: string
  agentId: number
  runId: number
}

/**
 * A tool call the caller is not allowed to make.
 *
 * A distinct class so the route can render it as an MCP *tool* error the agent
 * reads and adapts to, rather than an HTTP failure that looks like the server
 * is broken. Being told "only the leader may assign" is information the model
 * can act on; a 403 with no body is not.
 */
export class TeamPermissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamPermissionError'
  }
}

export type TeamCallerResolution =
  | { ok: true; caller: TeamCaller }
  | { ok: false; status: number; message: string }

/**
 * Turns an authenticated run plus a claimed slot id into a caller, or refuses.
 *
 * The run token has already proven "you are run N" before this is reached
 * (see the route). This proves the second half: that run N is entitled to act
 * as slot S. Without it, any valid run token would be a key to every team in
 * the installation, since slot ids are guessable small integers.
 *
 * One SELECT, not two: `team_members.team_id` is `NOT NULL REFERENCES
 * teams(id) ON DELETE CASCADE` (migration 0009), so a slot row that exists is
 * proof that its team exists. Re-reading `teams` would add a round trip on
 * every single tool call to re-derive a fact the schema already guarantees.
 */
export async function resolveTeamCaller(input: {
  slotId: number
  runId: number
  runAgentId: number | null
  runSessionId: number | null
}): Promise<TeamCallerResolution> {
  // R6.6 — this read is also the slot's HEARTBEAT, folded into the same
  // statement so it costs nothing extra on the tool path (see
  // `touchAndReadTeamSlot`). A tool call is the strongest evidence a slot is
  // alive, and the agent check below is applied inside the same UPDATE, so a
  // caller that fails it cannot make a slot look alive by knocking on it.
  const { slot } = await touchAndReadTeamSlot(input.slotId, input.runAgentId).catch(() => ({
    slot: null,
    heartbeat: false,
  }))
  if (!slot) return { ok: false, status: 401, message: 'Unauthorized: unknown team slot.' }

  // The run's agent must be the agent this slot is filled by. A run token
  // authorises the run, and the run belongs to an agent; presenting it
  // alongside somebody else's slot is exactly the escalation this blocks.
  if (input.runAgentId == null || slot.agentId !== input.runAgentId) {
    return {
      ok: false,
      status: 403,
      message: `Forbidden: this run's agent does not fill team slot ${input.slotId}.`,
    }
  }

  // Tightening, where the data allows it: because one agent may hold two slots
  // in the same team, the agent check above cannot by itself distinguish those
  // two slots. When both the slot and the run are bound to a chat session we
  // can, so we do.
  //
  // HONEST GAP: when either side has no session binding — a run dispatched
  // outside a team thread, or a slot whose session has not been created yet —
  // two slots of the same agent remain indistinguishable to this endpoint, and
  // such a run may act as either of them. Closing that needs a slot id
  // recorded on the run at dispatch time (a `runs` column or `runtime_config`
  // key), which belongs to the dispatcher unit, not here.
  if (input.runSessionId != null && slot.sessionId != null && slot.sessionId !== input.runSessionId) {
    return {
      ok: false,
      status: 403,
      message: `Forbidden: team slot ${input.slotId} is bound to a different conversation than this run.`,
    }
  }

  return {
    ok: true,
    caller: {
      teamId: slot.teamId,
      slotId: slot.id,
      role: slot.role,
      displayName: slot.displayName,
      agentId: slot.agentId,
      runId: input.runId,
    },
  }
}

function requireLeader(caller: TeamCaller, action: string): void {
  if (caller.role !== 'leader') {
    throw new TeamPermissionError(
      `Only the team leader may ${action}. You are slot ${caller.slotId} ("${caller.displayName}"), a member. ` +
        `Send a message to the leader asking for it instead.`,
    )
  }
}

/** Re-reads a task and refuses it if it is not this caller's team's.
 * See the file header: the broker layer will happily mutate any task id. */
async function requireOwnTeamTask(caller: TeamCaller, taskId: number): Promise<TeamTask> {
  const task = await getTeamTask(taskId)
  // Deliberately the same message for "does not exist" and "belongs to another
  // team": telling a caller which ids exist elsewhere is a free enumeration of
  // every other team's board.
  if (!task || task.teamId !== caller.teamId) {
    throw new TeamPermissionError(`Task ${taskId} is not on your team's board.`)
  }
  return task
}

function summariseTask(task: TeamTask) {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    owner: task.ownerSlotId,
    blockedBy: task.blockedBy,
    result: task.result,
  }
}

// --- Messaging --------------------------------------------------------------

/**
 * `team_send_message(to?, kind, body, task?)`. Omitting `to` broadcasts.
 *
 * 'instruction' is leader-only. That is the one kind that reads as an order on
 * the receiving side, and a room where any member can issue orders has no
 * leader at all — the role would be decoration.
 */
export async function teamSendMessage(
  caller: TeamCaller,
  input: { to?: number | null; kind: TeamMessageKind; body: string; task?: number | null },
): Promise<string> {
  return runTeamToolOnce(
    {
      teamId: caller.teamId,
      slotId: caller.slotId,
      tool: 'team_send_message',
      taskId: input.task ?? null,
      args: { to: input.to ?? null, kind: input.kind, body: input.body },
      repeatWindowMs: MESSAGE_REPEAT_WINDOW_MS,
    },
    async () => {
      if (input.kind === 'instruction') requireLeader(caller, "send 'instruction' messages")

      if (input.to != null) {
        const recipient = await getTeamMember(input.to).catch(() => null)
        // This is also the dead-letter guard at the sending end (R6.6). A slot
        // removed since the sender last read the roster is refused here, with
        // the roster's own answer, rather than accepted into a mailbox nobody
        // will ever open. Messages that were already in flight when the slot
        // went are handled at the other end, by the trigger in migration 0012.
        if (!recipient || recipient.teamId !== caller.teamId) {
          throw new TeamPermissionError(
            `Slot ${input.to} is not a member of your team — it may have been removed. ` +
              `Nothing was sent. Read the roster before addressing it again.`,
          )
        }
      }
      // A referenced task must be ours too — otherwise a message is a way to
      // smuggle another team's task id into this team's feed, where the UI will
      // render it as a link.
      if (input.task != null) await requireOwnTeamTask(caller, input.task)

      const message = await sendTeamMessage({
        teamId: caller.teamId,
        fromSlotId: caller.slotId,
        toSlotId: input.to ?? null,
        kind: input.kind,
        body: input.body,
        taskId: input.task ?? null,
      })
      return `Sent message ${message.id} (${message.kind}) ${input.to == null ? 'to the whole team' : `to slot ${input.to}`}.`
    },
  )
}

/**
 * `team_read_inbox(since?)` — everything addressed to this slot plus every
 * broadcast, after the cursor.
 *
 * The cursor is a **message id, not a timestamp**, and the returned `cursor`
 * is what the next call should pass. Two messages can share a millisecond;
 * ids cannot, so this can neither skip nor repeat a message. (The broker
 * docstring makes the same point — it is restated in the tool description the
 * model sees, because the model is the one choosing the argument.)
 */
export async function teamReadInbox(
  caller: TeamCaller,
  input: { since?: number; limit?: number },
): Promise<string> {
  // No idempotency record: a cursor read is already idempotent, and the only
  // write it makes (`read_at`) is guarded by `read_at IS NULL`, so a retry
  // cannot change an answer or a timestamp.
  //
  // R6.6's dead-letter fix lives underneath this call rather than in it.
  // `readTeamInbox`'s broadcast branch is `to_slot_id IS NULL`; migration 0012
  // dropped the `ON DELETE SET NULL` that turned a removed addressee's private
  // mail into exactly that, so a message to a slot that no longer exists now
  // matches NEITHER branch and reaches nobody. It is marked undeliverable and
  // announced once in the room instead.
  const messages = await readTeamInbox({
    teamId: caller.teamId,
    slotId: caller.slotId,
    since: input.since ?? 0,
    limit: input.limit,
  })

  // Mark only *directed* messages read. `read_at` is one column on the message,
  // not one per recipient, so flagging a broadcast because this slot polled
  // would tell the channel view (R6.4) that everybody has seen it. Under-
  // reporting reads is recoverable; claiming a message was read by people who
  // never saw it is not.
  const directed = messages.filter((m) => m.toSlotId === caller.slotId).map((m) => m.id)
  if (directed.length > 0) await markTeamMessagesRead(directed)

  const cursor = messages.length > 0 ? messages[messages.length - 1].id : (input.since ?? 0)
  return JSON.stringify(
    {
      cursor,
      count: messages.length,
      messages: messages.map((m) => ({
        id: m.id,
        from: m.fromSlotId,
        to: m.toSlotId,
        broadcast: m.toSlotId == null,
        kind: m.kind,
        body: m.body,
        task: m.taskId,
        at: m.createdAt,
      })),
    },
    null,
    2,
  )
}

// --- The board --------------------------------------------------------------

/** `team_list_tasks(status?)` — the whole board, or one status of it. Readable
 * by every slot: R6.2 says a member may read the board, and a member that
 * cannot see the graph cannot pick up work a stalled leader left behind. */
export async function teamListTasks(caller: TeamCaller, input: { status?: TeamTaskStatus }): Promise<string> {
  const tasks = await listTeamTasks(caller.teamId, input.status ? { status: input.status } : {})
  return JSON.stringify({ count: tasks.length, tasks: tasks.map(summariseTask) }, null, 2)
}

/**
 * `team_create_task(...)` — leader-only, including the assignment.
 *
 * Not in the minimal tool list, but the permission the roadmap names ("only a
 * leader may assign") is unenforceable without a tool that assigns. The
 * broker call already exists; wiring it here is what makes the rule mean
 * something instead of being a comment about a hypothetical.
 */
export async function teamCreateTask(
  caller: TeamCaller,
  input: { subject: string; description?: string | null; assignTo?: number | null; blockedBy?: number[] },
): Promise<string> {
  // Permanently deduplicated: a retried creation is the clearest form of
  // double-booking there is — two identical tasks on the board, one of which
  // two members will each pick up believing it is theirs.
  return runTeamToolOnce(
    {
      teamId: caller.teamId,
      slotId: caller.slotId,
      tool: 'team_create_task',
      taskId: null,
      args: {
        subject: input.subject,
        description: input.description ?? null,
        assignTo: input.assignTo ?? null,
        // Sorted, because the same dependency set in a different order is the
        // same call, and an agent has no reason to preserve order across a retry.
        blockedBy: [...(input.blockedBy ?? [])].sort((a, b) => a - b),
      },
    },
    () => createTaskEffect(caller, input),
  )
}

async function createTaskEffect(
  caller: TeamCaller,
  input: { subject: string; description?: string | null; assignTo?: number | null; blockedBy?: number[] },
): Promise<string> {
  requireLeader(caller, 'create or assign tasks')

  if (input.assignTo != null) {
    const owner = await getTeamMember(input.assignTo).catch(() => null)
    if (!owner || owner.teamId !== caller.teamId) {
      throw new TeamPermissionError(`Slot ${input.assignTo} is not a member of your team.`)
    }
  }
  // Dependencies are enforced by the claimability query, so a blocker from
  // another team would silently gate this team's board on rows it can never
  // see finish. Checked here rather than trusted — but in ONE query for the
  // whole list, not `requireOwnTeamTask` per id: a blocker list is caller-
  // supplied and unbounded, so a SELECT inside the loop is an N+1 an agent
  // could widen at will. Scanning the team's own board is a single statement
  // and answers every id at once. The first stray id in the declared order is
  // reported, so the message is deterministic.
  const blockers = input.blockedBy ?? []
  if (blockers.length > 0) {
    const onBoard = new Set((await listTeamTasks(caller.teamId)).map((task) => task.id))
    const stray = blockers.find((id) => !onBoard.has(id))
    // Same wording as `requireOwnTeamTask` on purpose: "does not exist" and
    // "belongs to another team" must stay indistinguishable.
    if (stray != null) throw new TeamPermissionError(`Task ${stray} is not on your team's board.`)
  }

  const task = await createTeamTask({
    teamId: caller.teamId,
    subject: input.subject,
    description: input.description ?? null,
    ownerSlotId: input.assignTo ?? null,
    blockedBy: blockers,
  })
  return JSON.stringify(summariseTask(task), null, 2)
}

/**
 * `team_claim_task(id)`.
 *
 * Losing the race is a normal outcome, not an error: the guard lives in the
 * UPDATE, so of two simultaneous claimants exactly one updates a row and the
 * other matches nothing. That is reported to the agent plainly, with the
 * current owner, and **not retried silently** — a retry loop here would turn a
 * settled race into two agents fighting over a board, and the agent's correct
 * next move (list the board, claim something else) is one it should make
 * knowingly.
 */
export async function teamClaimTask(caller: TeamCaller, input: { id: number }): Promise<string> {
  // Permanently deduplicated, and this is the case that most needed it: before
  // R6.6 a retried claim re-ran the guarded UPDATE, matched nothing (the slot
  // already owned the row), and was told "slot N claimed it first" — where N
  // was the caller. An agent that believes it lost a race it actually won
  // abandons work it is holding.
  return runTeamToolOnce(
    { teamId: caller.teamId, slotId: caller.slotId, tool: 'team_claim_task', taskId: input.id },
    () => claimTaskEffect(caller, input),
  )
}

async function claimTaskEffect(caller: TeamCaller, input: { id: number }): Promise<string> {
  await requireOwnTeamTask(caller, input.id)
  const claimed = await claimTeamTask(input.id, caller.slotId)
  if (claimed) return JSON.stringify({ claimed: true, task: summariseTask(claimed) }, null, 2)

  // Re-read for the reason, so the agent is told *why* rather than just "no".
  const current = await getTeamTask(input.id)
  return JSON.stringify(
    {
      claimed: false,
      reason: current
        ? current.ownerSlotId != null && current.ownerSlotId !== caller.slotId
          ? `Slot ${current.ownerSlotId} claimed it first.`
          : `The task is '${current.status}' and is no longer claimable.`
        : 'The task no longer exists.',
      task: current ? summariseTask(current) : null,
      advice: 'Do not retry this task. Call team_list_tasks and pick another one.',
    },
    null,
    2,
  )
}

/** Statuses a non-leader may move its own task to. 'done' and 'cancelled' are
 * absent on purpose: closing a task is the leader's, or `team_report_done`'s,
 * job. R6.2's example permission is precisely "read the board but not close
 * tasks", and `team_report_done` is the honest way to finish work because it
 * settles the task *and* files the report in one transaction — a bare status
 * flip to 'done' would leave the team with a finished task nobody was told
 * about. */
const MEMBER_SETTABLE: readonly TeamTaskStatus[] = ['claimed', 'in_progress', 'blocked']

/** `team_update_task(id, status)`. */
export async function teamUpdateTask(
  caller: TeamCaller,
  input: { id: number; status: TeamTaskStatus },
): Promise<string> {
  // Windowed rather than permanent: claimed -> in_progress -> blocked ->
  // in_progress is a legitimate life for a task, so the same transition an
  // hour later must be allowed through. Within the window it is a retry.
  return runTeamToolOnce(
    {
      teamId: caller.teamId,
      slotId: caller.slotId,
      tool: 'team_update_task',
      taskId: input.id,
      args: { status: input.status },
      repeatWindowMs: STATUS_REPEAT_WINDOW_MS,
    },
    () => updateTaskEffect(caller, input),
  )
}

async function updateTaskEffect(
  caller: TeamCaller,
  input: { id: number; status: TeamTaskStatus },
): Promise<string> {
  const task = await requireOwnTeamTask(caller, input.id)

  if (caller.role !== 'leader') {
    if (task.ownerSlotId !== caller.slotId) {
      throw new TeamPermissionError(
        `Task ${input.id} is owned by ${task.ownerSlotId == null ? 'nobody' : `slot ${task.ownerSlotId}`}, not by you. ` +
          `Claim it first with team_claim_task.`,
      )
    }
    if (!MEMBER_SETTABLE.includes(input.status)) {
      throw new TeamPermissionError(
        `Members may only set ${MEMBER_SETTABLE.join(', ')}. ` +
          `To finish this task use team_report_done, which settles it and files your report together.`,
      )
    }
  }

  await updateTeamTaskStatus(input.id, input.status)
  return `Task ${input.id} is now '${input.status}'.`
}

/**
 * `team_report_done(task, summary)` — the acknowledged completion edge.
 *
 * Everything transactional about it lives in the broker call; what is added
 * here is who may invoke it: the task's owner, or the leader. An unowned or
 * someone else's task cannot be closed on their behalf, because "done" here is
 * also a claim about who did the work — it is the row the channel view
 * attributes.
 */
export async function teamReportDone(
  caller: TeamCaller,
  input: { task: number; summary: string },
): Promise<string> {
  // The call R6.6 names explicitly: "a retried team_report_done must not
  // broadcast a second report or overwrite a result". Permanently deduplicated
  // by (slot, task, summary), and the first call's answer — including the list
  // of tasks it unblocked — is replayed verbatim.
  //
  // The `already done` guard below is NOT redundant with this. It covers the
  // other caller: a leader, or the same slot with a different summary, closing
  // a task somebody else already settled. Idempotency answers "you did this
  // before"; the guard answers "somebody did this before".
  return runTeamToolOnce(
    {
      teamId: caller.teamId,
      slotId: caller.slotId,
      tool: 'team_report_done',
      taskId: input.task,
      args: { summary: input.summary },
    },
    () => reportDoneEffect(caller, input),
  )
}

async function reportDoneEffect(
  caller: TeamCaller,
  input: { task: number; summary: string },
): Promise<string> {
  const task = await requireOwnTeamTask(caller, input.task)
  // A settled task cannot be reported on again. `reportTeamTaskDone` writes
  // `status = 'done'` with no guard on the current status, so without this a
  // second call would overwrite the recorded result and broadcast a duplicate
  // report — and calling it on a *cancelled* task would silently resurrect
  // work the team had agreed to drop. Both are states the board would then be
  // lying about, which is the one thing the completion edge exists to prevent.
  if (task.status === 'done' || task.status === 'cancelled') {
    throw new TeamPermissionError(
      `Task ${input.task} is already '${task.status}' and cannot be reported on again. ` +
        `If you have something to add, send it with team_send_message referencing this task.`,
    )
  }
  if (caller.role !== 'leader' && task.ownerSlotId !== caller.slotId) {
    throw new TeamPermissionError(
      `Task ${input.task} is not yours to report on — it is owned by ` +
        `${task.ownerSlotId == null ? 'nobody' : `slot ${task.ownerSlotId}`}.`,
    )
  }

  const { task: settled, released } = await reportTeamTaskDone({
    taskId: input.task,
    slotId: caller.slotId,
    summary: input.summary,
  })
  if (!settled) throw new TeamPermissionError(`Task ${input.task} could not be settled; it no longer exists.`)

  return JSON.stringify(
    {
      task: summariseTask(settled),
      // Returned so the reporter can say what it unblocked instead of the team
      // discovering it on somebody's next poll. Note this is the team's whole
      // claimable set after the write, not only the tasks this one released —
      // `reportTeamTaskDone` returns `claimableTasks(teamId)` and computing the
      // difference would need a before-snapshot inside its transaction, which
      // is its call to make, not ours.
      claimableNow: released.map(summariseTask),
    },
    null,
    2,
  )
}
