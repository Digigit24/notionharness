import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getActiveRunForAgent, getAgentUsageRollup } from '@/lib/broker'
import { getActiveModelConfig } from '@/lib/hermes/providers'
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

  // ROADMAP B7.2 — the Overview tab's per-agent spend, same 7-day window as
  // the list page and the ambient status bar elsewhere in this app.
  const weeklySpend = await getAgentUsageRollup(agentId, 7)

  const agentWorkspaceId = agent ? (typeof agent.workspace === 'number' ? agent.workspace : agent.workspace.id) : null
  if (!agent || agentWorkspaceId !== workspace.id) notFound()

  const runtimeProfile =
    agent.runtimeProfile && typeof agent.runtimeProfile !== 'number'
      ? {
          name: agent.runtimeProfile.name,
          commandName: agent.runtimeProfile.commandName,
          protocolFamily: agent.runtimeProfile.protocolFamily,
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

  return (
    <AgentDetailView
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      agent={agent as never}
      profiles={profiles.docs as never}
      runtimeProfile={runtimeProfile}
      activeRunId={activeRun?.id ?? null}
      ownerName={ownerName}
      weeklySpendTicks={weeklySpend.totalCostTicks}
      activeModel={activeModel}
      agentModel={agentModel}
    />
  )
}
