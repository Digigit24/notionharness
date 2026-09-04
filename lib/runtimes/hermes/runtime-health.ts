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
 * How stale a stored probe may be before health re-runs it.
 *
 * The health loop ticks every 30 seconds; probing spawns the agent binary and
 * takes seconds. Doing that per profile per tick would be a straight D0
 * violation, so a recent probe is reused and re-run only when it ages out.
 * The reported status carries its own timestamp either way, so "up" always
 * means "up as of a stated moment" rather than an implied now.
 */
const PROBE_MAX_AGE_MS = 10 * 60_000

function usesHermesHome(profile: RuntimeProfile): boolean {
  return ((profile as { homeStrategy?: string | null }).homeStrategy ?? 'hermes') === 'hermes'
}

/**
 * Health for a runtime that is not Hermes.
 *
 * The honest question for any ACP runtime is "does this binary start and
 * complete a handshake", which is exactly what the probe answers. This used
 * to call `checkHermesReachability()` for every profile regardless of family,
 * so a perfectly healthy Claude Code runtime was reported as down with
 * "Hermes responded 502" — a status about a completely unrelated service,
 * shown against a runtime that has no Hermes in it at all.
 *
 * A stored probe is reused while it is fresh; see `PROBE_MAX_AGE_MS`.
 */
async function checkAcpRuntime(profile: RuntimeProfile): Promise<RuntimeHealthResult> {
  const lastCode = (profile as { lastProbeCode?: string | null }).lastProbeCode
  const lastAt = (profile as { lastProbedAt?: string | null }).lastProbedAt
  const age = lastAt ? Date.now() - new Date(lastAt).getTime() : Number.POSITIVE_INFINITY

  if (lastCode && age < PROBE_MAX_AGE_MS) {
    return {
      reachable: lastCode === 'ok',
      error: lastCode === 'ok' ? undefined : (profile as { lastProbeDetail?: string | null }).lastProbeDetail ?? lastCode,
      checkedAt: lastAt as string,
    }
  }

  const { probeAcpRuntime } = await import('@/lib/runtimes/detect')
  const args = Array.isArray(profile.fixedArgs)
    ? profile.fixedArgs.filter((a): a is string => typeof a === 'string')
    : []
  const probe = await probeAcpRuntime(profile.commandName, args)
  // Written back so the Runtimes page and this loop agree, rather than each
  // keeping its own idea of when the runtime was last known good.
  const payload = await getPayloadClient()
  await payload
    .update({
      collection: 'runtime-profiles',
      id: profile.id,
      data: {
        handshake: probe.handshake ?? null,
        lastProbeCode: probe.code,
        lastProbeDetail: probe.detail.slice(0, 500),
        lastProbedAt: new Date().toISOString(),
      } as never,
      overrideAccess: true,
    })
    .catch(() => undefined)

  return {
    reachable: probe.ok,
    error: probe.ok ? undefined : probe.detail,
    checkedAt: new Date().toISOString(),
  }
}

/**
 * Runs one health check appropriate to the runtime and upserts its `Runtimes`
 * row — finding the existing row for this (workspace, runtimeProfile) pair if
 * one exists, else creating it.
 *
 * The check differs by runtime because the runtimes differ. Hermes has a
 * dashboard server that is its real control plane, so reaching it is a
 * meaningful signal. Everything else is checked at the protocol level, which
 * is the only signal that means anything for a bare ACP binary.
 */
export async function refreshRuntimeForProfile(profile: RuntimeProfile): Promise<void> {
  const payload = await getPayloadClient()
  const hermes = usesHermesHome(profile)

  // Status is always the protocol answer: can this runtime start and complete
  // a handshake — which is to say, can it run a turn.
  //
  // Hermes's dashboard reachability is deliberately NOT the verdict, even for
  // Hermes. That was the first version of this fix and it was still wrong in
  // the same way: with the dashboard host returning 502, a Hermes runtime that
  // demonstrably runs turns was reported "down". The dashboard powers the
  // profile, memory and MCP screens, so its absence is worth reporting — as
  // its own fact, alongside a status that means what it says.
  const result = await checkAcpRuntime(profile)
  const dashboard = hermes ? await checkHermesReachability() : null

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
    // What was actually checked, not a URL we never contacted.
    host: profile.commandName,
    // Payload's `json` field type wants a plain index-signature-compatible
    // object; `RuntimeHealthResult` is a named interface, so a bare spread
    // (not a cast on the interface itself) satisfies it structurally.
    connectionInfo: {
      ...result,
      checkKind: 'acp-handshake',
      // Present only for a runtime that has a dashboard at all. A reachable
      // runtime with an unreachable dashboard is a real and specific state:
      // turns run, the Hermes-specific settings screens do not.
      ...(dashboard
        ? {
            dashboard: {
              reachable: dashboard.reachable,
              statusCode: dashboard.statusCode,
              error: dashboard.error,
              url: HERMES_BASE_URL || 'unconfigured',
            },
          }
        : {}),
    } as Record<string, unknown>,
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
