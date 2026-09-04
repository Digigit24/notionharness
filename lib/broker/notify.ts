import { Client } from 'pg'
import { EventEmitter } from 'node:events'

/** Channel `appendRunEvent` (messages.ts) NOTIFYs on after every insert, and
 * this module LISTENs on — the push half of the P5.7 SSE route's
 * "persist-then-broadcast" path. One dedicated Postgres connection for the
 * whole server process, not one per open browser tab: the shared instance
 * has a real, low connection cap (see db.ts's pool-sizing note), so this
 * must never scale with concurrent viewers. */
const CHANNEL = 'run_events'

declare global {
  var _notionforgeRunEventEmitter: EventEmitter | undefined
  var _notionforgeListenClient: Client | null | undefined
  var _notionforgeListenConnecting: Promise<void> | null | undefined
}

function getEmitter(): EventEmitter {
  if (!global._notionforgeRunEventEmitter) {
    const emitter = new EventEmitter()
    // Many concurrently open SSE routes each subscribe to their own run's
    // channel on this one emitter — the default 10-listener cap is a normal
    // Node footgun here, not a real leak signal.
    emitter.setMaxListeners(0)
    global._notionforgeRunEventEmitter = emitter
  }
  return global._notionforgeRunEventEmitter
}

async function ensureListening(): Promise<void> {
  if (global._notionforgeListenClient) return
  if (global._notionforgeListenConnecting) {
    await global._notionforgeListenConnecting
    return
  }

  global._notionforgeListenConnecting = (async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URI || '' })

    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return
      try {
        const { runId } = JSON.parse(msg.payload) as { runId: number }
        if (typeof runId === 'number') getEmitter().emit(`run:${runId}`)
      } catch {
        // Malformed payload — the SSE route's own fallback poll (see
        // stream/route.ts's FALLBACK_POLL_INTERVAL_MS) still catches up.
      }
    })

    // A dropped LISTEN connection must not silently stop push delivery
    // forever: clear the cached client so the next subscribe re-dials.
    // Every open SSE route still has its own fallback poll in the meantime.
    client.on('error', (err) => {
      console.error('[broker/notify] LISTEN connection error, will reconnect on next subscribe', err)
      global._notionforgeListenClient = null
      client.end().catch(() => {})
    })
    client.on('end', () => {
      global._notionforgeListenClient = null
    })

    await client.connect()
    await client.query(`LISTEN ${CHANNEL}`)
    global._notionforgeListenClient = client
  })()

  try {
    await global._notionforgeListenConnecting
  } catch (err) {
    global._notionforgeListenClient = null
    throw err
  } finally {
    global._notionforgeListenConnecting = null
  }
}

/** Subscribes to push wake-ups for one run's new events — call `onNotify`
 * whenever `appendRunEvent` writes a row for `runId`, so the SSE route can
 * poll immediately instead of waiting for its fallback timer. Returns an
 * unsubscribe function; safe to call from many concurrent SSE routes since
 * they all share the one LISTEN connection above. If the LISTEN connection
 * can't be established, this resolves anyway (as a no-op subscription) —
 * the caller's fallback poll is what guarantees delivery in that case, not
 * this function throwing. */
export async function subscribeToRunNotifications(runId: number, onNotify: () => void): Promise<() => void> {
  await ensureListening().catch((err) => {
    console.error('[broker/notify] failed to establish LISTEN connection — falling back to polling only', err)
  })
  const emitter = getEmitter()
  const event = `run:${runId}`
  emitter.on(event, onNotify)
  return () => emitter.off(event, onNotify)
}

export const RUN_EVENTS_CHANNEL = CHANNEL
