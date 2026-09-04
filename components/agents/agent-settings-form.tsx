'use client'

import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { listAgentHermesProfiles, saveAgent } from '@/app/(app)/workspace/[workspaceSlug]/agents/actions'
import { Button } from '@/components/ui/button'
import { unwrap } from '@/lib/failures'
import type { Agent } from '@/components/agents/agent-editor'
import type { ActiveModelConfig } from '@/lib/runtimes/hermes/providers'
import type { HermesProfileSummary } from '@/lib/runtimes/hermes/profiles'
import { sessionConfigOptions, type AgentHandshake, type SessionConfigOption } from '@/lib/runtimes/handshake'
import { RuntimeConfigFields } from '@/components/runtimes/runtime-config-fields'
import { AgentSkillsField, normalizeSkillNames } from '@/components/agents/agent-skills-field'

// Extracted out of the old list-page inline editor (agent-editor.tsx) so the
// same save-a-draft form can be mounted from two places: the "New agent"
// creation flow on the list page, and the Settings tab on the new agent
// detail route (agents/[agentId]/page.tsx). The Capabilities half of the old
// inline editor (Skills/MCP/Models against /api/hermes/*) is NOT part of
// this form — it now lives only on the detail route's Capabilities tab, see
// components/agents/agent-detail-view.tsx.

export type AgentProfile = {
  id: number
  name: string
  commandName: string
  /** Which runtime home strategy this profile uses. 'hermes' is the only one
   * for which a Hermes profile means anything. */
  homeStrategy?: string | null
  /** What the runtime said about itself when it was last probed. The source
   * of truth for which settings this agent can be given. */
  handshake?: AgentHandshake | null
  /** R12-P4.1 — what this runtime does for an option the agent leaves unset.
   * Optional because the agents LIST page passes runtime-profile rows through
   * without projecting them; a missing value there means "we were not told",
   * which the inheritance summary renders differently from "no default". */
  defaultSessionConfig?: Record<string, unknown> | null
}

type Draft = {
  name: string
  runtimeProfile: number
  thinkingLevel: string
  instructions: string
  customEnv: string
  customArgs: string
  skills: string[]
  maxConcurrentRuns: number
  permissionMode: string
  enabled: boolean
  hermesProfile: string
  runtimeConfig: Record<string, unknown>
}

function buildDraft(agent: Agent | null, profiles: AgentProfile[]): Draft {
  return {
    name: agent?.name ?? '',
    runtimeProfile:
      typeof agent?.runtimeProfile === 'number'
        ? agent.runtimeProfile
        : agent?.runtimeProfile?.id ?? profiles[0]?.id ?? 0,
    thinkingLevel: agent?.thinkingLevel ?? 'medium',
    instructions: agent?.instructions ?? '',
    customEnv: JSON.stringify(agent?.customEnv ?? {}, null, 2),
    customArgs: JSON.stringify(agent?.customArgs ?? [], null, 2),
    skills: normalizeSkillNames(agent?.skills),
    maxConcurrentRuns: agent?.maxConcurrentRuns ?? 1,
    permissionMode: agent?.permissionMode ?? 'ask',
    enabled: agent?.enabled ?? true,
    hermesProfile: agent?.hermesProfile ?? '',
    runtimeConfig:
      agent?.runtimeConfig && typeof agent.runtimeConfig === 'object'
        ? (agent.runtimeConfig as Record<string, unknown>)
        : {},
  }
}

