import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { sessionConfigOptions, type AgentHandshake } from '@/lib/runtimes/handshake'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getActiveModelConfig, type ActiveModelConfig } from '@/lib/runtimes/hermes/providers'
import { listSessions } from '@/lib/broker'
import { WorkView } from '@/components/work/work-view'

/**
 * Work — the app's chat surface, replacing Ask.
 *
 * Opens the session named in `?session=`, or the most recently active one, so
 * returning to Work lands where you left off rather than on a blank page.
 * `?new=1` — the sidebar's "New Session" link — overrides that fallback: a
 * person who explicitly asked for a fresh session should get one, not
 * whatever they were last looking at.
 */
export default async function WorkPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>
  searchParams: Promise<{ session?: string; new?: string }>
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
      // depth 1 so each agent's runtime profile comes back with it, carrying
      // the handshake that says which settings that runtime offers. The
      // composer's chips are built from that, not from a list we maintain.
      depth: 1,
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
  const initialSessionId = query.new ? null : requestedSession?.id ?? sessions[0]?.id ?? null

  return (
    <WorkView
      workspaceId={workspace.id}
      workspaceSlug={workspaceSlug}
      agents={agentsResult.docs.map((a) => {
        const profile = typeof a.hermesProfile === 'string' ? a.hermesProfile.trim() : ''
        const runtime = a.runtimeProfile && typeof a.runtimeProfile !== 'number' ? a.runtimeProfile : null
        const handshake = (runtime?.handshake ?? null) as AgentHandshake | null
        return {
          id: a.id,
          name: a.name,
          profile,
          model: modelByProfile.get(profile) ?? null,
          // Whatever this agent's runtime declared about itself. Undefined
          // when it has never been probed, which the composer distinguishes
          // from "offers nothing".
          runtimeOptions: sessionConfigOptions(handshake),
          runtimeDefaults:
            a.runtimeConfig && typeof a.runtimeConfig === 'object'
              ? (a.runtimeConfig as Record<string, unknown>)
              : {},
        }
      })}
      projects={projectsResult.docs.map((p) => ({ id: p.id, name: p.name }))}
      initialSessions={sessions}
      initialSessionId={initialSessionId}
    />
  )
}
