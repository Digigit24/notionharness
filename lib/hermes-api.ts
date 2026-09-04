import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'

// Exported (not just module-private) so lib/search.ts can call Hermes's
// skills API directly for the command bar's explicit "Skills" filter —
// see that file's own comment for why skills search is a filter-triggered,
// out-of-band query rather than part of the hot-path full-text search.
//
// No hardcoded fallback (Phase C's C1.0 removed one — a specific
// developer's own Tailscale hostname baked into source, which meant nobody
// else could point this app at their own Hermes without editing checked-in
// code). `HERMES_API_BASE_URL` is required; see `assertHermesConfigured`.
// REWIRED 2026-09-04 — these proxies now talk to the LOCAL Hermes dashboard
// server (`hermes serve`), not to a remote `HERMES_API_BASE_URL`.
//
// The old target was Hermes's *gateway* API server
// (`gateway/platforms/api_server.py`): an OpenAI-compatible chat surface with
// bearer `API_SERVER_KEY` auth. It does not implement `/api/skills`,
// `/api/mcp/servers`, `/api/profiles` or `/api/memories` at all — those live
// only on the dashboard server (`hermes_cli/web_server.py` + `web_routers/`),
// which is the same backend the Hermes desktop app spawns. So every page
// built on these proxies was calling endpoints that were never there; the
// agent Memories tab's permanent "Failed to load memories" was the most
// visible symptom, and the skills and MCP views were quietly empty for the
// same reason. See `lib/hermes/serve-supervisor.ts` for how the server is
// started and authenticated.
//
// `profile` is forwarded verbatim, which is what makes every one of these
// screens per-profile: the dashboard API scopes almost every route to a
// profile's own HERMES_HOME when given `?profile=<name>`.
import { getServeEndpoint } from '@/lib/hermes/serve-supervisor'

/** Retained only so existing callers keep compiling; nothing reads it now. */
export const HERMES_BASE_URL = process.env.HERMES_API_BASE_URL || ''
export const HERMES_API_KEY = process.env.HERMES_API_KEY || ''

/**
 * A few call sites were written against endpoint names the dashboard server
 * spells differently. Translating here keeps those routes working unchanged
 * rather than leaving them silently 404ing, and each entry records the real
 * path verified against the running server.
 */
const PATH_MAP: Record<string, string> = {
  '/api/crons': '/api/cron/jobs',
  '/api/crons/create': '/api/cron/jobs',
  '/api/models': '/api/model/options',
}

function mapPath(hermesPath: string): string {
  return PATH_MAP[hermesPath] ?? hermesPath
}

/** Throws when Hermes cannot be located at all — kept for callers that
 * pre-flight before proxying. The dashboard server is started on demand, so
 * the only hard requirement is knowing where Hermes is installed. */
export function assertHermesConfigured(): void {
  if (!process.env.HERMES_HOME_BASE) {
    throw new Error('Hermes is not configured: set HERMES_HOME_BASE to your Hermes install directory.')
  }
}

export interface HermesProxyOptions extends RequestInit {
  hermesPath: string
  searchParams?: Record<string, string | string[] | undefined>
}

export async function proxyToHermes(options: HermesProxyOptions) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { hermesPath, searchParams, ...fetchOptions } = options

  let baseUrl: string
  let token: string
  try {
    const endpoint = await getServeEndpoint()
    baseUrl = endpoint.baseUrl
    token = endpoint.token
  } catch (err) {
    // A failed start is an operational problem worth naming precisely, not a
    // generic 500 — this is the message that tells someone their Hermes
    // install path is wrong or the server could not boot.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not reach the Hermes server.' },
      { status: 503 },
    )
  }

  const url = new URL(`${baseUrl}${mapPath(hermesPath)}`)
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) {
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(key, v)
        } else {
          url.searchParams.set(key, value)
        }
      }
    }
  }

  const headers: HeadersInit = {
    'X-Hermes-Session-Token': token,
    'Content-Type': 'application/json',
    ...(fetchOptions.headers || {}),
  }

  let response: Response
  try {
    response = await fetch(url.toString(), {
      ...fetchOptions,
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'The Hermes server did not respond.' },
      { status: 504 },
    )
  }

  const data = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    parsed = data
  }

  return NextResponse.json(parsed, { status: response.status })
}

export async function hermesGet(
  hermesPath: string,
  searchParams?: Record<string, string | string[] | undefined>
) {
  return proxyToHermes({ hermesPath, searchParams, method: 'GET' })
}

export async function hermesPost(
  hermesPath: string,
  body?: unknown,
  searchParams?: Record<string, string | string[] | undefined>
) {
  return proxyToHermes({
    hermesPath,
    searchParams,
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  })
}

export async function hermesPatch(
  hermesPath: string,
  body?: unknown
) {
  return proxyToHermes({
    hermesPath,
    method: 'PATCH',
    body: body ? JSON.stringify(body) : undefined,
  })
}

export async function hermesDelete(
  hermesPath: string,
  body?: unknown
) {
  return proxyToHermes({
    hermesPath,
    method: 'DELETE',
    body: body ? JSON.stringify(body) : undefined,
  })
}
