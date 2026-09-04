'use client'

import { useState, useTransition } from 'react'
import { AlertTriangle, Globe, Plus, Radio, Terminal, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PluginConfigFields } from './plugin-config-fields'
import {
  deletePlugin,
  savePlugin,
  setPluginEnabled,
  type AgentOption,
  type PluginConfigOption,
  type PluginSummary,
} from '@/app/(app)/workspace/[workspaceSlug]/settings/plugins/actions'
import { unwrap } from '@/lib/failures'

/**
 * Plugins — the tools this workspace gives its agents.
 *
 * Distinct from the MCP servers screen, and the difference is ownership. That
 * one reads and toggles servers inside the runtime's own config, which the CLI
 * owns and edits behind our back. These are ours: scoped to specific agents,
 * injected for the duration of a turn, and revocable for one agent without
 * touching another.
 *
 * Header and environment VALUES are never rendered back. The list shows which
 * names are set and whether each holds a value, which is what a person needs
 * to manage them and nothing an onlooker can use.
 */

interface DraftPair {
  name: string
  value: string
}

interface Draft {
  id?: number
  name: string
  description: string
  transport: 'http' | 'sse' | 'stdio'
  url: string
  command: string
  headers: DraftPair[]
  enabled: boolean
  scope: 'agents' | 'workspace'
  agentIds: number[]
  configOptions: PluginConfigOption[]
}

function emptyDraft(): Draft {
  return {
    name: '',
    description: '',
    transport: 'http',
    url: '',
    command: '',
    headers: [],
    enabled: true,
    // Reaching nobody until someone says who is the safe default for a thing
    // that grants capability.
    scope: 'agents',
    agentIds: [],
    configOptions: [],
  }
}

const TRANSPORT_ICON = { http: Globe, sse: Radio, stdio: Terminal } as const

