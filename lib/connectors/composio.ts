import 'server-only'

import { getPayloadClient } from '@/lib/payload'
import { failure, raise, type AppFailure } from '@/lib/failures'
import { logger } from '@/lib/logger'

/**
 * The only module in this app allowed to read `workspaces.composioApiKey`.
 *
 * WHY `fetch` AND NOT `@composio/core`. The SDK is not installed — there is no
 * `@composio` directory under `node_modules` and no `composio` entry in
 * `package.json` (checked 2026-09-04). Adding a dependency whose surface could
 * not be executed against a real key would mean writing code against method
 * names taken from prose, never once run; the handoff flags exactly that risk
 * ("VERIFY the exact method names and signatures against the SDK version you
 * install"). The REST API publishes a machine-readable contract instead: every
 * request and response shape below was generated from
 * `https://backend.composio.dev/api/v3/openapi.json`, downloaded and parsed on
 * 2026-09-04, so the field names came from the server rather than from a
 * paragraph. A live round trip still has not happened — no key was available —
 * but the shapes are not guesses.
 *
 * WHY `link()` AND NOT `initiate()`. `POST /api/v3/connected_accounts` is
 * retired for Composio-managed OAuth1/OAuth2/DCR_OAUTH auth configs — from
 * 2026-05-08 for new organisations and 2026-07-03 for all of them, both dates
 * now past. The live spec still carries that deprecation note on the retired
 * endpoint. `POST /api/v3/connected_accounts/link` is the hosted-auth path, is
 * unaffected, and is the only one this module calls.
 *
 * THE KEY NEVER LEAVES THIS FILE. It is read here, put into an `x-api-key`
 * header here, and never returned, logged, or included in a thrown message.
 * `describeKey` is the only thing any caller gets: presence, source and length.
 */

const COMPOSIO_BASE = 'https://backend.composio.dev/api/v3'

/** Composio's per-request budget is a single organisation-wide bucket shared
 * across every endpoint, so a slow call holds a slot everybody else in the
 * workspace is waiting behind. Ten seconds covers their slowest list endpoint
 * and is short enough that a hung connector cannot become a hung page. */
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Where a key came from. The UI shows this and never the value: "using the
 * workspace's own key" and "falling back to the server's key" are different
 * facts to an admin deciding whether clearing a key will break anything.
 */
export type KeySource = 'workspace' | 'environment'

export interface KeyPresence {
  present: boolean
  source: KeySource | null
  /** Length only. Enough to tell a truncated paste from a good one, and
   * useless to anybody who intercepts it. */
  length: number
}

interface ResolvedKey {
  key: string
  source: KeySource
}

/**
 * Workspace key, else `COMPOSIO_API_KEY`, else a failure naming both and
 * saying how to set either.
 *
 * BYO FIRST, DELIBERATELY. Composio meters and rate-limits per ORGANISATION,
 * so a workspace that supplies its own key must never silently fall through to
 * the server's shared one and start spending somebody else's budget. Falling
 * back only when the workspace has set nothing at all keeps "who is paying for
 * this call" answerable from one field.
 */
async function resolveKey(workspaceId: number): Promise<ResolvedKey> {
  const payload = await getPayloadClient()
  // `overrideAccess: true` is required, not incidental: `composioApiKey` has
  // `access: { read: () => false }` precisely so that no ordinary read can
  // return it. This is the one call site that deliberately steps past that,
  // which is why it is in the one module allowed to.
  const workspace = await payload.findByID({
    collection: 'workspaces',
    id: workspaceId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })
  const own = typeof workspace?.composioApiKey === 'string' ? workspace.composioApiKey.trim() : ''
  if (own) return { key: own, source: 'workspace' }

  const fromEnv = (process.env.COMPOSIO_API_KEY ?? '').trim()
  if (fromEnv) return { key: fromEnv, source: 'environment' }

  raise(
    'invalid_input',
    'This workspace has no Composio API key. Set one in Settings → Connectors, or set COMPOSIO_API_KEY in the server environment and restart it.',
    { retryable: false },
  )
}

/** Presence, source and length, for a screen. Never the value. */
export async function describeKey(workspaceId: number): Promise<KeyPresence> {
  try {
    const { key, source } = await resolveKey(workspaceId)
    return { present: true, source, length: key.length }
  } catch {
    return { present: false, source: null, length: 0 }
  }
}

/**
 * Our user id, as Composio's entity id.
 *
 * PREFIXED, AND NEVER AN EMAIL. An email changes and then the connection it
 * identified is orphaned with no way to find it again; a bare integer collides
 * the moment a development and a production deployment share one Composio
 * organisation, which is the normal state of affairs for a team of one. The
 * prefix costs nothing and makes both mistakes impossible — and it is very
 * annoying to change once live connected accounts exist under the old shape.
 */
export function composioUserId(userId: number): string {
  return `nf_user_${userId}`
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH'
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
}

/**
 * One request, with the key attached and every failure named.
 *
 * A 429 becomes `timeout` with `retryable: true` and Composio's own
 * `Retry-After` in the sentence, because "rate limited, try again in 12
 * seconds" is actionable and "request failed" is not. The budget is per
 * Composio ORGANISATION and shared across every endpoint, so a 429 here is
 * frequently caused by somebody else's agent loop — which is why the message
 * says so rather than implying the person in front of us did something wrong.
 */
