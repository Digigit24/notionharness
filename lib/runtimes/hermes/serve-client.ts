// Typed server-side client for the Hermes dashboard API (`hermes serve`).
//
// Every function here runs on the Next.js server, never in the browser: the
// session token must not reach a client bundle, and — more importantly — the
// raw responses must not either. See the SECURITY note on `readConfigSubset`.
//
// Endpoint shapes below were read off the live server on this machine, not
// guessed. Where a field is optional it is because the real response omitted
// it for some rows.
import { getServeEndpoint } from './serve-supervisor'

export class HermesServeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message)
    this.name = 'HermesServeError'
  }
}

type Query = Record<string, string | number | boolean | undefined | null>

function buildPath(path: string, profile?: string | null, query?: Query): string {
  const search = new URLSearchParams()
  // '' is a real, meaningful value (the install root), and the API wants the
  // parameter simply absent for it — not `profile=`.
  if (profile) search.set('profile', profile)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  return qs ? `${path}?${qs}` : path
}

export interface ServeRequestOptions {
  profile?: string | null
  query?: Query
  body?: unknown
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Some hub/search calls legitimately take a while. */
  timeoutMs?: number
}

export async function serveRequest<T>(path: string, options: ServeRequestOptions = {}): Promise<T> {
  const { baseUrl, token } = await getServeEndpoint()
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST')
  const url = `${baseUrl}${buildPath(path, options.profile, options.query)}`
  const res = await fetch(url, {
    method,
    headers: {
      'X-Hermes-Session-Token': token,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    cache: 'no-store',
  })
  if (!res.ok) {
    let detail = ''
    try {
      const payload = (await res.json()) as { detail?: unknown; error?: unknown }
      detail = String(payload.detail ?? payload.error ?? '')
    } catch {
      detail = (await res.text().catch(() => '')).slice(0, 300)
    }
    throw new HermesServeError(detail || `${method} ${path} failed (${res.status})`, res.status, path)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// Profiles

export interface ServeProfile {
  name: string
  path: string
  is_default: boolean
  model: string | null
  provider: string | null
  has_env: boolean
  skill_count: number
  gateway_running: boolean
  description: string
  description_auto: boolean
  has_alias: boolean
}

export async function listServeProfiles(): Promise<ServeProfile[]> {
  const body = await serveRequest<{ profiles: ServeProfile[] }>('/api/profiles')
  return body.profiles ?? []
}

/** The API calls the install root `default`; every other surface in this app
 * calls it `''`. Normalise here so callers never juggle two spellings. */
export function serveProfileKey(name: string): string {
  return name === 'default' ? '' : name
}

export async function updateProfileModel(
  profile: string,
  body: { provider?: string; model?: string },
): Promise<void> {
  await serveRequest(`/api/profiles/${encodeURIComponent(profile || 'default')}/model`, {
    method: 'PUT',
    body,
  })
}

export async function getProfileSoul(profile: string): Promise<{ content: string }> {
  return serveRequest(`/api/profiles/${encodeURIComponent(profile || 'default')}/soul`)
}

export async function setProfileSoul(profile: string, content: string): Promise<void> {
  await serveRequest(`/api/profiles/${encodeURIComponent(profile || 'default')}/soul`, {
    method: 'PUT',
    body: { content },
  })
}

// ---------------------------------------------------------------------------
// Models

export interface ServeModelInfo {
  model: string
  provider: string
  auto_context_length?: number
  config_context_length?: number
  effective_context_length?: number
  capabilities?: {
    supports_tools?: boolean
    supports_vision?: boolean
    supports_reasoning?: boolean
    context_window?: number
    max_output_tokens?: number
    model_family?: string
  }
}

/** One row of `/api/model/options`. Verified live: 7 providers on this
 * install, including a virtual `moa` entry whose only "model" is `default`. */
export interface ServeProviderOption {
  slug: string
  name: string
  is_current: boolean
  is_user_defined?: boolean
  models: string[]
  total_models: number
  source: string
  authenticated: boolean
  auth_type: string
  key_env?: string
  warning?: string | null
  featured_models?: string[]
  free_tier?: boolean
  unavailable_models?: string[]
}

export interface ServeModelOptions {
  providers: ServeProviderOption[]
  model: string
  provider: string
}

export function getModelInfo(profile?: string | null): Promise<ServeModelInfo> {
  return serveRequest('/api/model/info', { profile })
}

export function getModelOptions(profile?: string | null): Promise<ServeModelOptions> {
  return serveRequest('/api/model/options', { profile, timeoutMs: 30_000 })
}

export interface SetModelResult {
  ok: boolean
  scope?: string
  provider?: string
  model?: string
  /** The server refuses an expensive model until the caller repeats the
   * request with `confirmExpensive`, answering with this message instead of
   * an error. Surfacing it is the difference between a confusing no-op and a
   * confirmation prompt. */
  confirm_required?: boolean
  confirm_message?: string
}

export async function setActiveModel(
  body: { provider: string; model: string; confirmExpensive?: boolean },
  profile?: string | null,
): Promise<SetModelResult> {
  return serveRequest('/api/model/set', {
    method: 'POST',
    // `scope` is required — omitting it is a 400 ("bad scope"), not a default.
    body: {
      scope: 'main',
      provider: body.provider,
      model: body.model,
      confirm_expensive_model: body.confirmExpensive ?? false,
      profile: profile || undefined,
    },
    profile,
    timeoutMs: 60_000,
  })
}

// ---------------------------------------------------------------------------
// Skills

export interface ServeSkill {
  name: string
  description: string
  category: string
  enabled: boolean
  usage: number
  provenance: string
}

export function listSkills(profile?: string | null): Promise<ServeSkill[]> {
  return serveRequest('/api/skills', { profile })
}

export function getSkillContent(name: string, profile?: string | null): Promise<{ name: string; content: string }> {
  return serveRequest('/api/skills/content', { profile, query: { name } })
}

export async function setSkillContent(name: string, content: string, profile?: string | null): Promise<void> {
  await serveRequest('/api/skills/content', { method: 'PUT', body: { name, content, profile: profile || undefined } })
}

export async function toggleSkill(name: string, enabled: boolean, profile?: string | null): Promise<void> {
  await serveRequest('/api/skills/toggle', {
    method: 'PUT',
    body: { name, enabled, profile: profile || undefined },
  })
}

export interface ServeSkillHubResult {
  name: string
  description?: string
  source?: string
  identifier?: string
  installed?: boolean
}

export function searchSkillHub(
  q: string,
  profile?: string | null,
  source = 'all',
  limit = 20,
): Promise<unknown> {
  return serveRequest('/api/skills/hub/search', { profile, query: { q, source, limit }, timeoutMs: 45_000 })
}

export async function installSkillFromHub(identifier: string, profile?: string | null): Promise<unknown> {
  return serveRequest('/api/skills/hub/install', {
    method: 'POST',
    body: { identifier },
    profile,
    timeoutMs: 120_000,
  })
}

// ---------------------------------------------------------------------------
// MCP servers

export interface ServeMcpServer {
  name: string
  transport: 'http' | 'stdio' | string
  url: string | null
  command: string | null
  args: string[]
  env: Record<string, string>
  auth: string | null
  enabled: boolean
  tools: { include?: string[] } | null
}

export async function listMcpServers(profile?: string | null): Promise<ServeMcpServer[]> {
  const body = await serveRequest<{ servers: ServeMcpServer[] }>('/api/mcp/servers', { profile })
  return body.servers ?? []
}

export async function setMcpServerEnabled(name: string, enabled: boolean, profile?: string | null): Promise<void> {
  await serveRequest(`/api/mcp/servers/${encodeURIComponent(name)}/enabled`, {
    method: 'PUT',
    body: { enabled },
    profile,
  })
}

export function testMcpServer(name: string, profile?: string | null): Promise<unknown> {
  return serveRequest(`/api/mcp/servers/${encodeURIComponent(name)}/test`, {
    method: 'POST',
    profile,
    body: {},
    timeoutMs: 60_000,
  })
}

// ---------------------------------------------------------------------------
// Config
//
// SECURITY, and the reason there is no `getConfig()` here: `GET /api/config`
// returns the WHOLE parsed config.yaml, which on this install includes
// `providers` and `gateway` — real secrets (`gateway.api_server.key`). This
// codebase's standing rule, set in `personas.ts` and `providers.ts`, is that
// config.yaml is never read whole, returned, or logged. So the only reader
// exported here projects the response down to an explicit allowlist of key
// paths BEFORE it can be serialised to a client component, and the only
// writer sends a partial document (the API deep-merges it, verified in
// `web_server.py:7018-7021`, so a partial PUT cannot drop untouched keys).

/** Note: the schema deliberately carries NO default value — defaults come
 * from `/api/config/defaults`, which is a separate document. A settings form
 * that wants "reset to default" has to read both. */
export interface ServeConfigField {
  type: 'boolean' | 'number' | 'string' | 'list' | 'object' | 'select' | string
  description?: string
  category?: string
  options?: string[]
  searchable?: boolean
  clearable?: boolean
}

export interface ServeConfigSchema {
  fields: Record<string, ServeConfigField>
  category_order: string[]
}

export function getConfigSchema(profile?: string | null): Promise<ServeConfigSchema> {
  return serveRequest('/api/config/schema', { profile })
}

function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, segment) => {
    if (node && typeof node === 'object' && segment in (node as Record<string, unknown>)) {
      return (node as Record<string, unknown>)[segment]
    }
    return undefined
  }, source)
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  let node = target
  for (const segment of segments.slice(0, -1)) {
    if (typeof node[segment] !== 'object' || node[segment] === null) node[segment] = {}
    node = node[segment] as Record<string, unknown>
  }
  node[segments[segments.length - 1]] = value
}