export function PluginsSettings({
  workspaceSlug,
  plugins,
  agents,
  appUrl,
}: {
  workspaceSlug: string
  plugins: PluginSummary[]
  agents: AgentOption[]
  appUrl: string
}) {
  const [rows, setRows] = useState(plugins)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, startTransition] = useTransition()

  const refresh = (updater: (current: PluginSummary[]) => PluginSummary[]) => setRows(updater)

  function toggle(id: number, enabled: boolean) {
    refresh((current) => current.map((p) => (p.id === id ? { ...p, enabled } : p)))
    setError(null)
    startTransition(async () => {
      try {
        unwrap(await setPluginEnabled(workspaceSlug, id, enabled))
      } catch (err) {
        refresh((current) => current.map((p) => (p.id === id ? { ...p, enabled: !enabled } : p)))
        setError(err instanceof Error ? err.message : 'Could not change that plugin.')
      }
    })
  }

  function remove(id: number, name: string) {
    setError(null)
    startTransition(async () => {
      try {
        unwrap(await deletePlugin(workspaceSlug, id))
        refresh((current) => current.filter((p) => p.id !== id))
      } catch (err) {
        setError(err instanceof Error ? err.message : `Could not delete ${name}.`)
      }
    })
  }

  function save() {
    if (!draft) return
    setError(null)
    startTransition(async () => {
      try {
        unwrap(
          await savePlugin(workspaceSlug, {
            id: draft.id,
            name: draft.name,
            description: draft.description,
            transport: draft.transport,
            url: draft.url,
            command: draft.command,
            headers: draft.headers,
            enabled: draft.enabled,
            scope: draft.scope,
            agentIds: draft.agentIds,
            configOptions: draft.configOptions,
          }),
        )
        // Reloaded rather than patched in place: the server decides the
        // problem string and which header values survived, and guessing at
        // either here would let this list drift from what a run will see.
        window.location.reload()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save that plugin.')
      }
    })
  }

  function editDraftFrom(plugin: PluginSummary) {
    setDraft({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description ?? '',
      transport: plugin.transport,
      url: plugin.url ?? '',
      command: plugin.command ?? '',
      // Names are carried forward with empty values, because the stored value
      // is never sent to the browser. Leaving one blank drops it on save,
      // which is how a header is removed.
      headers: plugin.headers.map((h) => ({ name: h.name, value: '' })),
      enabled: plugin.enabled,
      scope: plugin.scope,
      agentIds: plugin.agentIds,
      configOptions: plugin.configOptions,
    })
  }

  return (
    <div className="flex w-full flex-col gap-6 px-5 py-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Plugins</h1>
          <p className="max-w-2xl text-sm text-black/50 dark:text-white/50">
            Tool servers this workspace gives its agents, injected for the duration of a turn and scoped to the
            agents you choose. Unlike the runtime&apos;s own MCP servers, these can be granted to one agent and not
            another, and revoked without editing anyone&apos;s config file.
          </p>
        </div>
        <Button onClick={() => setDraft(emptyDraft())} disabled={busy}>
          <Plus size={14} className="mr-1" />
          Add plugin
        </Button>
      </header>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* The endpoint this app serves itself, spelled out so the first plugin
          someone adds can be a working one rather than a guess. */}
      <Card>
        <CardContent className="py-3">
          <p className="text-xs font-medium text-black/60 dark:text-white/60">This app&apos;s own MCP server</p>
          <p className="mt-1 text-xs text-black/45 dark:text-white/45">
            Add an HTTP plugin pointing at <code className="font-mono">{appUrl}/api/mcp</code> with headers{' '}
            <code className="font-mono">Authorization: Bearer {'{{RUN_TOKEN}}'}</code> and{' '}
            <code className="font-mono">X-Run-Id: {'{{RUN_ID}}'}</code>. Those placeholders are replaced with the
            run&apos;s own short-lived values when a turn starts, so nothing stored here is a live credential.
          </p>
        </CardContent>
      </Card>

      {rows.length === 0 && !draft && (
        <p className="text-sm text-black/45 dark:text-white/45">
          No plugins yet. Agents still have whatever their runtime provides; these are the tools this product adds
          on top.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {rows.map((plugin) => {
          const Icon = TRANSPORT_ICON[plugin.transport]
          const reach =
            plugin.scope === 'workspace'
              ? 'Every agent in this workspace'
              : plugin.agentIds.length === 0
                ? 'No agents selected — this plugin reaches nobody'
                : `${plugin.agentIds.length} agent${plugin.agentIds.length === 1 ? '' : 's'}`
          return (
            <li key={plugin.id}>
              <Card>
                <CardContent className="flex items-start gap-3 py-3">
                  <Icon size={15} className="mt-0.5 shrink-0 text-black/40 dark:text-white/40" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{plugin.name}</span>
                      <span className="rounded bg-black/[0.06] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-black/50 dark:bg-white/[0.09] dark:text-white/50">
                        {plugin.transport}
                      </span>
                    </div>
                    {plugin.description && (
                      <p className="mt-0.5 text-xs text-black/50 dark:text-white/50">{plugin.description}</p>
                    )}
                    <p className="mt-1 truncate font-mono text-[11px] text-black/40 dark:text-white/40">
                      {plugin.transport === 'stdio' ? plugin.command : plugin.url}
                    </p>
                    <p className="mt-1 text-[11px] text-black/45 dark:text-white/45">{reach}</p>
                    {plugin.headers.length > 0 && (
                      <p className="mt-1 text-[11px] text-black/40 dark:text-white/40">
                        Headers:{' '}
                        {plugin.headers
                          .map((h) => `${h.name}${h.isTemplated ? ' (per-run)' : h.hasValue ? ' (set)' : ' (empty)'}`)
                          .join(', ')}
                      </p>
                    )}
                    {plugin.problem && (
                      <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                        <AlertTriangle size={11} />
                        Will not load: {plugin.problem}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={plugin.enabled}
                        disabled={busy}
                        onChange={(event) => toggle(plugin.id, event.target.checked)}
                      />
                      Enabled
                    </label>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => editDraftFrom(plugin)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => remove(plugin.id, plugin.name)}
                      aria-label={`Delete ${plugin.name}`}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          )
        })}
      </ul>

      {draft && (
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            <h2 className="text-sm font-semibold">{draft.id ? 'Edit plugin' : 'New plugin'}</h2>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-black/60 dark:text-white/60">Name</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
                placeholder="notionforge"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-black/60 dark:text-white/60">Description</span>
              <input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
                placeholder="What this lets an agent do."
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-black/60 dark:text-white/60">Transport</span>
              <select
                value={draft.transport}
                onChange={(e) => setDraft({ ...draft, transport: e.target.value as Draft['transport'] })}
                className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
              >
                <option value="http">HTTP</option>
                <option value="sse">SSE</option>
                <option value="stdio">stdio (local process)</option>
              </select>
            </label>

            {draft.transport === 'stdio' ? (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-black/60 dark:text-white/60">Command</span>
                <input
                  value={draft.command}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 font-mono text-sm dark:border-white/15"
                />
              </label>
            ) : (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-black/60 dark:text-white/60">URL</span>
                  <input
                    value={draft.url}
                    onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                    className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 font-mono text-sm dark:border-white/15"
                    placeholder={`${appUrl}/api/mcp`}
                  />
                </label>

                <div className="flex flex-col gap-2">
                  <span className="text-xs text-black/60 dark:text-white/60">
                    Headers — values are stored write-only and never shown again.
                  </span>
                  {draft.headers.map((pair, index) => (
                    <div key={index} className="flex gap-2">
                      <input
                        value={pair.name}
                        onChange={(e) => {
                          const next = [...draft.headers]
                          next[index] = { ...pair, name: e.target.value }
                          setDraft({ ...draft, headers: next })
                        }}
                        className="w-1/3 rounded-md border border-black/15 bg-transparent px-2 py-1.5 font-mono text-xs dark:border-white/15"
                        placeholder="Authorization"
                      />
                      <input
                        value={pair.value}
                        onChange={(e) => {
                          const next = [...draft.headers]
                          next[index] = { ...pair, value: e.target.value }
                          setDraft({ ...draft, headers: next })
                        }}
                        className="flex-1 rounded-md border border-black/15 bg-transparent px-2 py-1.5 font-mono text-xs dark:border-white/15"
                        placeholder="Bearer {{RUN_TOKEN}}"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDraft({ ...draft, headers: draft.headers.filter((_, i) => i !== index) })}
                        aria-label="Remove header"
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    onClick={() => setDraft({ ...draft, headers: [...draft.headers, { name: '', value: '' }] })}
                  >
                    <Plus size={13} className="mr-1" />
                    Add header
                  </Button>
                </div>
              </>
            )}

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-black/60 dark:text-white/60">Who can use it</span>
              <select
                value={draft.scope}
                onChange={(e) => setDraft({ ...draft, scope: e.target.value as Draft['scope'] })}
                className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
              >
                <option value="agents">Selected agents only</option>
                <option value="workspace">Every agent in this workspace</option>
              </select>
            </label>

            {draft.scope === 'agents' && (
              <div className="flex flex-wrap gap-2">
                {agents.length === 0 && (
                  <p className="text-xs text-black/45 dark:text-white/45">This workspace has no agents yet.</p>
                )}
                {agents.map((agent) => {
                  const selected = draft.agentIds.includes(agent.id)
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          agentIds: selected
                            ? draft.agentIds.filter((id) => id !== agent.id)
                            : [...draft.agentIds, agent.id],
                        })
                      }
                      className={`rounded-full border px-2.5 py-1 text-xs transition ${
                        selected
                          ? 'border-transparent bg-black/[0.08] font-medium dark:bg-white/[0.12]'
                          : 'border-black/15 hover:bg-black/[0.03] dark:border-white/15 dark:hover:bg-white/[0.05]'
                      }`}
                    >
                      {agent.name}
                    </button>
                  )
                })}
              </div>
            )}

            <PluginConfigFields
              options={draft.configOptions}
              disabled={busy}
              onChange={(configOptions) => setDraft({ ...draft, configOptions })}
            />

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
              Enabled
            </label>

            <div className="flex gap-2">
              <Button onClick={save} disabled={busy || !draft.name.trim()}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
