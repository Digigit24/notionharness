/**
 * RunEvent → chat runtime adapter
 *
 * Converts the canonical RunEventEnvelope stream (Pillar 3.1) into a shape
 * the `<Thread>` chrome renders. Handles message/thought/tool_call/
 * tool_result/terminal/usage/done events.
 */

import type { PermissionOption, RunEventEnvelope } from '@/lib/run-events'

/** An envelope plus when its event actually happened. The wire envelope
 * doesn't carry a timestamp, but `run_messages` rows do — passing it through
 * is what lets the UI show real per-step durations and stable message times
 * instead of "whenever this reducer last ran". */
export type TimedEnvelope = RunEventEnvelope & { createdAt?: string }
import { TERMINAL_STATUSES } from '@/lib/broker/types'
import type { Run, RunMessageRow } from '@/lib/broker/types'

/**
 * A Message in our chat runtime. Combines assistant-ui concepts with
 * RunEvent richness that AI SDK's token-shaped format would flatten.
 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  createdAt: Date
  content: ChatContent[]
  /** Per-turn summary shown under a finished assistant message. Every number
   * is derived from events already in the stream — no extra bookkeeping. */
  stats?: TurnStats
  /** Set when this message's own run ended badly, so the failure can be
   * stated in the transcript instead of only as a status word in a footer. */
  error?: string
  /** Delivery state for a message the client painted before the server
   * confirmed it. Only ever set on the optimistic copy: once the real event
   * arrives from the stream, that copy replaces this one and the status is
   * gone. Absent means "this is a real, stored message". */
  delivery?: 'sending' | 'failed'
  /** Whether the run THIS message belongs to has reached a terminal status.
   * The combined "Ask" thread stitches many runs together, so the thread-level
   * `isRunning` says nothing about an individual message: without this, an
   * unfinished tool call from an hour-old run kept rendering as live and its
   * elapsed counter kept ticking at 1Hz forever, re-rendering the whole
   * transcript every second for runs that ended long ago. */
  runEnded?: boolean
}

export interface TurnStats {
  /** Wall-clock from the turn's first event to its last. */
  durationMs?: number
  tokens: number
  toolCount: number
}

/** Every content block carries the timestamps of its first and last event,
 * so the UI can show how long a step actually took ("thinking · 4.2s",
 * "search · 1.4s") without any additional plumbing — the deltas are free. */
interface Timed {
  startedAt?: string
  endedAt?: string
}

export type ChatContent =
  | ({ type: 'text'; text: string } & Timed)
  | ({ type: 'thinking'; text: string } & Timed)
  | ({
      type: 'tool_call'
      toolCallId: string
      toolName: string
      toolInput: Record<string, unknown>
      toolOutput?: unknown
      isError?: boolean
      /** Paths the call touches, from ACP's own `locations`. */
      toolLocations?: string[]
      /** ACP tool kind: read/edit/search/execute/… */
      toolKind?: string
    } & Timed)
  // A live agent shell command (ACP `terminal/*`, node-pty-backed — see
  // acp-client.ts). Chunks for the same `id` arrive as separate RunEvents
  // and are merged here into one growing block, same as `text`/`thinking`.
  | ({
      type: 'terminal'
      id: string
      text: string
      /** Set once the shell exits. While undefined the block is genuinely
       * live; a run that ends without this arriving is a terminal that died
       * without reporting, which the UI states rather than hides. */
      exitCode?: number | null
      signal?: string | null
      exited?: boolean
    } & Timed)
  // A `session/request_permission` the agent raised mid-turn. Stays
  // interactive only while `outcome` is undefined; the settled event carrying
  // the same `id` fills the rest in and freezes the card.
  | ({
      type: 'permission'
      requestId: string
      title: string
      detail: string
      options: PermissionOption[]
      outcome?: 'selected' | 'cancelled'
      selectedOptionId?: string
      reason?: string
    } & Timed)
  // A file the agent wrote, carrying the unified diff of what changed.
  | ({ type: 'file_change'; path: string; diff: string } & Timed)

