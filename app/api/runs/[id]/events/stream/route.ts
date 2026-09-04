import { NextRequest } from 'next/server'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import {
  getRun,
  listRunEventsSince,
  subscribeToRunEvents,
  subscribeToRunNotifications,
  TERMINAL_STATUSES,
} from '@/lib/broker'
import type { Run, RunMessageRow } from '@/lib/broker/types'
import { logger } from '@/lib/logger'

// SSE needs a long-lived, uncached, Node-runtime connection — never the
// Edge runtime (the `pg` pool in lib/broker/db.ts is Node-only) and never
// statically optimized (this route's whole point is to stay open and push).
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Safety-net poll cadence — NOT the client-visible latency anymore. A
 * Postgres `LISTEN`/`NOTIFY` push (lib/broker/notify.ts) wakes this route
 * within milliseconds of `appendRunEvent` committing; this timer only
 * covers the case where that push connection is ever down (reconnecting,
 * or notifications lost across its own reconnect), so a viewer still
 * catches up within this interval instead of hanging indefinitely. Safe to
 * keep long — it's not the primary delivery path — which also matters
 * because `getBrokerPool()` caps at 4 connections against a small-tier
 * Postgres instance shared by every teammate's dev server (lib/broker/db.ts)
 * and every open run tab holds one of these loops for as long as the run
 * stays open. */
const FALLBACK_POLL_INTERVAL_MS = 10_000

const HEARTBEAT_INTERVAL_MS = 15_000

function sseFrame(runId: number, row: RunMessageRow): string {
  // `id:` carries the seq so a native EventSource reconnect can send it back
  // as `Last-Event-ID` — the SSE-native resume mechanism this route prefers
  // over relying on the client re-deriving `?since=` itself.
  const data = JSON.stringify({ runId, seq: row.seq, event: row.event, createdAt: row.createdAt })
  return `id: ${row.seq}\ndata: ${data}\n\n`
}

/** Same workspace-membership check `enqueuePageRun` and the
 * `/api/pages/[id]/live-state` route already use, resolved through whichever
 * of the run's possible owners it actually has — a task, a page, or (the
 * "Ask" page's standalone conversations — see `listRunsForAgentStandalone`'s
 * own comment) neither, in which case the run's own agent is the only
 * remaining way to find its workspace. Session identity always comes from
 * `getCurrentPayloadUser()`, never a client-supplied header (AGENTS.md's
 * Approvals precedent). */
