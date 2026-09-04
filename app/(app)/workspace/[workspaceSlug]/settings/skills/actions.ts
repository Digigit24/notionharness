'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { guard, raise, type WithFailure } from '@/lib/failures'
import {
  getSkillContent,
  listServeProfiles,
  listSkills,
  setSkillContent,
  toggleSkill,
  type ServeProfile,
  type ServeSkill,
} from '@/lib/runtimes/hermes/serve-client'

/**
 * Skills, per Hermes profile.
 *
 * These call the Hermes dashboard server directly. The previous route
 * (`/api/hermes/skills`) proxied a REMOTE gateway that has no `/api/skills`
 * endpoint at all, so the skills UI was permanently empty for the same
 * reason the memories tab was permanently broken.
 *
 * Enablement here is the profile's own `skills.disabled` list — a different
 * thing from an agent's `enabledSkills`, which decides what gets linked into
 * that run's overlay. A skill has to be enabled here to exist for the
 * profile, and selected on the agent to reach a particular run.
 *
 * R12-P1.1 — the toggle, the read-one and the write all return their failures
 * rather than throwing them. "That skill no longer exists" and Hermes's own
 * refusal to write a file are precisely the sentences this screen needs, and
 * a thrown one never reaches a production browser (`lib/failures.ts`).
 * `getSkillsSettings` still throws: it is awaited by the server component in
 * `page.tsx`, and already reports an unreachable Hermes in band.
 */

async function requireUser() {
  const user = await getCurrentPayloadUser()
  if (!user) raise('unauthenticated', 'You must be logged in.')
  return user
}

export interface SkillsSettings {
  profiles: ServeProfile[]
  profile: string
  skills: ServeSkill[]
  error: string | null
}

/**
 * Coerces one row into the shape the UI can rely on.
 *
 * Not defensive programming for its own sake: real rows from this install
 * come back with `category` null (an uncategorised skill at the pool root),
 * which crashed the page outright on `category.localeCompare` when grouping.
 * Normalising once here means every consumer gets strings.
 */
function normaliseSkill(raw: ServeSkill): ServeSkill {
  return {
    name: String(raw?.name ?? ''),
    description: String(raw?.description ?? ''),
    category: String(raw?.category ?? '') || 'Uncategorised',
    enabled: raw?.enabled === true,
    usage: typeof raw?.usage === 'number' ? raw.usage : 0,
    provenance: String(raw?.provenance ?? 'unknown'),
  }
}

export async function getSkillsSettings(profile: string): Promise<SkillsSettings> {
  await requireUser()
  const profiles = await listServeProfiles().catch(() => [] as ServeProfile[])
  try {
    const raw = await listSkills(profile)
    const skills = (Array.isArray(raw) ? raw : []).map(normaliseSkill).filter((skill) => skill.name)
    return { profiles, profile, skills, error: null }
  } catch (err) {
    return {
      profiles,
      profile,
      skills: [],
      error: err instanceof Error ? err.message : 'Could not read skills.',
    }
  }
}

export async function setSkillEnabled(input: {
  workspaceSlug: string
  profile: string
  name: string
  enabled: boolean
}): Promise<WithFailure<void>> {
  return guard(async () => {
    await requireUser()
    await toggleSkill(input.name, input.enabled, input.profile)
    revalidatePath(`/workspace/${input.workspaceSlug}/settings/skills`)
  })
}

export async function readSkill(profile: string, name: string): Promise<WithFailure<string>> {
  return guard(async () => {
    await requireUser()
    const body = await getSkillContent(name, profile)
    return body.content ?? ''
  })
}

export async function writeSkill(input: {
  workspaceSlug: string
  profile: string
  name: string
  content: string
}): Promise<WithFailure<void>> {
  return guard(async () => {
    await requireUser()
    if (!input.content.trim()) raise('invalid_input', 'A skill cannot be empty.')
    await setSkillContent(input.name, input.content, input.profile)
    revalidatePath(`/workspace/${input.workspaceSlug}/settings/skills`)
  })
}
