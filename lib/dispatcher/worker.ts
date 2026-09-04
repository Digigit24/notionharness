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
import type { Agent, Task } from '@/payload-types'
import type { ApprovalOption } from '@/collections/Approvals'
import type { ApprovalOutcome } from '@/lib/run-events'

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
  const accepted = await requestRunCancellation(runId).catch(() => false)

  // The in-process control remains as the fast path: when the turn happens to
  // be running right here, this cancels within milliseconds rather than
  // waiting for the watcher below to notice.
  const cancel = runCancelControls.get(runId)
  if (cancel) {
    await cancel().catch(() => undefined)
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
      const message = err instanceof Error ? err.message : String(err)
      await settleRun(run.id, 'failed', { error: message, retryable: true }).catch(() => undefined)
      void getPayloadClient()
        .then((payload) => notifyRunSettled(payload, run, null, 'failed'))
        .catch(() => undefined)
      console.error(`[dispatcher] Run ${run.id} failed outside executeRun's own error handling.`, err)
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
    console.error(`[dispatcher] Unhandled rejection executing run ${run.id}.`, err)
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
  const worktree = await getWorktree(worktreeId).catch(() => null)
  if (!worktree || worktree.status === 'removed') return null
  const { existsSync } = await import('node:fs')
  if (!existsSync(worktree.path)) {
    console.warn(
      `[dispatcher] ${describe} points at worktree ${worktree.path}, which is not on disk — using a disposable checkout instead.`,
    )
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
  const session = await getChatSession(run.sessionId).catch(() => null)
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

function buildPromptText(task: Task | null, agent: Agent, run: Run): string {
  const parts: string[] = []
  if (agent.instructions) parts.push(agent.instructions)
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
function notifyRunSettled(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  run: Run,
  task: Task | null,
  status: 'completed' | 'failed',
): void {
  const recipients = new Set<number>([run.accountableUser])
  if (run.originatorUser != null) recipients.add(run.originatorUser)

  void hrefForEntity(payload, 'run', String(run.id))
    .then((url) => {
      const subject = task ? `"${task.title}"` : `run ${run.id}`
      const message = {
        title: status === 'completed' ? 'Run completed' : 'Run failed',
        body: status === 'completed' ? `Your run for ${subject} finished.` : `Your run for ${subject} failed.`,
        url,
      }
      return Promise.all([...recipients].map((userId) => sendPushToUser(userId, 'completion', message)))
    })
    .catch((err) => console.error(`[dispatcher] Failed to push completion notification for run ${run.id}.`, err))
}

function buildPermissionCallback(
  runId: number,
  requestedUserId: number,
  permissionTimeoutMs: number
) {
  return async (params: {
    id: string
    title: string
    detail: string
    options: Array<{ optionId: string; kind: string; label?: string }>
  }): Promise<ApprovalOutcome> => {
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
      .catch((err) => console.error(`[dispatcher] Failed to push approval notification for run ${runId}.`, err))
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

async function executeRun(run: Run): Promise<{ status: 'completed' | 'failed'; error?: string }> {
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
      console.error(`[dispatcher] Failed to renew lease for run ${run.id}.`, err)
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
): Promise<{ status: 'completed' | 'failed'; error?: string }> {
  if (run.agentId == null) {
    await settleRun(run.id, 'failed', { error: 'Run has no agent assigned.', retryable: false })
    return { status: 'failed', error: 'no agent assigned' }
  }
  const agentId = run.agentId

  const agent = await payload
    .findByID({ collection: 'agents', id: agentId, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!agent || agent.enabled === false) {
    await settleRun(run.id, 'failed', { error: 'Agent missing or disabled.', retryable: false })
    return { status: 'failed', error: 'agent missing or disabled' }
  }

  const runtimeProfileId = typeof agent.runtimeProfile === 'number' ? agent.runtimeProfile : agent.runtimeProfile.id
  const runtimeProfile = await payload
    .findByID({ collection: 'runtime-profiles', id: runtimeProfileId, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!runtimeProfile || runtimeProfile.enabled === false) {
    await settleRun(run.id, 'failed', { error: 'Runtime profile missing or disabled.', retryable: false })
    return { status: 'failed', error: 'runtime profile missing or disabled' }
  }

  const task = run.taskId
    ? await payload.findByID({ collection: 'tasks', id: run.taskId, overrideAccess: true, disableErrors: true }).catch(() => null)
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
    ? await getTeamBindingForSession(run.sessionId).catch((err) => {
        console.warn(`[dispatcher] Could not resolve the team slot for run ${run.id}.`, err)
        return null
      })
    : null
  let teamBinding: TeamRunBinding | null = rawTeamBinding
  if (rawTeamBinding && rawTeamBinding.agentId !== agentId) {
    console.warn(
      `[dispatcher] Run ${run.id} (agent ${agentId}) shares a session with team slot ${rawTeamBinding.slotId}, ` +
        `which is filled by agent ${rawTeamBinding.agentId} — dispatching it without team tools.`,
    )
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
    console.warn(
      `[dispatcher] Run ${run.id} is in workspace ${agentWorkspaceId} but team slot ${rawTeamBinding.slotId} ` +
        `belongs to team ${rawTeamBinding.teamId} in workspace ${rawTeamBinding.workspaceId} — ` +
        `dispatching it without team tools.`,
    )
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
    await import('@/lib/teams/registration')
      .then(({ ensureTeamMcpPlugin }) => ensureTeamMcpPlugin(agentWorkspaceId))
      .catch((err) => {
        console.warn(
          `[dispatcher] Run ${run.id} is team ${teamBinding.teamId} slot ${teamBinding.slotId} but the team ` +
            `plugin could not be registered for workspace ${agentWorkspaceId}; this turn has no team tools.`,
          err,
        )
      })
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
        console.warn(`[dispatcher] Could not resolve plugins for run ${run.id}.`, err)
        return { servers: [], skipped: [] }
      })
    : { servers: [], skipped: [] }

  await markRunStarted(run.id)

  if (!run.runToken) {
    // Should be unreachable after this task's fix — `claimNextRun` always
    // mints one now — but surfaced loudly rather than silently sending the
    // agent a turn with no RUN_TOKEN at all if something upstream regresses.
    console.warn(`[dispatcher] Run ${run.id} was claimed with no run_token — page-writes auth will fail for this run.`)
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
    ? await getChatSession(run.sessionId)
        .then((s) => s?.hermesSessionId ?? null)
        .catch(() => null)
    : null

  if (sessionWorktree) {
    runCwd = sessionWorktree.path
    await touchWorktree(sessionWorktree.id).catch(() => undefined)
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
  const seqBase = await getRunSeqBase(run.id).catch(() => 0)
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
        console.error(`[dispatcher] Failed to persist ${batch.length} event(s) for run ${run.id}.`, err)
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
    console.warn(`[dispatcher] Run ${run.id} skipped ${plugins.skipped.length} plugin(s): ${detail}`)
  }

  // Resolved before the spawn so an unknown/typo'd profile fails the run with
  // a clear message, rather than silently running as the install default and
  // leaving someone to wonder why their agent is answering with the wrong
  // model. `resolveProfileHome` also validates the name before it becomes a
  // filesystem path.
  let agentProfileHome: string | undefined
  const configuredProfile = typeof agent.hermesProfile === 'string' ? agent.hermesProfile.trim() : ''
  if (configuredProfile) {
    try {
      agentProfileHome = resolveProfileHome(configuredProfile)
      await access(join(agentProfileHome, 'config.yaml'))
    } catch {
      const message = `Hermes profile "${configuredProfile}" was not found in this Hermes install.`
      await settleRun(run.id, 'failed', { error: message, retryable: false })
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
      text: buildPromptText(task, agent, run),
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
      sessionConfig: (() => {
        const base =
          agent.runtimeConfig && typeof agent.runtimeConfig === 'object'
            ? (agent.runtimeConfig as Record<string, unknown>)
            : {}
        const override = run.runtimeConfig ?? {}
        const merged = { ...base, ...override }
        return Object.keys(merged).length > 0 ? merged : undefined
      })(),
      // P5.4: when permissionMode is 'ask', wire the callback that creates a
      // real pending approval and waits for the user to resolve it. Also raise
      // timeouts significantly — the turn can now be blocked waiting for a human.
      ...(agent.permissionMode === 'ask'
        ? {
            permissionCallback: buildPermissionCallback(run.id, run.accountableUser, 5 * 60 * 1000),
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
          void isRunCancellationRequested(run.id)
            .then((requested) => {
              if (!requested) return
              clearInterval(watcher)
              void control.cancel().catch(() => undefined)
            })
            .catch(() => undefined)
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
            console.error(`[dispatcher] Failed to record usage for run ${run.id}.`, err)
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
    await settleRun(run.id, 'failed', { error: message, retryable: true })
    notifyRunSettled(payload, run, task, 'failed')
    return { status: 'failed', error: message }
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
    await setHermesSessionId(run.sessionId, result.sessionId).catch((err) => {
      console.warn(`[dispatcher] Could not record the agent session id for session ${run.sessionId}.`, err)
    })
  }
  if (resumeSessionId && result.resumeFailure) {
    console.warn(
      `[dispatcher] Run ${run.id} could not resume agent session ${resumeSessionId} (${result.resumeFailure}); started a new one.`,
    )
  }
  if (run.sessionId) {
    await touchSession(run.sessionId).catch(() => undefined)
  }

  const doneEvent = result.envelopes.find((e) => e.event.type === 'done')?.event
  const succeeded = doneEvent?.type === 'done' && doneEvent.status === 'ok'
  const finalStatus: 'completed' | 'failed' = succeeded ? 'completed' : 'failed'
  const failureReason = !succeeded ? (doneEvent?.type === 'done' ? doneEvent.reason : 'Turn did not produce a done event.') : undefined

  await settleRun(run.id, finalStatus, { error: failureReason, retryable: !succeeded })
  // Every event is durable by now (the allSettled above), so the in-memory
  // replay copy has nothing left to protect against — any late viewer reads
  // this run from the database like any other history.
  clearRunBacklog(run.id)
  notifyRunSettled(payload, run, task, finalStatus)

  return { status: finalStatus, error: failureReason }
}
