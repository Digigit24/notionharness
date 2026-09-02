import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getAgentUsageRollupForAgents } from '@/lib/broker'
import { AgentEditor } from '@/components/agents/agent-editor'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'

export default async function AgentsPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()
  const payload = await getPayloadClient()
  const [agents, profiles] = await Promise.all([
    payload.find({ collection: 'agents', where: { workspace: { equals: workspace.id } }, sort: 'name', limit: 100, depth: 0, overrideAccess: true }),
    payload.find({ collection: 'runtime-profiles', where: { workspace: { equals: workspace.id } }, sort: 'name', limit: 100, depth: 0, overrideAccess: true }),
  ])
  // ROADMAP B7.2 (Batch B-6 "Finish") — this list previously showed no
  // per-agent spend at all, a real gap the plan calls out by name ("per
  // agent... a real gap"). 7-day trailing window, matching the ambient
  // status bar's own window elsewhere in this app.
  const weeklySpend = await getAgentUsageRollupForAgents(agents.docs.map((a) => a.id), 7)
  return <main className="mx-auto w-full max-w-5xl px-6 py-8"><div className="mb-6">
    {/* ROADMAP B-0 (Frame) — proof-of-concept mount of the new <Breadcrumbs>
        primitive (components/nav/breadcrumbs.tsx). Copy this pattern onto
        other detail pages; wiring it in everywhere is a separate task. */}
    <Breadcrumbs
      className="mb-2"
      segments={[
        { label: workspace.name, href: `/workspace/${workspace.slug}` },
        { label: 'Agents' },
      ]}
    />
    <h1 className="text-2xl font-semibold">Agents</h1><p className="mt-1 text-sm text-black/50 dark:text-white/50">Configure how agents run in this workspace.</p></div><AgentEditor workspaceId={workspace.id} workspaceSlug={workspace.slug} profiles={profiles.docs as never} initialAgents={agents.docs as never} weeklySpendByAgentId={Object.fromEntries(Object.entries(weeklySpend).map(([id, totals]) => [id, totals.totalCostTicks]))} /></main>
}
