// Supervises the one Hermes dashboard server this app talks to.
//
// WHY THIS EXISTS, and why it replaces the old `lib/hermes-api.ts` proxy:
// the previous control-plane routes (skills, MCP, memories, models) pointed
// `HERMES_API_BASE_URL` at a remote Hermes *gateway* — a different server
// (`gateway/platforms/api_server.py`, OpenAI-compatible, bearer
// `API_SERVER_KEY`) that does not implement `/api/skills`, `/api/mcp/*` or
// `/api/memories` at all. That is why the agent Memories tab has always said
// "Failed to load memories": it was asking a server that never had the
// endpoint, over an auth scheme that server does not use.
//
// `hermes serve` is the RIGHT server: it is byte-for-byte the backend the
// Hermes desktop app spawns (`apps/desktop/electron/backend-command.ts` runs
// `hermes serve --host 127.0.0.1 --port 0`) and the same one `hermes
// dashboard` serves its web UI from. Using it means parity with Hermes's own
// UI by construction rather than by re-implementation.
//
// VERIFIED LIVE (2026-09-04, this machine, before any of this was written):
//   - `hermes serve --host 127.0.0.1 --port 9119 --skip-build` is ready in
//     ~3s and prints `HERMES_BACKEND_READY port=9119` on stdout.
//   - `GET /api/health` is unauthenticated: {"ok":true,"version":"0.20.0",
//     "auth_required":false}.
//   - Authentication in loopback mode is the ephemeral session token, which
//     the server takes from `HERMES_DASHBOARD_SESSION_TOKEN` when set
//     (`hermes_cli/web_server.py:346`), sent back as `X-Hermes-Session-Token`
//     (`web_server.py:350`). So injecting our own token at spawn is how we
//     get an authenticated client without scraping anything.
//   - Nearly every route takes `?profile=<name>`, scoping the call to that
//     profile's HERMES_HOME (`_config_profile_scope`/`_profile_scope`).
//     Confirmed with real data: `/api/model/info` returns gpt-5.4-mini at the
//     root, gpt-5.6-terra for `ritik`, MiniMax-M3 for `digitech-ops`.
//
// That last point is the architectural payoff: ONE server, profile as a
// query parameter. No per-profile process pool, no port bookkeeping.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { buildSpawnEnv } from './spawn-env'
import { hermesRoot } from './profiles'

export interface ServeEndpoint {
  baseUrl: string
  token: string
  /** True when this process spawned the server rather than attaching. */
  spawned: boolean
}

const DEFAULT_PORT = Number(process.env.HERMES_SERVE_PORT || 9119)
const HOST = process.env.HERMES_SERVE_HOST || '127.0.0.1'
const READY_TIMEOUT_MS = 90_000
const HEALTH_POLL_MS = 250

/**
 * The token is persisted, not regenerated per process, so a Next.js restart
 * re-attaches to the server the previous process spawned instead of
 * orphaning it and starting another. Same reasoning as the globalThis pool
 * caching elsewhere in this codebase, one level further out: the expensive
 * thing here is a 3-second Python process start, and dev restarts are
 * frequent.
 */
function tokenPath(): string {
  return join(homedir(), '.notionforge', 'hermes', 'serve-token')
}

async function loadOrCreateToken(): Promise<string> {
  const path = tokenPath()
  try {
    const existing = (await readFile(path, 'utf-8')).trim()
    if (existing.length >= 32) return existing
  } catch {
    // First run.
  }
  const token = randomBytes(32).toString('base64url')
  await mkdir(join(homedir(), '.notionforge', 'hermes'), { recursive: true })
  await writeFile(path, token, { mode: 0o600 })
  return token
}

async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(2_000),
      cache: 'no-store',
    })
    if (!res.ok) return false
    const body = (await res.json()) as { ok?: boolean }
    return body.ok === true
  } catch {
    return false
  }
}

/**
 * True when the server on `baseUrl` accepts OUR token. A server started by
 * the Hermes desktop app has its own ephemeral token and will reject ours;
 * that is a different server we must not try to drive, so we detect it here
 * rather than failing later on every call.
 */
