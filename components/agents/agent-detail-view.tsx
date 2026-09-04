'use client'

import { useState, type ReactNode } from 'react'
import { DetailLayout, type DetailLayoutTab } from '@/components/layout/detail-layout'
import { AgentSessionsTab, type AgentSessionRow } from '@/components/agents/agent-sessions-tab'
import { AgentPluginCapabilities, type AgentPluginRow } from '@/components/agents/agent-plugin-capabilities'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AgentCapabilities } from '@/components/agents/agent-capabilities'
import { AgentMemories } from '@/components/agents/agent-memories'
import { AgentWorkTab } from '@/components/agents/agent-work-tab'
import { AgentSettingsForm, type AgentProfile } from '@/components/agents/agent-settings-form'
import { SharePanel } from '@/components/access/share-panel'
import { AgentReachPanel } from '@/components/access/agent-reach-panel'
import { RuntimePingButton } from '@/components/agents/runtime-ping-button'
import { saveAgent } from '@/app/(app)/workspace/[workspaceSlug]/agents/actions'
import { useOptimisticAction } from '@/lib/optimistic'
import type { WithFailure } from '@/lib/failures'
import type { Agent } from '@/components/agents/agent-editor'
import type { ActiveModelConfig } from '@/lib/runtimes/hermes/providers'
import type { TaskAgentColumnData } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import type { TaskGroup } from '@/lib/task-views/data-layer'
import { formatTimestamp } from '@/lib/relative-time'

