import { NextRequest } from 'next/server'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { getPayloadClient } from '@/lib/payload'
import { CHANNEL_EVENTS_CHANNEL, CHANNEL_TYPING_CHANNEL, subscribeToNotifications } from '@/lib/broker'
import { getChannel, isChannelMember } from '@/app/(app)/workspace/[workspaceSlug]/teams/data'
import { logger } from '@/lib/logger'

// Same reasoning as app/api/runs/[id]/events/stream/route.ts: SSE needs a
// long-lived Node connection, never Edge (the `pg` pool is Node-only) and
// never statically optimized.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * R12-P3.3/P3.5 — the channel's push transport, and the reason it carries no
 * room DATA at all.
 *
 * `app/api/runs/[id]/events/stream/route.ts` streams EVENTS, because a run's
 * transcript is exactly one append-only sequence and replaying it is the whole
 * feature. A channel is not that: threads, reactions, unread, approvals and
 * the roster's liveness are five different reads with five different shapes,
 * already served correctly by `pollTeamRoomAction` and already covered by
 * `test-channels.ts`/`test-channel-approvals.ts`. Re-deriving all of that
 * inside a stream handler would be a second implementation of the same
 * queries, guaranteed to drift from the first the next time either one is
 * touched.
 *
 * So this route carries exactly two kinds of frame:
 *
 *   - `refresh` — "something in this room changed; call `pollTeamRoomAction`
 *     now instead of waiting for your next timer tick." No payload beyond
 *     that, because the client already knows how to ask for a delta.
 *   - `typing`  — the one piece of state with nowhere to be fetched FROM,
 *     because nothing about it is ever written to a table (see
 *     `notifyTyping`'s own comment). This frame IS the data.
 *
 * That is what turns the room's six-second blind poll into a push-triggered
 * one without touching the tested read path at all: the room still calls the
 * same action it always did, just on a signal instead of a timer.
 */
const HEARTBEAT_INTERVAL_MS = 20_000

/** Safety net matching P3.3's own "Done when": if the NOTIFY connection is
 * ever down (a dropped LISTEN, or the notification arriving while it was
 * reconnecting — `lib/broker/notify.ts` documents both), the room must still
 * catch up well inside a minute rather than hang indefinitely. This is NOT
 * the six-second interval it replaces; it is the reconciliation sweep that
 * remains once the fast path exists. */
const FALLBACK_REFRESH_INTERVAL_MS = 60_000

function frame(type: 'refresh' | 'typing', data: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

async function userCanReadChannel(userId: number, teamId: number): Promise<{ workspaceId: number } | null> {
  const team = await getChannel(teamId)
  if (!team) return null
  const payload = await getPayloadClient()
  const workspace = await payload
    .findByID({ collection: 'workspaces', id: team.workspaceId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!workspace) return null
  const ownerId = typeof workspace.owner === 'number' ? workspace.owner : workspace.owner?.id
  const memberIds = Array.isArray(workspace.members)
    ? workspace.members.map((member) => (typeof member === 'number' ? member : member.id))
    : []
  const inWorkspace = ownerId === userId || memberIds.includes(userId)
  if (!inWorkspace) return null
  // Same "same sentence as missing" posture `requireChannel` uses for a
  // private channel — this route answers 404 either way, below.
  if (team.isPrivate && !(await isChannelMember(teamId, userId))) return null
  return { workspaceId: team.workspaceId }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const user = await getCurrentPayloadUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  const { teamId: teamIdParam } = await params
  const teamId = Number(teamIdParam)
  if (!Number.isSafeInteger(teamId) || teamId < 1) {
    return new Response('Invalid channel id', { status: 400 })
  }

  const access = await userCanReadChannel(user.id, teamId)
  if (!access) return new Response('Not found', { status: 404 })

  const encoder = new TextEncoder()
  let closed = false
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let fallbackTimer: ReturnType<typeof setInterval> | null = null
  let unsubscribeEvents: (() => void) | null = null
  let unsubscribeTyping: (() => void) | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (closed) return
        closed = true
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        if (fallbackTimer) clearInterval(fallbackTimer)
        if (unsubscribeEvents) unsubscribeEvents()
        if (unsubscribeTyping) unsubscribeTyping()
        try {
          controller.close()
        } catch {
          // Already closed by the consumer disconnecting.
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

      // The push path. Every notification on the shared channel carries EVERY
      // room's events — see `notifyChannelEvent`'s own comment on why this is
      // one `LISTEN` for the whole install rather than one per open room — so
      // this filters to the team the connection is actually for.
      subscribeToNotifications(CHANNEL_EVENTS_CHANNEL, (payload) => {
        if (closed) return
        try {
          const parsed = JSON.parse(payload) as { teamId?: number }
          if (parsed.teamId === teamId) enqueue(frame('refresh'))
        } catch {
          // Malformed payload from some other emitter — the fallback timer
          // still covers this room regardless.
        }
      })
        .then((unsub) => {
          if (closed) unsub()
          else unsubscribeEvents = unsub
        })
        .catch((err) => logger.error('channel event notify subscribe failed', err, { teamId }))

      subscribeToNotifications(CHANNEL_TYPING_CHANNEL, (payload) => {
        if (closed) return
        try {
          const parsed = JSON.parse(payload) as { teamId?: number; slotId?: number; at?: number }
          if (parsed.teamId === teamId && typeof parsed.slotId === 'number') {
            enqueue(frame('typing', { slotId: parsed.slotId, at: parsed.at ?? Date.now() }))
          }
        } catch {
          // A dropped typing frame is cosmetic — see notifyTyping's comment.
        }
      })
        .then((unsub) => {
          if (closed) unsub()
          else unsubscribeTyping = unsub
        })
        .catch((err) => logger.error('channel typing notify subscribe failed', err, { teamId }))

      fallbackTimer = setInterval(() => enqueue(frame('refresh')), FALLBACK_REFRESH_INTERVAL_MS)

      // Immediate catch-up on connect — the same reason a reconnecting
      // EventSource must not wait a full interval before its first refresh:
      // whatever changed while this tab was closed, or while it was between
      // connections, is caught here rather than up to a minute later.
      enqueue(frame('refresh'))
    },
    cancel() {
      closed = true
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (fallbackTimer) clearInterval(fallbackTimer)
      if (unsubscribeEvents) unsubscribeEvents()
      if (unsubscribeTyping) unsubscribeTyping()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
