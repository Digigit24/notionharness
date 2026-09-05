'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import type { RuntimeProfile } from '@/payload-types'
import { probeAcpRuntime, resolveCommandPath } from '@/lib/runtimes/detect'
import { CATALOG_HOME_STRATEGIES, RUNTIME_CATALOG, catalogEntryCommandLine, type RuntimeCatalogId } from '@/lib/runtimes/catalog'
import { currentHostId } from '@/lib/runtimes/host-id'
import type { RuntimeHost } from '@/payload-types'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { guard, raise, type WithFailure } from '@/lib/failures'

// R12-P1.1 — every refusal below is RETURNED, not thrown. A server action that
// throws reaches a production browser as `1:E{"digest":…}` and nothing else
// (the measurement is in `lib/failures.ts`), so "Command is required." was a
// sentence only ever read in development. `guard()` turns it into a
// `__failure` envelope the button `unwrap()`s in the browser, where the
// message survives.

// Phase C, C2 — closes this page's own "add one from the Payload admin"
// stopgap (see page.tsx's empty state). `collections/RuntimeProfiles.ts`
// already exists and is already migrated — this is application code, not a
// schema change, so unlike C1.1/C1.6 it doesn't need the migration-gating
// discipline documented elsewhere in AGENTS.md's Phase C section.
export async function createRuntimeProfile({
  workspaceId,
  workspaceSlug,
  name,
  protocolFamily,
  commandName,
  fixedArgs,
  homeStrategy,
}: {
  workspaceId: number
  workspaceSlug: string
  name: string
  protocolFamily: RuntimeProfile['protocolFamily']
  commandName: string
  /** From a catalog preset. A hand-typed profile leaves these unset. */
  fixedArgs?: string[]
  homeStrategy?: string
}): Promise<WithFailure<RuntimeProfile>> {
  return guard(async () => {
    const trimmedName = name.trim()
    const trimmedCommand = commandName.trim()
    if (!trimmedName) raise('invalid_input', 'Name is required.')
    if (!trimmedCommand) raise('invalid_input', 'Command is required.')

    // A strategy the app has never heard of would be stored, resolve to
    // 'none' at run time, and quietly drop every skill. Refuse it here, where
    // the person can still see the message.
    const knownStrategies = new Set(['hermes', 'none', ...CATALOG_HOME_STRATEGIES.map((s) => s.value)])
    if (homeStrategy !== undefined && !knownStrategies.has(homeStrategy)) {
      raise('invalid_input', `"${homeStrategy}" is not a home strategy this app knows.`)
    }
    const args = Array.isArray(fixedArgs) ? fixedArgs.filter((a) => typeof a === 'string' && a.length > 0) : []

    const payload = await getPayloadClient()
    const created = await payload.create({
      collection: 'runtime-profiles',
      data: {
        workspace: workspaceId,
        name: trimmedName,
        protocolFamily,
        commandName: trimmedCommand,
        fixedArgs: args,
        // A profile that names no strategy is Hermes by history (see the
        // collection), which is wrong for a hand-typed `opencode acp` but
        // was the behaviour before the catalog existed; the presets set it
        // explicitly and a custom profile that is not Hermes gets 'none' —
        // the honest default for a CLI we know nothing about.
        ...(homeStrategy !== undefined ? { homeStrategy: homeStrategy as RuntimeProfile['homeStrategy'] } : {}),
        // Scoped to THIS machine by default — this action only ever runs on
        // whichever machine's server the browser creating it is talking to,
        // which is exactly the machine `detectCatalogRuntimes` just checked
        // PATH on. See `lib/broker/runs.ts`'s `claimNextRun` for where this
        // is enforced; a single-machine install never notices it.
        hostId: currentHostId(),
        enabled: true,
      },
      overrideAccess: true,
    })
    revalidatePath(`/workspace/${workspaceSlug}/settings/runtimes`)
    return created
  })
}

/** One catalog entry, and whether its CLI was found on this machine. */
export interface DetectedRuntime {
  id: RuntimeCatalogId
  installed: boolean
  /** The executable that answered, when one did. */
  path: string | null
}

/**
 * Which catalog CLIs are installed on the machine running this server.
 *
 * A PATH lookup per entry, on demand — behind a button rather than on page
 * load, because four process spawns per render of the Runtimes page would be
 * a D0 violation for a question that changes once a month. Detection is
 * "the executable exists", nothing more: whether it speaks ACP and whether
 * it is signed in are the probe's questions, asked after the profile exists.
 */
export async function detectCatalogRuntimes(): Promise<WithFailure<DetectedRuntime[]>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')
    return Promise.all(
      RUNTIME_CATALOG.map(async (entry) => {
        const path = await resolveCommandPath(entry.detectCommand)
        return { id: entry.id, installed: path !== null, path }
      }),
    )
  })
}

/** What "Add this machine" actually did, for the confirmation toast. */
export interface AddMachineResult {
  host: RuntimeHost
  addedCount: number
  skippedCount: number
}