// ROADMAP R14-P0.7 — restructured to exactly four tabs, in this order:
// Overview / Work / Capabilities / Settings.
//
//   - Overview: identity + what this agent is bound to. This is a MERGE, not
//     just a rename — the former standalone "Access" tab (SharePanel +
//     AgentReachPanel: who may use this agent, and what it may reach) and the
//     former "Sessions" tab (its own conversations) both answered a piece of
//     "what is this agent, and what is it bound to" and are folded in here
//     rather than left as two more tabs answering an overlapping question.
//   - Work (NEW): a status-grouped board of this agent's own tasks. Reuses
//     `groupTasks` and `getTaskAgentColumnsData`/`getAgentUsageRollup`
//     exactly as computed for the tasks board's own agent columns — see
//     agent-work-tab.tsx's header for the full accounting. No new query
//     shape, no new poll.
//   - Capabilities: skills + MCP (<AgentCapabilities>, unchanged), PLUS two
//     more things folded in here rather than left as their own tabs:
//     Connectors (<ScopedConnectorsTab>, built by another unit this session
//     as a top-level tab reached via `extraTabs` — its content now arrives
//     through the dedicated `connectorsContent` prop instead, still a
//     server-rendered element composed by the page, just mounted as a
//     section of this tab rather than a whole tab of its own) and Memory
//     (<AgentMemories>, formerly its own tab) — both are, honestly, "what
//     this agent can do/access/remember," which is what Capabilities means.
//   - Settings: the actual edit form (agent-settings-form.tsx). Its skills
//     editor moved out — skills are bound from the Capabilities tab's
//     existing Hermes skills library now, not edited a second way here. See
//     agent-settings-form.tsx's own comment.
//
// `extraTabs` (DetailLayoutTab[]) is left in place as a mechanism — nothing
// currently feeds it (Connectors moved to the dedicated `connectorsContent`
// prop below, since it needed to land *inside* an existing tab rather than
// beside it), but it is genuinely useful for the next unit that needs to add
// a whole new tab without touching this file, so it is not removed.
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
  taskGroups,
  taskColumnsData,
  connectorsContent,
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
  /** R14-P0.7 Work tab — this agent's tasks, already grouped by status via
   * the shared `groupTasks` (lib/task-views/data-layer.ts), computed
   * server-side in agents/[agentId]/page.tsx over tasks already filtered to
   * this agent. Empty array (not undefined) when the agent has none. */
  taskGroups?: TaskGroup[]
  /** R14-P0.7 Work tab — the exact same batched broker read the task board's
   * own agent columns use (`getTaskAgentColumnsData`), keyed by task id. */
  taskColumnsData?: Record<number, TaskAgentColumnData>
  /**
   * R14-P0.7 — the Connectors tab another unit built this session, folded
   * into Capabilities as a section rather than left as its own tab. This is
   * a pre-rendered element (`<ScopedConnectorsTab .../>`, an ASYNC SERVER
   * COMPONENT) composed by the server-component page and handed down as a
   * prop — the same reason `extraTabs` exists below: a client component
   * cannot import and invoke an async server component itself, only render
   * one that its server-component parent already resolved into an element.
   */
  connectorsContent?: ReactNode
  /**
   * Tabs contributed by the page that renders this view, appended after the
   * ones above. Nothing feeds this today (see header comment), but it stays
   * as the registration point for the next whole-new-tab a future unit adds
   * without needing to edit this file's tab list directly.
   */
  extraTabs?: DetailLayoutTab[]
}) {
  const [agent, setAgent] = useState(initialAgent)
  const toggleOptimistic = useOptimisticAction<Agent>()

  function toggleEnabled() {
    const previous = agent
    const next = { ...agent, enabled: !agent.enabled }
    void toggleOptimistic.run({
      apply: () => setAgent(next),
      rollback: () => setAgent(previous),
      // `saveAgent` returns the payload-types `Agent`; this view's `Agent`
      // (agent-editor.tsx) is a slimmer projection of the same shape — see
      // this file's own `TimestampRow` comment for why that cast is normal
      // here.
      work: () =>
        saveAgent({
          workspaceId,
          workspaceSlug,
          id: agent.id,
          data: { enabled: next.enabled },
        }) as unknown as Promise<WithFailure<Agent>>,
      failureTitle: 'Could not change this agent.',
      onSettled: (updated) => setAgent(updated),
    })
  }

  const statusBadge = !agent.enabled ? (
    <Badge variant="outline">disabled</Badge>
  ) : activeRunId != null ? (
    <Badge>running · #{activeRunId}</Badge>
  ) : (
    <Badge variant="secondary">idle</Badge>
  )

  const primaryAction = (
    <Button type="button" size="sm" variant="outline" disabled={toggleOptimistic.pending} onClick={toggleEnabled}>
      {agent.enabled ? 'Disable agent' : 'Enable agent'}
    </Button>
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

      {/* MERGED FROM THE FORMER "Access" TAB — who may use this agent, and
          what this agent may reach, are the two directions of "what this
          agent is bound to," which is exactly Overview's own brief. Kept as
          the two panels a prior unit built (SharePanel + AgentReachPanel),
          just relocated rather than left as an overlapping second tab. */}
      <div className="border-t border-black/10 pt-5 dark:border-white/10">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">
          Bound to
        </h3>
        <div className="space-y-6">
          <SharePanel
            workspaceId={workspaceId}
            workspaceSlug={workspaceSlug}
            objectType="agent"
            objectId={String(agent.id)}
            objectLabel={agent.name}
          />
          <AgentReachPanel workspaceId={workspaceId} workspaceSlug={workspaceSlug} agentId={agent.id} />
        </div>
      </div>

      {/* MERGED FROM THE FORMER "Sessions" TAB — this agent's own
          conversations are part of the same "what is this agent" picture,
          not a separate concern. */}
      {sessions && sessions.length > 0 && (
        <div className="border-t border-black/10 pt-5 dark:border-white/10">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">
            Recent sessions
          </h3>
          <AgentSessionsTab workspaceSlug={workspaceSlug} sessions={sessions} />
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

      {/* MERGED FROM THE FORMER "Connectors" TAB (built via `extraTabs` by
          another unit this session) — apps this agent may act on are exactly
          as much "what this agent can do" as its skills and MCP servers
          above, so this section replaces what used to be a whole separate
          tab rather than sitting beside it. `connectorsContent` is a
          server-rendered element (see this component's prop doc for why);
          rendered only when the page actually supplies one. */}
      {connectorsContent && (
        <div className="border-t border-black/10 pt-6 dark:border-white/10">
          <h3 className="mb-1 text-sm font-semibold">Connectors</h3>
          {connectorsContent}
        </div>
      )}

      {/* MERGED FROM THE FORMER "Memory" TAB — what an agent remembers is a
          capability the same way its skills and tools are. */}
      <div className="border-t border-black/10 pt-6 dark:border-white/10">
        <AgentMemories agent={agent} />
      </div>
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

  const workContent = (
    <AgentWorkTab workspaceSlug={workspaceSlug} groups={taskGroups ?? []} columnsData={taskColumnsData ?? {}} />
  )

  const tabs: DetailLayoutTab[] = [
    { key: 'overview', label: 'Overview', content: overviewContent },
    { key: 'work', label: 'Work', count: taskGroups?.reduce((sum, group) => sum + group.tasks.length, 0), content: workContent },
    { key: 'capabilities', label: 'Capabilities', count: skillsCount, content: capabilitiesContent },
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
