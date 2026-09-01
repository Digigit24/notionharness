/**
 * Last-resort process stability guard for asynchronous failures that escape a
 * route boundary. Route handlers still own normal error serialization; this
 * hook only logs an unexpected rejection so it cannot terminate the server.
 * We intentionally do not swallow uncaughtException: continuing after an
 * uncaught synchronous exception can leave application state corrupted.
 */
export function register(): void {
  console.log('[instrumentation] registered')
  process.on('unhandledRejection', (reason: unknown) => {
    console.error('[unhandled-rejection]', reason)
  })

  // ROADMAP Pillar 4/6.1 — `lib/dispatcher/worker.ts`'s `dispatchNextRun`
  // exists and is verified against the real hermes-acp binary, but nothing
  // in the running app ever called it: task assignment enqueued a broker
  // run that then sat 'queued' forever. This is the minimal real caller —
  // a polling loop, dogfood-appropriate for this stage (a dedicated daemon
  // process is real future work per Pillar 4.1, not something to fake here).
  // Node-only: dispatchNextRun pulls in `pg`/Payload/child_process, none of
  // which exist in the edge runtime.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    startDispatcherLoop()
  }
}

function startDispatcherLoop(): void {
  const g = globalThis as unknown as { __notionforgeDispatcherStarted?: boolean }
  // Next dev can call register() more than once per process (hot reload) —
  // guard against stacking a second overlapping interval on top of the first.
  if (g.__notionforgeDispatcherStarted) return
  g.__notionforgeDispatcherStarted = true

  const workerId = `local-${process.pid}`
  let inFlight = false
  setInterval(() => {
    if (inFlight) return
    inFlight = true
    import('./lib/dispatcher/worker')
      .then(({ dispatchNextRun }) => dispatchNextRun(workerId))
      .then((outcome) => {
        if (outcome.claimed) {
          console.log(`[dispatcher] run ${outcome.runId} -> ${outcome.status}${outcome.error ? `: ${outcome.error}` : ''}`)
        }
      })
      .catch((err) => console.error('[dispatcher] loop error', err))
      .finally(() => {
        inFlight = false
      })
  }, 3000)
  console.log('[dispatcher] polling loop started')
}
