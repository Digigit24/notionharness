'use client'

import { useState, type FormEvent } from 'react'
import { saveAgent } from '@/app/(app)/workspace/[workspaceSlug]/agents/actions'
import { Button } from '@/components/ui/button'
import type { Agent } from '@/components/agents/agent-editor'

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
  model: string
  thinkingLevel: string
  instructions: string
  customEnv: string
  customArgs: string
  mcpConfig: string
  skills: string
  maxConcurrentRuns: number
  permissionMode: string
  enabled: boolean
}

function buildDraft(agent: Agent | null, profiles: AgentProfile[]): Draft {
  return {
    name: agent?.name ?? '',
    runtimeProfile:
      typeof agent?.runtimeProfile === 'number'
        ? agent.runtimeProfile
        : agent?.runtimeProfile?.id ?? profiles[0]?.id ?? 0,
    model: agent?.model ?? '',
    thinkingLevel: agent?.thinkingLevel ?? 'medium',
    instructions: agent?.instructions ?? '',
    customEnv: JSON.stringify(agent?.customEnv ?? {}, null, 2),
    customArgs: JSON.stringify(agent?.customArgs ?? [], null, 2),
    mcpConfig: JSON.stringify(agent?.mcpConfig ?? {}, null, 2),
    skills: JSON.stringify(agent?.skills ?? [], null, 2),
    maxConcurrentRuns: agent?.maxConcurrentRuns ?? 1,
    permissionMode: agent?.permissionMode ?? 'ask',
    enabled: agent?.enabled ?? true,
  }
}

export function AgentSettingsForm({
  workspaceId,
  workspaceSlug,
  profiles,
  agent,
  onSaved,
}: {
  workspaceId: number
  workspaceSlug: string
  profiles: AgentProfile[]
  /** null when this form is creating a brand-new agent. */
  agent: Agent | null
  onSaved: (agent: Agent) => void
}) {
  const [draft, setDraft] = useState<Draft>(() => buildDraft(agent, profiles))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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

      <label className="block text-xs">
        Model
        <input
          value={draft.model}
          onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          placeholder="e.g. claude-sonnet"
          className="mt-1 w-full rounded border border-black/15 px-2 py-1.5 text-sm dark:border-white/15 dark:bg-white/[.04]"
        />
      </label>

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