/**
 * The one-click multi-machine onboarding step: name this machine, and give
 * it a profile for every catalog CLI actually on its PATH.
 *
 * Runs entirely against the machine THIS Server Action executes on — there
 * is no other machine it could mean. `hostKey` is never taken from the
 * client for the same reason `setRuntimeProfileHost` above refuses one: a
 * person typing a name for a machine they are not looking at would silently
 * create profiles nothing can ever claim.
 *
 * Upserts the `runtime-hosts` row by `(workspace, hostKey)` rather than
 * always inserting, so running this again after a rename updates the
 * existing row instead of creating a duplicate "machine" for the same
 * physical computer.
 *
 * Profile creation is additive and idempotent by command line: a catalog CLI
 * this host already has a profile for (matched on the exact command string
 * `createRuntimeProfile` would have stored) is skipped rather than
 * duplicated, so re-running this after installing one more CLI only adds
 * that one.
 */
export async function addMachine({
  workspaceId,
  workspaceSlug,
  displayName,
}: {
  workspaceId: number
  workspaceSlug: string
  displayName: string
}): Promise<WithFailure<AddMachineResult>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')
    const trimmedName = displayName.trim()
    if (!trimmedName) raise('invalid_input', 'Name is required.')

    const hostKey = currentHostId()
    const payload = await getPayloadClient()

    const existingHost = await payload.find({
      collection: 'runtime-hosts',
      where: { workspace: { equals: workspaceId }, hostKey: { equals: hostKey } },
      limit: 1,
      overrideAccess: true,
    })
    const host = existingHost.docs[0]
      ? await payload.update({
          collection: 'runtime-hosts',
          id: existingHost.docs[0].id,
          data: { displayName: trimmedName },
          overrideAccess: true,
        })
      : await payload.create({
          collection: 'runtime-hosts',
          data: { workspace: workspaceId, displayName: trimmedName, hostKey, addedBy: user.id },
          overrideAccess: true,
        })

    const existingProfiles = await payload.find({
      collection: 'runtime-profiles',
      where: { workspace: { equals: workspaceId }, hostId: { equals: hostKey } },
      limit: 200,
      depth: 0,
      overrideAccess: true,
    })
    const alreadyHave = new Set(existingProfiles.docs.map((p) => p.commandName.trim()))

    let addedCount = 0
    let skippedCount = 0
    for (const entry of RUNTIME_CATALOG) {
      const path = await resolveCommandPath(entry.detectCommand)
      if (!path) continue
      const commandLine = catalogEntryCommandLine(entry)
      if (alreadyHave.has(commandLine.trim())) {
        skippedCount += 1
        continue
      }
      await payload.create({
        collection: 'runtime-profiles',
        data: {
          workspace: workspaceId,
          name: `${entry.displayName} (${trimmedName})`,
          protocolFamily: entry.protocolFamily,
          commandName: commandLine,
          homeStrategy: entry.homeStrategy as RuntimeProfile['homeStrategy'],
          hostId: hostKey,
          enabled: true,
        },
        overrideAccess: true,
      })
      addedCount += 1
    }

    revalidatePath(`/workspace/${workspaceSlug}/settings/runtimes`)
    return { host, addedCount, skippedCount }
  })
}

/**
 * Changes which machine may claim runs for agents on this profile — or clears
 * it, making the profile claimable from any machine again (`host_id NULL`,
 * this collection's own pre-multi-machine default). See
 * `lib/broker/runs.ts`'s `claimNextRun` for the read side.
 *
 * Deliberately does not accept an arbitrary string from the client: the only
 * two honest values a person can pick from a browser are "this machine" (the
 * one this Server Action is actually running on) and "any machine" — typing a
 * hostname for a machine that isn't the one you're looking at would silently
 * create a profile that can never be claimed anywhere, which is a worse
 * failure mode than the one this feature closes.
 */
export async function setRuntimeProfileHost({
  workspaceSlug,
  profileId,
  scope,
}: {
  workspaceSlug: string
  profileId: number
  scope: 'this-machine' | 'any-machine'
}): Promise<WithFailure<void>> {
  return guard(async () => {
    const payload = await getPayloadClient()
    await payload.update({
      collection: 'runtime-profiles',
      id: profileId,
      data: { hostId: scope === 'this-machine' ? currentHostId() : null },
      overrideAccess: true,
    })
    revalidatePath(`/workspace/${workspaceSlug}/settings/runtimes`)
  })
}

export async function toggleRuntimeProfileEnabled({
  workspaceSlug,
  profileId,
  enabled,
}: {
  workspaceSlug: string
  profileId: number
  enabled: boolean
}): Promise<WithFailure<void>> {
  return guard(async () => {
    const payload = await getPayloadClient()
    await payload.update({
      collection: 'runtime-profiles',
      id: profileId,
      data: { enabled },
      overrideAccess: true,
    })
    revalidatePath(`/workspace/${workspaceSlug}/settings/runtimes`)
  })
}

