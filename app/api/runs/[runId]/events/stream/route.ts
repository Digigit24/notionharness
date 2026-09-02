import { NextRequest } from 'next/server'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import { getRun, listRunEventsSince, TERMINAL_STATUSES } from '@/lib/broker'
import type { Run, RunMessageRow } from '@/lib/broker/types'

// SSE needs a long-lived, uncached, Node-runtime connection — never the
// Edge runtime (the `pg` pool in lib/broker/db.ts is Node-only) and never
// statically optimized (this route's whole point is to stay open and push).
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Server-side poll cadence feeding the SSE push. Client-visible latency is
 * this interval, not the old 2s `setInterval` poll it replaces — see
 * ROADMAP P5.7. Deliberately not faster: `getBrokerPool()` caps at 3
 * connections against a small-tier Postgres instance shared by every
 * teammate's dev server (lib/broker/db.ts), and every open run tab now
 * holds one of these loops for as long as the run stays open. */
const POLL_INTERVAL_MS = 1000

/** How many poll ticks between safety-net run.status checks (below). */
const STATUS_CHECK_EVERY_N_TICKS = 5

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
 * of the run's two possible owners (a task or a page) it actually has —
 * runs are one or the other, never both (see lib/broker/types.ts's `Run`).
 * Session identity always comes from `getCurrentPayloadUser()`, never a
 * client-supplied header (AGENTS.md's Approvals precedent). */
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
 * ROADMAP P5.7 — replaces the client-side 2s `setInterval` poll
 * (components/runs/use-run-event-stream.ts) with a push-based SSE stream.
 * Still polls the DB, but server-side on a short interval, which is the
 * pragmatic middle ground this repo has: no LISTEN/NOTIFY or message-bus
 * infrastructure exists yet to push writes out without polling *something*.
 * The win is moving that poll off N open browser tabs and onto one
 * server-side loop per open tab that pushes instantly instead of the client
 * re-fetching everything on a fixed clock regardless of whether anything
 * changed.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const user = await getCurrentPayloadUser()
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { runId: runIdParam } = await params
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
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let tick = 0

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (closed) return
        closed = true
        if (pollTimer) clearTimeout(pollTimer)
        if (heartbeatTimer) clearInterval(heartbeatTimer)
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

      const poll = async () => {
        if (closed) return
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
          // Checked far less often than the event poll since it's a second
          // query against the same capped pool.
          tick += 1
          if (!done && tick % STATUS_CHECK_EVERY_N_TICKS === 0) {
            const current = await getRun(runId)
            if (current && TERMINAL_STATUSES.includes(current.status)) done = true
          }

          if (done) {
            cleanup()
            return
          }
        } catch (err) {
          // Transient DB hiccup: keep the connection open and retry next
          // tick, same "stay usable while the daemon/DB blips" stance the
          // client-side poll this replaces already took.
          console.error(`[runs/${runId}/events/stream] poll failed`, err)
        }
        if (!closed) pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
      }

      void poll()
    },
    cancel() {
      // Client disconnected (tab closed, navigated away, EventSource
      // torn down): `start`'s `cleanup` also runs via the `abort` listener
      // above, but `closed` is guarded so whichever fires first wins.
      closed = true
      if (pollTimer) clearTimeout(pollTimer)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
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
