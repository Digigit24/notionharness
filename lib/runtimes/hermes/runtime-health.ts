// C1.3 — the first code in this codebase that ever writes to the `runtimes`
// collection. `collections/Runtimes.ts` (workspace, runtimeProfile, host,
// connectionInfo, status, lastCheckedAt) has existed since an earlier
// batch, but nothing produced real data for it — any "runtimes online"
// indicator built on top would have been fabricated, not observed, which is
// exactly why B-5/B-6 both explicitly declined to build one (see health
// page's own header comment). This module makes the data underneath it
// real: a live HTTP round trip to Hermes, per enabled runtime profile, and
// an honest `status` derived from what actually happened.
//
// What "healthy" means here, precisely: a successful response from
// `GET /api/profiles` — the same Hermes endpoint `app/api/hermes/profiles/
// route.ts` already proxies, chosen because it's the one already-confirmed-
// working Hermes call in this codebase, not a guessed `/health` or
// `/version` endpoint this project has never actually verified exists.
// `profilesAvailable` is only ever set from a real, successfully-parsed
// response — never fabricated when the shape doesn't match.

import { getPayloadClient } from '@/lib/payload'
import { HERMES_API_KEY, HERMES_BASE_URL } from '@/lib/runtimes/hermes/api-proxy'
import type { RuntimeProfile } from '@/payload-types'

const HEALTH_CHECK_TIMEOUT_MS = 8_000

export interface RuntimeHealthResult {
  reachable: boolean
  statusCode?: number
  error?: string
  profilesAvailable?: number
  checkedAt: string
}

/** One real HTTP round trip to Hermes. Never throws — a network failure is a health result, not an exception. */
export async function checkHermesReachability(): Promise<RuntimeHealthResult> {
  const checkedAt = new Date().toISOString()
  if (!HERMES_BASE_URL) {
    return { reachable: false, error: 'Hermes is not configured (HERMES_API_BASE_URL unset).', checkedAt }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS)
  try {
    const res = await fetch(`${HERMES_BASE_URL}/api/profiles`, {
      headers: { Authorization: `Bearer ${HERMES_API_KEY}` },
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) {
      return { reachable: false, statusCode: res.status, error: `Hermes responded ${res.status}`, checkedAt }
    }
    let profilesAvailable: number | undefined
    try {
      const body: unknown = await res.json()
      if (Array.isArray(body)) profilesAvailable = body.length
      else if (Array.isArray((body as { profiles?: unknown })?.profiles)) {
        profilesAvailable = (body as { profiles: unknown[] }).profiles.length
      }
      // Any other shape: leave profilesAvailable unset rather than guess.
    } catch {
      // 2xx with an unparseable body still means Hermes is reachable.
    }
    return { reachable: true, statusCode: res.status, profilesAvailable, checkedAt }
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `Timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`
          : err.message
        : 'Unknown error'
    return { reachable: false, error: message, checkedAt }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Runs one real health check and upserts the `Runtimes` row for a single
 * runtime profile — finds the existing row for this (workspace,
 * runtimeProfile) pair if one exists, else creates it. `host` is currently
 * always the single configured `HERMES_BASE_URL` (this app talks to one
 * Hermes per installation as of C1 — see AGENTS.md's Phase C section for
 * why multi-runtime is explicitly deferred to Pillar 8), so it's derived
 * here rather than asked of the caller.
 */
export async function refreshRuntimeForProfile(profile: RuntimeProfile): Promise<void> {
  const payload = await getPayloadClient()
  const result = await checkHermesReachability()

  const workspaceId = typeof profile.workspace === 'object' ? profile.workspace.id : profile.workspace
  const existing = await payload.find({
    collection: 'runtimes',
    where: {
      and: [{ workspace: { equals: workspaceId } }, { runtimeProfile: { equals: profile.id } }],
    },
    limit: 1,
    overrideAccess: true,
  })

  const data = {
    name: profile.name,
    workspace: workspaceId,
    runtimeProfile: profile.id,
    host: HERMES_BASE_URL || 'unconfigured',
    // Payload's `json` field type wants a plain index-signature-compatible
    // object; `RuntimeHealthResult` is a named interface, so a bare spread
    // (not a cast on the interface itself) satisfies it structurally.
    connectionInfo: { ...result } as Record<string, unknown>,
    status: (result.reachable ? 'up' : 'down') as 'up' | 'down',
    lastCheckedAt: result.checkedAt,
  }

  if (existing.docs[0]) {
    await payload.update({ collection: 'runtimes', id: existing.docs[0].id, data, overrideAccess: true })
  } else {
    await payload.create({ collection: 'runtimes', data, overrideAccess: true })
  }
}

/** Refreshes every enabled runtime profile across every workspace. Returns how many were checked. */
export async function refreshAllRuntimes(): Promise<{ checked: number }> {
  const payload = await getPayloadClient()
  const profiles = await payload.find({
    collection: 'runtime-profiles',
    where: { enabled: { equals: true } },
    limit: 200,
    depth: 0,
    overrideAccess: true,
  })
  for (const profile of profiles.docs) {
    await refreshRuntimeForProfile(profile)
  }
  return { checked: profiles.docs.length }
}
