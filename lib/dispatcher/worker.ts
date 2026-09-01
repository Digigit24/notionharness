// ROADMAP — closes the gap the lead flagged after P6.4: task assignment
// already enqueues a broker run (Gate 3+4, `app/(app)/workspace/
// [workspaceSlug]/tasks/actions.ts`'s `enqueueRun` call), and everything
// downstream of "a run exists" was already built and verified in isolation
// — `RunWorktreeManager` (Pillar 4.4), `sendTurnWithIdentity` (Pillar 3.4),
// the broker's claim/settle machinery (Pillar 4) — but nothing actually
// called them in sequence for a claimed run. This is that missing wire.
//
// `dispatchNextRun` claims at most one run and runs it to completion
// (or failure) before returning — the caller decides how to loop (a
// long-running worker process, a cron tick, whatever Pillar 4/5's actual
// deployment model turns out to be; that's a separate concern from "does
// claim → worktree → identity-scoped turn → live event streaming → settle
// work end to end," which is what this module is responsible for).
import { getPayloadClient } from '@/lib/payload'
import { claimNextRun, markRunStarted, settleRun, appendRunEvent, type Run } from '@/lib/broker'
import { RunWorktreeManager } from '@/lib/run-worktrees/manager'
import { resolveRunWorktreeConfig } from '@/lib/run-worktrees/config'
import { sendTurnWithIdentity } from '@/lib/hermes/run-with-identity'
import type { Agent, Task } from '@/payload-types'

export interface DispatchOutcome {
  claimed: boolean
  runId?: number
  status?: 'completed' | 'failed'
  error?: string
}

export async function dispatchNextRun(workerId: string): Promise<DispatchOutcome> {
  const run = await claimNextRun(workerId)
  if (!run) return { claimed: false }

  try {
    const outcome = await executeRun(run)
    return { claimed: true, runId: run.id, ...outcome }
  } catch (err) {
    // Anything unexpected (agent lookup blew up, worktree creation failed,
    // the binary isn't on this machine) is still a run that needs settling
    // — never leave it stuck in 'dispatched'/'running' for the lease
    // sweeper to have to clean up later when it could fail cleanly now.
    const message = err instanceof Error ? err.message : String(err)
    await settleRun(run.id, 'failed', { error: message, retryable: true }).catch(() => undefined)
    return { claimed: true, runId: run.id, status: 'failed', error: message }
  }
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

function buildPromptText(task: Task | null, agent: Agent): string {
  const parts: string[] = []
  if (agent.instructions) parts.push(agent.instructions)
  // Tasks have no description/body field yet (P2.1) — title is the only
  // task-authored content available to hand the agent today. Richer prompt
  // construction (task description, linked page content, thread context)
  // is real future work, not something to fake here.
  parts.push(task ? `Task: ${task.title}` : 'No task is attached to this run.')
  return parts.join('\n\n')
}

async function executeRun(run: Run): Promise<{ status: 'completed' | 'failed'; error?: string }> {
  const payload = await getPayloadClient()

  if (run.agentId == null) {
    await settleRun(run.id, 'failed', { error: 'Run has no agent assigned.', retryable: false })
    return { status: 'failed', error: 'no agent assigned' }
  }

  const agent = await payload
    .findByID({ collection: 'agents', id: run.agentId, overrideAccess: true, disableErrors: true })
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

  const { source, rootDir, baseBranch } = resolveRunWorktreeConfig()
  const manager = new RunWorktreeManager({ rootDir })
  const worktree = await manager.create(source, String(run.id), baseBranch)

  let result
  try {
    result = await sendTurnWithIdentity({
      binaryPath: runtimeProfile.commandName,
      cwd: worktree.worktreePath,
      text: buildPromptText(task, agent),
      runId: String(run.id),
      agentId: run.agentId,
      // Roadmap 3.4: state.db is sharded per CONVERSATION, not per run — a
      // task's chain of runs (original attempt, then a "request changes"
      // follow-up, etc.) is the closest thing this product has to a
      // conversation, and those runs execute serially by construction (you
      // only request changes once the prior run has settled), so this
      // satisfies "a shard has one writer" exactly as 3.4 requires. Falls
      // back to the run's own id for a run with no task at all.
      conversationId: run.taskId ?? run.id,
      enabledSkills: agent.skills,
      args: [...stringArray(runtimeProfile.fixedArgs), ...stringArray(agent.customArgs)],
      env: stringEnv(agent.customEnv),
      onEvent: (envelope) => {
        // Best-effort, fire-and-forget: a dropped live event must never
        // abort the turn itself. `envelopes` in `result` below is still the
        // complete, ordered record this function's own return value is
        // computed from, so nothing is lost even if a single append fails.
        void appendRunEvent(run.id, envelope.event).catch((err) => {
          console.error(`[dispatcher] Failed to append live run event for run ${run.id}.`, err)
        })
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await settleRun(run.id, 'failed', { error: message, retryable: true })
    return { status: 'failed', error: message }
  }

  const doneEvent = result.envelopes.find((e) => e.event.type === 'done')?.event
  const succeeded = doneEvent?.type === 'done' && doneEvent.status === 'ok'
  const finalStatus: 'completed' | 'failed' = succeeded ? 'completed' : 'failed'
  const failureReason = !succeeded ? (doneEvent?.type === 'done' ? doneEvent.reason : 'Turn did not produce a done event.') : undefined

  await settleRun(run.id, finalStatus, { error: failureReason, retryable: !succeeded })

  return { status: finalStatus, error: failureReason }
}
