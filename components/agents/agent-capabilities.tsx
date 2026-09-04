'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { saveAgent } from '@/app/(app)/workspace/[workspaceSlug]/agents/actions'
import { Button } from '@/components/ui/button'
import type { Agent } from '@/components/agents/agent-editor'
import { formatTimestamp } from '@/lib/relative-time'

type SkillItem = {
  name: string
  description: string
  enabled: boolean | null
  size: number | null
  modifiedAt: string | null
  raw: Record<string, unknown>
}

type MpcServerItem = {
  key: string
  name: string
  transport: string
  state: string
  raw: Record<string, unknown>
}

type MpcToolItem = {
  name: string
  description: string
  serverKey: string | null
}

type ModelItem = {
  key: string
  name: string
  provider: string | null
  contextWindow: number | null
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function firstString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function firstNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function firstBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function extractArrayFromPayload(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload
  const root = asRecord(payload)
  for (const key of keys) {
    const value = root[key]
    if (Array.isArray(value)) return value
  }
  if (Array.isArray(root.data)) return root.data
  return []
}

function normalizeSkillNameList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const names: string[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry)
    else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name)
    }
  }
  return names
}

function formatBytes(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function extractSkillItems(payload: unknown): SkillItem[] {
  const rows = extractArrayFromPayload(payload, ['skills', 'items'])
  return rows
    .map((row) => {
      const raw = asRecord(row)
      const name =
        firstString(raw.name) ||
        firstString(raw.skill) ||
        firstString(raw.id) ||
        firstString(raw.slug)
      if (!name) return null
      return {
        name,
        description: firstString(raw.description) || firstString(raw.summary),
        enabled:
          firstBoolean(raw.enabled) ??
          firstBoolean(raw.isEnabled) ??
          firstBoolean(raw.active),
        size: firstNumber(raw.size) ?? firstNumber(raw.bytes) ?? firstNumber(raw.fileSize),
        modifiedAt:
          firstString(raw.modifiedAt) ||
          firstString(raw.updatedAt) ||
          firstString(raw.mtime) ||
          null,
        raw,
      }
    })
    .filter((item): item is SkillItem => item !== null)
}

function extractMcpServers(payload: unknown): MpcServerItem[] {
  const rows = extractArrayFromPayload(payload, ['servers', 'items'])
  return rows
    .map((row, index) => {
      const raw = asRecord(row)
      const name = firstString(raw.name) || firstString(raw.id) || `Server ${index + 1}`
      const key = firstString(raw.id) || name
      return {
        key,
        name,
        transport: firstString(raw.transport) || firstString(raw.type) || 'unknown',
        state:
          firstString(raw.state) ||
          firstString(raw.status) ||
          firstString(raw.connectionState) ||
          'unknown',
        raw,
      }
    })
    .filter((item) => Boolean(item.key))
}

function extractMcpTools(payload: unknown): MpcToolItem[] {
  const rows = extractArrayFromPayload(payload, ['tools', 'items'])
  return rows
    .map((row) => {
      const raw = asRecord(row)
      const name = firstString(raw.name) || firstString(raw.id)
      if (!name) return null
      return {
        name,
        description: firstString(raw.description) || firstString(raw.summary),
        serverKey:
          firstString(raw.serverName) ||
          firstString(raw.server) ||
          firstString(raw.serverId) ||
          null,
      }
    })
    .filter((item): item is MpcToolItem => item !== null)
}

function extractModels(payload: unknown): { models: ModelItem[]; refreshedAt: string | null } {
  const root = asRecord(payload)
  const rows = extractArrayFromPayload(payload, ['models', 'items'])
  return {
    models: rows
      .map((row, index) => {
        const raw = asRecord(row)
        const name = firstString(raw.name) || firstString(raw.id)
        if (!name) return null
        return {
          key: firstString(raw.id) || `${name}-${index}`,
          name,
          provider: firstString(raw.provider) || null,
          contextWindow:
            firstNumber(raw.contextWindow) ??
            firstNumber(raw.context_length) ??
            firstNumber(raw.maxTokens),
        }
      })
      .filter((item): item is ModelItem => item !== null),
    refreshedAt:
      firstString(root.lastRefreshedAt) ||
      firstString(root.refreshedAt) ||
      firstString(root.updatedAt) ||
      null,
  }
}

function maskSensitiveValue(key: string, value: string): string {
  if (!/(token|secret|password|api[_-]?key|key)/i.test(key)) return value
  if (value.length <= 4) return '****'
  return `${'*'.repeat(Math.max(value.length - 4, 4))}${value.slice(-4)}`
}

function readContentString(payload: unknown): string {
  if (typeof payload === 'string') return payload
  const root = asRecord(payload)
  return (
    firstString(root.content) ||
    firstString(root.text) ||
    firstString(root.value) ||
    ''
  )
}

export function AgentCapabilities({
  workspaceId,
  workspaceSlug,
  agent,
  onAgentUpdated,
}: {
  workspaceId: number
  workspaceSlug: string
  agent: Agent
  onAgentUpdated: (next: Agent) => void
}) {
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState('')
  const [skillToggleBusy, setSkillToggleBusy] = useState<Record<string, boolean>>({})
  const [agentSkillsBusy, setAgentSkillsBusy] = useState<Record<string, boolean>>({})

  const [selectedSkill, setSelectedSkill] = useState<string>('')
  const [selectedSkillFile, setSelectedSkillFile] = useState('SKILL.md')
  const [skillContent, setSkillContent] = useState('')
  const [contentLoading, setContentLoading] = useState(false)
  const [contentError, setContentError] = useState('')
  const [newSkillName, setNewSkillName] = useState('')
  const [saveStatus, setSaveStatus] = useState('')
  const [saveBusy, setSaveBusy] = useState(false)
  const [pendingDeleteSkill, setPendingDeleteSkill] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const [servers, setServers] = useState<MpcServerItem[]>([])
  const [serverTools, setServerTools] = useState<MpcToolItem[]>([])
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpError, setMcpError] = useState('')
  const [expandedServer, setExpandedServer] = useState<string>('')

  const [models, setModels] = useState<ModelItem[]>([])
  const [modelsRefreshedAt, setModelsRefreshedAt] = useState<string | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [refreshBusy, setRefreshBusy] = useState(false)

  const boundSkillNames = useMemo(() => new Set(normalizeSkillNameList(agent.skills)), [agent.skills])

  useEffect(() => {
    let cancelled = false
    const loadSkills = async () => {
      setSkillsLoading(true)
      setSkillsError('')
      try {
        const response = await fetch('/api/hermes/skills', { cache: 'no-store' })
        const payload = await response.json()
        if (!response.ok) {
          throw new Error(firstString(asRecord(payload).error) || 'Failed to load skills')
        }
        if (!cancelled) {
          const items = extractSkillItems(payload).sort((a, b) => a.name.localeCompare(b.name))
          setSkills(items)
          setSelectedSkill((current) => current || items[0]?.name || '')
        }
      } catch (error) {
        if (!cancelled) {
          setSkillsError(error instanceof Error ? error.message : 'Failed to load skills')
        }
      } finally {
        if (!cancelled) setSkillsLoading(false)
      }
    }
    void loadSkills()
    return () => {
      cancelled = true
    }
  }, [agent.id])

  useEffect(() => {
    let cancelled = false
    const loadContent = async () => {
      if (!selectedSkill) {
        setSkillContent('')
        return
      }
      setContentLoading(true)
      setContentError('')
      setSaveStatus('')
      try {
        const params = new URLSearchParams({ name: selectedSkill })
        if (selectedSkillFile) params.set('file', selectedSkillFile)
        const response = await fetch(`/api/hermes/skills/content?${params.toString()}`, { cache: 'no-store' })
        const payload = await response.json()
        if (!response.ok) {
          throw new Error(firstString(asRecord(payload).error) || `Failed to load ${selectedSkill}`)
        }
        if (!cancelled) setSkillContent(readContentString(payload))
      } catch (error) {
        if (!cancelled) {
          setContentError(error instanceof Error ? error.message : 'Failed to load skill content')
          setSkillContent('')
        }
      } finally {
        if (!cancelled) setContentLoading(false)
      }
    }
    void loadContent()
    return () => {
      cancelled = true
    }
  }, [selectedSkill, selectedSkillFile])

  const loadMcp = useCallback(async () => {
    setMcpLoading(true)
    setMcpError('')
    try {
      const [serversResponse, toolsResponse] = await Promise.all([
        fetch('/api/hermes/mcp/servers', { cache: 'no-store' }),
        fetch('/api/hermes/mcp/tools', { cache: 'no-store' }),
      ])
      const [serversPayload, toolsPayload] = await Promise.all([
        serversResponse.json(),
        toolsResponse.json(),
      ])

      if (!serversResponse.ok) {
        throw new Error(firstString(asRecord(serversPayload).error) || 'Failed to load MCP servers')
      }
      if (!toolsResponse.ok) {
        throw new Error(firstString(asRecord(toolsPayload).error) || 'Failed to load MCP tools')
      }

      setServers(extractMcpServers(serversPayload))
      setServerTools(extractMcpTools(toolsPayload))
    } catch (error) {
      setMcpError(error instanceof Error ? error.message : 'Failed to load MCP data')
    } finally {
      setMcpLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadMcp()
  }, [loadMcp])

  const loadModels = useCallback(async () => {
    setModelsLoading(true)
    setModelsError('')
    try {
      const response = await fetch('/api/hermes/models', { cache: 'no-store' })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(firstString(asRecord(payload).error) || 'Failed to load model catalog')
      }
      const parsed = extractModels(payload)
      setModels(parsed.models)
      setModelsRefreshedAt(parsed.refreshedAt)
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : 'Failed to load model catalog')
    } finally {
      setModelsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadModels()
  }, [loadModels])

  async function toggleSkillEnabled(name: string, enabled: boolean | null) {
    if (enabled == null) return
    const next = !enabled
    setSkillToggleBusy((current) => ({ ...current, [name]: true }))
    setSkills((current) => current.map((skill) => (skill.name === name ? { ...skill, enabled: next } : skill)))
    try {
      const response = await fetch('/api/hermes/skills/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, enabled: next }),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(firstString(asRecord(payload).error) || `Failed to update ${name}`)
      }
    } catch (error) {
      setSkills((current) => current.map((skill) => (skill.name === name ? { ...skill, enabled } : skill)))
      setSkillsError(error instanceof Error ? error.message : `Failed to update ${name}`)
    } finally {
      setSkillToggleBusy((current) => ({ ...current, [name]: false }))
    }
  }

  async function toggleAgentSkill(name: string) {
    const current = normalizeSkillNameList(agent.skills)
    const next = current.includes(name) ? current.filter((item) => item !== name) : [...current, name]
    setAgentSkillsBusy((state) => ({ ...state, [name]: true }))
    const previousSkills = agent.skills
    const optimisticAgent: Agent = { ...agent, skills: next }
    onAgentUpdated(optimisticAgent)
    try {
      const updated = await saveAgent({
        workspaceId,
        workspaceSlug,
        id: agent.id,
        data: { skills: next },
      })
      onAgentUpdated(updated as Agent)
    } catch (error) {
      onAgentUpdated({ ...agent, skills: previousSkills })
      setSkillsError(error instanceof Error ? error.message : `Failed to update ${name} binding`)
    } finally {
      setAgentSkillsBusy((state) => ({ ...state, [name]: false }))
    }
  }

  async function saveSkillContent() {
    if (!selectedSkill.trim()) {
      setSaveStatus('Save failed: skill name is required.')
      return
    }
    setSaveBusy(true)
    setSaveStatus('')
    try {
      const response = await fetch('/api/hermes/skills/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selectedSkill.trim(), file: selectedSkillFile, content: skillContent }),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(firstString(asRecord(payload).error) || 'Failed to save skill')
      }
      setSaveStatus('Saved.')
      if (!skills.some((skill) => skill.name === selectedSkill)) {
        setSkills((current) => [
          ...current,
          {
            name: selectedSkill,
            description: '',
            enabled: null,
            size: null,
            modifiedAt: null,
            raw: {},
          },
        ])
      }
    } catch (error) {
      setSaveStatus(`Save failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setSaveBusy(false)
    }
  }

  async function confirmDeleteSkill() {
    if (!pendingDeleteSkill) return
    setDeleteBusy(true)
    setSaveStatus('')
    try {
      const response = await fetch('/api/hermes/skills/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: pendingDeleteSkill }),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(firstString(asRecord(payload).error) || `Failed to delete ${pendingDeleteSkill}`)
      }
      setSkills((current) => current.filter((skill) => skill.name !== pendingDeleteSkill))
      if (selectedSkill === pendingDeleteSkill) {
        setSelectedSkill('')
        setSkillContent('')
      }
      setSaveStatus(`Deleted ${pendingDeleteSkill}.`)
      if (boundSkillNames.has(pendingDeleteSkill)) {
        await toggleAgentSkill(pendingDeleteSkill)
      }
    } catch (error) {
      setSaveStatus(`Delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setDeleteBusy(false)
      setPendingDeleteSkill(null)
    }
  }

  async function refreshModels() {
    setRefreshBusy(true)
    setModelsError('')
    try {
      const response = await fetch('/api/hermes/models/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(firstString(asRecord(payload).error) || 'Failed to refresh models')
      }
      await loadModels()
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : 'Failed to refresh models')
    } finally {
      setRefreshBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Skills library</h3>
          <Button type="button" variant="outline" size="sm" onClick={() => {
            const generated = newSkillName.trim() || `new-skill-${Date.now()}`
            setSelectedSkill(generated)
            setSkillContent('')
            setContentError('')
            setPendingDeleteSkill(null)
            setNewSkillName('')
          }}>New draft</Button>
        </div>
        <p className="mb-3 text-xs text-black/50 dark:text-white/50">
          Enable skills globally in Hermes, then bind the right ones to {agent.name}.
        </p>
        <div className="mb-3 flex gap-2">
          <input
            value={newSkillName}
            onChange={(event) => setNewSkillName(event.target.value)}
            placeholder="skill-name"
            className="w-full rounded-md border border-black/15 bg-transparent px-2.5 py-1.5 text-sm dark:border-white/15"
          />
        </div>

        {skillsError && <p className="mb-2 text-xs text-red-600">{skillsError}</p>}
        {skillsLoading ? (
          <p className="text-xs text-black/50 dark:text-white/50">Loading skills…</p>
        ) : skills.length === 0 ? (
          <div className="rounded-md border border-dashed border-black/15 px-3 py-3 text-xs text-black/50 dark:border-white/15 dark:text-white/50">
            No skills found in Hermes yet. Create one by typing a name above, then save SKILL.md below.
          </div>
        ) : (
          <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
            {skills.map((skill) => {
              const isBound = boundSkillNames.has(skill.name)
              const infoBits = [formatBytes(skill.size), skill.modifiedAt ? formatTimestamp(skill.modifiedAt) : null].filter(Boolean)
              return (
                <div key={skill.name} className="rounded-md border border-black/10 p-2 dark:border-white/10">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedSkill(skill.name)
                        setPendingDeleteSkill(null)
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="truncate text-sm font-medium">{skill.name}</p>
                      {skill.description && (
                        <p className="truncate text-xs text-black/50 dark:text-white/50">{skill.description}</p>
                      )}
                      {infoBits.length > 0 && (
                        <p className="mt-0.5 text-[11px] text-black/40 dark:text-white/40">{infoBits.join(' · ')}</p>
                      )}
                    </button>
                    <div className="flex items-center gap-3 text-[11px]">
                      <label className="flex items-center gap-1 text-black/50 dark:text-white/50">
                        <input
                          type="checkbox"
                          checked={skill.enabled ?? false}
                          disabled={skill.enabled == null || skillToggleBusy[skill.name]}
                          onChange={() => void toggleSkillEnabled(skill.name, skill.enabled)}
                        />
                        Enabled
                      </label>
                      <label className="flex items-center gap-1 text-black/50 dark:text-white/50">
                        <input
                          type="checkbox"
                          checked={isBound}
                          disabled={Boolean(agentSkillsBusy[skill.name])}
                          onChange={() => void toggleAgentSkill(skill.name)}
                        />
                        Bound
                      </label>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <div className="mt-4 rounded-md border border-black/10 p-3 dark:border-white/10">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-xs font-medium">SKILL.md editor</h4>
            {selectedSkill ? <p className="text-[11px] text-black/50 dark:text-white/50">{selectedSkill}</p> : null}
          </div>

          {!selectedSkill ? (
            <p className="text-xs text-black/50 dark:text-white/50">Pick a skill above, or create a new draft to start editing.</p>
          ) : (
            <>
              <div className="mb-2 flex gap-2">
                <input
                  value={selectedSkill}
                  onChange={(event) => setSelectedSkill(event.target.value)}
                  className="w-2/5 rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-xs dark:border-white/15"
                />
                <input
                  value={selectedSkillFile}
                  onChange={(event) => setSelectedSkillFile(event.target.value)}
                  className="w-3/5 rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-xs dark:border-white/15"
                />
              </div>
              {contentError && <p className="mb-2 text-xs text-red-600">{contentError}</p>}
              <textarea
                value={skillContent}
                onChange={(event) => setSkillContent(event.target.value)}
                rows={12}
                disabled={contentLoading}
                className="w-full rounded-md border border-black/15 bg-transparent px-2 py-2 font-mono text-xs dark:border-white/15"
              />
              <div className="mt-2 flex items-center gap-2">
                <Button type="button" size="sm" onClick={() => void saveSkillContent()} disabled={saveBusy || contentLoading}>
                  {saveBusy ? 'Saving…' : 'Save'}
                </Button>
                {pendingDeleteSkill === selectedSkill ? (
                  <>
                    <Button type="button" size="sm" variant="destructive" onClick={() => void confirmDeleteSkill()} disabled={deleteBusy}>
                      {deleteBusy ? 'Deleting…' : 'Confirm delete'}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setPendingDeleteSkill(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => setPendingDeleteSkill(selectedSkill)}
                  >
                    Delete?
                  </Button>
                )}
                {saveStatus && <p className="text-xs text-black/50 dark:text-white/50">{saveStatus}</p>}
              </div>
            </>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">MCP server library</h3>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadMcp()} disabled={mcpLoading}>
            {mcpLoading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
        <p className="mb-3 mt-1 text-xs text-black/50 dark:text-white/50">
          Connected MCP servers and their published tools for this workspace.
        </p>
        {mcpError && <p className="mb-2 text-xs text-red-600">{mcpError}</p>}
        {mcpLoading ? (
          <p className="text-xs text-black/50 dark:text-white/50">Loading MCP servers…</p>
        ) : servers.length === 0 ? (
          <div className="rounded-md border border-dashed border-black/15 px-3 py-3 text-xs text-black/50 dark:border-white/15 dark:text-white/50">
            No MCP servers found. Add one in your Hermes config, then refresh this page to inspect its tools.
          </div>
        ) : (
          <div className="space-y-2">
            {servers.map((server) => {
              const tools = serverTools.filter((tool) => {
                if (!tool.serverKey) return expandedServer === server.key
                return tool.serverKey === server.key || tool.serverKey === server.name
              })
              const details = Object.entries(server.raw)
                .filter(([key, value]) => ['string', 'number', 'boolean'].includes(typeof value) && key !== 'name' && key !== 'id')
                .slice(0, 6)
              return (
                <div key={server.key} className="rounded-md border border-black/10 p-3 dark:border-white/10">
                  <button
                    type="button"
                    onClick={() => setExpandedServer((current) => (current === server.key ? '' : server.key))}
                    className="flex w-full items-start justify-between gap-2 text-left"
                  >
                    <span>
                      <span className="block text-sm font-medium">{server.name}</span>
                      <span className="text-xs text-black/50 dark:text-white/50">
                        {server.transport} · {server.state}
                      </span>
                    </span>
                    <span className="text-[11px] text-black/40 dark:text-white/40">
                      {expandedServer === server.key ? 'Hide tools' : 'Show tools'}
                    </span>
                  </button>

                  {details.length > 0 && (
                    <div className="mt-2 grid gap-1 rounded bg-black/[.03] p-2 text-[11px] dark:bg-white/[.04]">
                      {details.map(([key, value]) => (
                        <p key={key} className="truncate text-black/60 dark:text-white/60">
                          {key}: {typeof value === 'string' ? maskSensitiveValue(key, value) : String(value)}
                        </p>
                      ))}
                    </div>
                  )}

                  {expandedServer === server.key && (
                    <div className="mt-2 rounded-md border border-black/10 p-2 dark:border-white/10">
                      {tools.length === 0 ? (
                        <p className="text-xs text-black/50 dark:text-white/50">No tools listed for this server.</p>
                      ) : (
                        <ul className="space-y-1">
                          {tools.map((tool) => (
                            <li key={`${server.key}-${tool.name}`}>
                              <p className="text-xs font-medium">{tool.name}</p>
                              {tool.description && (
                                <p className="text-[11px] text-black/50 dark:text-white/50">{tool.description}</p>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <p className="mt-3 text-[11px] text-black/45 dark:text-white/45">
          Per-agent MCP binding is not represented by a dedicated Hermes endpoint in this codebase yet, so this section is currently inspect-only.
        </p>
      </section>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Model catalog</h3>
          <Button type="button" variant="outline" size="sm" onClick={() => void refreshModels()} disabled={refreshBusy}>
            {refreshBusy ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
        {modelsRefreshedAt && (
          <p className="mt-1 text-[11px] text-black/50 dark:text-white/50">
            Last refreshed {formatTimestamp(modelsRefreshedAt)}
          </p>
        )}
        {modelsError && <p className="mt-2 text-xs text-red-600">{modelsError}</p>}
        {modelsLoading ? (
          <p className="mt-2 text-xs text-black/50 dark:text-white/50">Loading models…</p>
        ) : models.length === 0 ? (
          <div className="mt-2 rounded-md border border-dashed border-black/15 px-3 py-3 text-xs text-black/50 dark:border-white/15 dark:text-white/50">
            No models reported yet. Use refresh to force a catalog sync from Hermes.
          </div>
        ) : (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {models.map((model) => (
              <div key={model.key} className="rounded-md border border-black/10 p-2 dark:border-white/10">
                <p className="text-xs font-medium">{model.name}</p>
                <p className="text-[11px] text-black/50 dark:text-white/50">
                  {model.provider || 'Unknown provider'}
                  {model.contextWindow != null ? ` · ${model.contextWindow} ctx` : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
