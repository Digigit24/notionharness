import { Client } from 'pg'
import { EventEmitter } from 'node:events'
import { bestEffort } from '@/lib/failures'
import { logger } from '@/lib/logger'

/** Channel `appendRunEvent` (messages.ts) NOTIFYs on after every insert, and
 * this module LISTENs on — the push half of the P5.7 SSE route's
 * "persist-then-broadcast" path. One dedicated Postgres connection for the
 * whole server process, not one per open browser tab: the shared instance
 * has a real, low connection cap (see db.ts's pool-sizing note), so this
 * must never scale with concurrent viewers. */
const CHANNEL = 'run_events'

/**
 * The one connection now carries more than one channel.
 *
 * `run_events` was the only subscriber until an approval waiter needed to be
 * woken across processes (`lib/hermes/approval-helpers.ts`). The obvious
 * alternative — a second dedicated `Client` for the approvals channel — was
 * rejected for the reason stated above: the shared Postgres instance has a low
 * connection cap, and "one more long-lived connection per thing that wants a
 * push" is how an installation runs out of them. LISTEN is cheap and a single
 * connection can carry any number of channels, so the set is tracked here and
 * re-issued on every dial, including a reconnect after a dropped connection —
 * without which a reconnect would silently resume delivering only whichever
 * channel happened to re-subscribe first.
 */
declare global {
  var _notionforgeRunEventEmitter: EventEmitter | undefined
  var _notionforgeListenClient: Client | null | undefined
  var _notionforgeListenConnecting: Promise<void> | null | undefined
  var _notionforgeListenChannels: Set<string> | undefined
}

function subscribedChannels(): Set<string> {
  if (!global._notionforgeListenChannels) global._notionforgeListenChannels = new Set<string>()
  return global._notionforgeListenChannels
}

/** LISTEN takes an identifier, not a bound parameter, so the name is
 * interpolated. Every channel name in this codebase is a module-level
 * constant, and this makes that fact enforced rather than assumed. */
function assertChannelName(channel: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(channel)) {
    throw new Error(`Refusing to LISTEN on "${channel}": a channel name must be a plain lower-case identifier.`)
  }
  return channel
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

async function ensureListening(channel: string): Promise<void> {
  subscribedChannels().add(assertChannelName(channel))
  await dial()
  // Issued after the dial rather than inside it so a channel added while the
  // connection already exists starts delivering immediately. LISTEN is
  // idempotent, so repeating it for a channel already registered costs one
  // cheap round-trip and changes nothing.
  const client = global._notionforgeListenClient
  if (client) await client.query(`LISTEN ${channel}`)
}

async function dial(): Promise<void> {
  if (global._notionforgeListenClient) return
  if (global._notionforgeListenConnecting) {
    await global._notionforgeListenConnecting
    return
  }

  global._notionforgeListenConnecting = (async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URI || '' })

    client.on('notification', (msg) => {
      if (!msg.channel) return
      // The generic path: every subscriber to this channel gets the raw
      // payload. Emitted before the run-specific decoding below so a
      // malformed `run_events` payload cannot swallow an unrelated channel.
      getEmitter().emit(`channel:${msg.channel}`, msg.payload ?? '')

      if (msg.channel !== CHANNEL || !msg.payload) return
      try {
        const { runId } = JSON.parse(msg.payload) as { runId: number }
        // Kept as its own emit rather than folded into the generic path: a
        // busy workspace has one SSE stream per open transcript, and making
        // each of them parse every other run's notification would turn one
        // decode per event into N.
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
      logger.error('LISTEN connection error — will reconnect on the next subscribe', err, { channel: CHANNEL })
      global._notionforgeListenClient = null
      void bestEffort(
        client.end(),
        'a connection that is already broken cannot fail to close in a way that matters',
      )
    })
    client.on('end', () => {
      global._notionforgeListenClient = null
    })

    await client.connect()
    // Every channel anyone has ever subscribed to in this process, not just
    // the one that triggered this dial: after a reconnect the emitter still
    // holds the other channels' listeners, and re-issuing only one of them
    // would leave those listeners attached to a connection that never
    // delivers to them again.
    for (const name of subscribedChannels()) await client.query(`LISTEN ${name}`)
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
  await ensureListening(CHANNEL).catch((err) => {
    logger.error('could not establish the LISTEN connection — falling back to polling only', err, { runId })
  })
  const emitter = getEmitter()
  const event = `run:${runId}`
  emitter.on(event, onNotify)
  return () => emitter.off(event, onNotify)
}

/**
 * Push wake-ups for one named channel, payload and all.
 *
 * The general form of `subscribeToRunNotifications`, for a caller that has to
 * be woken by something a DIFFERENT PROCESS did — the case that motivated it
 * is an approval waiter parked inside a turn, settled by an HTTP request that
 * may be served anywhere (`lib/hermes/approval-helpers.ts`).
 *
 * Resolves even when the connection cannot be established, exactly as
 * `subscribeToRunNotifications` does and for the same reason: a subscriber
 * that treats this as its only delivery mechanism is already wrong, so
 * throwing here would convert a degraded push into a hard failure. Every
 * caller is expected to have a slower fallback of its own.
 */
export async function subscribeToNotifications(
  channel: string,
  onNotify: (payload: string) => void,
): Promise<() => void> {
  await ensureListening(channel).catch((err) => {
    logger.error('could not establish the LISTEN connection — falling back to polling only', err, { channel })
  })
  const emitter = getEmitter()
  const event = `channel:${channel}`
  emitter.on(event, onNotify)
  return () => emitter.off(event, onNotify)
}

export const RUN_EVENTS_CHANNEL = CHANNEL