/**
 * Values for exactly the given dotted key paths, and nothing else. Anything
 * not asked for never leaves this function, so a new settings field cannot
 * accidentally leak an adjacent secret.
 */
export async function readConfigSubset(
  paths: string[],
  profile?: string | null,
): Promise<Record<string, unknown>> {
  const full = await serveRequest<Record<string, unknown>>('/api/config', { profile })
  const out: Record<string, unknown> = {}
  for (const path of paths) {
    const value = readPath(full, path)
    if (value !== undefined) out[path] = value
  }
  return out
}

/** Writes only the given dotted key paths; every other key on disk is kept. */
export async function writeConfigSubset(
  values: Record<string, unknown>,
  profile?: string | null,
): Promise<void> {
  const partial: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(values)) writePath(partial, path, value)
  await serveRequest('/api/config', {
    method: 'PUT',
    body: { config: partial, profile: profile || undefined },
    profile,
  })
}

// ---------------------------------------------------------------------------
// Sessions (Hermes's own session store — distinct from this app's `sessions`
// table, which is the workspace-facing thread. Used read-only, to show what
// Hermes recorded for a run.)

export interface ServeSessionRow {
  id: string
  title?: string | null
  started_at?: string | null
  last_activity_at?: string | null
  message_count?: number
  model?: string | null
  cwd?: string | null
  git_branch?: string | null
}

export function listServeSessions(
  profile?: string | null,
  query: { limit?: number; offset?: number; order?: string } = {},
): Promise<unknown> {
  return serveRequest('/api/sessions', { profile, query })
}
