/**
 * Last-resort process stability guard for asynchronous failures that escape a
 * route boundary. Route handlers still own normal error serialization; this
 * hook only logs an unexpected rejection so it cannot terminate the server.
 * We intentionally do not swallow uncaughtException: continuing after an
 * uncaught synchronous exception can leave application state corrupted.
 *
 * ROADMAP B8.4 — extended (not replaced) to log through `lib/logger.ts`'s
 * structured helper instead of a raw `console.error`, so an unhandled
 * rejection shows up as the same one-JSON-object-per-line shape as every
 * other structured log line this app emits, rather than a differently
 * shaped one-off. This module still can't import Payload-dependent code
 * (see the dispatcher/broker section of AGENTS.md for why — webpack's
 * edge-runtime pass for `instrumentation.ts` can't resolve Payload's
 * Node-only deps); `lib/logger.ts` has zero dependencies of its own, so it's
 * safe to import here (unlike anything reaching into `lib/broker`/`payload`).
 */
import { logger } from './lib/logger'

export function register(): void {
  console.log('[instrumentation] registered')
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled-rejection', reason)
  })
}
