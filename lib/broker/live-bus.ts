import { EventEmitter } from 'node:events'
import type { RunEvent } from '@/lib/run-events'

/**
 * In-process live delivery for run events — the hot path.
 *
 * Why this exists: this app's Postgres is REMOTE (a Supabase pooler in
 * ap-northeast-2), so every database round-trip costs real network latency.
 * The previous delivery path made each streamed chunk pay several of them
 * before it could reach a browser: the dispatcher wrote the event
 * (serialized, so chunk N+1's write couldn't even start until chunk N's had
 * committed), Postgres NOTIFYed, and then the SSE route did *another*
 * round-trip to read the row back. Hermes streams word-by-word, so a normal
 * reply multiplied that by hundreds — which is exactly what "the chunks load
 * so slowly it feels laggy" was.
 *
 * The database is not what makes ordering correct, either: `acp-client.ts`'s
 * `allocSeq()` already assigns every envelope a monotonic `seq`
 * synchronously, in generation order, before it ever leaves the process. So
 * the correct order is known for free, in memory, with no round-trip and no
 * race — the DB's own `next_seq` allocation was only ever re-deriving
 * (badly, under concurrency) something the process already knew.
 *
 * So: the dispatcher publishes here the instant an event is generated, every
 * open SSE stream for that run gets it immediately (an in-process emit —
 * microseconds, no network), and the durable write to Postgres happens
 * asynchronously off to the side. Persistence still matters (reload,
 * multi-viewer, audit, reconnect backfill) — it just no longer sits between
 * the agent and the screen.
 */
export interface LiveRunEvent {
  runId: number
  seq: number
  event: RunEvent
  createdAt: string
}

/** Per-run replay backlog. Measured, not guessed: Hermes does NOT trickle a
 * response out gradually — instrumenting the dispatcher showed every content
 * chunk of a 40-line reply arriving in a single burst at `+0ms` after a
 * ~10s startup pause. A plain emitter drops all of that on the floor when no
 * stream is attached yet (a browser typically connects a beat later, after
 * run discovery), leaving the client to receive the reply only as the
 * durable writes trickled to a database in ap-northeast-2 — about 200ms per
 * chunk, which is exactly the "slow word-by-word printing" this was meant to
 * fix. Buffering the burst means a stream that attaches late still gets the
 * whole thing instantly, from memory. Same idea as hermes-webui's own
 * bounded per-terminal backlog. */
const MAX_BUFFERED_EVENTS_PER_RUN = 5_000

declare global {
  var _notionforgeLiveBus: EventEmitter | undefined
  var _notionforgeLiveBacklog: Map<number, LiveRunEvent[]> | undefined
}

function bus(): EventEmitter {
  if (!global._notionforgeLiveBus) {
    const emitter = new EventEmitter()
    // One listener per open SSE stream, and a busy workspace can easily have
    // more than Node's default 10 — that cap is a footgun here, not a real
    // leak signal.
    emitter.setMaxListeners(0)
    global._notionforgeLiveBus = emitter
  }
  return global._notionforgeLiveBus
}

function backlog(): Map<number, LiveRunEvent[]> {
  if (!global._notionforgeLiveBacklog) global._notionforgeLiveBacklog = new Map()
  return global._notionforgeLiveBacklog
}

/** Publish an event to every stream watching this run, and retain it for
 * streams that attach moments later. Never throws, never blocks. */
export function publishRunEvent(live: LiveRunEvent): void {
  const store = backlog()
  const events = store.get(live.runId) ?? []
  events.push(live)
  if (events.length > MAX_BUFFERED_EVENTS_PER_RUN) events.splice(0, events.length - MAX_BUFFERED_EVENTS_PER_RUN)
  store.set(live.runId, events)

  bus().emit(`run:${live.runId}`, live)
}

/**
 * Subscribe to a run's events. Anything already buffered with `seq` above
 * `sinceSeq` is replayed synchronously, in order, before this returns — so a
 * stream that attaches after the agent already answered still delivers the
 * whole reply immediately rather than waiting on the database. Returns an
 * unsubscribe function.
 */
export function subscribeToRunEvents(
  runId: number,
  sinceSeq: number,
  onEvent: (live: LiveRunEvent) => void,
): () => void {
  const channel = `run:${runId}`
  bus().on(channel, onEvent)

  for (const buffered of backlog().get(runId) ?? []) {
    if (buffered.seq > sinceSeq) onEvent(buffered)
  }

  return () => {
    bus().off(channel, onEvent)
  }
}

/** Drops a finished run's backlog once its transcript is durable. Called by
 * the dispatcher after settling; without it this map would grow for the life
 * of the process. */
export function clearRunBacklog(runId: number): void {
  backlog().delete(runId)
}