/**
 * Metadata about a usage event (tokens, cost, model)
 */
export interface UsageData {
  provider: string
  model: string
  tokens: number
  costTicks: number
}

/**
 * The complete chat thread state built from RunEvent stream
 */
export interface ChatThread {
  runId: string
  messages: ChatMessage[]
  usage: UsageData[]
  isRunning: boolean
  done?: { status: 'ok' | 'error' | 'cancelled'; reason?: string }
  /** Timestamp of the newest event in the thread. The client compares this
   * against the wall clock to tell "still working" apart from "hung" — a run
   * row can say `running` long after its worker died (an orphaned run after a
   * restart is exactly how this was found), so run status alone cannot be
   * trusted to mean anything is still happening. */
  lastEventAt?: string
}

/** Appends `text` to `content`'s trailing block if it's the same `kind`
 * (merging consecutive stream chunks into one growing bubble), otherwise
 * starts a new block of that kind. Pure — mutates the passed array only. */
function appendOrMergeText(content: ChatContent[], kind: 'text' | 'thinking', text: string, at?: string): void {
  const last = content[content.length - 1]
  if (last && last.type === kind) {
    last.text += text
    last.endedAt = at ?? last.endedAt
  } else {
    content.push({ type: kind, text, startedAt: at, endedAt: at })
  }
}

/** Returns `current` unchanged if it's already an in-progress assistant
 * message, otherwise creates and appends a fresh one. Deliberately returns
 * a value for the caller to assign back to its own `current` binding
 * (`current = ensureAssistantMessage(...)`) rather than mutating a captured
 * variable itself — a closure that reassigns an outer `let` defeats
 * TypeScript's control-flow narrowing of that variable at every later read
 * (it collapses to `never` instead of `ChatMessage | null`), which is what
 * a prior version of this function ran into. */
function ensureAssistantMessage(
  thread: ChatThread,
  current: ChatMessage | null,
  seq: number,
  at?: string,
): ChatMessage {
  if (current) return current
  // Real event time, not `new Date()` — the previous version stamped every
  // message with whenever the reducer happened to run, so timestamps
  // changed on every re-render and were meaningless for history.
  const msg: ChatMessage = {
    id: `msg-${seq}`,
    role: 'assistant',
    createdAt: at ? new Date(at) : new Date(),
    content: [],
  }
  thread.messages.push(msg)
  return msg
}

/**
 * Accumulate RunEventEnvelopes into a ChatThread.
 *
 * Hermes streams assistant text and thinking incrementally — one
 * `agent_message_chunk`/`agent_thought_chunk` RunEvent per fragment, not one
 * event per complete message (see acp-client.ts's own comment on
 * `normaliseSessionUpdate`: "streamed incrementally"). A prior version of
 * this function turned every one of those fragments into its own top-level
 * `ChatMessage`, which (a) rendered as a burst of tiny separate bubbles
 * instead of one bubble growing smoothly, and (b) accumulated thinking/
 * tool-call bubbles into a side buffer that only ever got attached to
 * whichever text-fragment message happened to be last, silently dropping
 * everything else. This version instead keeps one running "current
 * assistant message" per turn and appends each fragment onto its last
 * content block when the types match, so consecutive chunks of the same
 * kind grow in place — the actual mechanism behind "smooth streaming."
 */