async function userCanReadRun(userId: number, run: Run): Promise<boolean> {
  const payload = await getPayloadClient()

  let workspaceId: number | undefined
  if (run.taskId != null) {
    const task = await payload
      .findByID({ collection: 'tasks', id: run.taskId, depth: 0, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    workspaceId = task ? (typeof task.workspace === 'number' ? task.workspace : task.workspace?.id) : undefined
  } else if (run.pageId != null) {
    const page = await payload
      .findByID({ collection: 'pages', id: run.pageId, depth: 0, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    workspaceId = page ? (typeof page.workspace === 'number' ? page.workspace : page.workspace?.id) : undefined
  } else if (run.agentId != null) {
    const agent = await payload
      .findByID({ collection: 'agents', id: run.agentId, depth: 0, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    workspaceId = agent ? (typeof agent.workspace === 'number' ? agent.workspace : agent.workspace?.id) : undefined
  }
  if (typeof workspaceId !== 'number') return false

  const workspace = await payload
    .findByID({ collection: 'workspaces', id: workspaceId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!workspace) return false

  const ownerId = typeof workspace.owner === 'number' ? workspace.owner : workspace.owner?.id
  const memberIds = Array.isArray(workspace.members)
    ? workspace.members.map((member) => (typeof member === 'number' ? member : member.id))
    : []
  return ownerId === userId || memberIds.includes(userId)
}

/**
 * ROADMAP P5.7 + Pillar 4.5's "direct hot path" intent — push-based SSE with
 * the database out of the delivery path entirely.
 *
 * Three sources feed this stream, in descending order of how much they
 * matter to how fast it feels:
 *
 *  1. The in-process live bus (lib/broker/live-bus.ts) — THE hot path. The
 *     dispatcher publishes each event the instant Hermes generates it, and
 *     this route forwards it with zero network hops. This is what makes
 *     streaming feel live instead of laggy: Postgres is remote (a Supabase
 *     pooler in ap-northeast-2) and Hermes streams word-by-word, so routing
 *     delivery through it charged every single word a write round-trip plus
 *     a read-back before it could paint.
 *  2. A one-time backfill on connect (and on reconnect, resumed from
 *     `Last-Event-ID`/`?since=`) so history and missed events still arrive.
 *  3. Postgres `LISTEN`/`NOTIFY` + a slow fallback poll — resilience only,
 *     covering events published by some other process, or a live event
 *     missed while this stream was mid-connect.
 *
 * Ordering never depends on any of this: `seq` is assigned synchronously in
 * generation order inside acp-client.ts, and every source above carries it
 * through unchanged, with `sinceSeq` gating out anything already sent.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentPayloadUser()
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { id: runIdParam } = await params
  const runId = Number(runIdParam)
  if (!Number.isSafeInteger(runId) || runId < 1) {
    return new Response('Invalid run id', { status: 400 })
  }

  const run = await getRun(runId)
  if (!run) {
    return new Response('Run not found', { status: 404 })
  }
  if (!(await userCanReadRun(user.id, run))) {
    return new Response('You do not have access to this run.', { status: 403 })
  }

  // `Last-Event-ID` (a native EventSource reconnect) wins over `?since=`
  // (only present/meaningful on the very first connect, before any frame
  // carrying an `id:` has ever been received). Both headers/params are
  // `string | null` — `Number(null)` is `0`, not `NaN`, so the "is this
  // header even present" check has to happen before the `Number(...)` cast,
  // or an absent Last-Event-ID would always win over a real `?since=`.
  const lastEventIdHeader = req.headers.get('last-event-id')
  const sinceParam = req.nextUrl.searchParams.get('since')
  const headerSeq = lastEventIdHeader !== null ? Number(lastEventIdHeader) : NaN
  const querySeq = sinceParam !== null ? Number(sinceParam) : NaN
  let sinceSeq = Number.isFinite(headerSeq) && headerSeq >= 0
    ? headerSeq
    : Number.isFinite(querySeq) && querySeq >= 0
      ? querySeq
      : 0

  const encoder = new TextEncoder()
  let closed = false
  let fallbackTimer: ReturnType<typeof setInterval> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let liveUnsubscribe: (() => void) | null = null
  // Coalesces a NOTIFY that arrives while a poll triggered by the previous
  // one is still in flight, so overlapping polls never race each other's
  // `sinceSeq` reads — the in-flight poll's own re-check at the end covers
  // whatever the new NOTIFY would have found anyway.
  let polling = false
  let pollAgain = false
  let pollAgainCheckStatus = false

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (closed) return
        closed = true
        if (fallbackTimer) clearInterval(fallbackTimer)
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        if (unsubscribe) unsubscribe()
        if (liveUnsubscribe) liveUnsubscribe()
        try {
          controller.close()
        } catch {
          // Already closed by the consumer disconnecting — nothing to do.
        }
      }

      const enqueue = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          cleanup()
        }
      }

      req.signal.addEventListener('abort', cleanup)

      heartbeatTimer = setInterval(() => enqueue(`: heartbeat\n\n`), HEARTBEAT_INTERVAL_MS)

      // THE hot path. The dispatcher publishes each event to this in-process
      // bus the instant Hermes generates it (lib/broker/live-bus.ts), so a
      // chunk reaches the browser without waiting on the remote database at
      // all — no write round-trip, no read-back. Everything below this
      // (backfill, fallback poll, NOTIFY) exists for history and resilience,
      // not for live delivery.
      //
      // `sinceSeq` still gates it so a live event that the initial backfill
      // below already sent can't be emitted twice, and so a reconnecting
      // client never regresses.
      // `sinceSeq` is passed in so anything the agent already produced before
      // this stream attached is replayed from memory immediately, instead of
      // the client having to wait for those rows to reach a database on the
      // other side of the world. Measured: Hermes emits a whole reply in one
      // instant burst, so without this replay a stream that connects a beat
      // later sees nothing live at all and falls back to the (much slower)
      // durable path.
      liveUnsubscribe = subscribeToRunEvents(runId, sinceSeq, (live) => {
        if (closed || live.seq <= sinceSeq) return
        sinceSeq = live.seq
        enqueue(sseFrame(runId, { seq: live.seq, event: live.event, createdAt: live.createdAt }))
        if (live.event.type === 'done') cleanup()
      })

      const poll = async (opts: { checkStatus?: boolean } = {}) => {
        if (closed) return
        if (polling) {
          pollAgain = true
          if (opts.checkStatus) pollAgainCheckStatus = true
          return
        }
        polling = true
        try {
          const rows = await listRunEventsSince(runId, sinceSeq)
          let done = false
          for (const row of rows) {
            sinceSeq = Math.max(sinceSeq, row.seq)
            enqueue(sseFrame(runId, row))
            if (row.event.type === 'done') done = true
          }

          // Safety net: a run can reach a terminal status without ever
          // emitting a `done` RunEvent (e.g. a worker crash reclaimed by
          // sweepExpiredLeases rather than settleRun — lib/broker/runs.ts).
          // Only checked on the fallback timer's own tick, not on every
          // NOTIFY-triggered poll, since it's a second query against the
          // same capped pool.
          if (!done && opts.checkStatus) {
            const current = await getRun(runId)
            if (current && TERMINAL_STATUSES.includes(current.status)) done = true
          }

          if (done) {
            cleanup()
            return
          }
        } catch (err) {
          // Transient DB hiccup: keep the connection open. The NOTIFY
          // subscription and the fallback timer both still fire again
          // regardless, so this isn't the last chance to catch up.
          logger.error('run event poll failed', err, { runId })
        } finally {
          polling = false
          if (!closed && pollAgain) {
            const checkStatus = pollAgainCheckStatus
            pollAgain = false
            pollAgainCheckStatus = false
            void poll({ checkStatus })
          }
        }
      }

      // Push path: a Postgres NOTIFY (fired by appendRunEvent, relayed by
      // lib/broker/notify.ts's shared LISTEN connection) wakes this
      // immediately instead of waiting for the fallback timer below — this
      // is what turns the client-visible latency from ~1s into low
      // milliseconds. If the LISTEN connection is ever down,
      // subscribeToRunNotifications still resolves (as a no-op), and
      // FALLBACK_POLL_INTERVAL_MS below is what keeps this route working
      // regardless.
      subscribeToRunNotifications(runId, () => void poll())
        .then((unsub) => {
          if (closed) {
            unsub()
            return
          }
          unsubscribe = unsub
        })
        .catch((err) => logger.error('run event notify subscribe failed', err, { runId }))

      fallbackTimer = setInterval(() => void poll({ checkStatus: true }), FALLBACK_POLL_INTERVAL_MS)

      void poll({ checkStatus: true })
    },
    cancel() {
      // Client disconnected (tab closed, navigated away, EventSource
      // torn down): `start`'s `cleanup` also runs via the `abort` listener
      // above, but `closed` is guarded so whichever fires first wins.
      closed = true
      if (fallbackTimer) clearInterval(fallbackTimer)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (unsubscribe) unsubscribe()
      if (liveUnsubscribe) liveUnsubscribe()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disables response buffering on nginx-fronted deployments so frames
      // reach the client as they're written rather than batched.
      'X-Accel-Buffering': 'no',
    },
  })
}