export function AgentSettingsForm({
  workspaceId,
  workspaceSlug,
  profiles,
  agent,
  activeModel,
  onSaved,
}: {
  workspaceId: number
  workspaceSlug: string
  profiles: AgentProfile[]
  /** null when this form is creating a brand-new agent. */
  agent: Agent | null
  /** The install root's active model, used only as the fallback display when
   * this agent runs on no profile. Per-agent models come from the profile
   * picker below. Undefined when mounted from a context that doesn't fetch
   * it (e.g. the "New agent" creation flow). */
  activeModel?: ActiveModelConfig | null
  onSaved: (agent: Agent) => void
}) {
  const [draft, setDraft] = useState<Draft>(() => buildDraft(agent, profiles))
  // Which runtime this agent will actually run on decides what can be
  // configured for it. This form used to show the Hermes profile picker
  // unconditionally, so an agent on Claude Code was offered a list of Hermes
  // profiles that had no bearing on it whatsoever — and no way to choose the
  // model the runtime genuinely does offer.
  const selectedRuntime = profiles.find((entry) => entry.id === draft.runtimeProfile) ?? null
  const usesHermesHome = (selectedRuntime?.homeStrategy ?? 'hermes') === 'hermes'
  const runtimeOptions = sessionConfigOptions(selectedRuntime?.handshake ?? null)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Loaded from the server rather than passed in, because the authority for
  // which profiles exist is the Hermes install on this machine — not anything
  // this database knows. Fetched once on mount; the list changes only when
  // someone edits the Hermes install itself.
  const [hermesProfiles, setHermesProfiles] = useState<HermesProfileSummary[]>([])
  useEffect(() => {
    // Not fetched at all for a non-Hermes runtime: it reaches into the Hermes
    // install on this machine, which is both irrelevant and a wasted round
    // trip when the selected runtime is something else.
    if (!usesHermesHome) return
    let cancelled = false
    void listAgentHermesProfiles()
      .then((result) => {
        if (!cancelled) setHermesProfiles(unwrap(result))
      })
      // A failure here must not block editing everything else on the form —
      // the picker simply stays on whatever the agent already had.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [usesHermesHome])
  const selectedProfile = hermesProfiles.find((entry) => entry.name === draft.hermesProfile) ?? null

  const hasProfiles = profiles.length > 0

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!draft.name.trim() || !draft.runtimeProfile) {
      setError('Name and runtime profile are required.')
      return
    }

    setBusy(true)
    setError('')

    let advanced: { customEnv: unknown; customArgs: unknown }

    try {
      advanced = {
        customEnv: JSON.parse(draft.customEnv),
        customArgs: JSON.parse(draft.customArgs),
      }
    } catch {
      setError('Environment and arguments must contain valid JSON.')
      setBusy(false)
      return
    }

    try {
      const result = unwrap(
        await saveAgent({
          workspaceId,
          workspaceSlug,
          id: agent?.id,
          data: {
            ...draft,
            ...advanced,
            name: draft.name.trim(),
            instructions: draft.instructions || undefined,
            maxConcurrentRuns: Number(draft.maxConcurrentRuns),
          },
        }),
      ) as Agent

      onSaved(result)
      setDraft(buildDraft(result, profiles))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save agent.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {!hasProfiles && (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400">
          No runtime profiles are available. Create a runtime profile before saving an agent.
        </p>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      <label className="block text-xs">
        Name
        <input
          required
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          className="mt-1 w-full rounded border border-black/15 px-2 py-1.5 text-sm dark:border-white/15 dark:bg-white/[.04]"
        />
      </label>

      <label className="block text-xs">
        Runtime profile
        <select
          required
          value={draft.runtimeProfile}
          onChange={(event) => setDraft({ ...draft, runtimeProfile: Number(event.target.value) })}
          className="mt-1 w-full rounded border border-black/15 px-2 py-1.5 text-sm dark:border-white/15 dark:bg-white/[.04]"
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} ({profile.commandName})
            </option>
          ))}
        </select>
      </label>

      {/* What can be configured here depends on the runtime, and until now it
          did not: the Hermes profile picker rendered for every agent, so an
          agent on Claude Code was offered Hermes profiles that had no bearing
          on it and no way to pick the model Claude actually offers. */}
      {usesHermesHome ? (
        <>
          {/* Was: "Hermes has one active model for the whole install, not one
              per agent." That was wrong. `hermes-acp` genuinely has no --model
              flag, which is what the old copy reasoned from — but a Hermes
              PROFILE directory is a complete HERMES_HOME with its own
              config.yaml, so selecting a profile selects a model. Verified on
              this machine: four real profiles pinning three different models. */}
          <label className="block text-xs">
            Hermes profile
            <select
              value={draft.hermesProfile}
              onChange={(event) => setDraft({ ...draft, hermesProfile: event.target.value })}
              className="mt-1 w-full rounded border border-black/15 px-2 py-1.5 text-sm dark:border-white/15 dark:bg-white/[.04]"
            >
              {hermesProfiles.length === 0 && <option value="">Loading profiles…</option>}
              {hermesProfiles.map((profile) => (
                <option key={profile.name || '__root__'} value={profile.name}>
                  {profile.name || 'Install default'}
                  {profile.model ? ` — ${profile.provider}/${profile.model}` : ' — no model configured'}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] font-normal text-black/45 dark:text-white/45">
              The profile decides which model, provider and credentials this agent uses. Its skills, memories and
              per-conversation state stay scoped to this agent either way.
            </p>
          </label>

          <div className="block text-xs">
            Model for this agent
            <div className="mt-1 flex items-center justify-between gap-2 rounded border border-black/15 bg-black/[.02] px-2 py-1.5 text-sm dark:border-white/15 dark:bg-white/[.03]">
              <span>
                {selectedProfile
                  ? selectedProfile.model
                    ? `${selectedProfile.provider} / ${selectedProfile.model}`
                    : 'No model configured in this profile'
                  : activeModel
                    ? `${activeModel.provider} / ${activeModel.model}`
                    : 'Unknown'}
              </span>
              <Link
                href={`/workspace/${workspaceSlug}/settings/providers`}
                className="shrink-0 text-xs font-medium text-primary underline-offset-2 hover:underline"
              >
                Manage in Providers →
              </Link>
            </div>
          </div>
        </>
      ) : runtimeOptions === undefined ? (
        <p className="rounded border border-black/10 bg-black/[.02] px-2 py-1.5 text-[11px] text-black/50 dark:border-white/10 dark:bg-white/[.03] dark:text-white/50">
          This runtime has not been probed yet, so its settings are unknown. Probe it on the{' '}
          <Link
            href={`/workspace/${workspaceSlug}/settings/runtimes`}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            Runtimes page
          </Link>{' '}
          and its own model and options will appear here. Not knowing is different from there being nothing.
        </p>
      ) : runtimeOptions.length === 0 ? (
        <p className="rounded border border-black/10 bg-black/[.02] px-2 py-1.5 text-[11px] text-black/50 dark:border-white/10 dark:bg-white/[.03] dark:text-white/50">
          {selectedRuntime?.name ?? 'This runtime'} declares no settings of its own, so it chooses its own model
          and behaviour. Nothing to configure here.
        </p>
      ) : (
        <div className="flex flex-col gap-3 rounded border border-black/10 p-3 dark:border-white/10">
          <p className="text-[11px] font-medium uppercase tracking-wide text-black/40 dark:text-white/40">
            {selectedRuntime?.name ?? 'Runtime'} settings
          </p>
          {/* Every one of these came from the runtime's own `session/new`
              response at probe time. Nothing here is a list this app
              maintains, which is why a new model needs no release from us. */}
          <RuntimeConfigFields
            options={runtimeOptions}
            values={draft.runtimeConfig}
            disabled={busy}
            onChange={(runtimeConfig) => setDraft({ ...draft, runtimeConfig })}
          />
          <InheritedRuntimeDefaults
            runtimeName={selectedRuntime?.name ?? 'this runtime'}
            options={runtimeOptions}
            values={draft.runtimeConfig}
            defaults={selectedRuntime?.defaultSessionConfig ?? null}
          />
        </div>
      )}

      <label className="block text-xs">
        Thinking level
        <select
          value={draft.thinkingLevel}
          onChange={(event) => setDraft({ ...draft, thinkingLevel: event.target.value })}
          className="mt-1 w-full rounded border border-black/15 px-2 py-1.5 text-sm dark:border-white/15 dark:bg-white/[.04]"
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>

      <label className="block text-xs">
        Instructions
        <textarea
          value={draft.instructions}
          onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
          rows={4}
          className="mt-1 w-full rounded border border-black/15 px-2 py-1.5 text-sm dark:border-white/15 dark:bg-white/[.04]"
        />
      </label>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs">
          Custom environment (JSON)
          <textarea
            value={draft.customEnv}
            onChange={(event) => setDraft({ ...draft, customEnv: event.target.value })}
            rows={6}
            className="mt-1 w-full rounded border border-black/15 px-2 py-1.5 font-mono text-xs dark:border-white/15 dark:bg-white/[.04]"
          />
        </label>
        <label className="block text-xs">
          Custom args (JSON)
          <textarea
            value={draft.customArgs}
            onChange={(event) => setDraft({ ...draft, customArgs: event.target.value })}
            rows={6}
            className="mt-1 w-full rounded border border-black/15 px-2 py-1.5 font-mono text-xs dark:border-white/15 dark:bg-white/[.04]"
          />
        </label>
      </div>

      {/* The MCP config editor that used to sit beside this is GONE. It wrote
          `agents.mcpConfig` and nothing anywhere read it back: the dispatcher
          composes a run's MCP servers from `lib/plugins/resolve.ts`, and the
          only other references to the column in the whole repository were this
          form writing it and `app/api/agents/route.ts` listing it among the
          fields it must never return. An editor for a field with zero
          consumers is worse than no editor — it looks like configuration and
          behaves like a text file. The column is left in place (it is not this
          unit's to drop) but nothing offers to fill it any more; MCP servers
          are configured as plugins, which the Capabilities tab shows. */}
      <AgentSkillsField
        value={draft.skills}
        onChange={(skills) => setDraft({ ...draft, skills })}
        usesHermesHome={usesHermesHome}
        disabled={busy}
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs">
          Max concurrent runs
          <input
            type="number"
            min={1}
            value={draft.maxConcurrentRuns}
            onChange={(event) =>
              setDraft({ ...draft, maxConcurrentRuns: Number(event.target.value) || 1 })
            }
            className="mt-1 w-full rounded border border-black/15 px-2 py-1.5 text-sm dark:border-white/15 dark:bg-white/[.04]"
          />
          {draft.maxConcurrentRuns > 1 && (
            <span className="mt-1 block text-[11px] font-normal text-amber-700 dark:text-amber-400">
              Above 1: this agent&apos;s memory is last-writer-wins across its own concurrent runs (see the Memory
              tab) — the run that finishes last overwrites what an earlier one just learned.
            </span>
          )}
        </label>

        <label className="block text-xs">
          Permission mode
          <select
            value={draft.permissionMode}
            onChange={(event) => setDraft({ ...draft, permissionMode: event.target.value })}
            className="mt-1 w-full rounded border border-black/15 px-2 py-1.5 text-sm dark:border-white/15 dark:bg-white/[.04]"
          >
            <option value="ask">Ask before actions</option>
            <option value="auto">Auto-approve</option>
            <option value="deny">Deny actions</option>
          </select>
        </label>
      </div>

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />
        Enabled
      </label>

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !hasProfiles}>
          {busy ? 'Saving…' : agent ? 'Save changes' : 'Create agent'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setDraft(buildDraft(agent, profiles))}>
          Reset
        </Button>
      </div>
    </form>
  )
}

