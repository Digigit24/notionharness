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
  getWorktree,
  touchWorktree,
  type Run,
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

/**
 * Interrupts a run that's still answering. Uses ACP's own `session/cancel`
 * (see acp-client.ts) rather than killing the process, so the agent stops
 * cooperatively and the turn still ends with a real `done` event — whatever
 * it had already streamed stays in the transcript.
 */
export async function requestRunCancel(runId: number): Promise<{ cancelled: boolean }> {
  const cancel = runCancelControls.get(runId)
  if (!cancel) return { cancelled: false }
  await cancel()
  return { cancelled: true }
}

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
 * The project worktree this run should execute in, when its session is bound
 * to one.
 *
 * Returns null for anything unbound, and also for a worktree whose row says
 * it was removed — a stale binding must fall back to a disposable checkout
 * rather than failing the run or, worse, running in a directory that no
 * longer means what it used to.
 */
async function resolveSessionWorktree(run: Run) {
  if (!run.sessionId) return null
  const session = await getChatSession(run.sessionId).catch(() => null)
  if (!session?.worktreeId) return null
  const worktree = await getWorktree(session.worktreeId).catch(() => null)
  if (!worktree || worktree.status === 'removed') return null
  const { existsSync } = await import('node:fs')
  if (!existsSync(worktree.path)) {
    console.warn(
      `[dispatcher] Session ${session.id} points at worktree ${worktree.path}, which is not on disk — using a disposable checkout instead.`,
    )
    return null
  }
  return worktree
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
  parts.push(task ? `Task: ${task.title}` : run.prompt || 'No task is attached to this run.')
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
  const sessionWorktree = await resolveSessionWorktree(run)

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
  // it on settle would empty the review screen for every completed run. They
  // accumulate under the worktree root and need a real retention policy —
  // named here rather than quietly leaked.

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
    const message = err instanceof Error ? err.message : String(err)
    await settleRun(run.id, 'failed', { error: message, retryable: true })
    notifyRunSettled(payload, run, task, 'failed')
    return { status: 'failed', error: message }
  } finally {
    decrAgentInFlight(agentId)
    // The turn is over either way — nothing left to interrupt.
    runCancelControls.delete(run.id)
  }

  // Same reason as the catch block above — settleRun must never run ahead
  // of the transcript it's settling.
  flushWrites()
  await writeChain.catch(() => {})

  // Record the ACP session id against the chat session the moment we have
  // one. `setHermesSessionId` keeps the FIRST id and ignores later ones,
  // because that is the id whose history Hermes can replay — a subsequent
  // turn's fresh id would point at an empty transcript.
  if (run.sessionId && result.sessionId) {
    await setHermesSessionId(run.sessionId, result.sessionId).catch((err) => {
      console.warn(`[dispatcher] Could not record the Hermes session id for session ${run.sessionId}.`, err)
    })
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