export function adaptRunEventsToThread(envelopes: TimedEnvelope[]): ChatThread {
  const thread: ChatThread = {
    runId: envelopes[0]?.runId ?? '',
    messages: [],
    usage: [],
    isRunning: true,
  }

  // The in-progress assistant message for the current turn, and where to
  // find each open tool call's content block within it so a later
  // `tool_result` can attach to the right one even if other tool calls or
  // text fragments arrived in between.
  let current: ChatMessage | null = null
  let toolIndexByCallId = new Map<string, number>()

  // Turn-level counters, all derived from events already in the stream.
  let firstAt: string | undefined
  let lastAt: string | undefined
  let tokens = 0
  let toolCount = 0

  for (const env of envelopes) {
    const event = env.event
    const at = env.createdAt
    if (at) {
      if (!firstAt) firstAt = at
      lastAt = at
    }

    switch (event.type) {
      case 'message': {
        if (event.role === 'assistant') {
          const wasNew = current === null
          current = ensureAssistantMessage(thread, current, env.seq, at)
          if (wasNew) toolIndexByCallId = new Map()
          appendOrMergeText(current.content, 'text', event.text, at)
        } else {
          // A user (or system) message ends the current assistant turn —
          // the next assistant fragment starts a fresh message/bubble.
          current = null
          thread.messages.push({
            id: `msg-${env.seq}`,
            role: event.role,
            createdAt: at ? new Date(at) : new Date(),
            content: [{ type: 'text', text: event.text, startedAt: at, endedAt: at }],
          })
        }
        break
      }

      case 'thought': {
        const wasNew = current === null
        current = ensureAssistantMessage(thread, current, env.seq, at)
        if (wasNew) toolIndexByCallId = new Map()
        appendOrMergeText(current.content, 'thinking', event.text, at)
        break
      }

      case 'terminal': {
        const wasNew = current === null
        current = ensureAssistantMessage(thread, current, env.seq, at)
        if (wasNew) toolIndexByCallId = new Map()
        const content = current.content
        const last = content[content.length - 1]
        if (last && last.type === 'terminal' && last.id === event.id) {
          last.text += event.chunk
          last.endedAt = at ?? last.endedAt
        } else {
          content.push({ type: 'terminal', id: event.id, text: event.chunk, startedAt: at, endedAt: at })
        }
        break
      }

      case 'terminal_exit': {
        // Attach to the block it closes rather than appending anything — an
        // exit is a property of the terminal, not a new thing on screen.
        const target = current
          ? [...current.content].reverse().find((c) => c.type === 'terminal' && c.id === event.id)
          : undefined
        if (target && target.type === 'terminal') {
          target.exited = true
          target.exitCode = event.exitCode
          target.signal = event.signal
          target.endedAt = at ?? target.endedAt
        }
        break
      }

      case 'tool_call': {
        const wasNew = current === null
        current = ensureAssistantMessage(thread, current, env.seq, at)
        if (wasNew) toolIndexByCallId = new Map()
        // A `tool_call_update` that carries only a status (no content) is
        // normalised into another `tool_call` event with the SAME id — so
        // pushing unconditionally rendered a second card for one call, and
        // double-counted it in the turn footer. Update in place instead, and
        // let a later update fill in fields the first event lacked (Hermes
        // often sends `locations` only on the update).
        const existingIdx = toolIndexByCallId.get(event.id)
        const existingBlock = existingIdx != null ? current.content[existingIdx] : undefined
        if (existingBlock && existingBlock.type === 'tool_call') {
          if (event.name) existingBlock.toolName = event.name
          if (event.locations?.length) existingBlock.toolLocations = event.locations
          if (event.kind) existingBlock.toolKind = event.kind
          if (Object.keys(event.input).length > 0) existingBlock.toolInput = event.input
          break
        }
        toolCount += 1
        current.content.push({
          type: 'tool_call',
          toolCallId: event.id,
          toolName: event.name,
          toolInput: event.input,
          toolLocations: event.locations,
          toolKind: event.kind,
          startedAt: at,
        })
        toolIndexByCallId.set(event.id, current.content.length - 1)
        break
      }

      case 'tool_result': {
        const idx = toolIndexByCallId.get(event.id)
        if (current && idx != null) {
          const block = current.content[idx]
          if (block?.type === 'tool_call') {
            block.toolOutput = event.output
            block.isError = event.isError
            block.endedAt = at
          }
        }
        break
      }

      case 'usage': {
        tokens += event.tokens
        thread.usage.push({
          provider: event.provider,
          model: event.model,
          tokens: event.tokens,
          costTicks: event.costTicks,
        })
        break
      }

      case 'done': {
        thread.isRunning = false
        thread.done = {
          status: event.status,
          reason: event.reason,
        }
        break
      }

      // Permission, file_change, session and page_write are handled
      // separately by the UI layer — not part of the bubble content flow.
      case 'permission': {
        const wasNew = current === null
        current = ensureAssistantMessage(thread, current, env.seq, at)
        if (wasNew) toolIndexByCallId = new Map()
        // The settled event updates the card the request opened rather than
        // appending a second one — searched from the end because the same
        // request id is never reused within a turn.
        const existing = [...current.content]
          .reverse()
          .find((c) => c.type === 'permission' && c.requestId === event.id)
        if (existing && existing.type === 'permission') {
          existing.outcome = event.outcome
          existing.selectedOptionId = event.selectedOptionId
          existing.reason = event.reason
          existing.endedAt = at ?? existing.endedAt
        } else {
          current.content.push({
            type: 'permission',
            requestId: event.id,
            title: event.title,
            detail: event.detail,
            options: event.options,
            outcome: event.outcome,
            selectedOptionId: event.selectedOptionId,
            reason: event.reason,
            startedAt: at,
            endedAt: event.outcome ? at : undefined,
          })
        }
        break
      }

      case 'file_change': {
        const wasNew = current === null
        current = ensureAssistantMessage(thread, current, env.seq, at)
        if (wasNew) toolIndexByCallId = new Map()
        current.content.push({
          type: 'file_change',
          path: event.path,
          diff: event.diff,
          startedAt: at,
          endedAt: at,
        })
        break
      }

      case 'session':
      case 'page_write':
        break
    }
  }

  // Attach the turn's summary to its last assistant message, so a finished
  // answer can state what it cost right where it ends.
  // The stall watchdog's whole input. `lastAt` is already tracked above for
  // turn duration, so exposing it costs nothing — no extra pass, no timer,
  // no additional state anywhere on the streaming path.
  thread.lastEventAt = lastAt
  const lastAssistant = [...thread.messages].reverse().find((m) => m.role === 'assistant')
  if (lastAssistant) {
    lastAssistant.stats = {
      durationMs: firstAt && lastAt ? new Date(lastAt).getTime() - new Date(firstAt).getTime() : undefined,
      tokens,
      toolCount,
    }
    if (thread.done && thread.done.status !== 'ok') {
      lastAssistant.error = thread.done.reason || `Run ${thread.done.status}`
    }
  }

  return thread
}

