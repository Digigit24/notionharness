// ROADMAP — closes the gap the lead flagged after P6.4: task assignment
// already enqueues a broker run (Gate 3+4, `app/(app)/workspace/
// [workspaceSlug]/tasks/actions.ts`'s `enqueueRun` call), and everything
// downstream of "a run exists" was already built and verified in isolation
// — `RunWorktreeManager` (Pillar 4.4), `sendTurnWithIdentity` (Pillar 3.4),
// the broker's claim/settle machinery (Pillar 4) — but nothing actually
// called them in sequence for a claimed run. This is that missing wire.
//
// `dispatchNextRun` claims at most one run per call and returns as soon as
// the claim is known — it hands the actual claim → worktree → identity-
// scoped turn → live event streaming → settle sequence to a detached,
// in-process task (see the execution-registry comment below) rather than
// awaiting it inline, so a slow/long turn can never hold the tick request
// open. The caller still decides how to loop (a long-running worker
// process, a cron tick, whatever Pillar 4/5's actual deployment model turns
// out to be); that's a separate concern from making one claimed run
// actually execute correctly, which is what this module is responsible for.
import { getPayloadClient } from '@/lib/payload'
import {
  claimNextRun,
  markRunStarted,
  renewLease,
  settleRun,
  appendRunEventsBatch,
  clearRunBacklog,
  getRunSeqBase,
  publishRunEvent,
  recordUsage,
  setHermesSessionId,
  touchSession,
  getChatSession,
  isRunCancellationRequested,
  requestRunCancellation,
  getWorktree,
  touchWorktree,
  getTeamBindingForSession,
  getTeam,
  listTeamMembers,
  type Run,
  type TeamRunBinding,
} from '@/lib/broker'
import { RunWorktreeManager } from '@/lib/run-worktrees/manager'
import { resolveRunWorktreeConfig } from '@/lib/run-worktrees/config'
import { sendTurnWithIdentity } from '@/lib/runtimes/hermes/run-with-identity'
import { warnIfHermesProbeUnpatched } from '@/lib/runtimes/hermes/install-checks'
import { resolveProfileHome } from '@/lib/runtimes/hermes/profiles'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { createPendingApproval, waitForApproval } from '@/lib/hermes/approval-helpers'
import { hrefForEntity } from '@/lib/entity-links.server'
import { sendPushToUser } from '@/lib/push/send'
import type { RunEvent } from '@/lib/run-events'
import { redactError } from '@/lib/redact'
import { resolvePluginsForRun } from '@/lib/plugins/resolve'
import { TEAM_PLUGIN_NAME } from '@/lib/teams/registration'
import { classifyRunFailure, runDisposition, type RunDisposition } from '@/lib/dispatcher/classify-failure'
import { bestEffort } from '@/lib/failures'
import { logger } from '@/lib/logger'
import type { Agent, RuntimeProfile, Task } from '@/payload-types'
import type { ApprovalOption } from '@/collections/Approvals'
import type { ApprovalOutcome } from '@/lib/run-events'

/** Newline, without an escape sequence that a source-rewriting tool can eat. */
const NEWLINE = String.fromCharCode(10)

/** What an agent needs to know about the team it is acting for. */
interface TeamPromptContext {
  teamName: string
  slotId: number
  displayName: string
  role: 'leader' | 'member'
  members: Array<{ slotId: number; displayName: string; role: 'leader' | 'member' }>
}

/**
 * How a run this process executed ended.
 *
 * 'cancelled' is a first-class ending rather than a flavour of failure: it is
 * a terminal `runs.status` in its own right (`lib/broker/types.ts`), and the
 * only one of the three that nobody needs to be told about as bad news.
 */
type RunEndState = 'completed' | 'failed' | 'cancelled'

export interface DispatchOutcome {
  claimed: boolean
  runId?: number
  // 'started' means the tick handed the run off to a detached execution
  // task and returned without waiting for it — see the concurrency-registry
  // comment below for why. 'completed'/'failed' only ever describe a run
  // that this same process later finishes; the HTTP caller (the tick route,
  // and beyond it `scripts/run-dispatcher-loop.ts`) never observes those
  // synchronously any more.
  status?: 'started' | 'completed' | 'failed'
  error?: string
}

// --- In-process execution registry -----------------------------------------
//
// `executeRun` is wall-clock-capped at up to `turnTimeoutMs` (10 minutes,
// see the 'ask' permissionMode branch below) but used to be `await`ed
// directly inside the tick request handler (`app/api/dispatcher/tick/
// route.ts`) — so a single tick could hold its HTTP response open for up to
// 10 minutes. `scripts/run-dispatcher-loop.ts` polls that route every 3s
// with no mutex, so 10min / 3s could pile up ~200 concurrent in-flight tick
// requests, each racing `claimNextRun`. Fix: claim, then hand the actual
// turn to a detached (non-awaited) task tracked in this module-level map,
// and return from `dispatchNextRun` as soon as the claim (or "nothing
// queued") is known. This is deliberately just an in-process registry, not
// a durable queue — restart the Next.js server and any in-flight runs rely
// on their lease lapsing and `sweepExpiredLeases` reclaiming them, same as
// any other worker crash.
const MAX_CONCURRENT_RUNS = Number(process.env.DISPATCHER_MAX_CONCURRENT_RUNS) || 4

const inFlightRuns = new Map<number, Promise<void>>()
// Runs actually mid-turn per agent (i.e. past the per-agent slot wait below)
// — not the same set as `inFlightRuns`, which also counts runs still
// claimed but waiting on this counter to drop before their turn starts.
const agentInFlightCounts = new Map<number, number>()
// Stop controls for runs currently mid-turn, so a user can interrupt an
// answer they no longer want. In-process only, like `inFlightRuns` above:
// a run whose server restarted is reclaimed by the lease sweeper instead.
const runCancelControls = new Map<number, () => Promise<void>>()
// Timers watching for a stop raised in another process, one per in-flight run.
const cancelWatchers = new Map<number, ReturnType<typeof setInterval>>()

/**
 * Interrupts a run that's still answering. Uses ACP's own `session/cancel`
 * (see acp-client.ts) rather than killing the process, so the agent stops
 * cooperatively and the turn still ends with a real `done` event — whatever
 * it had already streamed stays in the transcript.
 */
export async function requestRunCancel(runId: number): Promise<{ cancelled: boolean }> {
  // Recorded in the database FIRST, because that is the signal that reliably
  // reaches the process actually running the turn. This used to be the
  // in-process map alone, and in Next the map reached from a server action is
  // not necessarily the map the dispatcher filled — so Stop found no control,
  // returned false, and did nothing at all with no explanation.
  const accepted =
    (await bestEffort(
      requestRunCancellation(runId),
      'Stop must still take the fast in-process path even if recording the request failed',
      { runId },
    )) ?? false

  // The in-process control remains as the fast path: when the turn happens to
  // be running right here, this cancels within milliseconds rather than
  // waiting for the watcher below to notice.
  const cancel = runCancelControls.get(runId)
  if (cancel) {
    await bestEffort(cancel(), 'a cancel that throws has already asked the agent to stop as loudly as it can', {
      runId,
    })
    return { cancelled: true }
  }
  return { cancelled: accepted }
}

