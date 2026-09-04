'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { guard, raise, type WithFailure } from '@/lib/failures'
import {
  getModelInfo,
  getModelOptions,
  listServeProfiles,
  readConfigSubset,
  setActiveModel,
  writeConfigSubset,
  type ServeModelInfo,
  type ServeModelOptions,
  type ServeProfile,
  type SetModelResult,
} from '@/lib/runtimes/hermes/serve-client'

/**
 * Model settings, per Hermes profile.
 *
 * All of this goes through the Hermes dashboard server rather than editing
 * `config.yaml` here, which is a deliberate reversal of how `providers.ts`
 * had to work: that module writes the file directly with a targeted regex
 * because nothing else was available. Hermes's own API validates the change,
 * applies it under its own mutation lock, and knows things this app cannot
 * (which models a provider actually offers, whether one is expensive enough
 * to warrant a confirmation). Two writers to one file is a bug waiting to
 * happen; the API is the one that should win.
 *
 * R12-P1.1 — the two WRITES return their failures rather than throwing them,
 * because Hermes's own validation errors ("no such model for that provider",
 * "config is locked") are the whole value of routing through its API, and a
 * thrown message never reaches a production browser (`lib/failures.ts`). The
 * reads still throw: `getModelSettings` is awaited by the server component,
 * and `getModelOptionsFor` is a best-effort catalogue whose absence the page
 * already renders as "still loading the pickers".
 */

async function requireUser() {
  const user = await getCurrentPayloadUser()
  if (!user) raise('unauthenticated', 'You must be logged in.')
  return user
}

/** A fallback entry as Hermes validates it (`hermes_cli/fallback_config.py`). */
export interface FallbackEntry {
  provider: string
  model: string
  base_url?: string
  key_env?: string
}

export interface ModelSettings {
  profiles: ServeProfile[]
  profile: string
  info: ServeModelInfo | null
  options: ServeModelOptions | null
  fallbacks: FallbackEntry[]
  error: string | null
}

const FALLBACK_PATH = 'fallback_providers'

function normaliseFallbacks(raw: unknown): FallbackEntry[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const entry = item as Record<string, unknown>
      const provider = typeof entry.provider === 'string' ? entry.provider : ''
      const model = typeof entry.model === 'string' ? entry.model : ''
      if (!provider || !model) return null
      const out: FallbackEntry = { provider, model }
      if (typeof entry.base_url === 'string' && entry.base_url) out.base_url = entry.base_url
      // Hermes accepts either spelling; normalise to the documented one so the
      // UI never shows two fields meaning the same thing.
      const keyEnv = entry.key_env ?? entry.api_key_env
      if (typeof keyEnv === 'string' && keyEnv) out.key_env = keyEnv
      return out
    })
    .filter((entry): entry is FallbackEntry => entry !== null)
}

/**
 * The fast half: everything needed to paint the page.
 *
 * Deliberately does NOT fetch the provider/model catalogue. That call can
 * take tens of seconds on a cold runtime — it wakes the dashboard server and
 * may hit provider APIs — and awaiting it here meant the whole page sat on
 * skeletons until it returned, which is exactly the "no first render blocked
 * on an external process" rule. The catalogue now loads after paint through
 * `getModelOptionsFor` below.
 */
export async function getModelSettings(profile: string): Promise<ModelSettings> {
  await requireUser()
  const profiles = await listServeProfiles().catch(() => [] as ServeProfile[])
  try {
    const [info, config] = await Promise.all([
      getModelInfo(profile),
      readConfigSubset([FALLBACK_PATH], profile),
    ])
    return {
      profiles,
      profile,
      info,
      options: null,
      fallbacks: normaliseFallbacks(config[FALLBACK_PATH]),
      error: null,
    }
  } catch (err) {
    return {
      profiles,
      profile,
      info: null,
      options: null,
      fallbacks: [],
      error: err instanceof Error ? err.message : 'Could not read model settings.',
    }
  }
}

/** The slow half, fetched after the page is already on screen. */
export async function getModelOptionsFor(profile: string): Promise<ServeModelOptions | null> {
  await requireUser()
  return getModelOptions(profile).catch(() => null)
}

export async function setProfileActiveModel(input: {
  workspaceSlug: string
  profile: string
  provider: string
  model: string
  confirmExpensive?: boolean
}): Promise<WithFailure<SetModelResult>> {
  return guard(async () => {
    await requireUser()
    const result = await setActiveModel(
      { provider: input.provider, model: input.model, confirmExpensive: input.confirmExpensive },
      input.profile,
    )
    revalidatePath(`/workspace/${input.workspaceSlug}/settings/model`)
    return result
  })
}

/**
 * Replaces the whole fallback list.
 *
 * A whole-list write rather than per-entry edits because the list IS an
 * ordering: "try this, then this". Reordering is the main thing anyone does
 * to it, and expressing a reorder as a series of single-entry mutations is
 * both slower and racier than sending the order you want.
 */
export async function setFallbackProviders(input: {
  workspaceSlug: string
  profile: string
  entries: FallbackEntry[]
}): Promise<WithFailure<FallbackEntry[]>> {
  return guard(async () => {
    await requireUser()
    const cleaned = input.entries
      .map((entry) => ({
        provider: String(entry.provider ?? '').trim(),
        model: String(entry.model ?? '').trim(),
        ...(entry.base_url ? { base_url: String(entry.base_url).trim() } : {}),
        ...(entry.key_env ? { key_env: String(entry.key_env).trim() } : {}),
      }))
      .filter((entry) => entry.provider && entry.model)

    // Hermes dedupes on (provider, model, base_url) when it loads this, so
    // sending duplicates would silently drop entries and make the saved list
    // differ from the one on screen.
    const seen = new Set<string>()
    const unique = cleaned.filter((entry) => {
      const key = `${entry.provider}::${entry.model}::${entry.base_url ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    await writeConfigSubset({ [FALLBACK_PATH]: unique }, input.profile)
    revalidatePath(`/workspace/${input.workspaceSlug}/settings/model`)
    return unique
  })
}