async function composioRequest<T>(workspaceId: number, options: RequestOptions): Promise<T> {
  const { key } = await resolveKey(workspaceId)

  const url = new URL(`${COMPOSIO_BASE}${options.path}`)
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, String(value))
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        // The single place the key is used. It is not copied into a variable
        // that outlives this call and it appears in no log line below.
        'x-api-key': key,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch (err) {
    // The path is safe to log — the key rides in a header, never in the query
    // string — but the caught error is not spread in wholesale, because a
    // fetch failure can carry request headers on some runtimes.
    logger.warn('composio request failed before a response', {
      path: options.path,
      reason: err instanceof Error ? err.name : 'unknown',
    })
    raise('agent_unavailable', 'Could not reach Composio. It may be down, or this machine may have no outbound network.', {
      retryable: true,
    })
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after')
    raise(
      'timeout',
      retryAfter
        ? `Composio is rate limiting this organisation. Try again in ${retryAfter} seconds.`
        : 'Composio is rate limiting this organisation. Try again shortly.',
      {
        detail: 'The limit is per Composio organisation and is shared across every endpoint.',
        retryable: true,
      },
    )
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw keyAwareFailure(response.status, text)
  }

  return (await response.json()) as T
}

/**
 * A refused request, turned into a sentence — with 401/403 separated out
 * because that is the one an admin can actually fix.
 *
 * The response body rides as `detail` rather than as the message: it is
 * Composio's prose, useful in a log, occasionally long. It cannot contain the
 * key (we sent it in a header and no API echoes one back), but it is truncated
 * anyway — an unbounded third-party string rendered into our UI is a mistake
 * waiting for its first oversized error.
 */
function keyAwareFailure(status: number, body: string): AppFailure {
  const detail = body.slice(0, 500) || undefined
  if (status === 401 || status === 403) {
    return failure('forbidden', 'Composio rejected this workspace’s API key. Check that it is current and has not been revoked.', {
      detail,
      retryable: false,
    })
  }
  if (status === 404) {
    return failure('not_found', 'Composio does not have that record. It may have been deleted there.', { detail, retryable: false })
  }
  return failure('unknown', `Composio refused the request (HTTP ${status}).`, { detail, retryable: status >= 500 })
}

/* ------------------------------------------------------------------ */
/* Toolkits                                                            */
/* ------------------------------------------------------------------ */

export interface Toolkit {
  slug: string
  name: string
  logo: string | null
  description: string | null
  /** True when the toolkit needs no authorisation at all. It then has no
   * meaningful per-person connection, and the UI must not offer a Connect
   * button that would do nothing. */
  noAuth: boolean
}

interface ToolkitsResponse {
  items: Array<{
    slug: string
    name: string
    no_auth?: boolean
    meta?: { description?: string | null; logo?: string | null }
  }>
  next_cursor?: string | null
  total_items?: number
}

/** The catalogue, one page at a time. `search` is Composio's own filter, so a
 * workspace does not pay to download several hundred toolkits to find one. */
export async function listToolkits(
  workspaceId: number,
  options?: { search?: string; limit?: number; cursor?: string },
): Promise<{ toolkits: Toolkit[]; nextCursor: string | null }> {
  const data = await composioRequest<ToolkitsResponse>(workspaceId, {
    path: '/toolkits',
    query: { search: options?.search || undefined, limit: options?.limit ?? 50, cursor: options?.cursor },
  })
  return {
    toolkits: (data.items ?? []).map((item) => ({
      slug: item.slug,
      name: item.name,
      logo: item.meta?.logo ?? null,
      description: item.meta?.description ?? null,
      noAuth: Boolean(item.no_auth),
    })),
    nextCursor: data.next_cursor ?? null,
  }
}

export interface ToolSummary {
  slug: string
  name: string
  description: string | null
}

interface ToolsResponse {
  items: Array<{ slug: string; name: string; description?: string | null }>
}

/** The tools one toolkit exposes, for the "which of these may an agent call"
 * list that `connectors.allowedTools` holds. A connector that grants a whole
 * toolkit when the job needs one action is the difference between "read my
 * calendar" and "send mail as me". */
export async function listToolkitTools(workspaceId: number, toolkitSlug: string, limit = 100): Promise<ToolSummary[]> {
  const data = await composioRequest<ToolsResponse>(workspaceId, {
    path: '/tools',
    query: { toolkit_slug: toolkitSlug, limit },
  })
  return (data.items ?? []).map((item) => ({
    slug: item.slug,
    name: item.name,
    description: item.description ?? null,
  }))
}

/* ------------------------------------------------------------------ */
/* Auth configs                                                        */
/* ------------------------------------------------------------------ */

interface AuthConfigListResponse {
  items: Array<{ id: string; toolkit: { slug: string }; status?: string }>
}

interface AuthConfigCreateResponse {
  toolkit: { slug: string }
  auth_config: { id: string; auth_scheme: string; is_composio_managed: boolean }
}

