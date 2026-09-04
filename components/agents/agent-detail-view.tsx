'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DetailLayout, type DetailLayoutTab } from '@/components/layout/detail-layout'
import { AgentSessionsTab, type AgentSessionRow } from '@/components/agents/agent-sessions-tab'
import { AgentPluginCapabilities, type AgentPluginRow } from '@/components/agents/agent-plugin-capabilities'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AgentCapabilities } from '@/components/agents/agent-capabilities'
import { AgentMemories } from '@/components/agents/agent-memories'
import { AgentSettingsForm, type AgentProfile } from '@/components/agents/agent-settings-form'
import { SharePanel } from '@/components/access/share-panel'
import { AgentReachPanel } from '@/components/access/agent-reach-panel'
import { RuntimePingButton } from '@/components/agents/runtime-ping-button'
import { saveAgent } from '@/app/(app)/workspace/[workspaceSlug]/agents/actions'
import { unwrap } from '@/lib/failures'
import type { Agent } from '@/components/agents/agent-editor'
import type { ActiveModelConfig } from '@/lib/runtimes/hermes/providers'
import { formatTimestamp } from '@/lib/relative-time'

// ROADMAP B-1 (Detail) — the real, linkable home for one agent, conformed to
// the shared <DetailLayout> primitive (components/layout/detail-layout.tsx)
// the same way runs/[runId]/review already is (see components/review/). Three
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
  monthlySpendTicks,
  sessions,
  plugins,
  activeModel,
  agentModel,
  extraTabs,
}: {
  workspaceId: number
  workspaceSlug: string
  agent: Agent
  profiles: AgentProfile[]
  runtimeProfile: { name: string; commandName: string; protocolFamily: string; homeStrategy?: string } | null
  activeRunId: number | null
  ownerName: string | null
  /** ROADMAP B7.2 — cost ticks for this agent, trailing 7 days. */
  weeklySpendTicks?: number
  /** R7.3 — trailing 30 days. Shown beside the 7-day figure because either
   * number alone leaves a real question unanswerable: 7 hides a burst that has
   * tailed off, 30 lags a change in behaviour. */
  monthlySpendTicks?: number
  /** R7.3 — this agent's own conversations, newest first. */
  sessions?: AgentSessionRow[]
  /** R7.3 — plugins scoped to this agent, read-only. */
  plugins?: AgentPluginRow[]
  /** Hermes's one, install-wide active model — not per-agent. See providers.ts. */
  activeModel: ActiveModelConfig | null
  /** The model pinned by THIS agent's own Hermes profile. Null when the agent
   * runs on the install default, in which case `activeModel` is the answer. */
  agentModel?: ActiveModelConfig | null
  /**
   * Tabs contributed by the page that renders this view, appended after the
   * ones above.
   *
   * The shared registration point for every tab whose data belongs to the
   * server component rather than to this file — the Access panels and the
   * Connectors tab both arrive this way. One composable array rather than a
   * prop per feature: two teams adding a tab in the same week is exactly the
   * case a second mechanism would have made conflict-prone for no gain.
   */
  extraTabs?: DetailLayoutTab[]
}) {
  const router = useRouter()
  const [agent, setAgent] = useState(initialAgent)
  const [toggleBusy, setToggleBusy] = useState(false)
  const [toggleError, setToggleError] = useState<string | null>(null)

  async function toggleEnabled() {
    setToggleBusy(true)
    setToggleError(null)
    try {
      const updated = unwrap(
        await saveAgent({
          workspaceId,
          workspaceSlug,
          id: agent.id,
          data: { enabled: !agent.enabled },
        }),
      ) as Agent
      setAgent(updated)
      router.refresh()
    } catch (error) {
      // Previously a bare try/finally: a refused enable/disable left the badge
      // showing the old state with nothing said about why, which reads as the
      // button having done nothing at all.
      setToggleError(error instanceof Error ? error.message : 'Could not change this agent.')
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
    <div className="flex flex-col items-end gap-1">
      <Button type="button" size="sm" variant="outline" disabled={toggleBusy} onClick={() => void toggleEnabled()}>
        {toggleBusy ? 'Saving…' : agent.enabled ? 'Disable agent' : 'Enable agent'}
      </Button>
      {toggleError && <p className="max-w-64 text-right text-[11px] text-destructive">{toggleError}</p>}
    </div>
  )

  const skillsCount = Array.isArray(agent.skills) ? agent.skills.length : 0

  const overviewContent = (
    <div className="max-w-2xl space-y-5 p-6 text-sm">
      <div className="grid grid-cols-2 gap-4">
        <OverviewField
          label="Model"
          value={
            agentModel
              ? `${agentModel.provider} / ${agentModel.model}`
              : activeModel
                ? `${activeModel.provider} / ${activeModel.model}`
                : 'Unknown'
          }
        />
        {/* The profile IS the model selector — see collections/Agents.ts. */}
        <OverviewField label="Hermes profile" value={agent.hermesProfile || 'Install default'} />
        <OverviewField label="Thinking level" value={agent.thinkingLevel || 'medium'} />
        <OverviewField
          label="Runtime profile"
          value={runtimeProfile ? `${runtimeProfile.name} (${runtimeProfile.commandName})` : 'Unknown'}
        />
        <OverviewField label="Permission mode" value={agent.permissionMode || 'ask'} />
        <OverviewField label="Max concurrent runs" value={String(agent.maxConcurrentRuns ?? 1)} />
        <OverviewField label="Skills bound" value={String(skillsCount)} />
        <OverviewField label="Spend, last 7 days" value={`$${((weeklySpendTicks ?? 0) / 100).toFixed(2)}`} />
        <OverviewField label="Spend, last 30 days" value={`$${((monthlySpendTicks ?? 0) / 100).toFixed(2)}`} />
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

  // The Hermes skills/MCP panel reads a Hermes install. Showing it for an
  // agent on another runtime rendered an empty panel fetched from something
  // that agent has no relationship to — so each runtime gets the view that is
  // actually true for it, and both link to the settings that edit them.
  const usesHermesHome = (runtimeProfile?.homeStrategy ?? 'hermes') === 'hermes'
  const capabilitiesContent = (
    <div className="flex flex-col gap-6 p-6">
      <AgentPluginCapabilities
        workspaceSlug={workspaceSlug}
        plugins={plugins ?? []}
        runtimeName={runtimeProfile?.name ?? null}
      />
      {usesHermesHome ? (
        <div className="border-t border-black/10 pt-6 dark:border-white/10">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Hermes skills and MCP servers</h3>
              <p className="mt-0.5 text-xs text-black/50 dark:text-white/50">
                From this agent&apos;s Hermes install. Bound per agent; the pool itself is install-wide.
              </p>
            </div>
            <div className="flex shrink-0 gap-3 text-xs font-medium">
              <Link
                href={`/workspace/${workspaceSlug}/settings/skills`}
                className="text-primary underline-offset-2 hover:underline"
              >
                Edit skills →
              </Link>
              <Link
                href={`/workspace/${workspaceSlug}/settings/mcp`}
                className="text-primary underline-offset-2 hover:underline"
              >
                Edit MCP →
              </Link>
            </div>
          </div>
          <AgentCapabilities
            workspaceId={workspaceId}
            workspaceSlug={workspaceSlug}
            agent={agent}
            onAgentUpdated={(next) => setAgent(next)}
          />
        </div>
      ) : (
        <p className="border-t border-black/10 pt-6 text-xs text-black/45 dark:border-white/10 dark:text-white/45">
          Skills and MCP servers shown here are a Hermes mechanism.{' '}
          {runtimeProfile?.name ?? 'This runtime'} manages its own tools internally, and its settings are on the{' '}
          <Link
            href={`/workspace/${workspaceSlug}/settings/providers`}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            Providers page
          </Link>
          .
        </p>
      )}
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
        activeModel={activeModel}
        onSaved={(next) => setAgent(next)}
      />
    </div>
  )

  // Both halves of "access" on one tab, because they are the two directions of
  // the same question and answering one without the other is how a permissions
  // screen misleads: who may USE this agent, and what this agent may REACH.
  // Splitting them into two tabs would let somebody grant an agent admin on
  // every project without ever seeing that a viewer can trigger it.
  const accessContent = (
    <div className="max-w-2xl space-y-8 p-6">
      <SharePanel
        workspaceId={workspaceId}
        workspaceSlug={workspaceSlug}
        objectType="agent"
        objectId={String(agent.id)}
        objectLabel={agent.name}
      />
      <div className="border-t border-black/10 pt-6 dark:border-white/10">
        <AgentReachPanel workspaceId={workspaceId} workspaceSlug={workspaceSlug} agentId={agent.id} />
      </div>
    </div>
  )

  const tabs: DetailLayoutTab[] = [
    { key: 'overview', label: 'Overview', content: overviewContent },
    { key: 'capabilities', label: 'Capabilities', count: skillsCount, content: capabilitiesContent },
    {
      key: 'sessions',
      label: 'Sessions',
      count: sessions?.length,
      content: <AgentSessionsTab workspaceSlug={workspaceSlug} sessions={sessions ?? []} />,
    },
    { key: 'memory', label: 'Memory', content: memoryContent },
    { key: 'access', label: 'Access', content: accessContent },
    { key: 'settings', label: 'Settings', content: settingsContent },
    ...(extraTabs ?? []),
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
            <RuntimePingButton agentId={agent.id} />
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
          created {formatTimestamp(withTimestamps.createdAt)}
        </p>
      )}
      {withTimestamps.updatedAt && (
        <p className="text-xs text-black/60 dark:text-white/60">
          updated {formatTimestamp(withTimestamps.updatedAt)}
        </p>
      )}
    </>
  )
}
