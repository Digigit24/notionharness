/**
 * Last-resort process stability guard for asynchronous failures that escape a
 * route boundary. Route handlers still own normal error serialization; this
 * hook only logs an unexpected rejection so it cannot terminate the server.
 * We intentionally do not swallow uncaughtException: continuing after an
 * uncaught synchronous exception can leave application state corrupted.
 */
export function register(): void {
  process.on('unhandledRejection', (reason: unknown) => {
    console.error('[unhandled-rejection]', reason)
  })
}