/** How quickly a stop requested from another process is noticed. Short enough
 * to feel immediate, long enough that a long turn does not hammer the
 * database — and the in-process path above usually gets there first anyway. */
const CANCEL_POLL_MS = 2_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * R12-P1.6 — the fields that make a dispatcher log line answerable.
 *
 * The question people actually ask is "what happened to run 214", and it used
 * to be answered by grepping prose for the number. Ids go in the record, not
 * in the sentence, so a log search is a field match rather than a substring
 * hunt across a dozen different phrasings of the same event.
 */
function runFields(run: Run, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: run.id,
    ...(run.sessionId != null ? { sessionId: run.sessionId } : {}),
    ...(run.agentId != null ? { agentId: run.agentId } : {}),
    ...(run.taskId != null ? { taskId: run.taskId } : {}),
    attempt: run.attempt,
    ...extra,
  }
}

/**
 * The one place a run's non-success is written down.
 *
 * Every settle in this file used to decide `retryable` for itself, which is
 * how a pool blip came to be recorded as a permanently broken agent (see
 * `classify-failure.ts`). Here the taxonomy decides, and the log line says
 * which row of it decided — so "why was run 214 not retried" is a question the
 * log answers rather than one that requires reading this file.
 */
async function settleWithDisposition(
  run: Run,
  disposition: RunDisposition,
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  if (disposition.outcome === 'cancelled') {
    // Not `failed`. Somebody asked for this to stop and it stopped; recording
    // that as a failure both misreports it and — because a failed settle under
    // the attempt cap enqueues a retry — used to restart the very turn they
    // had just interrupted.
    await settleRun(run.id, 'cancelled')
    logger.info('run cancelled', runFields(run, extra))
    return
  }
  await settleRun(run.id, 'failed', { error: message, retryable: disposition.retryable })
  logger.error('run failed', undefined, {
    ...runFields(run, extra),
    code: disposition.code,
    retryable: disposition.retryable,
    reason: message,
  })
}

function incrAgentInFlight(agentId: number): void {
  agentInFlightCounts.set(agentId, (agentInFlightCounts.get(agentId) ?? 0) + 1)
}

function decrAgentInFlight(agentId: number): void {
  const next = (agentInFlightCounts.get(agentId) ?? 1) - 1
  if (next <= 0) agentInFlightCounts.delete(agentId)
  else agentInFlightCounts.set(agentId, next)
}

export async function dispatchNextRun(workerId: string): Promise<DispatchOutcome> {
  // Global ceiling enforced *before* claiming: don't pull work off the
  // queue past capacity just to let it sit claimed-but-waiting — leave it
  // 'queued' for whichever tick has room, so priority ordering (`claimNextRun`'s
  // `ORDER BY priority DESC, created_at ASC`) still applies at claim time.
  if (inFlightRuns.size >= MAX_CONCURRENT_RUNS) {
    return { claimed: false }
  }

  const run = await claimNextRun(workerId)
  if (!run) return { claimed: false }

  const execution = executeRun(run)
    .then(() => undefined)
    .catch(async (err) => {
      // Anything unexpected (agent lookup blew up, worktree creation
      // failed, the binary isn't on this machine) is still a run that
      // needs settling — never leave it stuck in 'dispatched'/'running'
      // for the lease sweeper to have to clean up later when it could
      // fail cleanly now.
      // R3.8, same as the turn-level catch below: this text lands in
      // `runs.error` and is rendered in a chat bubble, so it goes through the
      // redactor rather than straight from the exception.
      const message = redactError(err)
      // Classified rather than blanket-retryable: this catch sees the causes
      // furthest from any call site that understands them — a missing binary
      // and an exhausted pool arrive here identically — and requeuing the
      // missing binary four times only delays the person who has to install it.
      const disposition = classifyRunFailure(err, { attempt: run.attempt })
      await bestEffort(
        settleWithDisposition(run, disposition, message, { origin: 'executeRun' }),
        'a run already failing outside its own error handling must not fail again on the way to being recorded',
        { runId: run.id },
      )
      if (disposition.outcome === 'failed') {
        void getPayloadClient()
          .then((payload) => notifyRunSettled(payload, run, null, 'failed'))
          .catch((pushErr) => logger.warn('could not notify run settled', runFields(run, { error: String(pushErr) })))
      }
      logger.error("run failed outside executeRun's own error handling", err, runFields(run))
    })
    .finally(() => {
      inFlightRuns.delete(run.id)
    })
  inFlightRuns.set(run.id, execution)
  // The `.catch` above already turns every rejection into a resolved
  // (logged) value, so `execution` itself should never reject — but per
  // `instrumentation.ts`'s own stance (a process-wide `unhandledRejection`
  // logger is a last-resort net, not a fix), attach a belt-and-suspenders
  // handler anyway rather than leaving a detached promise with nothing
  // observing it.
  execution.catch((err) => {
    logger.error('unhandled rejection executing run', err, runFields(run))
  })

  return { claimed: true, runId: run.id, status: 'started' }
}

/**
 * A bound worktree, or null if the binding cannot be honoured.
 *
 * A row that says `removed`, or a path that is no longer on disk, must fall
 * back to a disposable checkout rather than failing the run or — worse —
 * running in a directory that no longer means what it used to. `describe` is
 * only there so the warning names what pointed at the missing path.
 */
async function usableWorktree(worktreeId: number, describe: string) {
  const worktree =
    (await bestEffort(getWorktree(worktreeId), 'a worktree we cannot read falls back to a disposable checkout', {
      worktreeId,
    })) ?? null
  if (!worktree || worktree.status === 'removed') return null
  const { existsSync } = await import('node:fs')
  if (!existsSync(worktree.path)) {
    logger.warn('bound worktree is not on disk — using a disposable checkout', {
      worktreeId,
      path: worktree.path,
      boundBy: describe,
    })
    return null
  }
  return worktree
}

/**
 * The project worktree this run should execute in, when its session is bound
 * to one — or when its TEAM says where it belongs.
 *
 * R6.1 — this is where `teams.workspace_mode` stops being a stored string and
 * starts deciding something. `getTeamBindingForSession` has already applied
 * the mode: 'shared' answers with the one checkout the whole team works in,
 * 'per_member' answers with this slot's own. Taking that over the session's
 * own binding is the point — under 'shared', two slots whose sessions were
 * bound separately must still land in the same directory, or the mode means
 * nothing.
 *
 * A team binding that resolves to nothing falls through to the ordinary
 * session binding, and then to a disposable checkout, exactly as before: a
 * team whose slots nobody has bound to a repository is a team of agents that
 * still runs, just without a shared tree.
 */
