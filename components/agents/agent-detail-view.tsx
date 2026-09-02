'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DetailLayout, type DetailLayoutTab } from '@/components/layout/detail-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AgentCapabilities } from '@/components/agents/agent-capabilities'
import { AgentMemories } from '@/components/agents/agent-memories'
import { AgentSettingsForm, type AgentProfile } from '@/components/agents/agent-settings-form'
import { saveAgent } from '@/app/(app)/workspace/[workspaceSlug]/agents/actions'
import type { Agent } from '@/components/agents/agent-editor'

// ROADMAP B-1 (Detail) — the real, linkable home for one agent, conformed to
// the shared <DetailLayout> primitive (components/layout/detail-layout.tsx)
// the same way runs/[runId]/review already is (see review-panel.tsx). Three
// URL-backed tabs:
//   - Overview: read-only metadata summary. Deliberately does not rebuild
//     the editor form — that's what Settings is for.
//   - Capabilities: the *existing* <AgentCapabilities> component, relocated
//     here wholesale (its Skills/MCP/Models work against /api/hermes/* is
//     untouched) from where it used to live — a client-side tab toggle
//     inside the list page's inline editor, not a real route. This is now
//     the only place that UI is mounted.
//   - Memory (ROADMAP B7.1, Batch B-6 "Finish"): <AgentMemories>, a real
//     proxy to Hermes's per-agent memory files (app/api/hermes/memories/*)
//     — list/read/edit/delete, plus the honest last-writer-wins caveat the
//     plan itself calls for.
//   - Settings: the actual edit form (agent-settings-form.tsx, extracted out
//     of the old inline editor) — model, env/args, MCP config, concurrency,
//     permission mode, enabled toggle.
export function AgentDetailView({
  workspaceId,
  workspaceSlug,
  agent: initialAgent,
  profiles,
  runtimeProfile,
  activeRunId,
  ownerName,
  weeklySpendTicks,
}: {
  workspaceId: number
  workspaceSlug: string
  agent: Agent
  profiles: AgentProfile[]
  runtimeProfile: { name: string; commandName: string; protocolFamily: string } | null
  activeRunId: number | null
  ownerName: string | null
  /** ROADMAP B7.2 — cost ticks for this agent, trailing 7 days. */
  weeklySpendTicks?: number
}) {
  const router = useRouter()
  const [agent, setAgent] = useState(initialAgent)
  const [toggleBusy, setToggleBusy] = useState(false)

  async function toggleEnabled() {
    setToggleBusy(true)
    try {
      const updated = (await saveAgent({
        workspaceId,
        workspaceSlug,
        id: agent.id,
        data: { enabled: !agent.enabled },
      })) as Agent
      setAgent(updated)
      router.refresh()
    } finally {
      setToggleBusy(false)
    }
  }

  const statusBadge = !agent.enabled ? (
    <Badge variant="outline">disabled</Badge>
  ) : activeRunId != null ? (
    <Badge>running · #{activeRunId}</Badge>
  ) : (
    <Badge variant="secondary">idle</Badge>
  )

  const primaryAction = (
    <Button type="button" size="sm" variant="outline" disabled={toggleBusy} onClick={() => void toggleEnabled()}>
      {toggleBusy ? 'Saving…' : agent.enabled ? 'Disable agent' : 'Enable agent'}
    </Button>
  )

  const skillsCount = Array.isArray(agent.skills) ? agent.skills.length : 0

  const overviewContent = (
    <div className="max-w-2xl space-y-5 p-6 text-sm">
      <div className="grid grid-cols-2 gap-4">
        <OverviewField label="Model" value={agent.model || 'Default'} />
        <OverviewField label="Thinking level" value={agent.thinkingLevel || 'medium'} />
        <OverviewField
          label="Runtime profile"
          value={runtimeProfile ? `${runtimeProfile.name} (${runtimeProfile.commandName})` : 'Unknown'}
        />
        <OverviewField label="Permission mode" value={agent.permissionMode || 'ask'} />
        <OverviewField label="Max concurrent runs" value={String(agent.maxConcurrentRuns ?? 1)} />
        <OverviewField label="Skills bound" value={String(skillsCount)} />
        <OverviewField label="Spend, last 7 days" value={`$${((weeklySpendTicks ?? 0) / 100).toFixed(2)}`} />
      </div>
      {agent.instructions && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">
            Instructions
          </h3>
          <p className="mt-1 whitespace-pre-wrap text-sm">{agent.instructions}</p>
        </div>
      )}
    </div>
  )

  const capabilitiesContent = (
    <div className="p-6">
      <AgentCapabilities
        workspaceId={workspaceId}
        workspaceSlug={workspaceSlug}
        agent={agent}
        onAgentUpdated={(next) => setAgent(next)}
      />
    </div>
  )

  const memoryContent = (
    <div className="p-6">
      <AgentMemories agent={agent} />
    </div>
  )

  const settingsContent = (
    <div className="max-w-2xl p-6">
      <AgentSettingsForm
        workspaceId={workspaceId}
        workspaceSlug={workspaceSlug}
        profiles={profiles}
        agent={agent}
        onSaved={(next) => setAgent(next)}
      />
    </div>
  )

  const tabs: DetailLayoutTab[] = [
    { key: 'overview', label: 'Overview', content: overviewContent },
    { key: 'capabilities', label: 'Capabilities', count: skillsCount, content: capabilitiesContent },
    { key: 'memory', label: 'Memory', content: memoryContent },
    { key: 'settings', label: 'Settings', content: settingsContent },
  ]

  const rightRail = (
    <div className="flex flex-col gap-4 text-sm">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">Owner</h2>
        <p className="mt-1">{ownerName ?? 'Workspace owner'}</p>
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">Runtime</h2>
        {runtimeProfile ? (
          <>
            <p className="mt-1">{runtimeProfile.name}</p>
            <p className="text-xs text-black/50 dark:text-white/50">
              {runtimeProfile.protocolFamily.toUpperCase()} · {runtimeProfile.commandName}
            </p>
          </>
        ) : (
          <p className="mt-1 text-black/50 dark:text-white/50">Unknown</p>
        )}
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">Access</h2>
        <p className="mt-1">{agent.permissionMode || 'ask'}</p>
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">Timestamps</h2>
        <TimestampRow agent={agent} />
      </div>
    </div>
  )

  return (
    <DetailLayout
      breadcrumb={[
        { label: 'Agents', href: `/workspace/${workspaceSlug}/agents` },
        { label: agent.name },
      ]}
      title={agent.name}
      statusBadge={statusBadge}
      primaryAction={primaryAction}
      tabs={tabs}
      defaultTab="overview"
      rightRail={rightRail}
    />
  )
}

function OverviewField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">{label}</h3>
      <p className="mt-1">{value}</p>
    </div>
  )
}

// `saveAgent`'s return is cast to the list's slimmer `Agent` type (see
// agent-editor.tsx), which doesn't declare createdAt/updatedAt — read them
// defensively rather than widening that type just for this display.
function TimestampRow({ agent }: { agent: Agent }) {
  const withTimestamps = agent as Agent & { createdAt?: string; updatedAt?: string }
  return (
    <>
      {withTimestamps.createdAt && (
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">
          created {new Date(withTimestamps.createdAt).toLocaleString()}
        </p>
      )}
      {withTimestamps.updatedAt && (
        <p className="text-xs text-black/60 dark:text-white/60">
          updated {new Date(withTimestamps.updatedAt).toLocaleString()}
        </p>
      )}
    </>
  )
}
