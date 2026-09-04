import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getActiveRunForAgent, getAgentUsageRollup, listSessions } from '@/lib/broker'
import { getActiveModelConfig } from '@/lib/runtimes/hermes/providers'
import { AgentDetailView } from '@/components/agents/agent-detail-view'

// ROADMAP B-1 (Detail) — the real, linkable home for one agent. Conforms to
// <DetailLayout> the same way runs/[runId]/review/page.tsx does: this
// server component only fetches data, all interaction (tabs, the
// enable/disable primary action, Settings/Capabilities forms) lives in the
// client component it renders into (agent-detail-view.tsx) — see that
// file's header comment for what each tab contains and why.
export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; agentId: string }>
}) {
  const { workspaceSlug, agentId: agentIdParam } = await params
  const agentId = Number(agentIdParam)
  if (!Number.isFinite(agentId)) notFound()

  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const payload = await getPayloadClient()

  // depth: 1 so `agent.runtimeProfile` comes back populated (name/commandName/
  // protocolFamily) without a second round-trip — the Overview tab and right
  // rail both need it.
  const [agent, profiles, activeRun, activeModel] = await Promise.all([
    payload.findByID({ collection: 'agents', id: agentId, depth: 1, overrideAccess: true, disableErrors: true }),
    payload.find({
      collection: 'runtime-profiles',
      where: { workspace: { equals: workspace.id } },
      sort: 'name',
      limit: 100,
      depth: 0,
      overrideAccess: true,
    }),
    getActiveRunForAgent(agentId),
    // The install root's model — the fallback shown when this agent runs on
    // no profile. Per-agent models come from the agent's Hermes profile,
    // loaded separately below (a profile directory is its own HERMES_HOME
    // with its own config.yaml, so selecting a profile selects a model).
    getActiveModelConfig(),
  ])

  // R7.3 — spend over BOTH windows, and this agent's conversations.
  //
  // Seven days alone answers "is it costing anything right now" but hides a
  // burst that has already tailed off; thirty answers "what has this agent
  // actually cost" but lags a change in behaviour. Showing one was a choice
  // to make one of those questions unanswerable, so both are here.
  //
  // Issued together — three independent reads that would otherwise serialise
  // against a remote database for no reason (D0).
  const [weeklySpend, monthlySpend, agentSessions] = await Promise.all([
    getAgentUsageRollup(agentId, 7),
    getAgentUsageRollup(agentId, 30),
    listSessions({ workspaceId: workspace.id, agentId, limit: 50 }).catch(() => []),
  ])

  const agentWorkspaceId = agent ? (typeof agent.workspace === 'number' ? agent.workspace : agent.workspace.id) : null
  if (!agent || agentWorkspaceId !== workspace.id) notFound()

  const runtimeProfile =
    agent.runtimeProfile && typeof agent.runtimeProfile !== 'number'
      ? {
          name: agent.runtimeProfile.name,
          commandName: agent.runtimeProfile.commandName,
          protocolFamily: agent.runtimeProfile.protocolFamily,
          // Decides which Capabilities panel is honest for this agent: the
          // Hermes skills/MCP view reads a Hermes install, which an agent on
          // another runtime has nothing to do with.
          homeStrategy:
            (agent.runtimeProfile as { homeStrategy?: string | null }).homeStrategy ?? 'hermes',
        }
      : null

  const ownerName = workspace.owner && typeof workspace.owner !== 'number' ? workspace.owner.name || null : null

  // Resolved after the agent loads, because it depends on the agent's own
  // `hermesProfile`. Failure is non-fatal: the page falls back to showing the
  // install-wide model rather than refusing to render.
  const agentProfileName = typeof agent?.hermesProfile === 'string' ? agent.hermesProfile.trim() : ''
  const agentModel = agentProfileName
    ? await getActiveModelConfig(agentProfileName).catch(() => null)
    : null

  // R7.3 — the tools this workspace scopes to this agent. Resolved with the
  // same function the dispatcher uses, so the page and the run cannot disagree
  // about whether a plugin is usable.
  const { resolvePluginsForRun } = await import('@/lib/plugins/resolve')
  const pluginRows = await payload
    .find({
      collection: 'plugins',
      where: { workspace: { equals: workspace.id }, enabled: { equals: true } },
      depth: 0,
      limit: 200,
      sort: 'name',
      overrideAccess: true,
    })
    .catch(() => ({ docs: [] as Array<Record<string, unknown>> }))
  const resolved = await resolvePluginsForRun({ workspaceId: workspace.id, agentId }).catch(() => ({
    servers: [],
    skipped: [] as Array<{ name: string; reason: string }>,
  }))
  const reachableNames = new Set([
    ...resolved.servers.map((server) => server.name),
    ...resolved.skipped.map((entry) => entry.name),
  ])
  const agentPlugins = (pluginRows.docs as Array<Record<string, unknown>>)
    .filter((plugin) => reachableNames.has(String(plugin.name)))
    .map((plugin) => ({
      id: Number(plugin.id),
      name: String(plugin.name),
      description: (plugin.description as string | null) ?? null,
      transport: (plugin.transport as 'http' | 'sse' | 'stdio') ?? 'http',
      problem: resolved.skipped.find((entry) => entry.name === plugin.name)?.reason ?? null,
      viaWorkspace: plugin.scope === 'workspace',
    }))

  return (
    <AgentDetailView
      plugins={agentPlugins}
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      agent={agent as never}
      profiles={profiles.docs as never}
      runtimeProfile={runtimeProfile}
      activeRunId={activeRun?.id ?? null}
      ownerName={ownerName}
      weeklySpendTicks={weeklySpend.totalCostTicks}
      monthlySpendTicks={monthlySpend.totalCostTicks}
      sessions={agentSessions.map((session) => ({
        id: session.id,
        title: session.title,
        projectName: session.projectName,
        runCount: session.runCount,
        isRunning: session.isRunning,
        preview: session.preview,
        lastActivityAt: session.lastActivityAt ?? null,
      }))}
      activeModel={activeModel}
      agentModel={agentModel}
    />
  )
}
