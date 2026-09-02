'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Bot } from 'lucide-react'
import { AgentSettingsForm, type AgentProfile } from '@/components/agents/agent-settings-form'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

// ROADMAP B-1 (Detail) — this used to be a list + full inline editor (an
// Overview/Capabilities toggle built entirely as client-side state on this
// page, not a real URL). That inline editor is gone: every existing agent
// now gets a real, linkable home at
// /workspace/[workspaceSlug]/agents/[agentId] (agent-detail-view.tsx), which
// is where Settings AND Capabilities both live now — one place to edit an
// agent, not two out-of-sync ones. This component is back to being just a
// list (rows link to the detail route) plus the "New agent" creation flow,
// which still needs a lightweight form here since a not-yet-created agent
// has no id to link to.
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

export function AgentEditor({
  workspaceId,
  workspaceSlug,
  profiles,
  initialAgents,
}: {
  workspaceId: number
  workspaceSlug: string
  profiles: AgentProfile[]
  initialAgents: Agent[]
}) {
  const router = useRouter()
  const [agents, setAgents] = useState(initialAgents)
  const [creating, setCreating] = useState(false)

  const sortedAgents = useMemo(() => [...agents].sort((a, b) => a.name.localeCompare(b.name)), [agents])

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
      <section className="space-y-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : 'New agent'}
        </Button>

        {sortedAgents.length === 0 ? (
          <EmptyState
            icon={<Bot />}
            title="No agents configured yet"
            description="Agents are what runs work in this workspace — create one to get started."
            action={{ label: 'New agent', onClick: () => setCreating(true) }}
          />
        ) : (
          sortedAgents.map((agent) => (
            <Link
              key={agent.id}
              href={`/workspace/${workspaceSlug}/agents/${agent.id}`}
              className="flex w-full items-center justify-between rounded-lg border border-black/10 p-4 text-left hover:bg-black/[.03] dark:border-white/10 dark:hover:bg-white/[.04]"
            >
              <span>
                <span className="block font-medium">{agent.name}</span>
                <span className="text-xs text-black/50 dark:text-white/50">
                  {agent.model || 'Default model'} · {agent.permissionMode || 'ask'}
                  {agent.enabled === false ? ' · disabled' : ''}
                </span>
              </span>
              <span className="text-xs text-black/40">View →</span>
            </Link>
          ))
        )}
      </section>

      {creating && (
        <div className="space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/10">
          <h2 className="font-medium">New agent</h2>
          <AgentSettingsForm
            workspaceId={workspaceId}
            workspaceSlug={workspaceSlug}
            profiles={profiles}
            agent={null}
            onSaved={(result) => {
              setAgents((current) => [...current, result])
              setCreating(false)
              // Every further edit (Settings, Capabilities) happens on the
              // real detail route — send the user straight there instead of
              // staying in this now-stale inline form.
              router.push(`/workspace/${workspaceSlug}/agents/${result.id}`)
            }}
          />
        </div>
      )}
    </div>
  )
}
