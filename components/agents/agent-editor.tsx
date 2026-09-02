'use client'

import { useMemo, useState, type FormEvent } from 'react'
import { saveAgent } from '@/app/(app)/workspace/[workspaceSlug]/agents/actions'
import { AgentCapabilities } from '@/components/agents/agent-capabilities'
import { Button } from '@/components/ui/button'

export type Agent = {
  id: number
  name: string
  runtimeProfile: number | { id: number }
  model?: string | null
  thinkingLevel?: string | null
  instructions?: string | null
  customEnv?: unknown
  customArgs?: unknown
  mcpConfig?: unknown
  skills?: unknown
  maxConcurrentRuns?: number | null
  permissionMode?: string
  enabled?: boolean | null
}

type Profile = {
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

function buildDraft(agent: Agent | null, profiles: Profile[]): Draft {
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

export function AgentEditor({
  workspaceId,
  workspaceSlug,
  profiles,
  initialAgents,
}: {
  workspaceId: number
  workspaceSlug: string
  profiles: Profile[]
  initialAgents: Agent[]
}) {
  const [agents, setAgents] = useState(initialAgents)
  const [editing, setEditing] = useState<Agent | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<Draft>(buildDraft(null, profiles))
  const [activeTab, setActiveTab] = useState<'overview' | 'capabilities'>('overview')

  const hasProfiles = profiles.length > 0
  const sortedAgents = useMemo(() => [...agents].sort((a, b) => a.name.localeCompare(b.name)), [agents])

  function start(agent?: Agent) {
    const nextAgent = agent ?? null
    setEditing(nextAgent)
    setDraft(buildDraft(nextAgent, profiles))
    setActiveTab('overview')
    setError('')
  }

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
        id: editing?.id,
        data: {
          ...draft,
          ...advanced,
          name: draft.name.trim(),
          instructions: draft.instructions || undefined,
          maxConcurrentRuns: Number(draft.maxConcurrentRuns),
        },
      })) as Agent

      setAgents((current) =>
        editing
          ? current.map((item) => (item.id === editing.id ? result : item))
          : [...current, result],
      )
      setEditing(result)
      setDraft(buildDraft(result, profiles))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save agent.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
      <section className="space-y-2">
        <Button type="button" variant="outline" size="sm" onClick={() => start()}>
          New agent
        </Button>

        {sortedAgents.length === 0 ? (
          <p className="rounded-lg border border-black/10 p-4 text-sm text-black/50 dark:border-white/10 dark:text-white/50">
            No agents configured yet.
          </p>
        ) : (
          sortedAgents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => start(agent)}
              className="flex w-full items-center justify-between rounded-lg border border-black/10 p-4 text-left hover:bg-black/[.03] dark:border-white/10 dark:hover:bg-white/[.04]"
            >
              <span>
                <span className="block font-medium">{agent.name}</span>
                <span className="text-xs text-black/50 dark:text-white/50">
                  {agent.model || 'Default model'} · {agent.permissionMode || 'ask'}
                </span>
              </span>
              <span className="text-xs text-black/40">Edit</span>
            </button>
          ))
        )}
      </section>

      <div className="space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/10">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">{editing ? `Edit ${editing.name}` : 'New agent'}</h2>
          <div className="flex gap-1 rounded-md border border-black/10 p-1 dark:border-white/10">
            <button
              type="button"
              onClick={() => setActiveTab('overview')}
              className={`rounded px-2 py-1 text-xs ${activeTab === 'overview' ? 'bg-black text-white dark:bg-white dark:text-black' : 'text-black/60 hover:bg-black/[.04] dark:text-white/60 dark:hover:bg-white/[.06]'}`}
            >
              Overview
            </button>
            <button
              type="button"
              disabled={!editing}
              onClick={() => setActiveTab('capabilities')}
              className={`rounded px-2 py-1 text-xs ${activeTab === 'capabilities' ? 'bg-black text-white dark:bg-white dark:text-black' : 'text-black/60 hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-50 dark:text-white/60 dark:hover:bg-white/[.06]'}`}
            >
              Capabilities
            </button>
          </div>
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        {activeTab === 'overview' ? (
          <form onSubmit={submit} className="space-y-3">
            {!hasProfiles && (
              <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400">
                No runtime profiles are available. Create a runtime profile before saving an agent.
              </p>
            )}

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
                {busy ? 'Saving…' : editing ? 'Save changes' : 'Create agent'}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => start(editing ?? undefined)}>
                Reset
              </Button>
            </div>
          </form>
        ) : editing ? (
          <AgentCapabilities
            workspaceId={workspaceId}
            workspaceSlug={workspaceSlug}
            agent={editing}
            onAgentUpdated={(nextAgent) => {
              setEditing(nextAgent)
              setDraft(buildDraft(nextAgent, profiles))
              setAgents((current) => current.map((item) => (item.id === nextAgent.id ? nextAgent : item)))
            }}
          />
        ) : (
          <p className="rounded-md border border-black/10 p-3 text-sm text-black/50 dark:border-white/10 dark:text-white/50">
            Save a new agent first, then open Capabilities to manage skills, MCP, and models.
          </p>
        )}
      </div>
    </div>
  )
}