/**
 * Combines several runs' events into ONE continuous ChatThread — what the
 * "Ask" page's standalone conversation needs (a real back-and-forth, not
 * just the latest one-off run rendered in isolation) since each send today
 * still creates its own separate `runs` row (see ask/actions.ts's own
 * comment on why: no ACP session resumption exists yet). Runs are ordered
 * oldest-first by `createdAt`.
 *
 * Calls `adaptRunEventsToThread` ONCE PER RUN, never on a flattened
 * cross-run array, and concatenates the resulting `messages` — each call
 * gets its own fresh `current`/`toolIndexByCallId` state, so one run's
 * assistant reply can never merge into another's. A first version flattened
 * every run's events into one array and relied on each run's leading `user`
 * message event to reset that state — real, confirmed bug live: a run
 * enqueued before `enqueueAskRun` started writing that event (this feature
 * is new) has no such event, so its assistant text kept appending onto
 * whatever the PREVIOUS run in the array had left open, interleaving two
 * unrelated runs' text into one scrambled-looking bubble ("A is one dragon
 * humanity's of oldest most and enduring a: creature of..." — two separate
 * dragon-essay runs merged mid-sentence). Per-run isolation makes that
 * impossible regardless of what any individual run's event history looks
 * like — it doesn't depend on every run having a clean leading boundary
 * event.
 */