/**
 * The auth config for a toolkit, reused rather than recreated.
 *
 * FIND BEFORE CREATE, and not for tidiness. An auth config is CONFIGURATION
 * shared by everyone who connects that toolkit; a second one produces two
 * populations of connected accounts under one app, and "why can Ritik use
 * Gmail and Sam cannot" then has an answer nobody can see from our side.
 * Composio does not deduplicate this for us.
 */
export async function findOrCreateAuthConfig(workspaceId: number, toolkitSlug: string): Promise<string> {
  const slug = toolkitSlug.trim().toLowerCase()
  const existing = await composioRequest<AuthConfigListResponse>(workspaceId, {
    path: '/auth_configs',
    query: { toolkit_slug: slug, limit: 10 },
  })
  const usable = (existing.items ?? []).find((item) => item.status !== 'DISABLED')
  if (usable) return usable.id

  const created = await composioRequest<AuthConfigCreateResponse>(workspaceId, {
    method: 'POST',
    path: '/auth_configs',
    // No `auth_config` body: omitting it asks Composio for its own managed
    // OAuth app, which is the only scheme available without the tier that
    // permits self-managed credentials. A workspace that wants to keep custody
    // of its own OAuth client creates the config in Composio's dashboard, and
    // the lookup above then finds it rather than making a second one.
    body: { toolkit: { slug } },
  })
  return created.auth_config.id
}

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

export type LocalStatus = 'pending' | 'active' | 'failed' | 'revoked'

/**
 * Composio's status vocabulary, mapped onto the four values
 * `collections/Connections.ts` stores.
 *
 * Lossy on purpose. `INITIALIZING` and `INITIATED` both mean "the person has
 * not finished yet", and a UI distinguishing them would be showing a
 * difference nobody can act on. `EXPIRED` maps to `failed` rather than to
 * `revoked` because nobody chose it and the fix is to reconnect, not to ask
 * who withdrew access.
 */
export function toLocalStatus(status: string): LocalStatus {
  switch (status) {
    case 'ACTIVE':
      return 'active'
    case 'INITIALIZING':
    case 'INITIATED':
      return 'pending'
    case 'REVOKED':
    case 'INACTIVE':
      return 'revoked'
    default:
      return 'failed'
  }
}

export interface StartedConnection {
  connectedAccountId: string
  redirectUrl: string
  expiresAt: string | null
}

/**
 * Begin the hosted auth flow for one person and one toolkit.
 *
 * `callbackUrl` is passed rather than derived from the request because a run
 * can start a connection from a machine that is not the one rendering the
 * browser that will complete it.
 */
export async function startConnection(input: {
  workspaceId: number
  userId: number
  authConfigId: string
  callbackUrl?: string
}): Promise<StartedConnection> {
  const data = await composioRequest<{
    link_token: string
    redirect_url: string
    expires_at: string
    connected_account_id: string
  }>(input.workspaceId, {
    method: 'POST',
    path: '/connected_accounts/link',
    body: {
      auth_config_id: input.authConfigId,
      user_id: composioUserId(input.userId),
      callback_url: input.callbackUrl,
    },
  })
  return {
    connectedAccountId: data.connected_account_id,
    redirectUrl: data.redirect_url,
    expiresAt: data.expires_at ?? null,
  }
}

export interface ConnectionSnapshot {
  connectedAccountId: string
  status: LocalStatus
  rawStatus: string
  statusReason: string | null
  toolkitSlug: string
  /** Composio's entity id for whoever owns this account. Checked against our
   * own `composioUserId` before any status is believed — a connected account
   * id arriving on a callback is evidence that a browser visited a URL and
   * nothing more. */
  composioUserId: string
}

/** Ask Composio what a connection's status actually is. The only source of
 * truth for it. */
export async function getConnection(workspaceId: number, connectedAccountId: string): Promise<ConnectionSnapshot> {
  const data = await composioRequest<{
    id: string
    status: string
    status_reason?: string | null
    user_id: string
    toolkit: { slug: string }
  }>(workspaceId, { path: `/connected_accounts/${encodeURIComponent(connectedAccountId)}` })

  return {
    connectedAccountId: data.id,
    status: toLocalStatus(data.status),
    rawStatus: data.status,
    statusReason: data.status_reason ?? null,
    toolkitSlug: data.toolkit?.slug ?? '',
    composioUserId: data.user_id,
  }
}

/**
 * Revoke and delete a connected account at Composio.
 *
 * `revoke_on_delete` is set: deleting our record of a grant while the grant
 * itself stays live at Google is the worst of both outcomes — the person
 * believes they disconnected and the token keeps working. Our own `connections`
 * row is not deleted by the caller either; it is marked `revoked`, because the
 * audit question is "who had access to what, and when did it stop", and a
 * deleted row cannot answer the second half.
 */
export async function disconnect(workspaceId: number, connectedAccountId: string): Promise<void> {
  await composioRequest<{ success: boolean }>(workspaceId, {
    method: 'DELETE',
    path: `/connected_accounts/${encodeURIComponent(connectedAccountId)}`,
    query: { revoke_on_delete: true },
  })
}