async function acceptsOurToken(baseUrl: string, token: string): Promise<boolean> {
  try {
    // `/api/profiles` is token-protected and read-only — the cheapest probe
    // that actually exercises authentication.
    const res = await fetch(`${baseUrl}/api/profiles`, {
      headers: { 'X-Hermes-Session-Token': token },
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    })
    return res.status !== 401 && res.status !== 403
  } catch {
    return false
  }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('Could not allocate a port.'))))
    })
  })
}

function hermesBinary(): string {
  return join(hermesRoot(), 'hermes-agent', 'venv', 'Scripts', process.platform === 'win32' ? 'hermes.exe' : 'hermes')
}

async function spawnServer(port: number, token: string): Promise<void> {
  const binary = hermesBinary()
  const child = spawn(
    binary,
    // `--skip-build` serves the prebuilt web dist (confirmed present at
    // hermes_cli/web_dist). Without it, a first start can try to run npm.
    ['serve', '--host', HOST, '--port', String(port), '--skip-build'],
    {
      env: buildSpawnEnv({
        // Always spawn at the INSTALL ROOT, never a profile: a profile launch
        // reroutes to the machine-level server instead of starting one
        // (`hermes_cli/main.py:10340`). Per-profile work is done with
        // `?profile=` on each request.
        HERMES_HOME: hermesRoot(),
        HERMES_DASHBOARD_SESSION_TOKEN: token,
      }) as NodeJS.ProcessEnv,
      // Detached and unref'd on purpose: the server outlives this Next.js
      // process so a dev restart re-attaches (see `loadOrCreateToken`) rather
      // than paying the start cost again. It is stopped explicitly via
      // `stopServeServer()` / `hermes serve --stop`, not by our exit.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    // The one line worth surfacing; the rest is plugin-discovery noise.
    if (text.includes('HERMES_BACKEND_READY')) console.log(`[hermes-serve] ${text.trim()}`)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim()
    if (text) console.warn(`[hermes-serve] ${text.slice(0, 500)}`)
  })
  child.on('error', (err) => console.error('[hermes-serve] failed to start:', err))
  child.unref()
}

async function waitForReady(baseUrl: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isHealthy(baseUrl)) return
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
  }
  throw new Error(
    `Hermes dashboard server did not become ready at ${baseUrl} within ${READY_TIMEOUT_MS / 1000}s. ` +
      'Check that `hermes serve` runs manually.',
  )
}

// Single-flight across concurrent callers AND across HMR module reloads —
// without the globalThis cache, every hot reload in dev would spawn another
// server (the exact class of leak this codebase already fixed for the DB
// pools).
const globalForServe = globalThis as unknown as {
  __hermesServeEndpoint?: Promise<ServeEndpoint>
}

async function resolveEndpoint(): Promise<ServeEndpoint> {
  const token = await loadOrCreateToken()
  const preferred = `http://${HOST}:${DEFAULT_PORT}`

  if (await isHealthy(preferred)) {
    if (await acceptsOurToken(preferred, token)) {
      return { baseUrl: preferred, token, spawned: false }
    }
    // Someone else's server (most likely the Hermes desktop app) holds this
    // port. Run our own beside it rather than fighting over it.
    const port = await findFreePort()
    const baseUrl = `http://${HOST}:${port}`
    await spawnServer(port, token)
    await waitForReady(baseUrl)
    return { baseUrl, token, spawned: true }
  }

  await spawnServer(DEFAULT_PORT, token)
  await waitForReady(preferred)
  return { baseUrl: preferred, token, spawned: true }
}

/**
 * The base URL and token for the Hermes dashboard server, starting it if it
 * is not already running. Concurrent callers share one start.
 */
export function getServeEndpoint(): Promise<ServeEndpoint> {
  if (!globalForServe.__hermesServeEndpoint) {
    globalForServe.__hermesServeEndpoint = resolveEndpoint().catch((err) => {
      // Never cache a failure: the next call should retry, not inherit a
      // permanently rejected promise.
      globalForServe.__hermesServeEndpoint = undefined
      throw err
    })
  }
  return globalForServe.__hermesServeEndpoint
}

/** Forgets the cached endpoint so the next call re-probes and, if needed, re-spawns. */
export function resetServeEndpoint(): void {
  globalForServe.__hermesServeEndpoint = undefined
}
