'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import {
  listServeProfiles,
  readConfigSubset,
  writeConfigSubset,
  type ServeProfile,
} from '@/lib/hermes/serve-client'
import { APPROVAL_MODES } from '@/components/settings/approval-modes'

/**
 * Approvals and memory limits, per Hermes profile.
 *
 * Hermes has no dedicated endpoint for either — they are plain config keys
 * (`approvals.mode` is validated in `tools/approval.py`, the memory limits in
 * the memory tool) — so this reads and writes them through `/api/config`,
 * which deep-merges a partial document. That is why only the keys listed
 * below are ever sent: an untouched key cannot be clobbered by a save here.
 *
 * The read is equally narrow on purpose. `GET /api/config` returns the WHOLE
 * config, which on this install includes provider credentials and the gateway
 * API key; `readConfigSubset` projects it down to these paths before anything
 * can be serialised to a client component.
 */

const PATHS = [
  'approvals.mode',
  'approvals.timeout',
  'memory.memory_enabled',
  'memory.user_profile_enabled',
  'memory.memory_char_limit',
  'memory.user_char_limit',
  'security.redact_secrets',
] as const

export type SafetyPath = (typeof PATHS)[number]

export interface SafetySettings {
  profiles: ServeProfile[]
  profile: string
  values: Partial<Record<SafetyPath, unknown>>
  error: string | null
}


async function requireUser() {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')
  return user
}

export async function getSafetySettings(profile: string): Promise<SafetySettings> {
  await requireUser()
  const profiles = await listServeProfiles().catch(() => [] as ServeProfile[])
  try {
    const values = await readConfigSubset([...PATHS], profile)
    return { profiles, profile, values: values as Partial<Record<SafetyPath, unknown>>, error: null }
  } catch (err) {
    return {
      profiles,
      profile,
      values: {},
      error: err instanceof Error ? err.message : 'Could not read these settings.',
    }
  }
}

export async function saveSafetySettings(input: {
  workspaceSlug: string
  profile: string
  values: Partial<Record<SafetyPath, unknown>>
}): Promise<void> {
  await requireUser()
  const allowed: Record<string, unknown> = {}
  for (const path of PATHS) {
    if (path in input.values) allowed[path] = input.values[path]
  }
  if (Object.keys(allowed).length === 0) return

  const mode = allowed['approvals.mode']
  if (mode !== undefined && !APPROVAL_MODES.some((entry) => entry.value === mode)) {
    throw new Error(`"${String(mode)}" is not an approval mode Hermes accepts.`)
  }

  await writeConfigSubset(allowed, input.profile)
  revalidatePath(`/workspace/${input.workspaceSlug}/settings/safety`)
}