/**
 * R12-P4.1 - save what this runtime does unless an agent says otherwise.
 *
 * The values are the ids the runtime declared for itself in its ACP handshake,
 * so nothing here validates against a list we maintain: a runtime that ships a
 * new option gets a working editor at the next probe. What IS enforced is the
 * shape - a flat map of scalars - because the dispatcher merges this with
 * `agents.runtimeConfig` and a nested value there would be silently ignored by
 * `session/set_config_option`, which takes one scalar per id.
 */
export async function saveRuntimeDefaults({
  workspaceSlug,
  profileId,
  defaults,
}: {
  workspaceSlug: string
  profileId: number
  defaults: Record<string, unknown>
}): Promise<WithFailure<void>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')

    for (const [id, value] of Object.entries(defaults)) {
      const scalar = value === null || ['string', 'number', 'boolean'].includes(typeof value)
      if (!scalar) {
        raise('invalid_input', `"${id}" must be a single value, not a list or an object.`)
      }
    }

    const payload = await getPayloadClient()
    await payload.update({
      collection: 'runtime-profiles',
      id: profileId,
      data: { defaultSessionConfig: defaults },
      overrideAccess: true,
    })
    revalidatePath(`/workspace/${workspaceSlug}/settings/runtimes`)
  })
}

/** What the probe found, as the button renders it. The code is the part the UI
 * branches on; `lib/runtimes/probe-codes.ts` turns it into the sentences. */
export interface RuntimeProbeOutcome {
  code: string
  ok: boolean
  detail: string
  agentName: string | null
}

/**
 * Probes a runtime and records what came back.
 *
 * Two questions, answered separately, because they are two different problems
 * with two different fixes: is the binary on this machine, and does it
 * actually speak ACP. The previous check spawned the binary with Hermes's own
 * `--check` flag, so it could only ever validate Hermes.
 *
 * The agent's own `initialize` response is stored verbatim. We do not fold it
 * into flags of our own, because a capability matrix maintained here is a set
 * of claims about someone else's software that goes stale on their release
 * schedule.
 *
 * Note that a failed PROBE is not a failed ACTION: a runtime that is not
 * installed answers `command_not_found` as a normal result, which is why that
 * comes back in the success shape rather than as a `__failure`. The envelope
 * is reserved for the probe never happening at all.
 */
export async function probeRuntimeProfile({
  id,
  workspaceSlug,
}: {
  id: number
  workspaceSlug: string
}): Promise<WithFailure<RuntimeProbeOutcome>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) raise('unauthenticated', 'You must be logged in.')

    const payload = await getPayloadClient()
    const profile = await payload
      .findByID({ collection: 'runtime-profiles', id, depth: 0, overrideAccess: true, disableErrors: true })
      .catch(() => null)
    if (!profile) raise('not_found', 'That runtime profile no longer exists.')

    // A profile scoped to a different machine (`lib/broker/runs.ts`'s
    // `claimNextRun` reads the same `hostId`) has nothing real to spawn from
    // HERE — the binary this Server Action would try to run only exists on
    // the machine that profile names. Without this check that spawn attempt
    // fails ENOENT and reports `command_not_found`, which reads as "go
    // install it" when the true answer is "you're asking the wrong
    // computer." Deliberately not persisted to `lastProbeCode` — this is a
    // fact about who clicked the button just now, not about the runtime
    // itself, and writing it would clobber the real last-probe result every
    // other machine's page reads.
    if (profile.hostId && profile.hostId !== currentHostId()) {
      const hostRow = await payload.find({
        collection: 'runtime-hosts',
        where: {
          workspace: { equals: typeof profile.workspace === 'number' ? profile.workspace : profile.workspace.id },
          hostKey: { equals: profile.hostId },
        },
        limit: 1,
        depth: 0,
        overrideAccess: true,
      })
      const hostName = hostRow.docs[0]?.displayName ?? profile.hostId
      return {
        code: 'wrong_host',
        ok: false,
        detail: `This profile is scoped to "${hostName}". Open the Runtimes page on that machine and probe it from there.`,
        agentName: null,
      }
    }

    const args = Array.isArray(profile.fixedArgs)
      ? profile.fixedArgs.filter((a): a is string => typeof a === 'string')
      : []
    const result = await probeAcpRuntime(profile.commandName, args)

    await payload.update({
      collection: 'runtime-profiles',
      id,
      data: {
        handshake: result.handshake ?? null,
        lastProbeCode: result.code,
        lastProbeDetail: result.detail.slice(0, 500),
        lastProbedAt: new Date().toISOString(),
      } as never,
      overrideAccess: true,
    })

    revalidatePath(`/workspace/${workspaceSlug}/settings/runtimes`)
    return {
      code: result.code,
      ok: result.ok,
      detail: result.detail,
      agentName: result.handshake?.agentName ?? null,
    }
  })
}
