import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getActiveRunForAgent, getAgentUsageRollup } from '@/lib/broker'
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
  const [agent, profiles, activeRun] = await Promise.all([
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
    />
  )
}
