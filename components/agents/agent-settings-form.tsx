'use client'

import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { listAgentHermesProfiles, saveAgent } from '@/app/(app)/workspace/[workspaceSlug]/agents/actions'
import { Button } from '@/components/ui/button'
import type { Agent } from '@/components/agents/agent-editor'
import type { ActiveModelConfig } from '@/lib/runtimes/hermes/providers'
import type { HermesProfileSummary } from '@/lib/runtimes/hermes/profiles'

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
}

type Draft = {
  name: string
  runtimeProfile: number
  thinkingLevel: string
  instructions: string
  customEnv: string
  customArgs: string
  mcpConfig: string
  skills: string
  maxConcurrentRuns: number
  permissionMode: string
  enabled: boolean
  hermesProfile: string
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
    mcpConfig: JSON.stringify(agent?.mcpConfig ?? {}, null, 2),
    skills: JSON.stringify(agent?.skills ?? [], null, 2),
    maxConcurrentRuns: agent?.maxConcurrentRuns ?? 1,
    permissionMode: agent?.permissionMode ?? 'ask',
    enabled: agent?.enabled ?? true,
    hermesProfile: agent?.hermesProfile ?? '',
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Loaded from the server rather than passed in, because the authority for
  // which profiles exist is the Hermes install on this machine — not anything
  // this database knows. Fetched once on mount; the list changes only when
  // someone edits the Hermes install itself.
  const [hermesProfiles, setHermesProfiles] = useState<HermesProfileSummary[]>([])
  useEffect(() => {
    let cancelled = false
    void listAgentHermesProfiles()
      .then((list) => {
        if (!cancelled) setHermesProfiles(list)
      })
      // A failure here must not block editing everything else on the form —
      // the picker simply stays on whatever the agent already had.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
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

    let advanced: {
      customEnv: unknown
      customArgs: unknown
      mcpConfig: unknown
      skills: unknown
    }

    try {
      advanced = {
        customEnv: JSON.parse(draft.customEnv),
        customArgs: JSON.parse(draft.customArgs),
        mcpConfig: JSON.parse(draft.mcpConfig),
        skills: JSON.parse(draft.skills),
      }
    } catch {
      setError('Environment, arguments, MCP config, and skills must contain valid JSON.')
      setBusy(false)
      return
    }

    try {
      const result = (await saveAgent({
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
      })) as Agent

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

      {/* Was: "Hermes has one active model for the whole install, not one per
          agent." That was wrong. `hermes-acp` genuinely has no --model flag,
          which is what the old copy was reasoning from — but a Hermes PROFILE
          directory is a complete HERMES_HOME with its own config.yaml, so
          selecting a profile selects a model. Verified on this machine: four
          real profiles pinning three different models. */}
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

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs">
          MCP config (JSON)
          <textarea
            value={draft.mcpConfig}
            onChange={(event) => setDraft({ ...draft, mcpConfig: event.target.value })}
            rows={6}
            className="mt-1 w-full rounded border border-black/15 px-2 py-1.5 font-mono text-xs dark:border-white/15 dark:bg-white/[.04]"
          />
        </label>
        <label className="block text-xs">
          Skills (JSON)
          <textarea
            value={draft.skills}
            onChange={(event) => setDraft({ ...draft, skills: event.target.value })}
            rows={6}
            className="mt-1 w-full rounded border border-black/15 px-2 py-1.5 font-mono text-xs dark:border-white/15 dark:bg-white/[.04]"
          />
        </label>
      </div>
      <p className="-mt-1 text-[11px] text-black/45 dark:text-white/45">
        Prefer the Capabilities tab to bind/unbind skills — this raw JSON field is for advanced edits only.
      </p>

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
