import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { AgentEditor } from '@/components/agents/agent-editor'

export default async function AgentsPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()
  const payload = await getPayloadClient()
  const [agents, profiles] = await Promise.all([
    payload.find({ collection: 'agents', where: { workspace: { equals: workspace.id } }, sort: 'name', limit: 100, depth: 0, overrideAccess: true }),
    payload.find({ collection: 'runtime-profiles', where: { workspace: { equals: workspace.id } }, sort: 'name', limit: 100, depth: 0, overrideAccess: true }),
  ])
  return <main className="mx-auto w-full max-w-5xl px-6 py-8"><div className="mb-6"><h1 className="text-2xl font-semibold">Agents</h1><p className="mt-1 text-sm text-black/50 dark:text-white/50">Configure how agents run in this workspace.</p></div><AgentEditor workspaceId={workspace.id} workspaceSlug={workspace.slug} profiles={profiles.docs as never} initialAgents={agents.docs as never} /></main>
}
