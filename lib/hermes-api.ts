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
export const HERMES_BASE_URL = process.env.HERMES_API_BASE_URL || ''
export const HERMES_API_KEY = process.env.HERMES_API_KEY || ''

/**
 * Every Hermes-proxying route should call this before doing anything else,
 * so an unconfigured installation gets one clear, actionable error instead
 * of a confusing downstream failure (an empty-string URL reaching `fetch`,
 * or a request silently going nowhere).
 */
export function assertHermesConfigured(): void {
  if (!HERMES_BASE_URL) {
    throw new Error(
      'Hermes is not configured: set HERMES_API_BASE_URL (and HERMES_API_KEY if your Hermes requires one).',
    )
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
  if (!HERMES_BASE_URL) {
    return NextResponse.json(
      { error: 'Hermes is not configured. Set HERMES_API_BASE_URL (and HERMES_API_KEY if required).' },
      { status: 503 },
    )
  }

  const { hermesPath, searchParams, ...fetchOptions } = options

  const url = new URL(`${HERMES_BASE_URL}${hermesPath}`)
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) {
        if (Array.isArray(value)) {
          for (const v of value) {
            url.searchParams.append(key, v)
          }
        } else {
          url.searchParams.set(key, value)
        }
      }
    }
  }

  const headers: HeadersInit = {
    'Authorization': `Bearer ${HERMES_API_KEY}`,
    'Content-Type': 'application/json',
    ...(fetchOptions.headers || {}),
  }

  const response = await fetch(url.toString(), {
    ...fetchOptions,
    headers,
  })

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