/**
 * Per-run memo for `adaptRunEventsToThread`.
 *
 * The combined thread is rebuilt on every frame-aligned flush while a reply
 * streams, and without this that meant re-reducing EVERY run in the
 * conversation — including the dozens of finished ones whose events cannot
 * change — many times a second. Harmless at 20 messages, quadratic-feeling
 * at 200. Only the run currently receiving events actually needs redoing,
 * and its `events.length` changes every time, so a length+last-seq key
 * invalidates exactly when it should and never when it shouldn't.
 *
 * Keyed by run id in a Map that only ever holds one entry per run in the
 * open conversation, so it can't grow unbounded the way a global cache
 * would.
 */
const runThreadCache = new Map<number, { count: number; lastSeq: number; thread: ChatThread }>()

function adaptRunCached(run: Run, events: RunMessageRow[]): ChatThread {
  const lastSeq = events.length > 0 ? events[events.length - 1].seq : 0
  const cached = runThreadCache.get(run.id)
  if (cached && cached.count === events.length && cached.lastSeq === lastSeq) return cached.thread

  const envelopes: TimedEnvelope[] = events.map((row) => ({
    runId: String(run.id),
    seq: row.seq,
    event: row.event,
    createdAt: row.createdAt,
  }))
  const thread = adaptRunEventsToThread(envelopes)
  runThreadCache.set(run.id, { count: events.length, lastSeq, thread })
  return thread
}

export function adaptRunSnapshotsToThread(snapshots: Array<{ run: Run; events: RunMessageRow[] }>): ChatThread {
  const sorted = [...snapshots].sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt))

  const messages: ChatMessage[] = []
  const usage: UsageData[] = []
  let done: ChatThread['done']
  let lastEventAt: string | undefined

  for (const { run, events } of sorted) {
    const runThread = adaptRunCached(run, events)
    if (runThread.lastEventAt && (!lastEventAt || runThread.lastEventAt > lastEventAt)) {
      lastEventAt = runThread.lastEventAt
    }
    // Prefix ids with the run id — each run's own `seq` restarts at 1, so
    // `msg-${seq}` alone would collide across runs once concatenated.
    const runEnded = TERMINAL_STATUSES.includes(run.status)
    for (const m of runThread.messages) messages.push({ ...m, id: `run${run.id}-${m.id}`, runEnded })
    usage.push(...runThread.usage)
    // Deliberately overwritten, never accumulated: a previous run's `done`
    // must not describe the current one. Without the reset below, a finished
    // run left a green "OK: end_turn" sitting in the status strip above an
    // actively running (or stalled) turn — two contradictory claims at once.
    done = runThread.done
  }

  // The broker's own `status` on the most recent run is authoritative for
  // "is this conversation still going right now" — not whichever run
  // happened to emit a `done` event last, which is wrong when an earlier
  // (completed) run is followed by a later one that hasn't emitted `done`
  // yet (e.g. crashed and got reclaimed by sweepExpiredLeases rather than
  // settleRun — lib/broker/runs.ts's own documented case).
  const latestRun = sorted[sorted.length - 1]?.run

  return {
    runId: latestRun ? String(latestRun.id) : '',
    messages,
    usage,
    isRunning: latestRun ? !TERMINAL_STATUSES.includes(latestRun.status) : false,
    done,
    // Falls back to the newest run's own creation time so a run that has
    // been claimed but has not emitted anything yet still has a clock to
    // measure a stall against — otherwise the very failure mode this exists
    // to catch (a worker that dies before its first event) would be the one
    // case with nothing to compare.
    lastEventAt: lastEventAt ?? latestRun?.createdAt,
  }
}
