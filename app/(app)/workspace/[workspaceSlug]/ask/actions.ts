'use server'

import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import {
  appendRunEvent,
  enqueueRun,
  getRun,
  listRunEventsForRuns,
  listRunsForAgentStandalone,
  settleRun,
  sweepExpiredLeases,
} from '@/lib/broker'
import { requestRunCancel } from '@/lib/dispatcher/worker'
import type { Run, RunMessageRow } from '@/lib/broker/types'
import { TERMINAL_STATUSES } from '@/lib/broker/types'

/** How many of the agent's most recent completed standalone runs get
 * folded into the next turn's prompt as context. Each `sendTurn` call spawns
 * a brand-new ACP session with zero memory of prior turns (confirmed in
 * acp-client.ts — no session resumption exists yet), so without this every
 * message is a context-less one-shot. This is a deliberately cheap stopgap
 * — literal text replay, not real session persistence — bounded small so it
 * can't blow past the model's own context budget (already seen truncating
 * an 86k-char file at 65280 chars in a real run this session). */
const CONTEXT_EXCHANGE_COUNT = 3
const CONTEXT_REPLY_CHAR_CAP = 600
/** Cap on the *user* side of a replayed exchange. Without this the history
 * snowballed: a run's stored `prompt` is the already-augmented text below,
 * so replaying it verbatim nested the previous three exchanges inside each
 * of the next three, and so on — observed live as a 214K-token first API
 * call (7.7s before the model even started) for a four-message chat. */
const CONTEXT_PROMPT_CHAR_CAP = 1_200
/** Separator between the replayed context and what the user actually typed.
 * `summarizeRunForContext` splits on it to recover the raw message from a
 * stored prompt, so it must stay byte-identical in both places. */
const NEW_MESSAGE_MARKER = '\n\n---\n\nNew message:\n'

/** The raw user message from a stored run prompt, with any context prefix a
 * previous `enqueueAskRun` prepended stripped off. */
function rawUserMessage(prompt: string): string {
  const idx = prompt.lastIndexOf(NEW_MESSAGE_MARKER)
  return idx === -1 ? prompt : prompt.slice(idx + NEW_MESSAGE_MARKER.length)
}

/** Renders one prior run as `User: ...\nAssistant: ...` for the context
 * prefix below. Uses the run's own stored `prompt` (always populated,
 * regardless of when the run happened) for the user side, and the
 * concatenation of every assistant `message` RunEvent for the reply side —
 * same text the UI itself renders, so what gets replayed to the model
 * matches what a human reading the thread would see. Returns null for a run
 * with no assistant reply yet (nothing useful to replay). */
function summarizeRunForContext(run: Run, events: RunMessageRow[]): string | null {
  if (!run.prompt) return null
  const assistantText = events
    .filter((row): row is RunMessageRow & { event: { type: 'message'; role: 'assistant'; text: string } } =>
      row.event.type === 'message' && row.event.role === 'assistant',
    )
    .map((row) => row.event.text)
    .join('')
  if (!assistantText) return null
  const reply =
    assistantText.length > CONTEXT_REPLY_CHAR_CAP
      ? `${assistantText.slice(0, CONTEXT_REPLY_CHAR_CAP)}…`
      : assistantText
  const userText = rawUserMessage(run.prompt)
  const user =
    userText.length > CONTEXT_PROMPT_CHAR_CAP ? `${userText.slice(0, CONTEXT_PROMPT_CHAR_CAP)}…` : userText
  return `User: ${user}\nAssistant: ${reply}`
}

/**
 * The general "Ask" page's send action — the same shape as `enqueuePageRun`
 * (app/(app)/actions.ts) minus the page-context wiring: no `pageId`, so
 * `enqueueRun` gets `taskId: null, pageId: null`, making this a genuinely
 * standalone conversation with one agent (see `listRunsForAgentStandalone`'s
 * own comment for how `runs_task_agent_active_uidx` treats that combination).
 */