/**
 * What an unset option actually resolves to, named out loud.
 *
 * R12-P4.1 gave runtime profiles a `defaultSessionConfig` that the dispatcher
 * merges UNDER an agent's own `runtimeConfig`, so leaving a field empty is not
 * "no value" — it is "whatever the runtime profile says". Until this, the form
 * rendered an empty select for `model` and the agent silently ran on `sonnet`
 * because the Claude Code runtime profile said so, with nothing on the screen
 * connecting the two. Somebody debugging "why is this agent on the wrong
 * model" had no way to discover the answer from the page that configures it.
 *
 * Only options the agent leaves UNSET are listed: an option the agent has
 * chosen for itself is not inheriting anything, and listing it would turn a
 * short, readable line into noise nobody reads.
 *
 * `defaults` being null means the profile was passed through without this
 * field (the agents LIST page does that) — which is "we were not told", not
 * "there are no defaults", and the two must not render the same.
 */
function InheritedRuntimeDefaults({
  runtimeName,
  options,
  values,
  defaults,
}: {
  runtimeName: string
  options: SessionConfigOption[]
  values: Record<string, unknown>
  defaults: Record<string, unknown> | null
}) {
  if (!defaults) return null
  const inherited = options
    .filter((option) => values[option.id] === undefined && defaults[option.id] !== undefined)
    .map((option) => {
      const value = defaults[option.id]
      const label =
        option.options?.find((choice) => choice.value === String(value))?.name ?? String(value)
      return { id: option.id, name: option.name, label }
    })
  if (inherited.length === 0) return null

  return (
    <p className="border-t border-black/10 pt-2 text-[11px] text-black/50 dark:border-white/10 dark:text-white/50">
      Left unset, so inherited from the {runtimeName} runtime:{' '}
      {inherited.map((entry, index) => (
        <span key={entry.id}>
          {index > 0 ? ', ' : ''}
          <span className="font-medium text-black/70 dark:text-white/70">{entry.label}</span> for {entry.name}
        </span>
      ))}
      .
    </p>
  )
}