async function resolveSessionWorktree(run: Run, team: TeamRunBinding | null) {
  if (team?.worktreeId != null) {
    const teamTree = await usableWorktree(
      team.worktreeId,
      `Team ${team.teamId} slot ${team.slotId} (${team.workspaceMode})`,
    )
    if (teamTree) return teamTree
  }
  if (!run.sessionId) return null
  const session = await bestEffort(
    getChatSession(run.sessionId),
    'a session we cannot read runs in a disposable checkout rather than not at all',
    { runId: run.id, sessionId: run.sessionId },
  )
  if (!session?.worktreeId) return null
  return usableWorktree(session.worktreeId, `Session ${session.id}`)
}

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

function stringEnv(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

function buildPromptText(
  task: Task | null,
  agent: Agent,
  run: Run,
  team: TeamPromptContext | null,
): string {
  const parts: string[] = []
  if (agent.instructions) parts.push(agent.instructions)

  // Who this agent is on this team, and who else is on it.
  //
  // Without this an agent in a slot receives seven team tools and nothing
  // else — no idea it is on a team, that it leads one, or who the members
  // are. Verified live before this existed: a leader given a delegation
  // objective went looking for its own tools with a search, called
  // `team_list_tasks` to orient itself, and could not have assigned anything
  // to anyone because slot ids appear nowhere it can see. Tools without
  // context are not a capability, they are a puzzle.
  //
  // The roster carries SLOT IDS because that is what the tools take. A slot
  // is not an agent — the same agent can hold two — so naming teammates
  // without their slot ids would leave the ambiguity the slot model exists to
  // remove.
  if (team) {
    const roster = team.members
      .map((m) => `  - slot ${m.slotId}: ${m.displayName}${m.role === 'leader' ? ' (leader)' : ''}${m.slotId === team.slotId ? ' — you' : ''}`)
      .join(NEWLINE)
    parts.push(
      [
        `You are "${team.displayName}", ${team.role === 'leader' ? 'the leader' : 'a member'} of the team "${team.teamName}".`,
        'Team roster:',
        roster,
        '',
        team.role === 'leader'
          ? 'You have team tools. Use team_create_task to break work down, assign each task to a teammate by their slot id, and team_send_message to tell them. Do not do the work yourself that you have assigned to someone else.'
          : 'You have team tools. Use team_read_inbox to see what you have been asked to do, team_claim_task to take work off the board, and team_report_done when a task is finished.',
      ].join(NEWLINE),
    )
  }
  // Tasks have no description/body field yet (P2.1) — title is the only
  // task-authored content available to hand the agent today. Richer prompt
  // construction (task description, linked page content, thread context)
  // is real future work, not something to fake here.
  if (task) parts.push(`Task: ${task.title}`)

  // The run's own prompt, ALWAYS, not just when there is no task.
  //
  // This used to be `task ? title : prompt`, so a run that had both — a task
  // AND something specific to say — silently discarded the something. That is
  // not hypothetical: R5.3 batches a reviewer's line comments into one prompt
  // and enqueues it against the run's task, and every word of it was being
  // dropped on the floor. The agent received "Task: <title>" and no idea why
  // it had been woken up.
  if (run.prompt) parts.push(run.prompt)
  if (!task && !run.prompt) parts.push('No task is attached to this run.')
  return parts.join('\n\n')
}

// ROADMAP B5.3 (Batch B-5 "Attention") — "web push for... completions."
// Notifies both the accountable and originating user (often the same
// person, but not always — see Run's own field comments) that a run they
// care about reached a terminal state. Fire-and-forget from every call
// site's perspective: a push failure must never affect the settle it's
// reporting on.
/**
 * Puts a mention-run's answer back in the thread it came from.
 *
 * Reads the run's own transcript rather than asking the agent again: the
 * assistant text is already there, and a second model call to summarise what
 * was just said would cost money to produce a worse version of it.
 *
 * A failed run posts too, saying so. Silence after a mention is the failure
 * this whole path exists to remove, and "it broke" is information; nothing at
 * all is not.
 */
async function postMentionReply(
  run: Run,
  envelopes: Array<{ event: RunEvent }>,
  status: RunEndState,
): Promise<void> {
  const messageId = run.channelMessageId
  if (!messageId) return

  const { getChannelMessage, listThread, postChannelMessage } = await import('@/lib/broker/channels')
  const { getTeamBindingForSession } = await import('@/lib/broker')

  const source = await getChannelMessage(messageId)
  if (!source) return
  if (!run.sessionId) return
  const binding = await getTeamBindingForSession(run.sessionId)
  if (!binding) return

  const threadRootId = source.threadRootId ?? source.id

  // Did the agent already answer with its own tool? If so, leave it alone —
  // double-posting a good citizen is worse than not backstopping a bad one.
  const thread =
    (await bestEffort(
      listThread(threadRootId),
      'a thread we cannot read is answered rather than left silent — a duplicate reply beats no reply',
      { runId: run.id, threadRootId },
    )) ?? []
  const alreadyReplied = thread.some(
    (message) => message.fromSlotId === binding.slotId && message.id > source.id,
  )
  if (alreadyReplied) return

  const answer = envelopes
    .map((envelope) => envelope.event)
    .filter((event): event is Extract<RunEvent, { type: 'message' }> => event.type === 'message')
    .filter((event) => event.role === 'assistant')
    .map((event) => event.text)
    .join('')
    .trim()

  // A stopped run still owes the thread a line. It was stopped on purpose, so
  // it does not say it failed — but leaving the mention hanging is the exact
  // silence this backstop exists to remove, whatever the reason for it.
  const body =
    status === 'completed'
      ? answer || 'I finished, but produced no text to report.'
      : status === 'cancelled'
        ? `I was stopped before I finished. ${answer || 'Nothing was produced before the stop.'}`.trim()
        : `I could not finish that. ${answer || 'The run failed before producing an answer.'}`.trim()

  await postChannelMessage({
    teamId: binding.teamId,
    fromSlotId: binding.slotId,
    kind: status === 'completed' ? 'answer' : 'status',
    body: body.slice(0, 20_000),
    threadRootId,
    // Stamped so "see the full run" on this reply opens the run that actually
    // wrote it, rather than approximating from the slot's session.
    runId: run.id,
  })
}

function notifyRunSettled(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  run: Run,
  task: Task | null,
  status: RunEndState,
): void {
  const recipients = new Set<number>([run.accountableUser])
  if (run.originatorUser != null) recipients.add(run.originatorUser)

  void hrefForEntity(payload, 'run', String(run.id))
    .then((url) => {
      const subject = task ? `"${task.title}"` : `run ${run.id}`
      // The person who pressed Stop knows what they did, but they are not
      // necessarily the accountable user this notifies — and telling that
      // person their run FAILED, which is what this said until 'cancelled'
      // existed here, is both wrong and alarming.
      const title = status === 'completed' ? 'Run completed' : status === 'cancelled' ? 'Run stopped' : 'Run failed'
      const verb = status === 'completed' ? 'finished' : status === 'cancelled' ? 'was stopped' : 'failed'
      const message = { title, body: `Your run for ${subject} ${verb}.`, url }
      return Promise.all([...recipients].map((userId) => sendPushToUser(userId, 'completion', message)))
    })
    .catch((err) =>
      logger.error('could not push the run-settled notification', err, runFields(run, { settledAs: status })),
    )
}

/**
 * Tells a channel thread that its agent is blocked waiting for a person.
 *
 * Without this, a mention-run that hits `permissionMode: 'ask'` renders its
 * approval card in the WORK thread and the channel shows nothing at all — the
 * run blocks silently until it times out. That is the same failure as the
 * original "I mentioned it and nothing happened", arriving by a different
 * route, and it would read as the feature being broken again.
 *
 * Posted as a `status` message so it is visibly not an answer, and best-effort
 * throughout: failing to announce a block must never also fail the turn that
 * is blocked.
 */
async function announceApprovalInChannel(run: Run, title: string): Promise<void> {
  const channelMessageId = run.channelMessageId
  const sessionId = run.sessionId
  if (!channelMessageId || !sessionId) return
  await bestEffort(
    async () => {
      const { getChannelMessage, postChannelMessage } = await import('@/lib/broker/channels')
      const { getTeamBindingForSession } = await import('@/lib/broker')
      const [source, binding] = await Promise.all([
        getChannelMessage(channelMessageId),
        getTeamBindingForSession(sessionId),
      ])
      if (!source || !binding) return
      await postChannelMessage({
        teamId: binding.teamId,
        fromSlotId: binding.slotId,
        kind: 'status',
        body: `Waiting for approval to ${title}. The channel shows the decision on this thread's row — answer it there, in this thread, or in the Inbox, and I will carry on.`,
        threadRootId: source.threadRootId ?? source.id,
      })
    },
    'announcing a block is never worth failing the blocked turn over',
    { runId: run.id, sessionId },
  )
}

function buildPermissionCallback(
  run: Run,
  requestedUserId: number,
  permissionTimeoutMs: number
) {
  const runId = run.id
  return async (params: {
    id: string
    title: string
    detail: string
    options: Array<{ optionId: string; kind: string; label?: string }>
  }): Promise<ApprovalOutcome> => {
    // Say so in the channel BEFORE waiting, not after: the whole point is that
    // the person sees it while the run is still blocked rather than learning
    // about it from a timeout.
    void announceApprovalInChannel(run, params.title)

      const approvalId = await createPendingApproval({
      runId,
      externalId: params.id,
      requestedUserId,
      title: params.title,
      detail: params.detail,
      options: params.options.map((o) => ({
        optionId: o.optionId,
        kind: o.kind as ApprovalOption['kind'],
        label: o.label,
      })),
    })
    // ROADMAP B5.3 (Batch B-5 "Attention") — "web push for approvals... This
    // is what converts 'agents work while I am away' from a claim into a
    // fact." Fire-and-forget: a push failure must never block or fail the
    // approval wait itself (same posture as every other best-effort notify
    // call in this file — see appendRunEvent/recordUsage above).
    void getPayloadClient()
      .then((payload) => hrefForEntity(payload, 'run', String(runId)))
      .then((url) =>
        sendPushToUser(requestedUserId, 'approval', {
          title: 'Approval needed',
          body: params.title,
          url,
        }),
      )
      .catch((err) => logger.error('could not push the approval notification', err, { runId, requestedUserId }))
    try {
      const outcome = await waitForApproval(params.id, permissionTimeoutMs)
      return outcome
    } finally {
      void approvalId
    }
  }
}

// Lease heartbeat cadence (item B) — comfortably inside `DEFAULT_LEASE_MS`
// (60s, `lib/broker/runs.ts`) so a GC pause or one slow query doesn't let
// the lease lapse between renewals.
const LEASE_RENEW_INTERVAL_MS = 15_000
// How often a run waits, once claimed, for its agent's concurrency slot to
// free up before actually starting its turn (see `agentInFlightCounts`
// above). The lease heartbeat keeps running during this wait, so it's safe
// for this to be a fairly relaxed poll.
const AGENT_SLOT_POLL_MS = 5_000

async function executeRun(run: Run): Promise<{ status: RunEndState; error?: string }> {
  const payload = await getPayloadClient()

  // Started immediately: the run is already claimed (a lease exists) the
  // moment `dispatchNextRun` handed it to this detached task, so heartbeat
  // coverage must span everything below, not just the eventual
  // `sendTurnWithIdentity` call — including the agent/runtime-profile
  // lookups and any time spent waiting on a per-agent concurrency slot.
  // `.unref()` so a pending timer can never keep the Node process alive by
  // itself; `finally` below clears it on every exit path (settle-and-return
  // early, thrown error, or normal completion).
  const leaseInterval = setInterval(() => {
    void renewLease(run.id).catch((err) => {
      logger.error('could not renew the run lease', err, runFields(run))
    })
  }, LEASE_RENEW_INTERVAL_MS)
  leaseInterval.unref()

  try {
    return await executeClaimedRun(payload, run)
  } finally {
    clearInterval(leaseInterval)
  }
}

async function executeClaimedRun(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  run: Run,
): Promise<{ status: RunEndState; error?: string }> {
  if (run.agentId == null) {
    const message = 'Run has no agent assigned.'
    await settleWithDisposition(run, runDisposition('invalid_input'), message)
    return { status: 'failed', error: message }
  }
  const agentId = run.agentId

  // Two different failures, two different answers.
  //
  // This used to be one `.catch(() => null)` feeding a single "Agent missing or
  // disabled" that settled the run NON-RETRYABLE. Verified live: a transient
  // Postgres pool exhaustion made this lookup throw, and a perfectly good run
  // against a perfectly good agent was permanently killed with an explanation
  // that was simply untrue — the worst combination, because the message sends
  // whoever reads it to look at the agent instead of the database.
  //
  // `disableErrors` already turns "not found" into null, so anything thrown
  // here is infrastructure, and infrastructure failures are retryable.
  let agent: Agent | null
  try {
    agent = (await payload.findByID({
      collection: 'agents',
      id: agentId,
      overrideAccess: true,
      disableErrors: true,
    })) as Agent | null
  } catch (err) {
    const message = `Could not load agent ${agentId}: ${redactError(err)}`
    await settleWithDisposition(run, classifyRunFailure(err, { attempt: run.attempt }), message)
    return { status: 'failed', error: message }
  }
  if (!agent || agent.enabled === false) {
    const message = 'Agent missing or disabled.'
    await settleWithDisposition(run, runDisposition('agent_unavailable'), message)
    return { status: 'failed', error: message }
  }

  const runtimeProfileId = typeof agent.runtimeProfile === 'number' ? agent.runtimeProfile : agent.runtimeProfile.id
  // Split the same way the agent lookup above is, and for the same reason: a
  // `.catch(() => null)` here fed "Runtime profile missing or disabled." and
  // settled the run NON-retryable, so one bad second on the database read as a
  // configuration mistake that nobody had made. `disableErrors` already turns
  // a genuine "no such row" into null, so anything thrown is infrastructure.
  let runtimeProfile: RuntimeProfile | null
  try {
    runtimeProfile = await payload.findByID({
      collection: 'runtime-profiles',
      id: runtimeProfileId,
      overrideAccess: true,
      disableErrors: true,
    })
  } catch (err) {
    const message = `Could not load runtime profile ${runtimeProfileId}: ${redactError(err)}`
    await settleWithDisposition(run, classifyRunFailure(err, { attempt: run.attempt }), message, {
      runtimeProfileId,
    })
    return { status: 'failed', error: message }
  }
  if (!runtimeProfile || runtimeProfile.enabled === false) {
    const message = 'Runtime profile missing or disabled.'
    await settleWithDisposition(run, runDisposition('runtime_not_installed'), message, { runtimeProfileId })
    return { status: 'failed', error: message }
  }

  const task = run.taskId
    ? ((await bestEffort(
        payload.findByID({ collection: 'tasks', id: run.taskId, overrideAccess: true, disableErrors: true }),
        'a task we cannot read makes a thinner prompt, not a failed run',
        { runId: run.id, taskId: run.taskId },
      )) ?? null)
    : null

  // R4.1 — the tools this product gives this agent, resolved per run and
  // scoped to this agent specifically. Deliberately not written into the
  // runtime's own config: a server added there is available to every agent
  // that runtime ever runs, forever, with no way to revoke it for one agent
  // and not another. These exist for the duration of the session and no
  // longer.
  //
  // A failure to resolve them is not a failure of the run. An agent with no
  // plugins is the state every agent was in until this existed, so the turn
  // proceeds without them rather than refusing to start.
  const agentWorkspaceId = typeof agent.workspace === 'number' ? agent.workspace : agent.workspace?.id

  // R6.2 — is this run a team member taking its turn?
  //
  // The only link that exists is the session: a run carries `session_id`, a
  // team slot carries `session_id`. `getTeamBindingForSession` does that join,
  // the team lookup and the workspace-mode worktree choice in one query,
  // because this is the dispatch path and every extra round trip here is paid
  // by every run in the install (D0).
  //
  // The agent check is not redundant with the endpoint's. `/api/mcp/teams`
  // refuses a slot whose agent is not the run's agent, so a mismatch here
  // could only ever produce a credential that is rejected on first use — but
  // handing an agent a tool that is guaranteed to fail is worse than not
  // handing it one, and the mismatch itself (a slot whose agent was swapped
  // while its session kept running) is worth a line in the log.
  const rawTeamBinding = run.sessionId
    ? ((await bestEffort(
        getTeamBindingForSession(run.sessionId),
        'a team binding we cannot read dispatches the turn without team tools rather than not at all',
        { runId: run.id, sessionId: run.sessionId },
      )) ?? null)
    : null
  let teamBinding: TeamRunBinding | null = rawTeamBinding
  if (rawTeamBinding && rawTeamBinding.agentId !== agentId) {
    logger.warn('run shares a session with a team slot filled by a different agent — dispatching without team tools', {
      ...runFields(run),
      slotId: rawTeamBinding.slotId,
      slotAgentId: rawTeamBinding.agentId,
    })
    teamBinding = null
  } else if (rawTeamBinding && agentWorkspaceId && rawTeamBinding.workspaceId !== agentWorkspaceId) {
    // The slot's team and the agent must live in the same workspace, because
    // everything below reads from the AGENT's: the plugin row is registered in
    // `agentWorkspaceId` and `resolvePluginsForRun` is scoped to it, while the
    // slot id substituted into that row's header belongs to the team's. Let
    // those diverge and a run would carry one workspace's credential to
    // another workspace's board — and nothing downstream would catch it, since
    // `/api/mcp/teams` compares agents and sessions but never workspaces.
    //
    // Not reachable through the UI today (`addSlotAction` calls
    // `requireAgent(agentId, workspaceId)`), which is precisely why it is
    // checked here rather than assumed: the guard that makes it true lives in
    // a server action, and an agent moved between workspaces after its slot
    // was filled would leave exactly this row behind. Dropping the team tools
    // is the conservative answer — the turn still runs, and the roster is a
    // human's to repair.
    logger.warn('run and its team slot are in different workspaces — dispatching without team tools', {
      ...runFields(run),
      workspaceId: agentWorkspaceId,
      slotId: rawTeamBinding.slotId,
      teamId: rawTeamBinding.teamId,
      teamWorkspaceId: rawTeamBinding.workspaceId,
    })
    teamBinding = null
  }

  // A team that predates this wiring has no plugin row, because nothing had
  // created one when it was made. Repaired here rather than left broken: the
  // check is one indexed lookup, it only happens for a run that actually
  // occupies a slot (a small minority of runs), and it is idempotent, so after
  // the first team turn in a workspace it finds the row and returns. The
  // ALTERNATIVE — telling the user to create a second team, or to hand-write a
  // plugin row with three placeholder headers — is not a fix.
  if (teamBinding && agentWorkspaceId) {
    await bestEffort(
      import('@/lib/teams/registration').then(({ ensureTeamMcpPlugin }) => ensureTeamMcpPlugin(agentWorkspaceId)),
      'a team plugin that cannot be registered costs this turn its team tools, not the turn itself',
      { ...runFields(run), workspaceId: agentWorkspaceId, teamId: teamBinding.teamId, slotId: teamBinding.slotId },
    )
  }

  const plugins = agentWorkspaceId
    ? await resolvePluginsForRun({
        workspaceId: agentWorkspaceId,
        agentId,
        // A plugin row is inert configuration; the credential is per run and
        // short lived. `{{RUN_TOKEN}}` in a header value becomes this run's
        // own token here and nowhere else, so nothing live is ever stored.
        //
        // `TEAM_SLOT_ID` follows the same rule and adds one of its own: it is
        // OMITTED, not blanked, for a run that occupies no slot. An empty
        // `X-Team-Slot-Id` header looks supplied and is not; absent is a state
        // `lib/plugins/resolve.ts` can act on, and it does — a plugin row that
        // needs a slot is left out of the session entirely rather than
        // injected in a form that fails every call.
        substitutions: {
          RUN_TOKEN: run.runToken ?? undefined,
          RUN_ID: String(run.id),
          ...(teamBinding ? { TEAM_SLOT_ID: String(teamBinding.slotId) } : {}),
        },
      }).catch((err) => {
        logger.warn('could not resolve plugins for this run', { ...runFields(run), workspaceId: agentWorkspaceId, error: String(err) })
        return { servers: [], skipped: [] }
      })
    : { servers: [], skipped: [] }

  await markRunStarted(run.id)

  if (!run.runToken) {
    // Should be unreachable after this task's fix — `claimNextRun` always
    // mints one now — but surfaced loudly rather than silently sending the
    // agent a turn with no RUN_TOKEN at all if something upstream regresses.
    logger.warn('run was claimed with no run_token — page-writes auth will fail for this run', runFields(run))
  }

  // Where this turn actually runs.
  //
  // A session bound to a project worktree runs INSIDE that worktree: it is
  // the checkout the user is looking at, with their branch and their
  // uncommitted work, and running anywhere else would make the agent's edits
  // invisible to them. Everything else keeps the previous behaviour — a
  // disposable per-run worktree cut from the configured source repo.
  //
  // Note the asymmetry in cleanup: a per-run worktree is ours to create and
  // discard, while a project worktree belongs to the user and must survive
  // the run untouched.
  let runCwd: string
  const sessionWorktree = await resolveSessionWorktree(run, teamBinding)

  // The ACP session id this thread already established, if any. Passing it
  // makes the agent replay its own history so turn two knows what turn one
  // said. Without it every turn started a brand new agent session and the
  // only context that survived was whatever the runtime happened to persist
  // on disk, which is runtime-specific and, for a runtime with no home at
  // all, nothing.
  const resumeSessionId = run.sessionId
    ? ((await bestEffort(
        getChatSession(run.sessionId).then((s) => s?.hermesSessionId ?? null),
        'a session id we cannot read starts a fresh agent session rather than failing the turn',
        { runId: run.id, sessionId: run.sessionId },
      )) ?? null)
    : null

  if (sessionWorktree) {
    runCwd = sessionWorktree.path
    await bestEffort(touchWorktree(sessionWorktree.id), 'last-used bookkeeping must not cost a turn', {
      runId: run.id,
      worktreeId: sessionWorktree.id,
    })
  } else {
    const { source, rootDir, baseBranch } = resolveRunWorktreeConfig()
    const manager = new RunWorktreeManager({ rootDir })
    const disposable = await manager.create(source, String(run.id), baseBranch)
    runCwd = disposable.worktreePath
  }
  // Deliberately NOT removed after the run: `runs/[runId]/review` reads its
  // diff straight from this checkout (lib/run-worktrees/diff.ts), so deleting
  // it on settle would empty the review screen for every completed run.
  // Reclaimed later instead, by the retention policy in
  // `lib/run-worktrees/retention.ts` (R3.4), which keeps anything unfinished,
  // anything with an open review, and the most recent N.

  // Per-agent concurrency ceiling (`agent.maxConcurrentRuns`, `collections/
  // Agents.ts` — defaults to 1). The run stays claimed (lease kept alive by
  // the heartbeat in `executeRun` above) while waiting for a slot, rather
  // than being handed back to the queue, since there's nothing wrong with
  // it — its own agent is just already at capacity.
  const maxConcurrentForAgent = agent.maxConcurrentRuns ?? 1
  while ((agentInFlightCounts.get(agentId) ?? 0) >= maxConcurrentForAgent) {
    await sleep(AGENT_SLOT_POLL_MS)
  }

  incrAgentInFlight(agentId)
  // Read the run's current high-water seq ONCE, here, rather than letting
  // the database allocate a seq per streamed chunk (see appendRunEvent's own
  // comment). `acp-client.ts` restarts its envelope counter at 1 for each
  // turn, and `enqueueAskRun` has usually already written the user's own
  // message at seq 1, so every envelope's seq is offset above whatever is
  // already there.
  const seqBase =
    (await bestEffort(
      getRunSeqBase(run.id),
      'a seq base we cannot read starts at 0 — a duplicated seq costs ordering, not the turn',
      { runId: run.id },
    )) ?? 0
  // Durable writes still go out in order, but they no longer sit between the
  // agent and the screen — `publishRunEvent` below has already delivered the
  // chunk by the time any of these resolve.
  // Durable writes are accumulated here and flushed in batches rather than
  // one connection per streamed chunk — see appendRunEventsBatch for why
  // both one-at-a-time and all-at-once were wrong. Delivery to the browser
  // never waits on any of this (that's `publishRunEvent`).
  const writeBuffer: Array<{ seq: number; event: RunEvent }> = []
  let writeChain: Promise<unknown> = Promise.resolve()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const flushWrites = () => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (writeBuffer.length === 0) return
    const batch = writeBuffer.splice(0, writeBuffer.length)
    // Chained so only one batch is ever in flight for this run — batches
    // stay small and the pool stays free for everything else in the process.
    writeChain = writeChain.then(() =>
      appendRunEventsBatch(run.id, batch).catch((err) => {
        logger.error('could not persist run events', err, { ...runFields(run), events: batch.length })
      }),
    )
  }

  const scheduleFlush = () => {
    if (flushTimer) return
    flushTimer = setTimeout(flushWrites, 250)
  }
  // R4.1 — a plugin that matched this agent but could not be turned into a
  // server is stated, not dropped. A tool that silently fails to load is
  // indistinguishable from one that loaded and chose to do nothing, and the
  // agent will happily narrate its absence as its own failure.
  if (plugins.skipped.length > 0) {
    const detail = plugins.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')
    writeBuffer.push({
      seq: seqBase + 0,
      event: {
        type: 'message',
        role: 'system',
        text: `${plugins.skipped.length === 1 ? 'One plugin was' : `${plugins.skipped.length} plugins were`} not loaded for this turn: ${detail}.`,
      },
    })
    scheduleFlush()
    logger.warn('plugins were not loaded for this turn', { ...runFields(run), skipped: detail })
  }

  // Resolved before the spawn so an unknown/typo'd profile fails the run with
  // a clear message, rather than silently running as the install default and
  // leaving someone to wonder why their agent is answering with the wrong
  // model. `resolveProfileHome` also validates the name before it becomes a
  // filesystem path.
  // The roster, resolved once. One query, and only for a run that is actually
  // on a team — a solo run pays nothing.
  let teamPrompt: TeamPromptContext | null = null
  if (teamBinding) {
    try {
      const members = await listTeamMembers(teamBinding.teamId)
      const team = await getTeam(teamBinding.teamId)
      teamPrompt = {
        teamName: team?.name ?? 'this team',
        slotId: teamBinding.slotId,
        displayName: teamBinding.displayName,
        role: teamBinding.role,
        members: members.map((m) => ({ slotId: m.id, displayName: m.displayName, role: m.role })),
      }
    } catch (err) {
      // A roster we cannot read is a worse prompt, not a failed run.
      logger.warn('could not build the team context for this run', {
        ...runFields(run),
        teamId: teamBinding.teamId,
        error: String(err),
      })
    }
  }

  let agentProfileHome: string | undefined
  const configuredProfile = typeof agent.hermesProfile === 'string' ? agent.hermesProfile.trim() : ''
  if (configuredProfile) {
    try {
      agentProfileHome = resolveProfileHome(configuredProfile)
      await access(join(agentProfileHome, 'config.yaml'))
    } catch {
      const message = `Hermes profile "${configuredProfile}" was not found in this Hermes install.`
      await settleWithDisposition(run, runDisposition('runtime_not_installed'), message, {
        hermesProfile: configuredProfile,
      })
      return { status: 'failed', error: message }
    }
  }

  // Once per process: if a Hermes update reverted the stdin patch on its Git
  // Bash probe, say so here, in the dispatcher's own log, before the first
  // tool call of this run silently hangs on it (lib/hermes/install-checks.ts).
  void warnIfHermesProbeUnpatched()

  let result
  try {
    result = await sendTurnWithIdentity({
      binaryPath: runtimeProfile.commandName,
      cwd: runCwd,
      text: buildPromptText(task, agent, run, teamPrompt),
      runId: String(run.id),
      agentId: run.agentId,
      // Roadmap 3.4: state.db is sharded per CONVERSATION, not per run — a
      // task's chain of runs (original attempt, then a "request changes"
      // follow-up, etc.) is the closest thing this product has to a
      // conversation, and those runs execute serially by construction (you
      // only request changes once the prior run has settled), so this
      // satisfies "a shard has one writer" exactly as 3.4 requires. Runs with
      // no task (P6.1/6.2's page-anchored runs) shard by their page instead,
      // for the same reason: multiple runs against the same page also
      // execute serially by construction (a human triggers each one) —
      // falling all the way through to `run.id` (always unique) would give
      // every page-scoped run its own throwaway shard and silently drop
      // memory across turns on the same page. `run.id` remains the last
      // resort for a run with neither a task nor a page.
      // A chat session is the strongest conversation identity there is —
      // it is the thread the user is actually looking at — so it wins over
      // task and page. Before sessions existed this fell through to
      // `run.id` for every Work turn, giving each one its own throwaway
      // state.db shard: Hermes started from zero history every message,
      // which is exactly what forced the old transcript-replay workaround.
      conversationId: run.sessionId ?? run.taskId ?? run.pageId ?? run.id,
      enabledSkills: agent.skills,
      args: [...stringArray(runtimeProfile.fixedArgs), ...stringArray(agent.customArgs)],
      permissionMode: agent.permissionMode,
      // Per-agent model/provider/credentials, via the ONE lever Hermes
      // actually exposes: HERMES_HOME. `buildHermesHomeOverlay` already
      // accepts this base and passthrough-links everything in it except
      // `skills`/`memories`/`state.db` — so pointing it at a profile gives
      // this agent that profile's config.yaml (model + provider) and
      // auth.json (credentials) while the run-scoped identity overlay stays
      // fully intact. Undefined falls back to the install root, which is
      // exactly the previous behaviour for every agent that sets no profile.
      //
      // Note this is deliberately NOT done by passing `-p <profile>`: that
      // flag repoints HERMES_HOME *into* the profile directory, silently
      // bypassing the overlay and reverting per-agent skills, memories and
      // per-conversation state to the profile's own. Verified — it fails
      // quietly, with no error, which is the worst way to be wrong.
      baseHermesHome: agentProfileHome,
      // Which strategy materialises this agent's identity on disk. Read off
      // the runtime profile rather than assumed: a runtime with no
      // relocatable home answers 'none', and the agent still gets its
      // instructions because those go into the prompt (`buildPromptText`).
      homeStrategy: typeof runtimeProfile.homeStrategy === 'string' ? runtimeProfile.homeStrategy : 'hermes',
      resumeSessionId,
      mcpServers: plugins.servers,
      // Per-agent values for whatever settings this runtime declares about
      // itself — its model, its effort level, whatever it offers. Ids come
      // from the runtime's own probe, so nothing here names a specific CLI.
      // The agent's defaults, with this turn's own overrides on top. Merged
      // rather than replaced: choosing "high effort" for one message should
      // not silently drop the model that agent is configured to use.
      // Our own team tools need no human approval: the endpoint is ours, the
      // run token authorises it, and role permissions are enforced server-side.
      // Without this a team deadlocks — verified live, a leader asked
      // permission to read its own board and the turn wedged and died.
      autoAllowToolPrefixes: teamBinding ? [`mcp__${TEAM_PLUGIN_NAME}__`] : undefined,
      sessionConfig: (() => {
        // R12-P4.1 - three layers, most specific last.
        //
        // The runtime's own defaults sit UNDERNEATH the agent's, so choosing a
        // model once on the Claude Code runtime applies to every agent that
        // has not overridden it, and a new agent inherits it without being
        // told. The agent's map wins over that, and this turn's override wins
        // over both: picking high effort for one message must not silently
        // drop the model that agent is configured to use.
        const runtimeDefaults =
          runtimeProfile?.defaultSessionConfig && typeof runtimeProfile.defaultSessionConfig === 'object'
            ? (runtimeProfile.defaultSessionConfig as Record<string, unknown>)
            : {}
        const base =
          agent.runtimeConfig && typeof agent.runtimeConfig === 'object'
            ? (agent.runtimeConfig as Record<string, unknown>)
            : {}
        const override = run.runtimeConfig ?? {}
        const merged = { ...runtimeDefaults, ...base, ...override }
        return Object.keys(merged).length > 0 ? merged : undefined
      })(),
      // P5.4: when permissionMode is 'ask', wire the callback that creates a
      // real pending approval and waits for the user to resolve it. Also raise
      // timeouts significantly — the turn can now be blocked waiting for a human.
      ...(agent.permissionMode === 'ask'
        ? {
            permissionCallback: buildPermissionCallback(run, run.accountableUser, 5 * 60 * 1000),
            permissionTimeoutMs: 5 * 60 * 1000,
            turnTimeoutMs: 10 * 60 * 1000,
          }
        : {}),
      // Pillar 4.7 — `run.runToken` is minted fresh by `claimNextRun` and
      // reaches the agent's own process the same way every other
      // identity-scoped value does (HERMES_HOME, per `sendTurnWithIdentity`)
      // — an env var, not a config file or CLI arg, so it never lands on
      // disk anywhere this overlay's cleanup wouldn't already reach. This is
      // only "the credential exists and reaches the agent's environment" —
      // giving the agent an actual mechanism (MCP tool, etc.) to spend it
      // against `POST /api/daemon/page-writes` is separate, real future
      // work, not invented here.
      env: { ...stringEnv(agent.customEnv), ...(run.runToken ? { RUN_TOKEN: run.runToken } : {}) },
      onControl: (control) => {
        runCancelControls.set(run.id, control.cancel)
        // A stop pressed in a different process reaches this turn only through
        // the database, so watch for it. Cleared in the `finally` below along
        // with the control itself.
        const watcher = setInterval(() => {
          void bestEffort(
            isRunCancellationRequested(run.id).then((requested) => {
              if (!requested) return
              clearInterval(watcher)
              void bestEffort(control.cancel(), 'a cancel that throws has still asked the agent to stop', {
                runId: run.id,
              })
            }),
            'a missed cancellation poll is retried on the next tick of this timer',
            { runId: run.id },
          )
        }, CANCEL_POLL_MS)
        watcher.unref?.()
        cancelWatchers.set(run.id, watcher)
      },
      onEvent: (envelope) => {
        const seq = seqBase + envelope.seq


        // THE hot path — everything a viewer sees comes from this line, and
        // it is a synchronous in-process emit (microseconds), not a network
        // round-trip. This app's Postgres is remote (a Supabase pooler in
        // ap-northeast-2), and Hermes streams word-by-word, so routing
        // delivery through the database meant every single word paid a
        // write round-trip AND a read-back round-trip before it could be
        // painted — hundreds of them per reply. That is what made streaming
        // feel laggy rather than live. Ordering doesn't depend on the
        // database either: `envelope.seq` was assigned synchronously in
        // generation order by acp-client.ts before this callback ran.
        publishRunEvent({
          runId: run.id,
          seq,
          event: envelope.event,
          createdAt: new Date().toISOString(),
        })

        // Durability, deliberately off the hot path: the viewer already has
        // this event. These no longer need to be chained one-after-another
        // either — each row carries the `seq` decided above, so concurrent
        // writes can't reorder anything the way they could when the database
        // was the thing handing out sequence numbers. Letting them overlap
        // matters: the database is remote, and serializing ~90 chunk-writes
        // behind each other meant a reply took ~20s to become durable even
        // though it was generated instantly. A failed write costs history,
        // never the live stream or the turn.
        writeBuffer.push({ seq, event: envelope.event })
        // Flush immediately once a batch is worth sending, otherwise let the
        // timer catch the tail of a burst.
        if (writeBuffer.length >= 50) flushWrites()
        else scheduleFlush()
        // The run-card block (6.3) and P5.8's cost-on-task-card both read
        // cost via getRunUsageTotals, which SUMs run_usage — without this,
        // every real dispatched run shows $0.00 forever even though the
        // RunEvent stream genuinely carries real `usage` events. Usage
        // events don't need seq-ordering against the transcript (they're
        // summed, not concatenated), so this one stays a simple best-effort
        // fire-and-forget rather than joining the write queue.
        if (envelope.event.type === 'usage') {
          const usage = envelope.event
          void recordUsage(run.id, {
            provider: usage.provider,
            model: usage.model,
            tokens: usage.tokens,
            costTicks: usage.costTicks,
          }).catch((err) => {
            logger.error('could not record usage for this run', err, {
              ...runFields(run),
              provider: usage.provider,
              model: usage.model,
            })
          })
        }
      },
    })
  } catch (err) {
    // Drain whatever writes are still queued before settling — otherwise a
    // client could see this run reach a terminal `status` (via the SSE
    // route's own safety-net status check) before the last few events it
    // should show are actually in `run_messages` yet.
    flushWrites()
    await writeChain.catch(() => {})
    // R3.8 — this string is written to the `runs` table and rendered in a
    // chat bubble, so it must never carry a credential the agent echoed.
    const message = redactError(err)
    // A turn that was stopped usually ends HERE rather than with a `done`
    // event: the cooperative cancel escalates to killing the process, and what
    // reaches this catch is whatever the transport said as it closed. That
    // text is about a broken pipe, not about the person who pressed Stop, so
    // the database flag is what decides — never the message.
    const cancellationRequested =
      (await bestEffort(
        isRunCancellationRequested(run.id),
        'a stop flag we cannot read settles the run as failed, which is the safe answer of the two',
        { runId: run.id },
      )) ?? false
    const disposition = classifyRunFailure(err, { attempt: run.attempt, cancellationRequested })
    await settleWithDisposition(run, disposition, message)
    if (disposition.outcome === 'failed') notifyRunSettled(payload, run, task, 'failed')
    return { status: disposition.outcome === 'cancelled' ? 'cancelled' : 'failed', error: message }
  } finally {
    decrAgentInFlight(agentId)
    // The turn is over either way — nothing left to interrupt.
    runCancelControls.delete(run.id)
    const watcher = cancelWatchers.get(run.id)
    if (watcher) {
      clearInterval(watcher)
      cancelWatchers.delete(run.id)
    }
  }

  // Same reason as the catch block above — settleRun must never run ahead
  // of the transcript it's settling.
  flushWrites()
  await writeChain.catch(() => {})

  // Record the agent-side session id only when this turn actually established
  // a new one. A resumed turn changed nothing, and writing the same value back
  // is a pointless UPDATE on the hot settle path.
  //
  // When a resume was attempted and failed, the id we stored was dead and this
  // overwrites it — otherwise every future turn would keep retrying the same
  // doomed `session/load` and keep losing the conversation.
  if (run.sessionId && result.sessionId && !result.resumed) {
    await bestEffort(
      setHermesSessionId(run.sessionId, result.sessionId),
      'an unrecorded agent session id costs the next turn its history, not this turn its answer',
      { runId: run.id, sessionId: run.sessionId },
    )
  }
  if (resumeSessionId && result.resumeFailure) {
    logger.warn('could not resume the agent session — started a new one', {
      ...runFields(run),
      hermesSessionId: resumeSessionId,
      reason: result.resumeFailure,
    })
  }
  if (run.sessionId) {
    await bestEffort(touchSession(run.sessionId), 'last-activity bookkeeping must not cost a turn', {
      runId: run.id,
      sessionId: run.sessionId,
    })
  }

  const doneEvent = result.envelopes.find((e) => e.event.type === 'done')?.event
  const succeeded = doneEvent?.type === 'done' && doneEvent.status === 'ok'
  const failureReason = !succeeded ? (doneEvent?.type === 'done' ? doneEvent.reason : 'Turn did not produce a done event.') : undefined

  // A cooperative cancel ends the turn with a real `done` event, which is the
  // whole point of asking rather than killing — everything already streamed is
  // kept. `status: 'cancelled'` is that event saying so, and it is the one
  // signal here that is not a guess about a message.
  const disposition: RunDisposition | null = succeeded
    ? null
    : classifyRunFailure(failureReason, {
        attempt: run.attempt,
        cancellationRequested: doneEvent?.type === 'done' && doneEvent.status === 'cancelled',
      })
  const finalStatus: RunEndState =
    disposition === null ? 'completed' : disposition.outcome === 'cancelled' ? 'cancelled' : 'failed'

  if (disposition === null) {
    await settleRun(run.id, 'completed')
    logger.info('run completed', runFields(run))
  } else {
    // `retryable: !succeeded` — what this used to be — meant every unsuccessful
    // turn came back, including the refusals that will refuse again and the
    // cancellations somebody had just asked to stop.
    await settleWithDisposition(run, disposition, failureReason ?? 'The turn did not succeed.')
  }
  // Every event is durable by now (the allSettled above), so the in-memory
  // replay copy has nothing left to protect against — any late viewer reads
  // this run from the database like any other history.
  clearRunBacklog(run.id)
  notifyRunSettled(payload, run, task, finalStatus)


  // A run started by a channel mention owes that thread an answer.
  //
  // The agent is asked in its prompt to reply with `team_send_message`, and a
  // well-behaved one does. This is the backstop for when it does not — and it
  // matters more than a backstop usually would, because the failure it
  // prevents is the exact one being fixed: you mention an agent and nothing
  // visibly happens. An agent that answered in its own transcript and never
  // posted is indistinguishable, from the channel, from one that ignored you.
  //
  // Skipped when the agent DID post in the thread itself, so a good citizen is
  // never double-posted.
  if (run.channelMessageId) {
    await bestEffort(
      postMentionReply(run, result.envelopes, finalStatus),
      'a backstop reply that fails must not also fail the run it is reporting on',
      { ...runFields(run), channelMessageId: run.channelMessageId },
    )
  }

  return { status: finalStatus, error: failureReason }
}