export async function enqueueAskRun({
  prompt,
  workspaceId,
  agentId,
}: {
  prompt: string
  workspaceId: number
  agentId: number
}): Promise<{ runId: number }> {
  const text = typeof prompt === 'string' ? prompt.trim() : ''
  if (!text || text.length > 20_000) throw new Error('A prompt between 1 and 20,000 characters is required.')
  if (!Number.isSafeInteger(agentId) || agentId < 1) throw new Error('A valid agent id is required.')

  const [user, payload] = await Promise.all([getCurrentPayloadUser(), getPayloadClient()])
  if (!user) throw new Error('You must be logged in to start a conversation.')

  const agent = await payload
    .findByID({ collection: 'agents', id: agentId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!agent || agent.enabled === false) throw new Error('Agent not found or disabled.')
  const agentWorkspaceId = typeof agent.workspace === 'number' ? agent.workspace : agent.workspace?.id
  if (agentWorkspaceId !== workspaceId) throw new Error("That agent does not belong to this workspace.")

  // Fold recent turns into the prompt actually sent to Hermes (see
  // summarizeRunForContext's own comment for why) — the run's own `prompt`
  // field is what worker.ts's buildPromptText hands the agent, so this is
  // where that has to happen. The RunEvent written below carries the clean,
  // un-augmented `text` instead, so the UI shows exactly what the user
  // typed, never the internal context-stuffing.
  const priorRuns = await listRunsForAgentStandalone(agentId)
  const recentCompleted = priorRuns
    .filter((r) => r.status === 'completed')
    .slice(0, CONTEXT_EXCHANGE_COUNT)
    .reverse() // oldest first, matching natural reading order
  // One batched query for all the history being replayed, not one per run —
  // this runs on the send path, so every extra round-trip to the (remote)
  // database is latency the user feels between hitting Enter and the run
  // actually starting.
  const contextEvents = await listRunEventsForRuns(recentCompleted.map((r) => r.id))
  const exchanges = recentCompleted
    .map((r) => summarizeRunForContext(r, contextEvents.get(r.id) ?? []))
    .filter((s): s is string => s !== null)
  const promptForAgent =
    exchanges.length > 0
      ? `Recent conversation history, for context:\n\n${exchanges.join('\n\n')}${NEW_MESSAGE_MARKER}${text}`
      : text

  let run
  try {
    run = await enqueueRun({
      agentId,
      originatorUser: user.id,
      accountableUser: user.id,
      prompt: promptForAgent,
    })
  } catch (err) {
    // `runs_task_agent_active_uidx` allows only one active run per
    // (task, agent, page) bucket, and a standalone conversation is one
    // bucket per agent — so sending again while the agent is still
    // answering hits it. That's the schema working as intended, but the
    // raw Postgres constraint error surfaced to the user as an unhandled
    // "error occurred in the Server Components render". Translate it into
    // something a person can act on. (The composer also disables itself
    // while a reply is streaming — this is the backstop for the race where
    // the run starts between render and click.)
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('runs_task_agent_active_uidx')) {
      throw new Error('This agent is still answering your last message — wait for it to finish, then send again.')
    }
    throw err
  }

  // Without this, the user's own message never appears anywhere in the
  // event stream — only Hermes's own `session`/`message`/`done` events get
  // written, so the thread UI had literally nothing to render for "what did
  // I just say." seq 1, always — appendRunEvent assigns it atomically, and
  // this is always the very first event for a fresh run, ahead of any
  // session events Hermes itself emits once it starts.
  await appendRunEvent(run.id, { type: 'message', role: 'user', text })

  return { runId: run.id }
}

/**
 * Interrupts the run that's currently answering. Cooperative — this asks the
 * agent to stop via ACP's `session/cancel` (lib/dispatcher/worker.ts's
 * `requestRunCancel`), so everything already streamed stays in the
 * transcript and the turn still settles normally.
 *
 * Returns `cancelled: false` when there was nothing running to stop in this
 * process (already finished, or a different server instance owns it) — the
 * caller treats that as a no-op rather than an error.
 */
export async function cancelAskRun(runId: number): Promise<{ cancelled: boolean }> {
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('A valid run id is required.')
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')

  const result = await requestRunCancel(runId)
  if (result.cancelled) return result

  // No live control for this run means no process in THIS server is executing
  // it — it was orphaned by a restart, or another instance owns it. Stop then
  // did nothing at all and the composer stayed locked behind an "agent is
  // answering" state for a run that would never answer. Settling the row is
  // the honest outcome: the work is not happening, so the record should not
  // claim that it is.
  const run = await getRun(runId)
  if (!run || TERMINAL_STATUSES.includes(run.status)) return { cancelled: true }

  await settleRun(runId, 'cancelled', { error: 'Stopped by the user (no worker was running this run).' })
  return { cancelled: true }
}

export async function getAskRunSnapshots(agentId: number): Promise<{ run: Run; events: RunMessageRow[] }[]> {
  if (!Number.isSafeInteger(agentId) || agentId < 1) throw new Error('A valid agent id is required.')
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')
  const runs = await listRunsForAgentStandalone(agentId)
  // One batched query for every run's events, not one query per run — an
  // agent with a real conversation history (18 runs, confirmed live) was
  // firing 18 concurrent queries via Promise.all against a 3-connection
  // pool, which both stalled this page and starved other routes (the SSE
  // stream, the dispatcher) at the same time. See listRunEventsForRuns's
  // own comment.
  const eventsByRun = await listRunEventsForRuns(runs.map((r) => r.id))
  return runs.map((run) => ({ run, events: eventsByRun.get(run.id) ?? [] }))
}

/**
 * What the stalled-run notice's "Check status" button actually asks.
 *
 * A run row can keep saying `running` long after the process behind it is
 * gone — a server restart mid-run orphans it, and only `sweepExpiredLeases`
 * puts it right, on its own schedule. So this does the sweep first and then
 * reports the truth, which turns "it's been spinning for four minutes" into
 * either "still genuinely working" or "the worker was lost", instead of
 * leaving the reader to guess.
 */
export async function checkAskRunStatus(runId: number): Promise<{
  status: string
  /** True when the row claims to be running but its lease has lapsed — i.e.
   * nothing is actually working on it. */
  workerLost: boolean
  error: string | null
}> {
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('A valid run id is required.')
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')

  // Reclaim first: an expired lease is exactly the case this is called for,
  // and sweeping means the answer below is the settled one rather than a
  // snapshot that the next tick would contradict.
  await sweepExpiredLeases().catch(() => 0)

  const run = await getRun(runId)
  if (!run) return { status: 'unknown', workerLost: false, error: null }

  const leaseLapsed =
    run.leaseExpiresAt != null && new Date(run.leaseExpiresAt).getTime() < Date.now()
  return {
    status: run.status,
    workerLost: run.status === 'running' && leaseLapsed,
    error: run.error,
  }
}
