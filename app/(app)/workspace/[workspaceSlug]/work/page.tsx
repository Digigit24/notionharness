import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getActiveModelConfig, type ActiveModelConfig } from '@/lib/hermes/providers'
import { listSessions } from '@/lib/broker'
import { WorkView } from '@/components/work/work-view'

/**
 * Work — the app's chat surface, replacing Ask.
 *
 * Opens the session named in `?session=`, or the most recently active one, so
 * returning to Work lands where you left off rather than on a blank page.
 */
export default async function WorkPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>
  searchParams: Promise<{ session?: string }>
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams])
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const payload = await getPayloadClient()
  const [agentsResult, projectsResult, sessions] = await Promise.all([
    payload.find({
      collection: 'agents',
      where: { workspace: { equals: workspace.id }, enabled: { equals: true } },
      sort: 'name',
      limit: 100,
      depth: 0,
      overrideAccess: true,
    }),
    payload.find({
      collection: 'projects',
      where: { workspace: { equals: workspace.id } },
      sort: 'name',
      limit: 200,
      depth: 0,
      overrideAccess: true,
    }),
    listSessions({ workspaceId: workspace.id }),
  ])

  // One config read per distinct Hermes profile, not per agent: an agent
  // answers with the model its profile pins, and several agents usually share
  // a profile.
  const profiles = new Set(
    agentsResult.docs.map((a) => (typeof a.hermesProfile === 'string' ? a.hermesProfile.trim() : '')),
  )
  const modelByProfile = new Map<string, ActiveModelConfig | null>()
  await Promise.all(
    [...profiles].map(async (profile) => {
      modelByProfile.set(profile, await getActiveModelConfig(profile || undefined).catch(() => null))
    }),
  )

  const requested = Number(query.session)
  const requestedSession = Number.isSafeInteger(requested)
    ? sessions.find((s) => s.id === requested)
    : undefined
  const initialSessionId = requestedSession?.id ?? sessions[0]?.id ?? null

  return (
    <WorkView
      workspaceId={workspace.id}
      workspaceSlug={workspaceSlug}
      agents={agentsResult.docs.map((a) => {
        const profile = typeof a.hermesProfile === 'string' ? a.hermesProfile.trim() : ''
        return { id: a.id, name: a.name, profile, model: modelByProfile.get(profile) ?? null }
      })}
      projects={projectsResult.docs.map((p) => ({ id: p.id, name: p.name }))}
      initialSessions={sessions}
      initialSessionId={initialSessionId}
    />
  )
}
